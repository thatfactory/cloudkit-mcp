import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("public documentation retains exact high-risk tool boundaries", async () => {
  const plan = await readFile(new URL("../Documentation/ImplementationPlan.md", import.meta.url), "utf8");
  const readme = await readFile(new URL("../README.md", import.meta.url), "utf8");
  assert.doesNotMatch(plan, /`list_zones` \| View, page limit\/handle/);
  assert.doesNotMatch(plan, /`get_zone`[^\n]*sharing\/change-state hints/);
  assert.match(plan, /`compare_views`[^\n]*`leftZone`\/`rightZone`/);
  assert.match(readme, /cloudkit:\/\/capabilities/);
  assert.match(readme, /Empty `allowedTypes` or `queryableFields` intentionally makes `query_records` unavailable/);
  assert.doesNotMatch(readme, /img\.shields\.io\/npm\/v/);
});
