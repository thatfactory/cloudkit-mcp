import { randomBytes } from "node:crypto";
import { hostname } from "node:os";
import type { Profile } from "../domain/types.js";
import { CloudKitTransport, type TransportResult } from "../api/transport.js";
import { safeError } from "../errors.js";
import { bindWebCredential, CredentialStore, reservationStatus, suspendWebSession, webSessionUsable, type WebUserCredential } from "./credential-store.js";
import type { RecoveryProvider } from "./post-message.js";
import { recoveryActive, RecoveryFailure, recoveryStatus, type RecoveryReason, type RecoveryReservation, type RecoveryStatus } from "./recovery-types.js";

interface RunningRecovery { readonly attemptId: string; readonly controller: AbortController; readonly done: Promise<void> }

/** Coordinates short durable reservations, never a credential lease held over human sign-in. */
export class RecoveryCoordinator {
  readonly #running = new Map<string, RunningRecovery>();
  readonly #storageFailures = new Map<string, RecoveryStatus>();
  #closed = false;

  constructor(
    private readonly store: CredentialStore,
    private readonly transport: CloudKitTransport,
    private readonly provider?: RecoveryProvider,
    private readonly deadlineMilliseconds = 10 * 60 * 1000,
  ) {}

  get mode(): "post-message" | "manual" { return this.provider ? "post-message" : "manual"; }

  async status(profile: Profile): Promise<RecoveryStatus> {
    if (profile.authenticationMode !== "web-user" || !this.provider) return recoveryStatus("manualRequired", undefined, "manualMode");
    try {
      // Atomic snapshots keep status responsive while verification owns the credential lease.
      const stored = await this.store.read(profile.credentialRef);
      if (stored.class !== "web-user") return recoveryStatus("manualRequired", undefined, "missingConfiguration");
      try { bindWebCredential(stored, profile); } catch { return recoveryStatus("manualRequired", undefined, "configurationMismatch"); }
      return stored.recovery ? reservationStatus(stored.recovery) : recoveryStatus("idle");
    } catch { return this.#storageFailures.get(profile.credentialRef) ?? recoveryStatus("manualRequired", undefined, "localRepairRequired"); }
  }

  async start(profile: Profile, explicit = true): Promise<RecoveryStatus> {
    if (this.#closed) return recoveryStatus("failed", undefined, "interrupted");
    if (profile.authenticationMode !== "web-user" || !this.provider) return recoveryStatus("manualRequired", undefined, "manualMode");
    let launch: { seed: WebUserCredential; reservation: RecoveryReservation } | undefined;
    try {
      const status = await this.store.withLock(profile.credentialRef, async () => {
        let stored;
        try { stored = await this.store.read(profile.credentialRef); }
        catch { return recoveryStatus("manualRequired", undefined, "missingConfiguration"); }
        if (stored.class !== "web-user") return recoveryStatus("manualRequired", undefined, "missingConfiguration");
        let credential;
        try { credential = bindWebCredential(stored, profile); }
        catch { return recoveryStatus("manualRequired", undefined, "configurationMismatch"); }
        if (credential.recovery) {
          const previous = reservationStatus(credential.recovery);
          if (recoveryActive(previous.state)) return previous;
          if (!explicit && previous.state !== "succeeded") return previous;
        }
        if (webSessionUsable(credential)) return credential.recovery ? reservationStatus(credential.recovery) : recoveryStatus("idle");
        if (!credential.principalRecordName) return recoveryStatus("manualRequired", undefined, "principalUnbound");
        const reservation: RecoveryReservation = { attemptId: randomBytes(18).toString("hex"), profileId: profile.id, ownerPid: process.pid, ownerHost: hostname(), expiresAt: Date.now() + this.deadlineMilliseconds, state: "starting" };
        const seed = { ...suspendWebSession(credential), recovery: reservation };
        await this.store.write(profile.credentialRef, seed);
        this.#storageFailures.delete(profile.credentialRef);
        launch = { seed, reservation };
        return recoveryStatus("starting", reservation.attemptId);
      });
      if (launch) {
        const controller = new AbortController();
        const { seed, reservation } = launch;
        const done = Promise.resolve().then(() => this.#run(profile, seed, reservation, controller));
        this.#running.set(profile.credentialRef, { attemptId: reservation.attemptId, controller, done });
        void done.finally(() => { if (this.#running.get(profile.credentialRef)?.attemptId === reservation.attemptId) this.#running.delete(profile.credentialRef); });
      }
      return status;
    } catch { return recoveryStatus("manualRequired", undefined, "localRepairRequired"); }
  }

  async cancel(profile: Profile, attemptId: string | undefined): Promise<RecoveryStatus> {
    if (!attemptId) throw safeError({ code: "invalidInput", message: "Cancellation requires the active recovery attempt identifier.", execution: "notStarted", sessionEffect: "unchanged", retryable: false, retryConditions: [], nextStep: "Call recover_session with action status, then cancel that attempt." });
    const snapshot = await this.store.read(profile.credentialRef);
    if (snapshot.class === "web-user") {
      bindWebCredential(snapshot, profile);
      const local = this.#running.get(profile.credentialRef);
      if (snapshot.recovery?.attemptId === attemptId && local?.attemptId === attemptId) local.controller.abort("operatorCancelled");
    }
    const status = await this.store.withLock(profile.credentialRef, async () => {
      const credential = await this.store.read(profile.credentialRef);
      if (credential.class !== "web-user" || credential.recovery?.attemptId !== attemptId) throw safeError({ code: "invalidInput", message: "The recovery attempt does not belong to this credential slot.", execution: "notStarted", sessionEffect: "unchanged", retryable: false, retryConditions: [], nextStep: "Use the current attempt returned for this profile." });
      bindWebCredential(credential, profile);
      if (!recoveryActive(credential.recovery.state)) return reservationStatus(credential.recovery);
      await this.store.write(profile.credentialRef, { ...suspendWebSession(credential), recovery: { ...credential.recovery, state: "cancelled", reason: "operatorCancelled" } });
      return recoveryStatus("cancelled", attemptId, "operatorCancelled");
    });
    const running = this.#running.get(profile.credentialRef);
    if (running?.attemptId === attemptId) running.controller.abort("operatorCancelled");
    return status;
  }

  async close(): Promise<void> {
    this.#closed = true;
    const running = [...this.#running.values()];
    for (const attempt of running) attempt.controller.abort("interrupted");
    await Promise.allSettled(running.map((attempt) => attempt.done));
  }

  async #run(profile: Profile, seed: WebUserCredential, reservation: RecoveryReservation, controller: AbortController): Promise<void> {
    const expire = setTimeout(() => controller.abort("timedOut"), Math.max(0, reservation.expiresAt - Date.now()));
    let monitoring = false;
    const monitor = setInterval(() => {
      if (monitoring || controller.signal.aborted) return;
      monitoring = true;
      void this.store.read(profile.credentialRef).then((current) => {
        if (!sameAttempt(current, seed, reservation) || !recoveryActive(current.recovery!.state)) controller.abort("superseded");
      }).catch(() => controller.abort("superseded")).finally(() => { monitoring = false; });
    }, 500);
    monitor.unref(); expire.unref();
    try {
      const result = await this.provider!.authorize(profile, seed, controller.signal, async () => {
        await this.#update(profile, seed, reservation, "awaitingUser");
      });
      if (controller.signal.aborted) throw new RecoveryFailure(abortReason(controller));
      await this.#update(profile, seed, reservation, "verifying");
      await this.store.withLock(profile.credentialRef, async () => {
        const current = await this.store.read(profile.credentialRef);
        if (!sameAttempt(current, seed, reservation) || !recoveryActive(current.recovery!.state)) throw new RecoveryFailure("superseded");
        let verified: TransportResult;
        try { verified = await this.transport.execute("probeCurrentUser", { containerId: profile.containerId, environment: profile.environment, scope: profile.allowedScopes[0]! }, { mode: "web-user", apiToken: current.apiToken, webAuthenticationToken: result.token }, {}, controller.signal, result.origin); }
        catch { throw new RecoveryFailure("verificationFailed"); }
        if (controller.signal.aborted || Date.now() >= reservation.expiresAt) throw new RecoveryFailure(Date.now() >= reservation.expiresAt ? "timedOut" : abortReason(controller));
        const body = verified.body as { userRecordName?: unknown; serverErrorCode?: unknown } | null;
        if (verified.error || !body || body.serverErrorCode || typeof body.userRecordName !== "string" || body.userRecordName.length < 1 || body.userRecordName.length > 1024 || !verified.replacementWebAuthenticationToken) throw new RecoveryFailure("verificationFailed");
        if (body.userRecordName !== seed.principalRecordName) throw new RecoveryFailure("principalMismatch");
        await this.store.commitReplacement(profile.credentialRef, { ...current, sessionState: "ready", uncertain: false, webAuthenticationToken: verified.replacementWebAuthenticationToken, generation: current.generation + 1, recovery: { ...current.recovery!, state: "succeeded" } }, current);
        this.#storageFailures.delete(profile.credentialRef);
      });
    } catch (error) {
      const reason = controller.signal.aborted ? abortReason(controller) : error instanceof RecoveryFailure ? error.reason : "storageFailed";
      try { await this.#update(profile, seed, reservation, reason === "operatorCancelled" ? "cancelled" : "failed", reason); }
      catch (failure) { if (!(failure instanceof RecoveryFailure && failure.reason === "superseded")) this.#storageFailures.set(profile.credentialRef, recoveryStatus("failed", reservation.attemptId, "storageFailed")); }
    } finally { clearTimeout(expire); clearInterval(monitor); }
  }

  async #update(profile: Profile, seed: WebUserCredential, reservation: RecoveryReservation, state: RecoveryReservation["state"], reason?: RecoveryReason): Promise<void> {
    await this.store.withLock(profile.credentialRef, async () => {
      const current = await this.store.read(profile.credentialRef);
      if (!sameAttempt(current, seed, reservation) || !recoveryActive(current.recovery!.state)) throw new RecoveryFailure("superseded");
      await this.store.write(profile.credentialRef, { ...suspendWebSession(current), recovery: { ...current.recovery!, state, ...(reason ? { reason } : {}) } });
    });
  }
}

function sameAttempt(current: import("./credential-store.js").StoredCredential, seed: WebUserCredential, reservation: RecoveryReservation): current is WebUserCredential {
  return current.class === "web-user" && current.recovery?.attemptId === reservation.attemptId && current.principalEpoch === seed.principalEpoch && current.generation === seed.generation && current.apiToken === seed.apiToken && current.principalRecordName === seed.principalRecordName && current.binding?.containerId === seed.binding?.containerId && current.binding?.environment === seed.binding?.environment;
}

function abortReason(controller: AbortController): RecoveryReason {
  return ["operatorCancelled", "superseded", "timedOut"].includes(String(controller.signal.reason)) ? controller.signal.reason as RecoveryReason : "interrupted";
}
