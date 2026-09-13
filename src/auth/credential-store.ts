import { constants } from "node:fs";
import { lstat, mkdir, open, readFile, rename, rm, stat } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { safeError } from "../errors.js";

/** Credential variants persisted outside repository trees. */
export type StoredCredential =
  | { readonly schemaVersion: 1; readonly class: "api-token-public"; readonly apiToken: string; readonly generation: number }
  | { readonly schemaVersion: 1; readonly class: "web-user"; readonly apiToken: string; readonly webAuthenticationToken: string; readonly generation: number; readonly principalEpoch: string; readonly principalRecordName?: string; readonly uncertain?: boolean }
  | { readonly schemaVersion: 1; readonly class: "server-key"; readonly keyId: string; readonly privateKeyPem: string; readonly generation: number };

/** Safe status for one local credential slot. */
export interface CredentialStatus {
  readonly credentialRef: string;
  readonly available: boolean;
  readonly credentialClass?: StoredCredential["class"];
  readonly generation?: number;
  readonly principalBound?: boolean;
  readonly uncertain?: boolean;
}

/** Owner-only POSIX credential store with symlink rejection and atomic replacement. */
export class CredentialStore {
  readonly #root: string;

  constructor(root: string) {
    this.#root = resolve(root);
  }

  /** Initializes and validates the explicitly configured store root. */
  async initialize(): Promise<void> {
    await mkdir(this.#root, { recursive: true, mode: 0o700 });
    const rootInfo = await lstat(this.#root);
    if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory() || rootInfo.uid !== process.getuid?.() || (rootInfo.mode & 0o077) !== 0) {
      throw credentialStoreError("The credential directory is not an owner-only real directory.", "Create a private directory owned by the current user with mode 0700.");
    }
  }

  /** Reads and validates one credential slot. */
  async read(credentialRef: string): Promise<StoredCredential> {
    const path = this.#slotPath(credentialRef);
    let info;
    try {
      info = await lstat(path);
    } catch {
      throw safeError({ code: "authenticationRequired", message: "The selected local credential is not available.", execution: "notStarted", sessionEffect: "unchanged", retryable: false, retryConditions: [], nextStep: `Run cloudkit-mcp auth import --profile for credential reference ${credentialRef}.` });
    }
    if (info.isSymbolicLink() || !info.isFile() || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0 || info.size > 16 * 1024) {
      throw credentialStoreError("The credential slot failed ownership, type, mode, or size validation.", "Remove the unsafe slot and import the credential again.");
    }
    try {
      return validateCredential(JSON.parse(await readFile(path, "utf8")));
    } catch {
      throw credentialStoreError("The credential slot is malformed.", "Remove the unsafe slot and import the credential again.");
    }
  }

  /** Atomically replaces one credential slot with restrictive permissions from creation. */
  async write(credentialRef: string, credential: StoredCredential): Promise<void> {
    await this.initialize();
    const validated = validateCredential(credential);
    const destination = this.#slotPath(credentialRef);
    const temporary = join(dirname(destination), `.${basename(destination)}.${randomBytes(10).toString("hex")}.tmp`);
    const handle = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(validated)}\n`, { encoding: "utf8" });
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, destination);
    const directory = await open(dirname(destination), constants.O_RDONLY);
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  }

  /** Removes exactly one selected local credential without claiming remote revocation. */
  async remove(credentialRef: string): Promise<void> {
    const path = this.#slotPath(credentialRef);
    try {
      const info = await lstat(path);
      if (info.isSymbolicLink() || !info.isFile()) throw credentialStoreError("The credential slot is not a removable regular file.", "Inspect the configured credential store manually.");
      await rm(path);
    } catch (error) {
      if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return;
      throw error;
    }
  }

  /** Returns non-secret availability metadata. */
  async status(credentialRef: string): Promise<CredentialStatus> {
    try {
      const credential = await this.read(credentialRef);
      return {
        credentialRef,
        available: true,
        credentialClass: credential.class,
        generation: credential.generation,
        principalBound: credential.class === "web-user" && credential.principalRecordName !== undefined,
        uncertain: credential.class === "web-user" && credential.uncertain === true,
      };
    } catch {
      return { credentialRef, available: false };
    }
  }

  /** Serializes a complete use-and-replacement transaction across server processes. */
  async withLease<T>(credentialRef: string, operation: (credential: StoredCredential) => Promise<{ readonly value: T; readonly replacement?: StoredCredential }>): Promise<T> {
    await this.initialize();
    const lockPath = `${this.#slotPath(credentialRef)}.lock`;
    let acquired = false;
    const deadline = Date.now() + 10_000;
    while (!acquired && Date.now() < deadline) {
      try {
        await mkdir(lockPath, { mode: 0o700 });
        acquired = true;
      } catch (error) {
        if (!(typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST")) throw error;
        const info = await stat(lockPath).catch(() => undefined);
        if (info && Date.now() - info.mtimeMs > 45_000) {
          throw credentialStoreError("The credential slot has a stale or abandoned lock.", "Inspect running CloudKit MCP processes before removing the lock; do not risk concurrent token reuse.");
        }
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
      }
    }
    if (!acquired) throw safeError({ code: "queueExhausted", message: "The credential slot is busy.", execution: "notStarted", sessionEffect: "unchanged", retryable: true, retryConditions: ["The active credential transaction completes."], nextStep: "Retry after the active read has completed." });
    try {
      const credential = await this.read(credentialRef);
      const outcome = await operation(credential);
      if (outcome.replacement) {
        try {
          await this.write(credentialRef, outcome.replacement);
        } catch {
          await rm(this.#slotPath(credentialRef), { force: true });
          throw safeError({ code: "authenticationUncertain", message: "The replacement credential could not be committed atomically, so the local slot was invalidated.", execution: "completed", sessionEffect: "uncertain", retryable: false, retryConditions: [], nextStep: "Reauthenticate and import a fresh credential before another request." });
        }
      }
      return outcome.value;
    } finally {
      await rm(lockPath, { recursive: true, force: true });
    }
  }

  #slotPath(credentialRef: string): string {
    if (!/^[A-Za-z0-9._:-]{1,255}$/.test(credentialRef)) throw credentialStoreError("The credential reference is invalid.", "Use the configured credentialRef exactly.");
    const path = join(this.#root, `${credentialRef}.json`);
    if (dirname(path) !== this.#root) throw credentialStoreError("The credential reference escapes the configured store.", "Use the configured credentialRef exactly.");
    return path;
  }
}

function validateCredential(input: unknown): StoredCredential {
  if (typeof input !== "object" || input === null) throw new Error("invalid credential");
  const value = input as Record<string, unknown>;
  if (value.schemaVersion !== 1 || !Number.isSafeInteger(value.generation) || (value.generation as number) < 0) throw new Error("invalid credential");
  if (value.class === "api-token-public" && typeof value.apiToken === "string" && value.apiToken.length > 0 && value.apiToken.length <= 4096 && onlyKeys(value, ["schemaVersion", "class", "apiToken", "generation"])) return value as unknown as StoredCredential;
  if (value.class === "server-key" && typeof value.keyId === "string" && value.keyId.length > 0 && value.keyId.length <= 255 && typeof value.privateKeyPem === "string" && value.privateKeyPem.length > 0 && value.privateKeyPem.length <= 8192 && onlyKeys(value, ["schemaVersion", "class", "keyId", "privateKeyPem", "generation"])) return value as unknown as StoredCredential;
  if (value.class === "web-user" && typeof value.apiToken === "string" && value.apiToken.length > 0 && value.apiToken.length <= 4096 && typeof value.webAuthenticationToken === "string" && value.webAuthenticationToken.length > 0 && value.webAuthenticationToken.length <= 4096 && typeof value.principalEpoch === "string" && value.principalEpoch.length > 0 && value.principalEpoch.length <= 255 && (value.principalRecordName === undefined || (typeof value.principalRecordName === "string" && value.principalRecordName.length <= 1024)) && (value.uncertain === undefined || typeof value.uncertain === "boolean") && onlyKeys(value, ["schemaVersion", "class", "apiToken", "webAuthenticationToken", "generation", "principalEpoch", "principalRecordName", "uncertain"])) return value as unknown as StoredCredential;
  throw new Error("invalid credential");
}

function onlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function credentialStoreError(message: string, nextStep: string) {
  return safeError({ code: "authenticationRequired", message, execution: "notStarted", sessionEffect: "unchanged", retryable: false, retryConditions: [], nextStep });
}
