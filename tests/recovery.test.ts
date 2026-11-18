import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { once } from "node:events";
import test, { type TestContext } from "node:test";
import { CloudKitTransport } from "../src/api/transport.js";
import { bindWebCredential, CredentialStore, webSessionUsable, type WebUserCredential } from "../src/auth/credential-store.js";
import { RecoveryCoordinator } from "../src/auth/recovery.js";
import { RecoveryFailure } from "../src/auth/recovery-types.js";
import type { RecoveryProvider } from "../src/auth/post-message.js";
import { SessionManager } from "../src/auth/session.js";
import { HandleRegistry } from "../src/state/handles.js";
import type { Profile } from "../src/domain/types.js";

const profile: Profile = { id: "owner", containerId: "iCloud.com.example", environment: "development", backend: "web-services", authenticationMode: "web-user", credentialRef: "owner", allowedScopes: ["private"], recordPolicy: { allowedTypes: [], queryableFields: [], readablePayloadFields: [], discloseRecordNames: false, discloseZoneNames: false } };
const seed: WebUserCredential = { schemaVersion: 1, class: "web-user", apiToken: "synthetic-api", webAuthenticationToken: "synthetic-consumed", generation: 7, principalEpoch: "original-epoch", principalRecordName: "synthetic-principal", uncertain: true };

async function fixture(context: TestContext, input = seed) {
  const root = await mkdtemp(join(tmpdir(), "cloudkit-recovery-"));
  const cleanups: Array<() => void | Promise<unknown>> = [];
  const onCleanup = (cleanup: () => void | Promise<unknown>): void => { cleanups.push(cleanup); };
  context.after(async () => {
    // Recovery can still write while closing, so drain resources before removing their store.
    for (const cleanup of cleanups) await cleanup();
    await rm(root, { recursive: true, force: true });
  });
  const store = new CredentialStore(root); await store.write("owner", input);
  return { root, store, onCleanup };
}

function handoff() {
  const token = Promise.withResolvers<{ token: string }>(); let calls = 0;
  const provider: RecoveryProvider = { authorize: async (_profile, _credential, signal, awaiting) => {
    calls += 1; await awaiting();
    return new Promise((resolve, reject) => {
      const abort = () => reject(new RecoveryFailure("interrupted"));
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
      void token.promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
    });
  } };
  return { provider, token, calls: () => calls };
}

function verifier(principal = "synthetic-principal", replacement = true) {
  let calls = 0;
  const transport = new CloudKitTransport(async (input) => {
    calls += 1; const url = new URL(input);
    assert.equal(url.searchParams.get("ckSession"), "synthetic-fresh");
    return new Response(JSON.stringify({ userRecordName: principal, ...(replacement ? { ckWebAuthToken: "synthetic-replacement" } : {}) }));
  });
  return { transport, calls: () => calls };
}

async function state(coordinator: RecoveryCoordinator, expected: string) {
  let observed;
  for (let i = 0; i < 200; i++) {
    const status = await coordinator.status(profile);
    observed = status;
    if (status.state === expected) return status;
    await new Promise((done) => setTimeout(done, 5));
  }
  assert.fail(`Recovery did not reach ${expected}; last status: ${JSON.stringify(observed)}`);
}

test("recovery coalesces stores and processes, hands off sign-in, verifies and commits the replacement", async (context) => {
  const { root, store, onCleanup } = await fixture(context); const flow = handoff(); const remote = verifier();
  const first = new RecoveryCoordinator(store, remote.transport, flow.provider);
  const second = new RecoveryCoordinator(new CredentialStore(root), remote.transport, flow.provider);
  onCleanup(() => Promise.all([first.close(), second.close()]));
  const statuses = await Promise.all([first.start(profile), second.start(profile)]);
  assert.equal(statuses[0].attemptId, statuses[1].attemptId);
  await state(first, "awaitingUser"); assert.equal(flow.calls(), 1);
  const moduleURL = new URL("../src/auth/recovery.ts", import.meta.url).href;
  const storeURL = new URL("../src/auth/credential-store.ts", import.meta.url).href;
  const transportURL = new URL("../src/api/transport.ts", import.meta.url).href;
  const script = `import {RecoveryCoordinator} from ${JSON.stringify(moduleURL)}; import {CredentialStore} from ${JSON.stringify(storeURL)}; import {CloudKitTransport} from ${JSON.stringify(transportURL)}; const c=new RecoveryCoordinator(new CredentialStore(process.argv[1]),new CloudKitTransport(),{authorize:async()=>{throw Error('duplicate provider')}}); console.log(JSON.stringify(await c.start(${JSON.stringify(profile)}))); await c.close();`;
  const child = await promisify(execFile)(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script, root]);
  assert.equal(JSON.parse(child.stdout).attemptId, statuses[0].attemptId);
  assert.equal((await store.status("owner")).usable, false);
  const quarantined = await store.read("owner"); assert.equal(quarantined.class === "web-user" && quarantined.webAuthenticationToken, undefined);
  flow.token.resolve({ token: "synthetic-fresh" });
  await state(first, "succeeded");
  const saved = await store.read("owner"); assert.equal(saved.class, "web-user"); if (saved.class !== "web-user") return;
  assert.equal(saved.schemaVersion, 2); assert.equal(saved.webAuthenticationToken, "synthetic-replacement");
  assert.equal(saved.principalEpoch, seed.principalEpoch); assert.equal(saved.principalRecordName, seed.principalRecordName); assert.equal(saved.generation, 8);
  assert.equal(webSessionUsable(saved), true); assert.equal(remote.calls(), 1);
  const publicStatus = JSON.stringify(await first.status(profile));
  for (const privateValue of [seed.apiToken, seed.principalRecordName!, "synthetic-fresh", "synthetic-replacement", "https:"]) assert.equal(publicStatus.includes(privateValue), false);
});

test("automatic recovery preserves notStarted versus dispatched execution and never replays a read", async (context) => {
  const { store, onCleanup } = await fixture(context); const flow = handoff(); const remote = verifier();
  const coordinator = new RecoveryCoordinator(store, remote.transport, flow.provider); onCleanup(() => coordinator.close());
  const sessions = new SessionManager(store, remote.transport, coordinator);
  await assert.rejects(sessions.execute(profile, "private", "lookupRecords", {}), (error: any) => {
    assert.equal(error.details.execution, "notStarted"); assert.equal(error.details.recovery.requestRetry, "retryNotStartedOnce"); return true;
  });
  await state(coordinator, "awaitingUser");
  flow.token.resolve({ token: "synthetic-fresh" }); await state(coordinator, "succeeded"); assert.equal(remote.calls(), 1);
  const secondFlow = handoff(); const failure = new CloudKitTransport(async () => { throw new Error("synthetic private provider value"); });
  const next = new RecoveryCoordinator(store, failure, secondFlow.provider); onCleanup(() => next.close());
  await assert.rejects(new SessionManager(store, failure, next).execute(profile, "private", "lookupRecords", {}), (error: any) => {
    assert.equal(error.details.execution, "uncertain"); assert.equal(error.details.recovery.requestRetry, "freshObservationRequired");
    assert.equal(JSON.stringify(error.details).includes("synthetic private provider value"), false); return true;
  });
  await state(next, "awaitingUser");
});

for (const scenario of ["principalMismatch", "verificationFailed"] as const) test(`${scenario} leaves the intended binding suspended and requires explicit restart`, async (context) => {
  const { store, onCleanup } = await fixture(context); const flow = handoff();
  const remote = verifier(scenario === "principalMismatch" ? "different-synthetic-principal" : "synthetic-principal", scenario !== "verificationFailed");
  const coordinator = new RecoveryCoordinator(store, remote.transport, flow.provider); onCleanup(() => coordinator.close());
  await coordinator.start(profile); await state(coordinator, "awaitingUser"); flow.token.resolve({ token: "synthetic-fresh" });
  assert.equal((await state(coordinator, "failed")).reason, scenario);
  const saved = await store.read("owner"); assert.equal(saved.class === "web-user" && saved.principalRecordName, seed.principalRecordName); assert.equal((await store.status("owner")).usable, false);
  const again = await coordinator.start(profile, false); assert.equal(again.state, "failed"); assert.equal(flow.calls(), 1);
  const restarted = await coordinator.start(profile); assert.notEqual(restarted.attemptId, again.attemptId);
});

test("cancellation is bound to the selected slot and closes the running attempt", async (context) => {
  const { store, onCleanup } = await fixture(context); const flow = handoff(); const remote = verifier();
  const coordinator = new RecoveryCoordinator(store, remote.transport, flow.provider); onCleanup(() => coordinator.close());
  const started = await coordinator.start(profile); await state(coordinator, "awaitingUser");
  await assert.rejects(coordinator.cancel(profile, undefined)); await assert.rejects(coordinator.cancel(profile, "a".repeat(36)));
  assert.equal((await coordinator.cancel(profile, started.attemptId)).state, "cancelled");
  flow.token.resolve({ token: "synthetic-fresh" }); await coordinator.close();
  assert.equal((await coordinator.status(profile)).state, "cancelled"); assert.equal(remote.calls(), 0); assert.equal((await store.status("owner")).usable, false);
});

test("status stays responsive and local cancellation interrupts an in-flight verification", { timeout: 5_000 }, async (context) => {
  const { store, onCleanup } = await fixture(context); const flow = handoff();
  const dispatched = Promise.withResolvers<void>();
  const remote = new CloudKitTransport(async (_input, init) => {
    dispatched.resolve();
    return new Promise<Response>((_resolve, reject) => init!.signal!.addEventListener("abort", () => reject(new Error("synthetic aborted probe")), { once: true }));
  });
  const coordinator = new RecoveryCoordinator(store, remote, flow.provider); onCleanup(() => coordinator.close());
  const started = await coordinator.start(profile); await state(coordinator, "awaitingUser"); flow.token.resolve({ token: "synthetic-fresh" });
  await dispatched.promise;
  assert.equal((await coordinator.status(profile)).state, "verifying");
  assert.equal((await coordinator.cancel(profile, started.attemptId)).state, "cancelled");
  assert.equal((await store.status("owner")).usable, false);
});

test("recovery deadline closes human handoff and leaves a terminal safe status", async (context) => {
  const { store, onCleanup } = await fixture(context); const flow = handoff();
  const coordinator = new RecoveryCoordinator(store, verifier().transport, flow.provider, 100); onCleanup(() => coordinator.close());
  await coordinator.start(profile); const result = await state(coordinator, "failed"); assert.equal(result.reason, "timedOut");
  assert.equal((await store.status("owner")).usable, false);
});

for (const change of ["import", "remove"] as const) test(`a newer ${change} wins over a late callback`, async (context) => {
  const { store, onCleanup } = await fixture(context); const flow = handoff(); const remote = verifier();
  const coordinator = new RecoveryCoordinator(store, remote.transport, flow.provider); onCleanup(() => coordinator.close());
  await coordinator.start(profile); await state(coordinator, "awaitingUser");
  if (change === "import") await store.importCredential("owner", { ...seed, uncertain: false, principalEpoch: "new-epoch", webAuthenticationToken: "new-import" });
  else await store.remove("owner");
  flow.token.resolve({ token: "synthetic-fresh" }); await coordinator.close();
  if (change === "import") { const saved = await store.read("owner"); assert.equal(saved.class === "web-user" && saved.principalEpoch, "new-epoch"); }
  else assert.equal((await store.status("owner")).available, false);
  assert.equal(remote.calls(), 0);
});

test("interrupted final storage retains configuration, removes the token and does not claim success", async (context) => {
  const { root, onCleanup } = await fixture(context); const store = new CredentialStore(root, async () => { throw new Error("synthetic filesystem detail"); });
  const flow = handoff(); const coordinator = new RecoveryCoordinator(store, verifier().transport, flow.provider); onCleanup(() => coordinator.close());
  await coordinator.start(profile); await state(coordinator, "awaitingUser"); flow.token.resolve({ token: "synthetic-fresh" });
  assert.equal((await state(coordinator, "failed")).reason, "storageFailed");
  const saved = await new CredentialStore(root).read("owner"); assert.equal(saved.class, "web-user"); if (saved.class !== "web-user") return;
  assert.equal(saved.apiToken, seed.apiToken); assert.equal(saved.principalRecordName, seed.principalRecordName); assert.equal(saved.webAuthenticationToken, undefined);
  assert.equal(webSessionUsable(saved), false);
});

test("a killed rotating request leaves durable suspension and its proven-dead lease can be reclaimed", { timeout: 10_000 }, async (context) => {
  const { root, store, onCleanup } = await fixture(context, { ...seed, uncertain: false });
  const url = (name: string) => new URL(`../src/${name}.ts`, import.meta.url).href;
  const script = `import {SessionManager} from ${JSON.stringify(url("auth/session"))}; import {CredentialStore} from ${JSON.stringify(url("auth/credential-store"))}; import {CloudKitTransport} from ${JSON.stringify(url("api/transport"))}; const t=new CloudKitTransport(async()=>{process.stdout.write('dispatched\\n'); await new Promise(()=>setInterval(()=>{},1000)); return new Response('{}')}); await new SessionManager(new CredentialStore(process.argv[1]),t).execute(${JSON.stringify(profile)},'private','lookupRecords',{});`;
  const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script, root], { stdio: ["ignore", "pipe", "pipe"] });
  onCleanup(async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = once(child, "exit"); child.kill("SIGKILL"); await exited;
  });
  const dispatched = await once(child.stdout!, "data"); assert.match(String(dispatched[0]), /dispatched/);
  const exiting = once(child, "exit"); child.kill("SIGKILL"); await exiting;
  const suspended = await store.read("owner"); assert.equal(suspended.class === "web-user" && suspended.webAuthenticationToken, undefined);
  const flow = handoff(); const coordinator = new RecoveryCoordinator(store, verifier().transport, flow.provider); onCleanup(() => coordinator.close());
  await coordinator.start(profile); await state(coordinator, "awaitingUser"); flow.token.resolve({ token: "synthetic-fresh" }); await state(coordinator, "succeeded");
});

test("same-account recovery preserves handle context while explicit import changes its epoch", async (context) => {
  const { store, onCleanup } = await fixture(context); const flow = handoff(); const remote = verifier();
  const coordinator = new RecoveryCoordinator(store, remote.transport, flow.provider); onCleanup(() => coordinator.close());
  const sessions = new SessionManager(store, remote.transport, coordinator); const handles = new HandleRegistry();
  const handleContext = { profileId: profile.id, containerId: profile.containerId, environment: profile.environment, scope: "private" as const, backend: profile.backend, principalEpoch: seed.principalEpoch, operation: "test", selectorDigest: "selector" };
  const handle = handles.issue("test", handleContext, "synthetic-cursor");
  await coordinator.start(profile); await state(coordinator, "awaitingUser"); flow.token.resolve({ token: "synthetic-fresh" }); await state(coordinator, "succeeded");
  assert.equal(handles.resolve(handle, { ...handleContext, principalEpoch: (await sessions.currentView(profile, "private")).principalEpoch }), "synthetic-cursor");
  await store.importCredential("owner", bindWebCredential({ ...seed, uncertain: false, principalEpoch: "explicitly-changed-epoch" }, profile));
  assert.throws(() => handles.resolve(handle, { ...handleContext, principalEpoch: "explicitly-changed-epoch" }), /does not belong/);
});

test("manual-only, unbound and incompatible configurations never launch a browser", async (context) => {
  const { store, onCleanup } = await fixture(context); const remote = verifier(); const flow = handoff();
  const manual = new RecoveryCoordinator(store, remote.transport); assert.equal((await manual.start(profile)).reason, "manualMode");
  const automatic = new RecoveryCoordinator(store, remote.transport, flow.provider); onCleanup(() => automatic.close());
  await store.importCredential("owner", { schemaVersion: 1, class: "web-user", apiToken: "synthetic-api", webAuthenticationToken: "synthetic-token", generation: 0, principalEpoch: "unbound", uncertain: true });
  assert.equal((await automatic.start(profile)).reason, "principalUnbound");
  await store.importCredential("owner", bindWebCredential(seed, { ...profile, environment: "production" }));
  assert.equal((await automatic.start(profile)).reason, "configurationMismatch"); assert.equal(flow.calls(), 0);
});
