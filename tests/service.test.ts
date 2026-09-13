import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CloudKitTransport } from "../src/api/transport.js";
import { CredentialStore } from "../src/auth/credential-store.js";
import { SessionManager } from "../src/auth/session.js";
import { parseProfilesDocument } from "../src/config/profiles.js";
import { DiagnosticService } from "../src/diagnostics/service.js";

test("synthetic contracts exercise the complete read-only diagnostic service", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "cloudkit-service-")); context.after(async () => { const { rm } = await import("node:fs/promises"); await rm(root, { recursive: true, force: true }); });
  const store = new CredentialStore(root);
  await store.write("public", { schemaVersion: 1, class: "api-token-public", apiToken: "public-api", generation: 0 });
  await store.write("owner", { schemaVersion: 1, class: "web-user", apiToken: "api", webAuthenticationToken: "owner-token", generation: 0, principalEpoch: "owner-epoch", principalRecordName: "owner-principal" });
  await store.write("participant", { schemaVersion: 1, class: "web-user", apiToken: "api", webAuthenticationToken: "participant-token", generation: 0, principalEpoch: "participant-epoch", principalRecordName: "participant-principal" });
  let tokenGeneration = 0;
  const transport = new CloudKitTransport(async (input, init) => {
    const url = new URL(input); const request = init?.body ? JSON.parse(Buffer.from(init.body as Uint8Array).toString("utf8")) as Record<string, unknown> : {};
    const token = url.searchParams.has("ckWebAuthToken") ? { ckWebAuthToken: `replacement-${tokenGeneration += 1}` } : {};
    if (url.pathname.endsWith("/users/caller")) return response({ userRecordName: "owner-principal", ...token });
    if (url.pathname.endsWith("/zones/list")) return response({ zones: [{ zoneName: "Inventory", ownerRecordName: "owner-principal" }], ...token });
    if (url.pathname.endsWith("/zones/lookup")) return response({ zones: [{ zoneID: { zoneName: "Inventory", ownerRecordName: "owner-principal" } }], ...token });
    if (url.pathname.endsWith("/records/query")) return response({ records: [wireRecord("record-a")], continuationMarker: "next-page", ...token });
    if (url.pathname.endsWith("/subscriptions/list")) return response({ subscriptions: [{ subscriptionType: "zone", zoneID: { zoneName: "Inventory" } }], ...token });
    if (url.pathname.endsWith("/changes/database")) return response({ zones: [{ zoneID: { zoneName: "Inventory", ownerRecordName: "owner-principal" } }], syncToken: "database-token", ...token });
    if (url.pathname.endsWith("/changes/zone")) return response({ zones: [{ zoneID: { zoneName: "Inventory", ownerRecordName: "owner-principal" }, records: [{ ...wireRecord("record-a"), deleted: false }], syncToken: "zone-token" }], ...token });
    if (url.pathname.endsWith("/records/lookup")) {
      assert.deepEqual(request.zoneID, { zoneName: "Inventory", ownerRecordName: "owner-principal" });
      assert.equal(request.numbersAsStrings, true);
      const names = (request.records as Array<{ recordName: string }> | undefined)?.map((record) => record.recordName) ?? [];
      if (names[0] === "share-record") return response({ records: [{ recordName: "share-record", recordType: "cloudkit.share", participants: [{ type: "OWNER", acceptanceStatus: "ACCEPTED", permission: "READ_WRITE", userIdentity: { lookupInfo: { emailAddress: "must-not-escape@example.com" } } }], shareType: "ZONE_WIDE", currentUserParticipant: { type: "OWNER" }, publicPermission: "NONE" }], ...token });
      return response({ records: names.map((name) => ({ ...wireRecord(name), share: { recordName: "share-record" } })), ...token });
    }
    return response({ serverErrorCode: "UNKNOWN" }, 500);
  });
  const profiles = parseProfilesDocument({ schemaVersion: 1, profiles: [
    { id: "public", containerId: "iCloud.com.example", environment: "development", backend: "web-services", authenticationMode: "api-token-public", credentialRef: "public", allowedScopes: ["public"], recordPolicy: { allowedTypes: ["Entry"], queryableFields: ["entryID"], readablePayloadFields: ["title"] } },
    { id: "owner", containerId: "iCloud.com.example", environment: "development", backend: "web-services", authenticationMode: "web-user", credentialRef: "owner", allowedScopes: ["private"], recordPolicy: { allowedTypes: ["Entry"], queryableFields: ["entryID"], readablePayloadFields: ["title"] } },
    { id: "participant", containerId: "iCloud.com.example", environment: "development", backend: "web-services", authenticationMode: "web-user", credentialRef: "participant", allowedScopes: ["shared"], recordPolicy: { allowedTypes: ["Entry"], queryableFields: ["entryID"], readablePayloadFields: ["title"] } },
  ] });
  const service = new DiagnosticService(profiles, new SessionManager(store, transport));
  const publicView = { profileId: "public", scope: "public" as const }; const ownerView = { profileId: "owner", scope: "private" as const }; const participantView = { profileId: "participant", scope: "shared" as const }; const zone = { zoneName: "Inventory", ownerRecordName: "owner-principal" };

  assert.equal(service.getContext().profiles.length, 3);
  assert.equal((await service.probeAccess(ownerView)).data.accessible, true);
  const zones = await service.listZones(publicView); assert.equal(zones.data.length, 1);
  assert.equal((await service.getZone(publicView, { handle: zones.data[0]?.handle ?? "" })).data.outcome, "present");
  assert.equal((await service.getRecords(ownerView, zone, ["record-a"])).data[0]?.outcome, "present");
  assert.deepEqual((await service.readRecordFields(ownerView, zone, ["record-a"], ["title"])).data[0]?.fields?.title, { state: "returned", value: "synthetic title" });
  assert.equal((await service.queryRecords(ownerView, zone, "Entry", [{ fieldName: "entryID", comparator: "EQUALS", fieldValue: "synthetic" }], 10)).data.records.length, 1);
  const share = await service.getShare(ownerView, zone, "record-a"); assert.equal(share.data.mode, "zoneWide"); assert.equal(JSON.stringify(share).includes("must-not-escape"), false);
  assert.equal((await service.listSubscriptions(ownerView)).data.subscriptions[0]?.type, "zone");
  const databaseChanges = await service.getDatabaseChanges(ownerView, "beginning"); assert.equal(databaseChanges.data.changedZones.length, 1); assert.ok(databaseChanges.data.continuationHandle); assert.equal(databaseChanges.data.moreComing, false);
  const zoneChanges = await service.getZoneChanges(ownerView, zone, "beginning"); assert.equal(zoneChanges.data.changes[0]?.outcome, "present"); assert.ok(zoneChanges.data.continuationHandle); assert.equal(zoneChanges.data.moreComing, false);
  const comparison = await service.compareViews(ownerView, participantView, zone, ["record-a"]); assert.equal(comparison.conclusions[0]?.category, "matchingObservedMetadata"); assert.equal(comparison.samePrincipal, false);
});

function wireRecord(recordName: string) {
  return { recordName, recordType: "Entry", recordChangeTag: "tag-1", created: { timestamp: 1_700_000_000_000 }, modified: { timestamp: 1_700_000_010_000 }, fields: { title: { value: "synthetic title" }, hidden: { value: "never returned" } } };
}

function response(body: unknown, status = 200): Response { return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }); }
