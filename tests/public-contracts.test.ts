import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("public documentation retains exact high-risk tool boundaries", async () => {
  const readme = await readFile(new URL("../README.md", import.meta.url), "utf8");
  const capabilities = JSON.parse(await readFile(new URL("../resources/capabilities.json", import.meta.url), "utf8")) as {
    authentication: { serverKey: { liveVerifiedScopes: string[] } };
    backendOperations: Array<{ id: string; liveVerificationStatus: string; liveVerifiedScopes: string[] }>;
    limitations: string[];
  };
  const provenance = JSON.parse(await readFile(new URL("../contracts/provenance.json", import.meta.url), "utf8")) as {
    liveEvidence: { limitations: string[] };
  };
  assert.match(readme, /cloudkit:\/\/capabilities/);
  assert.match(readme, /`compare_views` \| Exact-record comparison using two authorized views and independent `leftZone`\/`rightZone` selectors/);
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
