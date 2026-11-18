import { constants } from "node:fs";
import { lstat, mkdir, open, readFile, readdir, rename, rm, rmdir } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { hostname } from "node:os";
import { safeError } from "../errors.js";
import type { Profile } from "../domain/types.js";
import { recoveryActive, recoveryStatus, type RecoveryReservation, type RecoveryStatus } from "./recovery-types.js";

/** Version one is accepted for migration; version two retains a binding without a usable token. */
export interface WebUserCredential {
  readonly schemaVersion: 1 | 2;
  readonly class: "web-user";
  readonly apiToken: string;
  readonly webAuthenticationToken?: string;
  readonly generation: number;
  readonly principalEpoch: string;
  readonly principalRecordName?: string;
  readonly uncertain?: boolean;
  readonly binding?: { readonly containerId: string; readonly environment: "development" | "production" };
  readonly sessionState?: "ready" | "suspended";
  readonly recovery?: RecoveryReservation;
}

export type StoredCredential =
  | { readonly schemaVersion: 1; readonly class: "api-token-public"; readonly apiToken: string; readonly generation: number }
  | WebUserCredential
  | { readonly schemaVersion: 1; readonly class: "server-key"; readonly keyId: string; readonly privateKeyPem: string; readonly generation: number };

export interface CredentialStatus {
  readonly credentialRef: string;
  readonly available: boolean;
  readonly usable: boolean;
  readonly credentialClass?: StoredCredential["class"];
  readonly generation?: number;
  readonly principalBound?: boolean;
  readonly uncertain?: boolean;
  readonly recovery?: RecoveryStatus;
}

export type ReplacementCommitter = (credentialRef: string, credential: StoredCredential) => Promise<void>;

/** Owner-only POSIX storage. Hold withLock for read/modify/write transactions. */
export class CredentialStore {
  readonly #root: string;
  readonly #blocked = new Set<string>();

  constructor(root: string, private readonly replacementCommitter?: ReplacementCommitter) { this.#root = resolve(root); }

  async initialize(): Promise<void> {
    await mkdir(this.#root, { recursive: true, mode: 0o700 });
    const info = await lstat(this.#root);
    if (info.isSymbolicLink() || !info.isDirectory() || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0) {
      throw credentialStoreError("The credential directory is not an owner-only real directory.", "Create a private directory owned by the current user with mode 0700.");
    }
  }

  async read(credentialRef: string): Promise<StoredCredential> {
    if (this.#blocked.has(credentialRef)) throw credentialStoreError("The credential slot requires local storage repair.", "Repair storage and restart the connector before recovery.");
    await this.initialize();
    const path = this.#slotPath(credentialRef);
    let info;
    try { info = await lstat(path); }
    catch { throw credentialStoreError("The selected local credential is not available.", "Run hidden-terminal auth import for this profile. Read cloudkit://troubleshooting."); }
    if (info.isSymbolicLink() || !info.isFile() || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0 || info.size > 16 * 1024) {
      throw credentialStoreError("The credential slot failed ownership, type, mode, or size validation.", "Remove the unsafe slot and import the credential again.");
    }
    try { return validateCredential(JSON.parse(await readFile(path, "utf8"))); }
    catch { throw credentialStoreError("The credential slot is malformed.", "Remove the unsafe slot and import the credential again."); }
  }

  /** Low-level atomic write, also used to seed deterministic tests. */
  async write(credentialRef: string, credential: StoredCredential): Promise<void> {
    await this.initialize();
    const validated = validateCredential(credential);
    const destination = this.#slotPath(credentialRef);
    const temporary = join(dirname(destination), `.${basename(destination)}.${randomBytes(10).toString("hex")}.tmp`);
    try {
      const file = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
      try { await file.writeFile(`${JSON.stringify(validated)}\n`, "utf8"); await file.sync(); }
      finally { await file.close(); }
      await rename(temporary, destination);
      const directory = await open(dirname(destination), constants.O_RDONLY);
      try { await directory.sync(); } finally { await directory.close(); }
    } finally { await rm(temporary, { force: true }); }
  }

  /** Explicit replacement invalidates any older recovery reservation. */
  async importCredential(credentialRef: string, credential: StoredCredential): Promise<void> {
    await this.withLock(credentialRef, async () => { await this.write(credentialRef, credential); this.#blocked.delete(credentialRef); });
  }

  async remove(credentialRef: string): Promise<void> {
    await this.withLock(credentialRef, async () => {
      const path = this.#slotPath(credentialRef);
      try {
        const info = await lstat(path);
        if (info.isSymbolicLink() || !info.isFile()) throw credentialStoreError("The credential slot is not a removable regular file.", "Inspect the configured credential store manually.");
        await rm(path);
      } catch (error) { if (!hasCode(error, "ENOENT")) throw error; }
      this.#blocked.delete(credentialRef);
    });
  }

  async status(credentialRef: string): Promise<CredentialStatus> {
    try {
      const credential = await this.read(credentialRef);
      return { credentialRef, available: true, usable: credential.class !== "web-user" || webSessionUsable(credential), credentialClass: credential.class, generation: credential.generation,
        principalBound: credential.class === "web-user" && credential.principalRecordName !== undefined,
        uncertain: credential.class === "web-user" && !webSessionUsable(credential),
        ...(credential.class === "web-user" ? { recovery: credential.recovery ? reservationStatus(credential.recovery) : recoveryStatus("idle") } : {}) };
    } catch { return { credentialRef, available: false, usable: false }; }
  }

  /** Failed commits retain recovery configuration and keep the session unavailable. */
  async commitReplacement(credentialRef: string, replacement: StoredCredential, fallback: StoredCredential, execution: "notStarted" | "completed" | "uncertain" = "completed"): Promise<void> {
    try {
      if (this.replacementCommitter) await this.replacementCommitter(credentialRef, replacement);
      else await this.write(credentialRef, replacement);
    } catch {
      if (fallback.class === "web-user") {
        try { await this.write(credentialRef, suspendWebSession(fallback)); }
        catch { this.#blocked.add(credentialRef); }
      }
      throw safeError({ code: "authenticationUncertain", message: "The replacement credential could not be committed atomically; the session remains unavailable.", execution, sessionEffect: "uncertain", retryable: false, retryConditions: [], nextStep: "Repair local storage, then recover the session. Read cloudkit://troubleshooting." });
    }
  }

  async withLease<T>(credentialRef: string, operation: (credential: StoredCredential) => Promise<{ readonly value: T; readonly replacement?: StoredCredential }>): Promise<T> {
    return this.withLock(credentialRef, async () => {
      const credential = await this.read(credentialRef);
      const outcome = await operation(credential);
      if (outcome.replacement) await this.commitReplacement(credentialRef, outcome.replacement, credential);
      return outcome.value;
    });
  }

  /** Token-named owner files let reclaimers remove only a proven dead owner's lease. */
  async withLock<T>(credentialRef: string, operation: () => Promise<T>): Promise<T> {
    await this.initialize();
    const lockPath = `${this.#slotPath(credentialRef)}.lock`;
    const ownerFile = `${randomBytes(18).toString("hex")}.json`;
    const deadline = Date.now() + 10_000;
    let acquired = false;
    while (!acquired && Date.now() < deadline) {
      try { await mkdir(lockPath, { mode: 0o700 }); acquired = true; }
      catch (error) {
        if (!hasCode(error, "EEXIST")) throw error;
        await reclaimDeadLock(lockPath);
        await new Promise((done) => setTimeout(done, 25));
      }
    }
    if (!acquired) throw safeError({ code: "queueExhausted", message: "The credential slot is busy.", execution: "notStarted", sessionEffect: "unchanged", retryable: true, retryConditions: ["The active credential transaction completes."], nextStep: "Retry after the active read has completed." });
    try {
      const file = await open(join(lockPath, ownerFile), constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
      try { await file.writeFile(JSON.stringify({ pid: process.pid, host: hostname() })); await file.sync(); }
      finally { await file.close(); }
      return await operation();
    } finally {
      await rm(join(lockPath, ownerFile), { force: true });
      await rmdir(lockPath).catch((error: unknown) => { if (!hasCode(error, "ENOENT")) throw error; });
    }
  }

  #slotPath(credentialRef: string): string {
    if (!/^[A-Za-z0-9._:-]{1,255}$/.test(credentialRef)) throw credentialStoreError("The credential reference is invalid.", "Use the configured credentialRef exactly.");
    const path = join(this.#root, `${credentialRef}.json`);
    if (dirname(path) !== this.#root) throw credentialStoreError("The credential reference escapes the configured store.", "Use the configured credentialRef exactly.");
    return path;
  }
}

export function webSessionUsable(credential: WebUserCredential): boolean {
  return credential.uncertain !== true && credential.sessionState !== "suspended" && Boolean(credential.webAuthenticationToken) && !recoveryActive(credential.recovery?.state ?? "idle");
}

export function bindWebCredential(credential: WebUserCredential, profile: Profile): WebUserCredential {
  if (credential.binding && (credential.binding.containerId !== profile.containerId || credential.binding.environment !== profile.environment)) {
    throw credentialStoreError("The credential is bound to a different container or environment.", "Use the intended profile and an independently imported credential slot.");
  }
  const migrated: WebUserCredential = { ...credential, schemaVersion: 2, binding: { containerId: profile.containerId, environment: profile.environment }, sessionState: webSessionUsable(credential) ? "ready" : "suspended" };
  return migrated.sessionState === "ready" ? migrated : suspendWebSession(migrated);
}

export function suspendWebSession(credential: WebUserCredential): WebUserCredential {
  const { webAuthenticationToken: _token, ...retained } = credential;
  // Legacy suspension retains its token solely until migration can bind it to a profile.
  if (credential.schemaVersion === 1) return { ...credential, uncertain: true };
  return { ...retained, uncertain: true, sessionState: "suspended" };
}

export function ownerAlive(pid: number, host: string): boolean {
  if (host !== hostname()) return true;
  try { process.kill(pid, 0); return true; } catch (error) { return !hasCode(error, "ESRCH"); }
}

export function reservationStatus(reservation: RecoveryReservation): RecoveryStatus {
  if (recoveryActive(reservation.state) && reservation.expiresAt <= Date.now()) return recoveryStatus("failed", reservation.attemptId, "timedOut");
  if (recoveryActive(reservation.state) && !ownerAlive(reservation.ownerPid, reservation.ownerHost)) return recoveryStatus("failed", reservation.attemptId, "interrupted");
  return recoveryStatus(reservation.state, reservation.attemptId, reservation.reason);
}

async function reclaimDeadLock(path: string): Promise<void> {
  let info;
  try { info = await lstat(path); } catch (error) { if (hasCode(error, "ENOENT")) return; throw error; }
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0) throw credentialStoreError("The credential lock is unsafe.", "Inspect the configured credential directory manually.");
  const files = await readdir(path).catch(() => []);
  if (files.length !== 1 || !/^[a-f0-9]{36}\.json$/.test(files[0]!)) {
    if (Date.now() - info.mtimeMs > 45_000) throw credentialStoreError("The credential slot has a stale or abandoned lock without verifiable ownership.", "Inspect running processes before manually removing this legacy lock.");
    return;
  }
  const ownerPath = join(path, files[0]!);
  let owner;
  try {
    const metadata = await lstat(ownerPath);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.uid !== process.getuid?.() || metadata.size > 1024 || (metadata.mode & 0o077) !== 0) throw new Error();
    owner = JSON.parse(await readFile(ownerPath, "utf8")) as { pid?: unknown; host?: unknown };
    if (!Number.isSafeInteger(owner.pid) || (owner.pid as number) <= 0 || typeof owner.host !== "string") throw new Error();
  } catch (error) {
    // The holder may still be creating its owner file, or may have just released it.
    if (hasCode(error, "ENOENT") || Date.now() - info.mtimeMs < 45_000) return;
    throw credentialStoreError("The credential lock ownership cannot be verified.", "Inspect running processes before repairing this lock.");
  }
  if (ownerAlive(owner.pid as number, owner.host as string)) return;
  try { await rm(ownerPath); } catch (error) { if (hasCode(error, "ENOENT")) return; throw error; }
  await rmdir(path).catch((error: unknown) => { if (!hasCode(error, "ENOENT") && !hasCode(error, "ENOTEMPTY")) throw error; });
}

function validateCredential(input: unknown): StoredCredential {
  if (typeof input !== "object" || input === null) throw new Error("invalid credential");
  const value = input as Record<string, unknown>;
  if (![1, 2].includes(value.schemaVersion as number) || !Number.isSafeInteger(value.generation) || (value.generation as number) < 0) throw new Error("invalid credential");
  if (value.schemaVersion === 1 && value.class === "api-token-public" && bounded(value.apiToken, 4096) && onlyKeys(value, ["schemaVersion", "class", "apiToken", "generation"])) return value as unknown as StoredCredential;
  if (value.schemaVersion === 1 && value.class === "server-key" && bounded(value.keyId, 255) && bounded(value.privateKeyPem, 8192) && onlyKeys(value, ["schemaVersion", "class", "keyId", "privateKeyPem", "generation"])) return value as unknown as StoredCredential;
  if (value.class === "web-user" && bounded(value.apiToken, 4096) && bounded(value.principalEpoch, 255) && (value.principalRecordName === undefined || bounded(value.principalRecordName, 1024)) && (value.uncertain === undefined || typeof value.uncertain === "boolean")) {
    const base = ["schemaVersion", "class", "apiToken", "webAuthenticationToken", "generation", "principalEpoch", "principalRecordName", "uncertain"];
    if (value.schemaVersion === 1 && bounded(value.webAuthenticationToken, 4096) && onlyKeys(value, base)) return value as unknown as StoredCredential;
    const binding = value.binding as Record<string, unknown> | undefined;
    if (value.schemaVersion === 2 && binding && /^iCloud\.[A-Za-z0-9.-]+$/.test(String(binding.containerId)) && ["development", "production"].includes(String(binding.environment)) && onlyKeys(binding, ["containerId", "environment"]) && ["ready", "suspended"].includes(String(value.sessionState)) && (value.sessionState === "suspended" ? value.webAuthenticationToken === undefined : bounded(value.webAuthenticationToken, 4096)) && (value.recovery === undefined || validReservation(value.recovery)) && onlyKeys(value, [...base, "binding", "sessionState", "recovery"])) return value as unknown as StoredCredential;
  }
  throw new Error("invalid credential");
}

function validReservation(input: unknown): boolean {
  if (typeof input !== "object" || input === null) return false;
  const r = input as Record<string, unknown>;
  const states = ["starting", "awaitingUser", "verifying", "succeeded", "cancelled", "failed"];
  const reasons = ["manualMode", "missingConfiguration", "principalUnbound", "principalMismatch", "configurationMismatch", "browserUnavailable", "authorizationFailed", "invalidCallback", "verificationFailed", "storageFailed", "timedOut", "interrupted", "superseded", "operatorCancelled", "localRepairRequired"];
  return typeof r.attemptId === "string" && /^[a-f0-9]{36}$/.test(r.attemptId) && bounded(r.profileId, 255) && Number.isSafeInteger(r.ownerPid) && (r.ownerPid as number) > 0 && bounded(r.ownerHost, 255) && Number.isSafeInteger(r.expiresAt) && states.includes(String(r.state)) && (r.reason === undefined || reasons.includes(String(r.reason))) && onlyKeys(r, ["attemptId", "profileId", "ownerPid", "ownerHost", "expiresAt", "state", "reason"]);
}

function bounded(value: unknown, maximum: number): value is string { return typeof value === "string" && value.length > 0 && value.length <= maximum; }
function onlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean { return Object.keys(value).every((key) => keys.includes(key)); }
function hasCode(error: unknown, code: string): boolean { return typeof error === "object" && error !== null && "code" in error && error.code === code; }
function credentialStoreError(message: string, nextStep: string) { return safeError({ code: "authenticationRequired", message, execution: "notStarted", sessionEffect: "unchanged", retryable: false, retryConditions: [], nextStep }); }
