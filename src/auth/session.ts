import { createHmac, randomBytes } from "node:crypto";
import { CloudKitMCPError, safeError } from "../errors.js";
import type { DatabaseScope, Profile, ResolvedView } from "../domain/types.js";
import { CloudKitTransport } from "../api/transport.js";
import { preflightOperation } from "../api/operations.js";
import { CredentialStore, type StoredCredential } from "./credential-store.js";

/** Resolves credentials lazily and commits rotating user tokens before releasing a slot lease. */
export class SessionManager {
  readonly #aliasSecret = randomBytes(32);

  constructor(private readonly store: CredentialStore, private readonly transport: CloudKitTransport) {}

  /** Executes one authorized profile operation as a single credential transaction. */
  async execute(profile: Profile, scope: DatabaseScope, operation: Parameters<CloudKitTransport["execute"]>[0], body: unknown, signal?: AbortSignal) {
    if (!profile.allowedScopes.includes(scope)) {
      throw safeError({ code: "disallowedScope", message: "The selected profile does not authorize this database scope.", execution: "notStarted", sessionEffect: "unchanged", retryable: false, retryConditions: [], nextStep: "Choose an allowed scope returned by get_context." });
    }
    preflightOperation(operation, profile.authenticationMode, scope);
    const outcome = await this.store.withLease(profile.credentialRef, async (stored) => {
      validateCredentialClass(profile, stored);
      const credential = stored.class === "web-user"
        ? { mode: "web-user" as const, apiToken: stored.apiToken, webAuthenticationToken: stored.webAuthenticationToken }
        : stored.class === "server-key"
          ? { mode: "server-key" as const, serverKey: { keyId: stored.keyId, privateKeyPem: stored.privateKeyPem } }
          : { mode: "api-token-public" as const, apiToken: stored.apiToken };
      let result;
      try {
        result = await this.transport.execute(operation, { containerId: profile.containerId, environment: profile.environment, scope }, credential, body, signal);
      } catch (error) {
        if (stored.class !== "web-user") throw error;
        const details = error instanceof CloudKitMCPError ? error.toSafeObject() : { code: "authenticationUncertain" as const, message: "The rotating CloudKit user request failed after dispatch without a durable replacement token.", execution: "uncertain" as const, sessionEffect: "uncertain" as const, retryable: false, retryConditions: [], nextStep: "Reauthenticate this profile before another request." };
        if (details.execution === "notStarted" && details.sessionEffect === "unchanged") {
          return { value: { body: {}, status: 0, error: details, resolvedView: this.resolveView(profile, scope, stored) } };
        }
        return { value: { body: {}, status: 0, error: { ...details, retryable: false, retryConditions: [], sessionEffect: "uncertain" as const }, resolvedView: this.resolveView(profile, scope, { ...stored, uncertain: true }) }, replacement: { ...stored, uncertain: true } };
      }
      let replacement: StoredCredential | undefined;
      let effectiveResult = result;
      if (stored.class === "web-user") {
        const token = result.replacementWebAuthenticationToken;
        if (!token) {
          replacement = { ...stored, uncertain: true };
          if (!result.error) effectiveResult = { ...result, error: { code: "authenticationUncertain", message: "The rotating CloudKit user session did not yield a durable replacement token.", execution: "completed", sessionEffect: "uncertain", retryable: false, retryConditions: [], nextStep: "Reauthenticate this profile before another request." } };
        } else {
          const response = typeof result.body === "object" && result.body !== null ? result.body as Record<string, unknown> : {};
          const observedPrincipal = operation === "probeCurrentUser" && typeof response.userRecordName === "string" && response.userRecordName.length <= 1024 ? response.userRecordName : stored.principalRecordName;
          const accountSwitched = stored.principalRecordName !== undefined
            && observedPrincipal !== undefined
            && observedPrincipal !== stored.principalRecordName;
          replacement = {
            ...stored,
            webAuthenticationToken: token,
            generation: stored.generation + 1,
            uncertain: accountSwitched,
            ...(accountSwitched || observedPrincipal === undefined ? {} : { principalRecordName: observedPrincipal }),
          };
          if (accountSwitched) {
            effectiveResult = {
              ...result,
              error: {
                code: "authenticationUncertain",
                message: "The authenticated CloudKit account no longer matches the principal bound to this credential slot.",
                execution: "completed",
                sessionEffect: "uncertain",
                retryable: false,
                retryConditions: [],
                nextStep: "Reauthenticate and import the intended account into this profile before another request.",
              },
            };
          }
        }
      }
      const resolvedView = this.resolveView(profile, scope, replacement ?? stored);
      return { value: { ...effectiveResult, resolvedView }, ...(replacement ? { replacement } : {}) };
    });
    if (outcome.error) throw new CloudKitMCPError(outcome.error);
    return outcome;
  }

  /** Reads the current principal epoch for local handle validation without contacting Apple. */
  async currentView(profile: Profile, scope: DatabaseScope): Promise<ResolvedView> {
    return this.resolveView(profile, scope, await this.store.read(profile.credentialRef));
  }

  /** Builds a principal-bound view without exposing the raw principal record name. */
  resolveView(profile: Profile, scope: DatabaseScope, credential: StoredCredential): ResolvedView {
    const principalEpoch = credential.class === "web-user" ? credential.principalEpoch : `credential-generation-${credential.generation}`;
    const principalInput = credential.class === "web-user" && credential.principalRecordName ? credential.principalRecordName : `${profile.credentialRef}:${principalEpoch}`;
    const principalAlias = createHmac("sha256", this.#aliasSecret).update(`${profile.containerId}\0${principalInput}`).digest("base64url").slice(0, 20);
    return { profileId: profile.id, containerId: profile.containerId, environment: profile.environment, scope, backend: profile.backend, principalAlias: `account_${principalAlias}`, principalEpoch, principalBound: credential.class !== "web-user" || credential.principalRecordName !== undefined && credential.uncertain !== true };
  }

  /** Produces a process-local keyed alias for a provider identity. */
  alias(kind: "account" | "owner", containerId: string, identity: string): string {
    return `${kind}_${createHmac("sha256", this.#aliasSecret).update(`${containerId}\0${identity}`).digest("base64url").slice(0, 20)}`;
  }
}

function validateCredentialClass(profile: Profile, stored: StoredCredential): void {
  const expected = profile.authenticationMode;
  if (stored.class !== expected) {
    throw safeError({ code: "authenticationRequired", message: "The stored credential class does not match the immutable profile.", execution: "notStarted", sessionEffect: "unchanged", retryable: false, retryConditions: [], nextStep: "Remove the selected slot and import the exact configured credential class." });
  }
  if (stored.class === "web-user" && stored.uncertain === true) {
    throw safeError({ code: "authenticationUncertain", message: "The stored rotating user session is marked uncertain.", execution: "notStarted", sessionEffect: "uncertain", retryable: false, retryConditions: [], nextStep: "Reauthenticate and import a fresh web-authentication token before another request." });
  }
}
