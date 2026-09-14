import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("public documentation retains exact high-risk tool boundaries", async () => {
  const readme = await readFile(new URL("../README.md", import.meta.url), "utf8");
  const setup = await readFile(new URL("../Documentation/Setup.md", import.meta.url), "utf8");
  const capabilityGuide = await readFile(new URL("../Documentation/Capabilities.md", import.meta.url), "utf8");
  const capabilities = JSON.parse(await readFile(new URL("../resources/capabilities.json", import.meta.url), "utf8")) as {
    authentication: { serverKey: { liveVerifiedScopes: string[] } };
    backendOperations: Array<{ id: string; liveVerificationStatus: string; liveVerifiedScopes: string[] }>;
    limitations: string[];
    tools: string[];
  };
  const provenance = JSON.parse(await readFile(new URL("../contracts/provenance.json", import.meta.url), "utf8")) as {
    liveEvidence: { limitations: string[] };
  };
  assert.match(readme, /cloudkit:\/\/capabilities/);
  assert.match(readme, /--package=@thatfactory\/cloudkit-mcp@0\.1\.0/);
  assert.match(readme, /Documentation\/Setup\.md/);
  assert.match(readme, /Documentation\/Capabilities\.md/);
  assert.match(capabilityGuide, /`compare_views` \| Compare exact record metadata across independently authenticated and independently zone-selected views/);
  assert.deepEqual([...capabilityGuide.matchAll(/^\| `([^`]+)` \|/gm)].map((match) => match[1]), capabilities.tools);
  assert.match(setup, /Empty `allowedTypes` makes `query_records` unavailable/);
  assert.match(setup, /Empty `queryableFields` disables filtered queries; an allowed type may still use a zero-filter query/);
  for (const action of ["import", "status", "remove"]) assert.match(setup, new RegExp(`auth ${action}`));
  assert.match(capabilityGuide, /acceptance profiles intentionally authorized metadata only/);
  assert.deepEqual(capabilities.authentication.serverKey.liveVerifiedScopes, []);
  const query = capabilities.backendOperations.find((operation) => operation.id === "queryRecords");
  assert.deepEqual(query?.liveVerifiedScopes, []);
  assert.equal(query?.liveVerificationStatus, "notVerified");
  assert.equal(capabilities.limitations.some((limitation) => limitation.includes("no record types, queryable fields, or payload fields")), true);
  assert.equal(provenance.liveEvidence.limitations.some((limitation) => limitation.includes("no record types, queryable fields, or payload fields")), true);
  assert.equal(provenance.liveEvidence.limitations.some((limitation) => limitation.includes("account-switch and expiry")), true);
  assert.doesNotMatch(readme, /img\.shields\.io\/npm\/v/);
});
