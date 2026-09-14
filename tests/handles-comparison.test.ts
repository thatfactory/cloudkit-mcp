import assert from "node:assert/strict";
import test from "node:test";
import { compareObservations } from "../src/diagnostics/comparison.js";
import { CloudKitMCPError } from "../src/errors.js";
import { HandleRegistry, type HandleContext } from "../src/state/handles.js";
import type { ViewObservation } from "../src/domain/types.js";

const context: HandleContext = { principalEpoch: "epoch-a", profileId: "owner", containerId: "iCloud.com.example", environment: "development", scope: "private", backend: "web-services", operation: "queryRecords", selectorDigest: "digest", zoneOwner: "owner-a", zoneName: "Inventory" };

test("handles reject changed profile, scope, zone, selector, and principal epoch", () => {
  const registry = new HandleRegistry(() => 1000);
  const handle = registry.issue("query", context, "provider-token");
  assert.equal(registry.resolve(handle, context), "provider-token");
  for (const changed of [{ ...context, profileId: "other" }, { ...context, scope: "shared" as const }, { ...context, zoneOwner: "other" }, { ...context, selectorDigest: "changed" }, { ...context, principalEpoch: "epoch-b" }]) assert.throws(() => registry.resolve(handle, changed));
});

test("expired handles never reveal or resolve provider tokens", () => {
  let now = 1000;
  const registry = new HandleRegistry(() => now, 128, 1024, 100);
  const handle = registry.issue("cursor", context, "raw-secret-token");
  assert.equal(handle.includes("raw-secret-token"), false);
  now = 1100;
  assert.throws(() => registry.resolve(handle, context), (error) => error instanceof CloudKitMCPError && error.details.code === "cursorExpired");
});

test("batched handle issuance is atomic when registry capacity is exhausted", () => {
  const registry = new HandleRegistry(() => 1000, 1);
  assert.throws(() => registry.issueBatch([
    { kind: "zone", context, value: "first" },
    { kind: "cursor", context, value: "second" },
  ]), (error) => error instanceof CloudKitMCPError && error.details.code === "outputBoundExceeded");
  const handle = registry.issue("cursor", context, "after-failure");
  assert.equal(registry.resolve(handle, context), "after-failure");
});

test("releasing one compact derived handle invalidates its bounded group", () => {
  const registry = new HandleRegistry(() => 1000, 1);
  const [first, second] = registry.issueBoundBatch("zone", [
    { context, value: "first" },
    { context: { ...context, zoneName: "Other" }, value: "second" },
  ]);
  registry.release(first!);
  assert.throws(() => registry.resolve(first!, context), (error) => error instanceof CloudKitMCPError && error.details.code === "cursorInvalid");
  assert.throws(() => registry.resolve(second!, { ...context, zoneName: "Other" }), (error) => error instanceof CloudKitMCPError && error.details.code === "cursorInvalid");
  assert.equal(registry.resolve(registry.issue("cursor", context, "after-release"), context), "after-release");
});

test("comparison distinguishes matching observations from transactional equality", () => {
  const view = { profileId: "owner", containerId: "iCloud.com.example", environment: "development" as const, scope: "private" as const, backend: "web-services" as const, principalAlias: "account-a", principalEpoch: "epoch-a" };
  const observation: ViewObservation = { view, observedFrom: "2026-09-13T00:00:00Z", observedTo: "2026-09-13T00:00:01Z", identityMapping: "verified", limitations: [], records: { record: { handle: "record-a", outcome: "present", changeTag: "tag", deleted: "notObserved" } } };
  const result = compareObservations(observation, { ...observation, view: { ...view, profileId: "participant", scope: "shared", principalAlias: "account-b" } });
  assert.equal(result[0]?.category, "matchingObservedMetadata");
  assert.match(result[0]?.limitations[0] ?? "", /not transactional/);
});

test("comparison never calls one-sided absence an upload failure", () => {
  const view = { profileId: "owner", containerId: "iCloud.com.example", environment: "development" as const, scope: "private" as const, backend: "web-services" as const, principalAlias: "account-a", principalEpoch: "epoch-a" };
  const left: ViewObservation = { view, observedFrom: "a", observedTo: "b", identityMapping: "verified", limitations: [], records: { record: { handle: "left", outcome: "present", deleted: "notObserved" } } };
  const right: ViewObservation = { ...left, view: { ...view, profileId: "participant", scope: "shared", principalAlias: "account-b" }, records: { record: { handle: "right", outcome: "notFoundInView", deleted: "unknown" } } };
  const conclusion = compareObservations(left, right)[0];
  assert.equal(conclusion?.category, "visibilityMismatch");
  assert.match(conclusion?.evidence.join(" ") ?? "", /explicitly not found/);
  assert.doesNotMatch(conclusion?.evidence.join(" ") ?? "", /inaccessible|unknown/);
});

test("comparison fails closed for environments, identity uncertainty, partial reads, and differing metadata", () => {
  const view = { profileId: "owner", containerId: "iCloud.com.example", environment: "development" as const, scope: "private" as const, backend: "web-services" as const, principalAlias: "account-a", principalEpoch: "epoch-a" };
  const present = { handle: "left", outcome: "present" as const, changeTag: "tag-a", deleted: "notObserved" as const };
  const left: ViewObservation = { view, observedFrom: "a", observedTo: "b", identityMapping: "verified", limitations: [], records: { record: present } };

  const production: ViewObservation = { ...left, view: { ...view, environment: "production" } };
  assert.equal(compareObservations(left, production)[0]?.category, "environmentMismatch");

  const uncertain: ViewObservation = { ...left, identityMapping: "explicitUnverified" };
  assert.equal(compareObservations(left, uncertain)[0]?.category, "inconclusive");

  const partial: ViewObservation = { ...left, limitations: ["Right view failed independently."], records: { record: { handle: "right", outcome: "unknown", deleted: "unknown" } } };
  assert.equal(compareObservations(left, partial)[0]?.category, "inconclusive");

  const changed: ViewObservation = { ...left, records: { record: { ...present, changeTag: "tag-b" } } };
  assert.equal(compareObservations(left, changed)[0]?.category, "inconclusive");

  const samePrincipal: ViewObservation = { ...left, view: { ...view, profileId: "alias-profile" } };
  assert.match(compareObservations(left, samePrincipal)[0]?.limitations.join(" ") ?? "", /same authenticated principal/);
});

test("comparison requires client evidence instead of declaring remote upload failure", () => {
  const view = { profileId: "owner", containerId: "iCloud.com.example", environment: "development" as const, scope: "private" as const, backend: "web-services" as const, principalAlias: "account-a", principalEpoch: "epoch-a" };
  const absent = { handle: "missing", outcome: "notFoundInView" as const, deleted: "unknown" as const };
  const observation: ViewObservation = { view, observedFrom: "a", observedTo: "b", identityMapping: "verified", limitations: [], records: { record: absent } };
  const conclusion = compareObservations(observation, { ...observation, view: { ...view, profileId: "participant", scope: "shared", principalAlias: "account-b" } })[0];
  assert.equal(conclusion?.category, "uploadFailureNotEstablished");
  assert.match(conclusion?.nextStep ?? "", /client/i);
});
