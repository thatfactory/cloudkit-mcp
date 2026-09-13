import assert from "node:assert/strict";
import test from "node:test";
import { compareObservations } from "../src/diagnostics/comparison.js";
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
  assert.throws(() => registry.resolve(handle, context));
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
  const right: ViewObservation = { ...left, view: { ...view, profileId: "participant", scope: "shared" }, records: { record: { handle: "right", outcome: "notFoundInView", deleted: "unknown" } } };
  assert.equal(compareObservations(left, right)[0]?.category, "visibilityMismatch");
});
