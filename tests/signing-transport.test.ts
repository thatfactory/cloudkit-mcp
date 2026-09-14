import assert from "node:assert/strict";
import { generateKeyPairSync, verify } from "node:crypto";
import test from "node:test";
import { CloudKitTransport } from "../src/api/transport.js";
import { cloudKitTimestamp, serverKeySignatureInput, signServerKeyRequest } from "../src/api/signing.js";

test("server-key signature verifies against exact body path and date", () => {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const credential = { keyId: "key-id", privateKeyPem: privateKey.export({ format: "pem", type: "pkcs8" }).toString() };
  const body = Buffer.from('{"records":[]}'); const path = "/database/1/iCloud.com.example/development/public/records/lookup"; const date = new Date("2026-09-13T12:34:56.789Z");
  const headers = signServerKeyRequest(credential, body, path, date);
  assert.equal(headers["X-Apple-CloudKit-Request-ISO8601Date"], "2026-09-13T12:34:56Z");
  assert.equal(verify("sha256", Buffer.from(serverKeySignatureInput(cloudKitTimestamp(date), body, path)), publicKey, Buffer.from(headers["X-Apple-CloudKit-Request-SignatureV1"], "base64")), true);
  assert.equal(verify("sha256", Buffer.from(serverKeySignatureInput(cloudKitTimestamp(date), Buffer.from("tampered"), path)), publicKey, Buffer.from(headers["X-Apple-CloudKit-Request-SignatureV1"], "base64")), false);
});

test("POST record reads remain allowed and use only the fixed origin", async () => {
  let observed: URL | undefined; let method: string | undefined;
  const transport = new CloudKitTransport(async (input, init) => { observed = new URL(input); method = init?.method; return new Response(JSON.stringify({ records: [] }), { status: 200, headers: { "content-type": "application/json" } }); });
  await transport.execute("lookupRecords", { containerId: "iCloud.com.example", environment: "development", scope: "public" }, { mode: "api-token-public", apiToken: "private-api-token" }, { records: [] });
  assert.equal(observed?.origin, "https://api.apple-cloudkit.com");
  assert.equal(method, "POST");
  assert.equal(observed?.searchParams.get("ckAPIToken"), "private-api-token");
});

test("public API-token probe accepts only a documented authentication challenge", async () => {
  const transport = new CloudKitTransport(async () => new Response(JSON.stringify({ serverErrorCode: "AUTHENTICATION_REQUIRED", redirectURL: "https://icloud.example/sign-in" }), { status: 421 }));
  const result = await transport.execute("probeCurrentUser", { containerId: "iCloud.com.example", environment: "development", scope: "public" }, { mode: "api-token-public", apiToken: "token" }, {});
  assert.equal(result.status, 421);
  assert.equal(result.error, undefined);
});

test("web-user probe uses the public caller endpoint and ckSession contract", async () => {
  let observed: URL | undefined;
  const transport = new CloudKitTransport(async (input) => {
    observed = new URL(input);
    return new Response(JSON.stringify({ userRecordName: "principal" }), {
      status: 200,
      headers: { "content-type": "application/json", "x-apple-cloudkit-web-auth-token": "replacement" },
    });
  });
  await transport.execute("probeCurrentUser", { containerId: "iCloud.com.example", environment: "development", scope: "private" }, { mode: "web-user", apiToken: "api", webAuthenticationToken: "session" }, {});
  assert.equal(observed?.pathname, "/database/1/iCloud.com.example/development/public/users/caller");
  assert.equal(observed?.searchParams.get("ckSession"), "session");
  assert.equal(observed?.searchParams.has("ckWebAuthToken"), false);
});

test("redirects are rejected and never followed", async () => {
  let redirect: RequestRedirect | undefined;
  const transport = new CloudKitTransport(async (_input, init) => { redirect = init?.redirect; return new Response("", { status: 302, headers: { location: "https://evil.example" } }); });
  await assert.rejects(transport.execute("lookupRecords", { containerId: "iCloud.com.example", environment: "development", scope: "public" }, { mode: "api-token-public", apiToken: "token" }, {}));
  assert.equal(redirect, "manual");
});

test("shared zone discovery stays gated before any network access", async () => {
  let calls = 0;
  const transport = new CloudKitTransport(async () => { calls += 1; return new Response("{}"); });
  await assert.rejects(transport.execute("listZones", { containerId: "iCloud.com.example", environment: "development", scope: "shared" }, { mode: "web-user", apiToken: "api", webAuthenticationToken: "web" }, {}));
  assert.equal(calls, 0);
});

test("response byte bound applies while consuming error bodies", async () => {
  const transport = new CloudKitTransport(async () => new Response("x".repeat(20)), undefined, 1000, 10);
  await assert.rejects(transport.execute("lookupRecords", { containerId: "iCloud.com.example", environment: "development", scope: "public" }, { mode: "api-token-public", apiToken: "token" }, {}), /configured response bound/);
});

test("global transport concurrency never exceeds four active requests", async () => {
  let active = 0; let maximum = 0; const releases: Array<() => void> = [];
  const transport = new CloudKitTransport(async () => {
    active += 1; maximum = Math.max(maximum, active);
    await new Promise<void>((resolvePromise) => releases.push(resolvePromise));
    active -= 1;
    return new Response("{}");
  });
  const requests = Array.from({ length: 6 }, () => transport.execute("lookupRecords", { containerId: "iCloud.com.example", environment: "development", scope: "public" }, { mode: "api-token-public", apiToken: "token" }, {}));
  while (releases.length < 4) await new Promise((resolvePromise) => setImmediate(resolvePromise));
  assert.equal(maximum, 4);
  while (releases.length) releases.shift()?.();
  while (active > 0 || releases.length === 0) { if (active === 0) break; await new Promise((resolvePromise) => setImmediate(resolvePromise)); while (releases.length) releases.shift()?.(); }
  await Promise.all(requests);
  assert.equal(maximum, 4);
});
