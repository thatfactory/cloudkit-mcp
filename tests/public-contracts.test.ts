import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("public documentation retains exact high-risk tool boundaries", async () => {
  const plan = await readFile(new URL("../Documentation/ImplementationPlan.md", import.meta.url), "utf8");
  const readme = await readFile(new URL("../README.md", import.meta.url), "utf8");
  const capabilities = JSON.parse(await readFile(new URL("../resources/capabilities.json", import.meta.url), "utf8")) as {
    authentication: { serverKey: { liveVerifiedScopes: string[] } };
    backendOperations: Array<{ id: string; liveVerificationStatus: string; liveVerifiedScopes: string[] }>;
    limitations: string[];
  };
  const provenance = JSON.parse(await readFile(new URL("../contracts/provenance.json", import.meta.url), "utf8")) as {
    liveEvidence: { limitations: string[] };
  };
  assert.doesNotMatch(plan, /`list_zones` \| View, page limit\/handle/);
  assert.doesNotMatch(plan, /`get_zone`[^\n]*sharing\/change-state hints/);
  assert.match(plan, /`compare_views`[^\n]*`leftZone`\/`rightZone`/);
  assert.match(readme, /cloudkit:\/\/capabilities/);
  assert.match(readme, /Empty `allowedTypes` makes `query_records` unavailable/);
  assert.match(readme, /Empty `queryableFields` disables filtered queries, but an allowed record type can still use a zero-filter query/);
  assert.match(readme, /release-acceptance profiles intentionally authorized metadata only/);
  assert.deepEqual(capabilities.authentication.serverKey.liveVerifiedScopes, []);
  const query = capabilities.backendOperations.find((operation) => operation.id === "queryRecords");
  assert.deepEqual(query?.liveVerifiedScopes, []);
  assert.equal(query?.liveVerificationStatus, "notVerified");
  assert.equal(capabilities.limitations.some((limitation) => limitation.includes("no record types, queryable fields, or payload fields")), true);
  assert.equal(provenance.liveEvidence.limitations.some((limitation) => limitation.includes("no record types, queryable fields, or payload fields")), true);
  assert.equal(provenance.liveEvidence.limitations.some((limitation) => limitation.includes("account-switch and expiry")), true);
  assert.doesNotMatch(readme, /img\.shields\.io\/npm\/v/);
});
