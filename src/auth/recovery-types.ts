/** Public recovery state; no provider values or browser URLs cross this boundary. */
export type RecoveryState = "idle" | "starting" | "awaitingUser" | "verifying" | "succeeded" | "cancelled" | "failed" | "manualRequired";

export interface RecoveryStatus {
  readonly state: RecoveryState;
  readonly attemptId?: string;
  readonly reason?: RecoveryReason;
  readonly callbackOrigin?: CallbackOrigin;
  readonly callbackHost?: string;
  readonly nextStep: string;
}

export type RecoveryReason = "manualMode" | "missingConfiguration" | "principalUnbound" | "principalMismatch" | "configurationMismatch" | "browserUnavailable" | "authorizationFailed" | "invalidCallback" | "callbackOriginMismatch" | "verificationFailed" | "storageFailed" | "timedOut" | "interrupted" | "superseded" | "operatorCancelled" | "localRepairRequired";
export const callbackOriginClasses = ["cloudkitApi", "cloudkitCdn", "appleSignIn", "icloudWeb", "appleId", "appleAccount", "developerConsole", "localPage", "opaque", "other"] as const;
export type CallbackOrigin = (typeof callbackOriginClasses)[number];

/** Persisted reservation, protected by the same owner-only slot and lease as credentials. */
export interface RecoveryReservation {
  readonly attemptId: string;
  readonly profileId: string;
  readonly ownerPid: number;
  readonly ownerHost: string;
  readonly expiresAt: number;
  readonly state: Exclude<RecoveryState, "idle" | "manualRequired">;
  readonly reason?: RecoveryReason;
  readonly callbackOrigin?: CallbackOrigin;
  readonly callbackHost?: string;
}

export function recoveryActive(state: RecoveryState): boolean {
  return state === "starting" || state === "awaitingUser" || state === "verifying";
}

export function recoveryStatus(state: RecoveryState, attemptId?: string, reason?: RecoveryReason, callbackOrigin?: CallbackOrigin, callbackHost?: string): RecoveryStatus {
  const nextStep = state === "succeeded" ? "The session is usable. Retry a notStarted read once; completed or uncertain reads require a fresh observation."
    : recoveryActive(state) ? "Complete Apple sign-in in the local browser, then call recover_session with action status. Read cloudkit://troubleshooting for Console inspection."
    : state === "idle" ? "No recovery is active. Use probe_access to check the session."
    : state === "manualRequired" ? "Use hidden-terminal auth import and probe_access. Read cloudkit://troubleshooting; Act As iCloud Account can answer immediate Console inspection questions."
    : "The session remains unavailable. Inspect the safe reason, then explicitly start recovery again or use auth import. Read cloudkit://troubleshooting.";
  return { state, ...(attemptId ? { attemptId } : {}), ...(reason ? { reason } : {}), ...(callbackOrigin ? { callbackOrigin } : {}), ...(callbackHost && publicAppleHost(callbackHost) ? { callbackHost } : {}), nextStep };
}

/** Internal failure carrying only an enumerated reason. */
export class RecoveryFailure extends Error {
  constructor(readonly reason: RecoveryReason, readonly callbackOrigin?: CallbackOrigin, readonly callbackHost?: string) { super(reason); }
}

/** Diagnostic hostnames contain no scheme, port, path, query, credentials, or dynamic numeric labels. */
export function publicAppleHost(value: unknown): value is string {
  return typeof value === "string" && value.length <= 255 && /^[a-z.-]+\.(?:apple|icloud|cdn-apple|apple-cloudkit)\.com$/.test(value);
}
