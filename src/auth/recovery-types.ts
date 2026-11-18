/** Public recovery state; no provider values or browser URLs cross this boundary. */
export type RecoveryState = "idle" | "starting" | "awaitingUser" | "verifying" | "succeeded" | "cancelled" | "failed" | "manualRequired";

export interface RecoveryStatus {
  readonly state: RecoveryState;
  readonly attemptId?: string;
  readonly reason?: RecoveryReason;
  readonly nextStep: string;
}

export type RecoveryReason = "manualMode" | "missingConfiguration" | "principalUnbound" | "principalMismatch" | "configurationMismatch" | "browserUnavailable" | "authorizationFailed" | "invalidCallback" | "verificationFailed" | "storageFailed" | "timedOut" | "interrupted" | "superseded" | "operatorCancelled" | "localRepairRequired";

/** Persisted reservation, protected by the same owner-only slot and lease as credentials. */
export interface RecoveryReservation {
  readonly attemptId: string;
  readonly profileId: string;
  readonly ownerPid: number;
  readonly ownerHost: string;
  readonly expiresAt: number;
  readonly state: Exclude<RecoveryState, "idle" | "manualRequired">;
  readonly reason?: RecoveryReason;
}

export function recoveryActive(state: RecoveryState): boolean {
  return state === "starting" || state === "awaitingUser" || state === "verifying";
}

export function recoveryStatus(state: RecoveryState, attemptId?: string, reason?: RecoveryReason): RecoveryStatus {
  const nextStep = state === "succeeded" ? "The session is usable. Retry a notStarted read once; completed or uncertain reads require a fresh observation."
    : recoveryActive(state) ? "Complete Apple sign-in in the local browser, then call recover_session with action status. Read cloudkit://troubleshooting for Console inspection."
    : state === "idle" ? "No recovery is active. Use probe_access to check the session."
    : state === "manualRequired" ? "Use hidden-terminal auth import and probe_access. Read cloudkit://troubleshooting; Act As iCloud Account can answer immediate Console inspection questions."
    : "The session remains unavailable. Inspect the safe reason, then explicitly start recovery again or use auth import. Read cloudkit://troubleshooting.";
  return { state, ...(attemptId ? { attemptId } : {}), ...(reason ? { reason } : {}), nextStep };
}

/** Internal failure carrying only an enumerated reason. */
export class RecoveryFailure extends Error {
  constructor(readonly reason: RecoveryReason) { super(reason); }
}
