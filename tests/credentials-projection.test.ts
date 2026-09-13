import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CredentialStore } from "../src/auth/credential-store.js";
import { projectRecord } from "../src/diagnostics/projection.js";
import { HandleRegistry } from "../src/state/handles.js";
import type { Profile } from "../src/domain/types.js";

test("credential store creates owner-only atomic files and exposes safe status", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "cloudkit-credentials-")); context.after(async () => { const { rm } = await import("node:fs/promises"); await rm(root, { recursive: true, force: true }); });
  const store = new CredentialStore(join(root, "store"));
  await store.write("owner", { schemaVersion: 1, class: "web-user", apiToken: "api-secret", webAuthenticationToken: "web-secret", generation: 0, principalEpoch: "epoch" });
  const status = await store.status("owner");
  assert.deepEqual(status, { credentialRef: "owner", available: true, credentialClass: "web-user", generation: 0, principalBound: false, uncertain: false });
  assert.equal(JSON.stringify(status).includes("secret"), false);
  assert.match(await readFile(join(root, "store", "owner.json"), "utf8"), /web-secret/);
  assert.equal((await stat(join(root, "store"))).mode & 0o777, 0o700);
  assert.equal((await stat(join(root, "store", "owner.json"))).mode & 0o777, 0o600);
});

test("credential store rejects a symlink slot", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "cloudkit-credentials-")); context.after(async () => { const { rm } = await import("node:fs/promises"); await rm(root, { recursive: true, force: true }); });
  const storeRoot = join(root, "store"); await mkdir(storeRoot, { mode: 0o700 }); await symlink("/etc/passwd", join(storeRoot, "owner.json"));
  await assert.rejects(new CredentialStore(storeRoot).read("owner"));
});

test("payload projection returns only selected allowed fields and redacts token-like data", () => {
  const profile: Profile = { id: "owner", containerId: "iCloud.com.example", environment: "development", backend: "web-services", authenticationMode: "web-user", credentialRef: "owner", allowedScopes: ["private"], recordPolicy: { allowedTypes: ["Entry"], queryableFields: ["entryID"], readablePayloadFields: ["safe", "secretField"], discloseRecordNames: false, discloseZoneNames: false } };
  const context = { principalEpoch: "epoch", profileId: "owner", containerId: profile.containerId, environment: profile.environment, scope: "private" as const, backend: "web-services" as const, operation: "record", selectorDigest: "digest", zoneOwner: "owner-id", zoneName: "Inventory" };
  const observation = projectRecord({ recordName: "personal-name", recordType: "Entry", fields: { safe: { value: "hello" }, secretField: { value: { accessToken: "do-not-return" } }, notRequested: { value: "hidden" } } }, profile, { zoneName: "Inventory", ownerRecordName: "owner-id" }, new HandleRegistry(), context, ["safe", "secretField"]);
  assert.equal(observation.handle.includes("personal-name"), false);
  assert.deepEqual(observation.fields?.safe, { state: "returned", value: "hello" });
  assert.deepEqual(observation.fields?.secretField, { state: "returned", value: { accessToken: "[redacted]" } });
  assert.equal(observation.fields?.notRequested, undefined);
});
