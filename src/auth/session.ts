import { createHmac, randomBytes } from "node:crypto";
import { CloudKitMCPError, safeError, sanitizeUnknownError } from "../errors.js";
import type { DatabaseScope, Profile, ResolvedView } from "../domain/types.js";
import { CloudKitTransport, type TransportResult } from "../api/transport.js";
import { preflightOperation } from "../api/operations.js";
import { bindWebCredential, CredentialStore, suspendWebSession, webSessionUsable, type StoredCredential } from "./credential-store.js";
import { RecoveryCoordinator } from "./recovery.js";
import { recoveryStatus } from "./recovery-types.js";

/** Resolves credentials lazily and commits rotating tokens before releasing the slot lease. */
export class SessionManager {
  readonly #aliasSecret = randomBytes(32);

  constructor(private readonly store: CredentialStore, private readonly transport: CloudKitTransport, private readonly recovery?: RecoveryCoordinator) {}

  get recoveryMode(): "post-message" | "manual" { return this.recovery?.mode ?? "manual"; }

  async recoverSession(profile: Profile, action: "start" | "status" | "cancel", attemptId?: string) {
    if (!this.recovery) return recoveryStatus("manualRequired", undefined, "manualMode");
    if (action === "start") return this.recovery.start(profile);
    if (action === "cancel") return this.recovery.cancel(profile, attemptId);
    return this.recovery.status(profile);
  }

  /** Executes one authorized operation, durably quarantining a rotating token before dispatch. */
  async execute(profile: Profile, scope: DatabaseScope, operation: Parameters<CloudKitTransport["execute"]>[0], body: unknown, signal?: AbortSignal) {
    if (!profile.allowedScopes.includes(scope)) throw safeError({ code: "disallowedScope", message: "The selected profile does not authorize this database scope.", execution: "notStarted", sessionEffect: "unchanged", retryable: false, retryConditions: [], nextStep: "Choose an allowed scope returned by get_context." });
    preflightOperation(operation, profile.authenticationMode, scope);
    try {
      const outcome = await this.store.withLock(profile.credentialRef, async () => {
        const loaded = await this.store.read(profile.credentialRef);
        validateCredentialClass(profile, loaded);
        const stored = loaded.class === "web-user" ? bindWebCredential(loaded, profile) : loaded;
        validateUsable(stored);
        if (signal?.aborted) throw safeError({ code: "cancelled", message: "The CloudKit read was cancelled before dispatch.", execution: "notStarted", sessionEffect: "unchanged", retryable: false, retryConditions: [], nextStep: "Issue a new request only if the diagnostic is still wanted." });
        const credential = stored.class === "web-user"
          ? { mode: "web-user" as const, apiToken: stored.apiToken, webAuthenticationToken: stored.webAuthenticationToken! }
          : stored.class === "server-key"
            ? { mode: "server-key" as const, serverKey: { keyId: stored.keyId, privateKeyPem: stored.privateKeyPem } }
            : { mode: "api-token-public" as const, apiToken: stored.apiToken };
        const suspended = stored.class === "web-user" ? suspendWebSession(stored) : undefined;
        if (suspended) {
          try { await this.store.write(profile.credentialRef, suspended); }
          catch { throw safeError({ code: "authenticationRequired", message: "The session could not be suspended durably; no CloudKit request was sent.", execution: "notStarted", sessionEffect: "unchanged", retryable: false, retryConditions: [], nextStep: "Repair credential storage before retrying. Read cloudkit://troubleshooting." }); }
        }
        let result: TransportResult;
        try {
          result = await this.transport.execute(operation, { containerId: profile.containerId, environment: profile.environment, scope }, credential, body, signal);
        } catch (error) {
          if (stored.class !== "web-user") throw error;
          const details = sanitizeUnknownError(error);
          if (details.execution === "notStarted" && details.sessionEffect === "unchanged") {
            await this.store.commitReplacement(profile.credentialRef, stored, suspended!, "notStarted");
            return { body: {}, status: 0, error: details, resolvedView: this.resolveView(profile, scope, stored) };
          }
          return { body: {}, status: 0, error: { ...details, retryable: false, retryConditions: [], sessionEffect: "uncertain" as const }, resolvedView: this.resolveView(profile, scope, suspended!) };
        }
        if (stored.class !== "web-user") return { ...result, resolvedView: this.resolveView(profile, scope, stored) };
        const token = result.replacementWebAuthenticationToken;
        if (!token) {
          return { ...result, error: result.error ?? { code: "authenticationUncertain" as const, message: "The rotating CloudKit user session did not yield a durable replacement token.", execution: "completed" as const, sessionEffect: "uncertain" as const, retryable: false, retryConditions: [], nextStep: "Recover this profile before another request. Read cloudkit://troubleshooting." }, resolvedView: this.resolveView(profile, scope, suspended!) };
        }
        const response = typeof result.body === "object" && result.body !== null ? result.body as Record<string, unknown> : {};
        const observedPrincipal = operation === "probeCurrentUser" && typeof response.userRecordName === "string" && response.userRecordName.length > 0 && response.userRecordName.length <= 1024 ? response.userRecordName : stored.principalRecordName;
        const switched = stored.principalRecordName !== undefined && observedPrincipal !== undefined && observedPrincipal !== stored.principalRecordName;
        const rejected = result.error?.code === "authenticationExpired" || ["AUTHENTICATION_REQUIRED", "AUTHENTICATION_FAILED"].includes(String(response.serverErrorCode));
        const rotated = { ...stored, generation: stored.generation + 1, webAuthenticationToken: token, uncertain: false, sessionState: "ready" as const, ...(!switched && observedPrincipal !== undefined ? { principalRecordName: observedPrincipal } : {}) };
        const replacement = switched || rejected ? suspendWebSession(rotated) : rotated;
        await this.store.commitReplacement(profile.credentialRef, replacement, suspended!);
        const error = switched ? { code: "authenticationUncertain" as const, message: "The authenticated CloudKit account no longer matches the principal bound to this credential slot.", execution: "completed" as const, sessionEffect: "uncertain" as const, retryable: false, retryConditions: [], nextStep: "Recover the intended account. Account changes require explicit manual import." }
          : rejected ? { code: "authenticationExpired" as const, message: "CloudKit rejected the authenticated session.", execution: "completed" as const, sessionEffect: "uncertain" as const, retryable: false, retryConditions: [], nextStep: "Recover the intended account before another request." } : result.error;
        return { ...result, ...(error ? { error } : {}), resolvedView: this.resolveView(profile, scope, replacement) };
      });
      if (outcome.error) throw new CloudKitMCPError(outcome.error);
      return outcome;
    } catch (error) { throw await this.attachRecovery(profile, error, signal?.aborted === true); }
  }

  /** Reads under the lease so an in-flight suspension is never mistaken for an abandoned request. */
  async currentView(profile: Profile, scope: DatabaseScope): Promise<ResolvedView> {
    try {
      return await this.store.withLock(profile.credentialRef, async () => {
        const credential = await this.store.read(profile.credentialRef);
        validateCredentialClass(profile, credential);
        const bound = credential.class === "web-user" ? bindWebCredential(credential, profile) : credential;
        validateUsable(bound);
        return this.resolveView(profile, scope, bound);
      });
    } catch (error) { throw await this.attachRecovery(profile, error); }
  }

  /** Authentication recovery never rewrites the triggering request's execution status. */
  async attachRecovery(profile: Profile, error: unknown, cancelled = false): Promise<unknown> {
    if (profile.authenticationMode !== "web-user" || !(error instanceof CloudKitMCPError) || error.details.recovery) return error;
    const details = error.toSafeObject();
    if (!["authenticationRequired", "authenticationExpired", "authenticationUncertain"].includes(details.code) && details.sessionEffect !== "uncertain") return error;
    const recovery = this.recovery ? cancelled || details.code === "cancelled" ? await this.recovery.status(profile) : await this.recovery.start(profile, false) : recoveryStatus("manualRequired", undefined, "manualMode");
    return new CloudKitMCPError({ ...details, recovery: { ...recovery, requestRetry: details.execution === "notStarted" ? "retryNotStartedOnce" : "freshObservationRequired" }, nextStep: recovery.nextStep });
  }

  resolveView(profile: Profile, scope: DatabaseScope, credential: StoredCredential): ResolvedView {
    const principalEpoch = credential.class === "web-user" ? credential.principalEpoch : `credential-generation-${credential.generation}`;
    const principalInput = credential.class === "web-user" && credential.principalRecordName ? credential.principalRecordName : `${profile.credentialRef}:${principalEpoch}`;
    const principalAlias = createHmac("sha256", this.#aliasSecret).update(`${profile.containerId}\0${principalInput}`).digest("base64url").slice(0, 20);
    return { profileId: profile.id, containerId: profile.containerId, environment: profile.environment, scope, backend: profile.backend, principalAlias: `account_${principalAlias}`, principalEpoch, principalBound: credential.class !== "web-user" || credential.principalRecordName !== undefined && webSessionUsable(credential) };
  }

  alias(kind: "account" | "owner", containerId: string, identity: string): string {
    return `${kind}_${createHmac("sha256", this.#aliasSecret).update(`${containerId}\0${identity}`).digest("base64url").slice(0, 20)}`;
  }
}

function validateCredentialClass(profile: Profile, stored: StoredCredential): void {
  if (stored.class !== profile.authenticationMode) throw safeError({ code: "authenticationRequired", message: "The stored credential class does not match the immutable profile.", execution: "notStarted", sessionEffect: "unchanged", retryable: false, retryConditions: [], nextStep: "Remove the selected slot and import the exact configured credential class." });
}

function validateUsable(stored: StoredCredential): void {
  if (stored.class === "web-user" && !webSessionUsable(stored)) throw safeError({ code: "authenticationUncertain", message: "The stored rotating user session is marked uncertain or suspended.", execution: "notStarted", sessionEffect: "uncertain", retryable: false, retryConditions: [], nextStep: "Recover this profile before another request. Read cloudkit://troubleshooting." });
}
