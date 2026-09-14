import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CloudKitTransport } from "../src/api/transport.js";
import { CredentialStore } from "../src/auth/credential-store.js";
import { SessionManager } from "../src/auth/session.js";
import { parseProfilesDocument } from "../src/config/profiles.js";
import { DiagnosticService } from "../src/diagnostics/service.js";
import { CloudKitMCPError } from "../src/errors.js";
import { HandleRegistry } from "../src/state/handles.js";

const ownerView = { profileId: "owner", scope: "private" as const };
const sharedView = { profileId: "participant", scope: "shared" as const };
const zone = { zoneName: "Inventory", ownerRecordName: "owner-principal" };

test("database changes preserve tombstones, per-zone errors, coverage, and cyclic-token safety", async (context) => {
  let page = 0;
  const service = await makeService(context, (url, body) => {
    assert.equal(url.pathname.endsWith("/changes/database"), true);
    assert.equal((body as { resultsLimit?: number }).resultsLimit, 50);
    const token = ["token-a", "token-b", "token-a"][page++];
    return { zones: [{ zoneID: zone, deleted: true }, { zoneID: { zoneName: "Denied", ownerRecordName: "owner-principal" }, serverErrorCode: "ACCESS_DENIED", reason: "private detail" }], syncToken: token, moreComing: true };
  });
  const first = await service.getDatabaseChanges(ownerView, { kind: "beginning" });
  assert.equal(first.data.coverage, "beginning");
  assert.equal(first.status, "partial");
  assert.equal(first.data.changedZones[0]?.deleted, true);
  assert.equal(first.data.errors[0]?.outcome, "inaccessible");
  assert.equal(JSON.stringify(first).includes("private detail"), false);
  const second = await service.getDatabaseChanges(ownerView, { kind: "cursor", handle: first.data.continuationHandle });
  assert.equal(second.data.coverage, "sinceIssuedCursor");
  await assert.rejects(service.getDatabaseChanges(ownerView, { kind: "cursor", handle: second.data.continuationHandle }), hasCode("malformedResponse"));
});

test("change feeds require documented token and completion shapes and keep cursor kinds distinct", async (context) => {
  for (const body of [{ zones: [], moreComing: false }, { zones: [], syncToken: "token" }, { zones: [], syncToken: "token", moreComing: "false" }]) {
    const service = await makeService(context, () => body);
    await assert.rejects(service.getDatabaseChanges(ownerView, { kind: "beginning" }), hasCode("malformedResponse"));
  }

  const database = await makeService(context, (url) => url.pathname.endsWith("/changes/database")
    ? { zones: [], syncToken: "database-token", moreComing: false }
    : { zones: [{ zoneID: zone, records: [], syncToken: "zone-token", moreComing: false }] });
  const databaseResult = await database.getDatabaseChanges(ownerView, { kind: "beginning" });
  await assert.rejects(database.getZoneChanges(ownerView, zone, { kind: "cursor", handle: databaseResult.data.continuationHandle }), hasCode("cursorContextMismatch"));
  await assert.rejects(database.getDatabaseChanges(ownerView, { kind: "cursor", handle: "raw-provider-token" }), hasCode("cursorInvalid"));
});

test("full database-change pages keep all zones drill-down-capable in a tiny registry", async (context) => {
  let page = 0;
  const handles = new HandleRegistry(Date.now, 3);
  const service = await makeService(context, (url, body) => {
    if (url.pathname.endsWith("/zones/lookup")) return { zones: [{ zoneID: (body as { zones: unknown[] }).zones[0] }] };
    return { zones: Array.from({ length: 50 }, (_, index) => ({ zoneID: { zoneName: `Zone-${page}-${index}`, ownerRecordName: "owner-principal" } })), syncToken: `token-${page += 1}`, moreComing: true };
  }, handles);
  const first = await service.getDatabaseChanges(ownerView, { kind: "beginning" });
  const second = await service.getDatabaseChanges(ownerView, { kind: "cursor", handle: first.data.continuationHandle });
  assert.equal(first.data.changedZones.length, 50);
  assert.equal(second.data.changedZones.length, 50);
  const zoneResult = await service.getZone(ownerView, { handle: second.data.changedZones[49]!.handle });
  assert.equal(zoneResult.data.outcome, "present");
});

test("zone changes validate zone identity, tombstones, required collections, and custom-zone scope", async (context) => {
  let response: unknown = { zones: [{ zoneID: zone, records: [{ recordName: "deleted-record", deleted: true }], syncToken: "zone-token", moreComing: false }] };
  let requests = 0;
  const service = await makeService(context, (_url, body) => {
    requests += 1;
    const request = body as { zones?: Array<{ resultsLimit?: number; desiredKeys?: unknown[]; numberAsStrings?: boolean }> };
    assert.equal(request.zones?.[0]?.resultsLimit, 50);
    assert.deepEqual(request.zones?.[0]?.desiredKeys, []);
    assert.equal(request.zones?.[0]?.numberAsStrings, true);
    return response;
  });
  const result = await service.getZoneChanges(ownerView, zone, { kind: "beginning" });
  assert.equal(result.data.changes[0]?.deleted, "observed");
  assert.equal(result.data.coverage, "beginning");
  assert.ok(result.data.continuationHandle);

  response = { zones: [{ zoneID: { ...zone, zoneName: "Other" }, records: [] }] };
  await assert.rejects(service.getZoneChanges(ownerView, zone, { kind: "beginning" }), hasCode("malformedResponse"));
  response = { zones: [{ zoneID: zone }] };
  await assert.rejects(service.getZoneChanges(ownerView, zone, { kind: "beginning" }), hasCode("malformedResponse"));
  const beforeDefault = requests;
  await assert.rejects(service.getZoneChanges(ownerView, { zoneName: "_defaultZone" }, { kind: "beginning" }), hasCode("unsupportedCapability"));
  assert.equal(requests, beforeDefault);

  response = { zones: [{ zoneID: zone, records: [{ recordName: "record", zoneID: { ...zone, ownerRecordName: "other-owner" } }], syncToken: "zone-token", moreComing: false }] };
  await assert.rejects(service.getZoneChanges(ownerView, zone, { kind: "beginning" }), hasCode("malformedResponse"));
});

test("zone-level errors preserve an issued cursor without claiming completion", async (context) => {
  let call = 0;
  const service = await makeService(context, () => call++ === 0
    ? { zones: [{ zoneID: zone, records: [], syncToken: "zone-token", moreComing: false }] }
    : { zones: [{ zoneID: zone, serverErrorCode: "ACCESS_DENIED" }] });
  const first = await service.getZoneChanges(ownerView, zone, { kind: "beginning" });
  const cursor = first.data.continuationHandle!;
  const failed = await service.getZoneChanges(ownerView, zone, { kind: "cursor", handle: cursor });
  assert.equal(failed.status, "partial");
  assert.equal(failed.data.completion, "notEstablished");
  assert.equal(failed.data.stopReason, "zoneError");
  assert.equal(failed.data.continuationAvailable, true);
  assert.equal(failed.data.continuationHandle, cursor);
  assert.equal("moreComing" in failed.data, false);
});

test("missing share metadata remains canonically unavailable without fallback", async (context) => {
  let lookups = 0;
  const service = await makeService(context, () => { lookups += 1; return { records: [{ recordName: "root" }] }; });
  const result = await service.getShare(ownerView, zone, "root");
  assert.equal(result.status, "unavailable");
  assert.equal(result.data.outcome, "unavailable");
  assert.equal(lookups, 1);
});

test("share projection covers modes and roles without identities, links, or mutation", async (context) => {
  let lookups = 0;
  const service = await makeService(context, (url) => {
    assert.equal(url.pathname.endsWith("/records/lookup"), true);
    lookups += 1;
    if (lookups === 1) return { records: [{ recordName: "root", share: { recordName: "share-record", shortGUID: "must-not-escape" } }] };
    return { records: [{ recordName: "share-record", shareType: "RECORD_HIERARCHY", publicPermission: "READ_ONLY", currentUserParticipant: { type: "USER", userIdentity: { userRecordName: "private-user" } }, participants: [{ type: "OWNER", acceptanceStatus: "INVITED", permission: "READ_WRITE", userIdentity: { lookupInfo: { emailAddress: "private@example.com" } }, webpageURL: "https://example.invalid/share" }] }] };
  });
  const result = await service.getShare(ownerView, zone, "root");
  assert.equal(result.data.outcome, "present");
  assert.equal(result.data.mode, "recordHierarchy");
  assert.equal(result.data.callerRole, "user");
  assert.equal(result.data.publicPermission, "readOnly");
  assert.deepEqual(result.data.participants, [{ role: "owner", acceptanceStatus: "invited", permission: "readWrite" }]);
  assert.equal(JSON.stringify(result).includes("private-user"), false);
  assert.equal(JSON.stringify(result).includes("private@example.com"), false);
  assert.equal(JSON.stringify(result).includes("example.invalid"), false);
  assert.equal(lookups, 2);
});

test("share and subscription malformed or oversized structures fail safely", async (context) => {
  let call = 0;
  const malformedShare = await makeService(context, () => call++ === 0
    ? { records: [{ recordName: "root", share: { recordName: "share-record" } }] }
    : { records: [{ recordName: "share-record", participants: {} }] });
  await assert.rejects(malformedShare.getShare(ownerView, zone, "root"), hasCode("malformedResponse"));

  const wrongRoot = await makeService(context, () => ({ records: [{ recordName: "unexpected", share: { recordName: "share-record" } }] }));
  await assert.rejects(wrongRoot.getShare(ownerView, zone, "root"), hasCode("malformedResponse"));

  call = 0;
  const oversizedShare = await makeService(context, () => call++ === 0
    ? { records: [{ recordName: "root", share: { recordName: "share-record" } }] }
    : { records: [{ recordName: "share-record", participants: Array.from({ length: 101 }, () => ({})) }] });
  await assert.rejects(oversizedShare.getShare(ownerView, zone, "root"), hasCode("responseBoundExceeded"));

  const malformedSubscriptions = await makeService(context, () => ({}));
  await assert.rejects(malformedSubscriptions.listSubscriptions(ownerView), hasCode("malformedResponse"));
});

test("subscriptions expose bounded structure, preserve unknown types, and gate shared scope pre-network", async (context) => {
  let requests = 0;
  const service = await makeService(context, () => {
    requests += 1;
    return { subscriptions: [{ subscriptionType: "database", zoneID: null, query: null }, { subscriptionType: "future-kind", zoneID: zone, query: { recordType: "Entry", predicate: "must-not-escape" }, notificationInfo: { alertBody: "must-not-escape" } }] };
  });
  const result = await service.listSubscriptions(ownerView);
  assert.deepEqual(result.data.subscriptions, [
    { type: "database", zonePresent: false, predicatePresent: false },
    { type: "unknown", zonePresent: true, predicatePresent: true },
  ]);
  assert.equal(JSON.stringify(result).includes("must-not-escape"), false);
  await assert.rejects(service.listSubscriptions(sharedView), hasCode("unverifiedCapability"));
  assert.equal(requests, 1);
});

test("subscription item failures are partial and never expose provider reasons", async (context) => {
  const service = await makeService(context, () => ({ subscriptions: [{ subscriptionType: "zone", zoneID: zone }, { serverErrorCode: "ACCESS_DENIED", reason: "must-not-escape" }] }));
  const result = await service.listSubscriptions(ownerView);
  assert.equal(result.status, "partial");
  assert.equal(result.data.subscriptions.length, 1);
  assert.equal(result.data.errors[0]?.outcome, "inaccessible");
  assert.equal(JSON.stringify(result).includes("must-not-escape"), false);
  assert.match(result.limitations[0] ?? "", /does not establish client/);
});

test("unverified operations fail before credential resolution", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "cloudkit-preflight-"));
  context.after(async () => rm(root, { recursive: true, force: true }));
  let requests = 0;
  const transport = new CloudKitTransport(async () => { requests += 1; return new Response("{}"); });
  const profiles = parseProfilesDocument({ schemaVersion: 1, profiles: [{ id: "participant", containerId: "iCloud.com.example", environment: "development", backend: "web-services", authenticationMode: "web-user", credentialRef: "missing-slot", allowedScopes: ["shared"], recordPolicy: {} }] });
  const service = new DiagnosticService(profiles, new SessionManager(new CredentialStore(root), transport));
  await assert.rejects(service.listSubscriptions(sharedView), hasCode("unverifiedCapability"));
  await assert.rejects(service.listZones(sharedView), hasCode("unverifiedCapability"));
  assert.equal(requests, 0);
});

test("unsupported change and shared zone lookup fail before missing credentials are resolved", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "cloudkit-preflight-missing-"));
  context.after(async () => rm(root, { recursive: true, force: true }));
  let requests = 0;
  const profiles = parseProfilesDocument({ schemaVersion: 1, profiles: [
    { id: "public", containerId: "iCloud.com.example", environment: "development", backend: "web-services", authenticationMode: "api-token-public", credentialRef: "missing-public", allowedScopes: ["public"], recordPolicy: {} },
    { id: "participant", containerId: "iCloud.com.example", environment: "development", backend: "web-services", authenticationMode: "web-user", credentialRef: "missing-shared", allowedScopes: ["shared"], recordPolicy: {} },
  ] });
  const service = new DiagnosticService(profiles, new SessionManager(new CredentialStore(root), new CloudKitTransport(async () => { requests += 1; return new Response("{}"); })));
  await assert.rejects(service.getDatabaseChanges({ profileId: "public", scope: "public" }, { kind: "beginning" }), hasCode("authenticationRequired"));
  await assert.rejects(service.getZone(sharedView, { handle: "opaque-zone-handle" }), hasCode("unverifiedCapability"));
  await assert.rejects(service.readRecordFields(sharedView, { handle: "opaque-zone-handle" }, ["record"], ["unauthorized"]), hasCode("invalidInput"));
  await assert.rejects(service.compareViews(sharedView, sharedView, { zoneName: "Inventory" }, { zoneName: "Inventory" }, ["record"]), hasCode("invalidInput"));
  assert.equal(requests, 0);
});

test("change-feed cancellation is safe before dispatch and uncertain after dispatch", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "cloudkit-change-cancel-"));
  context.after(async () => rm(root, { recursive: true, force: true }));
  const store = new CredentialStore(root);
  await store.write("owner", { schemaVersion: 1, class: "web-user", apiToken: "synthetic-api", webAuthenticationToken: "owner-session", generation: 0, principalEpoch: "owner-epoch", principalRecordName: "owner-principal" });
  let dispatches = 0;
  let markDispatched!: () => void;
  const dispatched = new Promise<void>((resolve) => { markDispatched = resolve; });
  const transport = new CloudKitTransport(async (_input, init) => {
    dispatches += 1;
    markDispatched();
    return new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
  });
  const profiles = parseProfilesDocument({ schemaVersion: 1, profiles: [{ id: "owner", containerId: "iCloud.com.example", environment: "development", backend: "web-services", authenticationMode: "web-user", credentialRef: "owner", allowedScopes: ["private"], recordPolicy: {} }] });
  const service = new DiagnosticService(profiles, new SessionManager(store, transport));

  const before = new AbortController(); before.abort();
  await assert.rejects(service.getDatabaseChanges(ownerView, { kind: "beginning" }, before.signal), (error) => error instanceof CloudKitMCPError && error.details.code === "cancelled" && error.details.execution === "notStarted" && error.details.sessionEffect === "unchanged");
  assert.equal(dispatches, 0);

  const after = new AbortController();
  const request = service.getDatabaseChanges(ownerView, { kind: "beginning" }, after.signal);
  await dispatched; after.abort();
  await assert.rejects(request, (error) => error instanceof CloudKitMCPError && error.details.code === "cancelled" && error.details.execution === "uncertain" && error.details.sessionEffect === "uncertain");
  assert.equal((await store.status("owner")).uncertain, true);
});

test("comparison retains successful evidence when the other authorized view fails", async (context) => {
  const service = await makeService(context, (url, body) => url.pathname.includes("/private/")
    ? { records: (body as { records: Array<{ recordName: string }> }).records.map(({ recordName }) => ({ recordName, recordChangeTag: "tag" })) }
    : { serverErrorCode: "ACCESS_DENIED", reason: "must-not-escape" });
  const result = await service.compareViews(ownerView, sharedView, zone, zone, ["record-a"]);
  assert.equal(result.left.status, "fulfilled");
  assert.equal(result.right.status, "rejected");
  assert.equal(result.right.errorCode, "permissionDenied");
  assert.equal(result.conclusions[0]?.category, "inconclusive");
  assert.equal(JSON.stringify(result).includes("must-not-escape"), false);
});

test("comparison keeps absent-plus-failed and both-failed observations inconclusive", async (context) => {
  let privateFails = false;
  const service = await makeService(context, (url, body) => {
    if (url.pathname.includes("/shared/") || privateFails) return { serverErrorCode: "ACCESS_DENIED" };
    return { records: (body as { records: Array<{ recordName: string }> }).records.map(({ recordName }) => ({ recordName, serverErrorCode: "NOT_FOUND" })) };
  });
  const oneFailed = await service.compareViews(ownerView, sharedView, zone, zone, ["record-a"]);
  assert.equal(oneFailed.conclusions[0]?.category, "inconclusive");
  privateFails = true;
  const bothFailed = await service.compareViews(ownerView, sharedView, zone, zone, ["record-a"]);
  assert.equal(bothFailed.conclusions[0]?.category, "inconclusive");
});

test("comparison treats per-item inaccessible and unknown outcomes as inconclusive", async (context) => {
  for (const serverErrorCode of ["ACCESS_DENIED", "FUTURE_PROVIDER_ERROR"]) {
    const service = await makeService(context, (url, body) => ({ records: (body as { records: Array<{ recordName: string }> }).records.map(({ recordName }) => url.pathname.includes("/private/") ? { recordName, recordChangeTag: "tag" } : { recordName, serverErrorCode }) }));
    const result = await service.compareViews(ownerView, sharedView, zone, zone, ["record-a"]);
    assert.equal(result.conclusions[0]?.category, "inconclusive");
  }
});

test("comparison requires independently corresponding owner-aware zones", async (context) => {
  const service = await makeService(context, (_url, body) => ({ records: (body as { records: Array<{ recordName: string }> }).records.map(({ recordName }) => ({ recordName, recordChangeTag: "tag" })) }));
  const result = await service.compareViews(ownerView, sharedView, zone, { ...zone, ownerRecordName: "different-owner" }, ["record-a"]);
  assert.equal(result.identityMapping, "explicitUnverified");
  assert.equal(result.conclusions[0]?.category, "inconclusive");
  assert.ok(result.observationWindows.left.from <= result.observationWindows.left.to);
  assert.ok(result.observationWindows.right.from <= result.observationWindows.right.to);
});

async function makeService(context: test.TestContext, responder: (url: URL, body: unknown) => unknown, handles?: HandleRegistry): Promise<DiagnosticService> {
  const root = await mkdtemp(join(tmpdir(), "cloudkit-secondary-"));
  context.after(async () => rm(root, { recursive: true, force: true }));
  const store = new CredentialStore(root);
  await store.write("owner", { schemaVersion: 1, class: "web-user", apiToken: "synthetic-api", webAuthenticationToken: "owner-session", generation: 0, principalEpoch: "owner-epoch", principalRecordName: "owner-principal" });
  await store.write("participant", { schemaVersion: 1, class: "web-user", apiToken: "synthetic-api", webAuthenticationToken: "participant-session", generation: 0, principalEpoch: "participant-epoch", principalRecordName: "participant-principal" });
  let generation = 0;
  const transport = new CloudKitTransport(async (input, init) => {
    const body = init?.body ? JSON.parse(Buffer.from(init.body as Uint8Array).toString("utf8")) : {};
    return new Response(JSON.stringify(responder(new URL(input), body)), { status: 200, headers: { "content-type": "application/json", "x-apple-cloudkit-web-auth-token": `replacement-${generation += 1}` } });
  });
  const profiles = parseProfilesDocument({ schemaVersion: 1, profiles: [
    { id: "owner", containerId: "iCloud.com.example", environment: "development", backend: "web-services", authenticationMode: "web-user", credentialRef: "owner", allowedScopes: ["private"], recordPolicy: {} },
    { id: "participant", containerId: "iCloud.com.example", environment: "development", backend: "web-services", authenticationMode: "web-user", credentialRef: "participant", allowedScopes: ["shared"], recordPolicy: {} },
  ] });
  return new DiagnosticService(profiles, new SessionManager(store, transport), handles);
}

function hasCode(code: string): (error: unknown) => boolean {
  return (error) => error instanceof CloudKitMCPError && error.details.code === code;
}
