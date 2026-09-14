import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CloudKitTransport } from "../src/api/transport.js";
import { CredentialStore } from "../src/auth/credential-store.js";
import { SessionManager } from "../src/auth/session.js";
import type { Profile } from "../src/domain/types.js";

const profile: Profile = { id: "owner", containerId: "iCloud.com.example", environment: "development", backend: "web-services", authenticationMode: "web-user", credentialRef: "owner", allowedScopes: ["private"], recordPolicy: { allowedTypes: [], queryableFields: [], readablePayloadFields: [], discloseRecordNames: false, discloseZoneNames: false } };

test("web-user success commits replacement before releasing transaction", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "cloudkit-session-")); context.after(async () => { const { rm } = await import("node:fs/promises"); await rm(root, { recursive: true, force: true }); });
  const store = new CredentialStore(root); await store.write("owner", { schemaVersion: 1, class: "web-user", apiToken: "api", webAuthenticationToken: "old", generation: 0, principalEpoch: "epoch" });
  const transport = new CloudKitTransport(async () => new Response(JSON.stringify({ userRecordName: "raw-principal", ckWebAuthToken: "new" }), { status: 200 }));
  const result = await new SessionManager(store, transport).execute(profile, "private", "probeCurrentUser", {});
  assert.equal(result.resolvedView.principalAlias.startsWith("account_"), true);
  const saved = await store.read("owner");
  assert.equal(saved.class === "web-user" && saved.webAuthenticationToken, "new");
  assert.equal(saved.generation, 1);
  assert.equal(saved.class === "web-user" && saved.principalRecordName, "raw-principal");
});

test("web-user error still commits a received replacement before surfacing safe failure", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "cloudkit-session-")); context.after(async () => { const { rm } = await import("node:fs/promises"); await rm(root, { recursive: true, force: true }); });
  const store = new CredentialStore(root); await store.write("owner", { schemaVersion: 1, class: "web-user", apiToken: "api", webAuthenticationToken: "old", generation: 0, principalEpoch: "epoch" });
  const transport = new CloudKitTransport(async () => new Response(JSON.stringify({ ckWebAuthToken: "replacement", reason: "private provider text" }), { status: 403 }));
  await assert.rejects(new SessionManager(store, transport).execute(profile, "private", "lookupRecords", {}), /not permitted/);
  const saved = await store.read("owner");
  assert.equal(saved.class === "web-user" && saved.webAuthenticationToken, "replacement");
  assert.equal(saved.generation, 1);
});

test("web-user response without replacement makes the slot uncertain and does not reuse the old token", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "cloudkit-session-")); context.after(async () => { const { rm } = await import("node:fs/promises"); await rm(root, { recursive: true, force: true }); });
  const store = new CredentialStore(root); await store.write("owner", { schemaVersion: 1, class: "web-user", apiToken: "api", webAuthenticationToken: "old", generation: 0, principalEpoch: "epoch" });
  const transport = new CloudKitTransport(async () => new Response("{}", { status: 200 }));
  await assert.rejects(new SessionManager(store, transport).execute(profile, "private", "lookupRecords", {}), /did not yield a durable replacement/);
  const saved = await store.read("owner");
  assert.equal(saved.class === "web-user" && saved.webAuthenticationToken, "old");
  assert.equal(saved.generation, 0);
  assert.equal(saved.class === "web-user" && saved.uncertain, true);
  await assert.rejects(new SessionManager(store, transport).execute(profile, "private", "lookupRecords", {}), /marked uncertain/);
});

test("web-user probe fails closed when the authenticated account changes", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "cloudkit-session-")); context.after(async () => { const { rm } = await import("node:fs/promises"); await rm(root, { recursive: true, force: true }); });
  const store = new CredentialStore(root); await store.write("owner", { schemaVersion: 1, class: "web-user", apiToken: "api", webAuthenticationToken: "old", generation: 7, principalEpoch: "original-epoch", principalRecordName: "original-principal" });
  const transport = new CloudKitTransport(async () => new Response(JSON.stringify({ userRecordName: "different-principal" }), {
    status: 200,
    headers: { "x-apple-cloudkit-web-auth-token": "replacement-for-different-account" },
  }));
  const manager = new SessionManager(store, transport);

  await assert.rejects(manager.execute(profile, "private", "probeCurrentUser", {}), /no longer matches the principal bound/);

  const saved = await store.read("owner");
  assert.equal(saved.class, "web-user");
  if (saved.class !== "web-user") return;
  assert.equal(saved.webAuthenticationToken, "replacement-for-different-account");
  assert.equal(saved.generation, 8);
  assert.equal(saved.principalEpoch, "original-epoch");
  assert.equal(saved.principalRecordName, "original-principal");
  assert.equal(saved.uncertain, true);
  await assert.rejects(manager.execute(profile, "private", "probeCurrentUser", {}), /marked uncertain/);
});
