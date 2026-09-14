import assert from "node:assert/strict";
import { generateKeyPairSync, verify } from "node:crypto";
import test from "node:test";
import { CloudKitTransport } from "../src/api/transport.js";
import { cloudKitTimestamp, serverKeySignatureInput, signServerKeyRequest } from "../src/api/signing.js";

const publicContext = { containerId: "iCloud.com.example", environment: "development" as const, scope: "public" as const };
const publicCredential = { mode: "api-token-public" as const, apiToken: "token" };

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

test("documented list reads use GET without a request body", async () => {
  const observations: Array<{ method?: string; body?: BodyInit | null }> = [];
  const transport = new CloudKitTransport(async (_input, init) => {
    observations.push({ method: init?.method, body: init?.body });
    return new Response(JSON.stringify({ zones: [], subscriptions: [] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
  const context = { containerId: "iCloud.com.example", environment: "development" as const, scope: "public" as const };
  const credential = { mode: "api-token-public" as const, apiToken: "token" };
  await transport.execute("listZones", context, credential, {});
  await transport.execute("listSubscriptions", context, credential, {});
  assert.deepEqual(observations, [{ method: "GET", body: undefined }, { method: "GET", body: undefined }]);
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

test("HTTP failures map to stable safe errors without provider text", async () => {
  for (const [status, code] of [[401, "authenticationExpired"], [403, "permissionDenied"], [429, "rateLimited"], [503, "partialFailure"]] as const) {
    const transport = new CloudKitTransport(async () => new Response(JSON.stringify({ reason: "token=private-provider-detail" }), { status }));
    const result = await transport.execute("lookupRecords", publicContext, publicCredential, {});
    assert.equal(result.error?.code, code);
    assert.equal(result.error?.retryable, false);
    assert.equal(JSON.stringify(result.error).includes("private-provider-detail"), false);
  }
});

test("rotating-session HTTP errors distinguish committed replacement from uncertainty", async () => {
  const context = { ...publicContext, scope: "private" as const };
  const credential = { mode: "web-user" as const, apiToken: "api", webAuthenticationToken: "session" };
  const withoutReplacement = await new CloudKitTransport(async () => new Response("{}", { status: 401 })).execute("lookupRecords", context, credential, {});
  assert.equal(withoutReplacement.error?.sessionEffect, "uncertain");
  const withReplacement = await new CloudKitTransport(async () => new Response("{}", { status: 401, headers: { "x-apple-cloudkit-web-auth-token": "replacement" } })).execute("lookupRecords", context, credential, {});
  assert.equal(withReplacement.error?.sessionEffect, "unchanged");
  assert.equal(withReplacement.replacementWebAuthenticationToken, "replacement");
});

test("malformed UTF-8 and JSON responses fail with stable diagnostics", async () => {
  const invalidResponses = [new Response(new Uint8Array([0xff])), new Response("{not-json")];
  for (const response of invalidResponses) {
    const transport = new CloudKitTransport(async () => response);
    await assert.rejects(transport.execute("lookupRecords", publicContext, publicCredential, {}), (error: unknown) => {
      assert.equal((error as { details?: { code?: string; sessionEffect?: string } }).details?.code, "malformedResponse");
      assert.equal((error as { details?: { sessionEffect?: string } }).details?.sessionEffect, "unchanged");
      return true;
    });
  }
});

test("body-read timeout cancels a stalled stream with a safe timeout", async () => {
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({ cancel: () => { cancelled = true; } });
  const transport = new CloudKitTransport(async () => new Response(stream), undefined, 10);
  await assert.rejects(transport.execute("lookupRecords", publicContext, publicCredential, {}), (error: unknown) => {
    assert.equal((error as { details?: { code?: string } }).details?.code, "timeout");
    return true;
  });
  assert.equal(cancelled, true);
});

test("queued cancellation never dispatches the cancelled request", async () => {
  const releases: Array<() => void> = [];
  let calls = 0;
  const transport = new CloudKitTransport(async () => {
    calls += 1;
    await new Promise<void>((resolvePromise) => releases.push(resolvePromise));
    return new Response("{}");
  });
  const active = Array.from({ length: 4 }, () => transport.execute("lookupRecords", publicContext, publicCredential, {}));
  while (calls < 4) await new Promise((resolvePromise) => setImmediate(resolvePromise));
  const controller = new AbortController();
  const queued = transport.execute("lookupRecords", publicContext, publicCredential, {}, controller.signal);
  controller.abort();
  await assert.rejects(queued, (error: unknown) => {
    assert.equal((error as { details?: { code?: string; execution?: string } }).details?.code, "cancelled");
    assert.equal((error as { details?: { execution?: string } }).details?.execution, "notStarted");
    return true;
  });
  assert.equal(calls, 4);
  while (releases.length) releases.shift()?.();
  await Promise.all(active);
});

test("immediate cancellation cannot race an available permit into dispatch", async () => {
  let calls = 0;
  const transport = new CloudKitTransport(async () => { calls += 1; return new Response("{}"); });
  const controller = new AbortController();
  const request = transport.execute("lookupRecords", publicContext, publicCredential, {}, controller.signal);
  controller.abort();
  await assert.rejects(request, (error: unknown) => {
    assert.equal((error as { details?: { code?: string; execution?: string } }).details?.code, "cancelled");
    assert.equal((error as { details?: { execution?: string } }).details?.execution, "notStarted");
    return true;
  });
  assert.equal(calls, 0);
});

test("cancellation after dequeue cannot race a granted permit into dispatch", async () => {
  const releases: Array<() => void> = [];
  let calls = 0;
  const transport = new CloudKitTransport(async () => {
    calls += 1;
    await new Promise<void>((resolvePromise) => releases.push(resolvePromise));
    return new Response("{}");
  });
  const active = Array.from({ length: 4 }, () => transport.execute("lookupRecords", publicContext, publicCredential, {}));
  while (calls < 4) await new Promise((resolvePromise) => setImmediate(resolvePromise));
  const controller = new AbortController();
  const queued = transport.execute("lookupRecords", publicContext, publicCredential, {}, controller.signal);
  releases.shift()?.();
  controller.abort();
  await assert.rejects(queued, (error: unknown) => {
    assert.equal((error as { details?: { code?: string; execution?: string } }).details?.code, "cancelled");
    assert.equal((error as { details?: { execution?: string } }).details?.execution, "notStarted");
    return true;
  });
  assert.equal(calls, 4);
  while (releases.length) releases.shift()?.();
  await Promise.all(active);
});

test("bounded queue rejects overflow before dispatch", async () => {
  const releases: Array<() => void> = [];
  let calls = 0;
  const transport = new CloudKitTransport(async () => {
    calls += 1;
    await new Promise<void>((resolvePromise) => releases.push(resolvePromise));
    return new Response("{}");
  });
  const accepted = Array.from({ length: 36 }, () => transport.execute("lookupRecords", publicContext, publicCredential, {}));
  await assert.rejects(transport.execute("lookupRecords", publicContext, publicCredential, {}), (error: unknown) => {
    assert.equal((error as { details?: { code?: string; execution?: string } }).details?.code, "queueExhausted");
    assert.equal((error as { details?: { execution?: string } }).details?.execution, "notStarted");
    return true;
  });
  while (calls < 4) await new Promise((resolvePromise) => setImmediate(resolvePromise));
  while (calls < 36 || releases.length > 0) {
    while (releases.length) releases.shift()?.();
    await new Promise((resolvePromise) => setImmediate(resolvePromise));
  }
  await Promise.all(accepted);
  assert.equal(calls, 36);
});

test("transport failures are not automatically replayed", async () => {
  let calls = 0;
  const transport = new CloudKitTransport(async () => { calls += 1; throw new Error("provider detail"); });
  await assert.rejects(transport.execute("lookupRecords", publicContext, publicCredential, {}), (error: unknown) => {
    assert.equal((error as { details?: { code?: string } }).details?.code, "timeout");
    return true;
  });
  assert.equal(calls, 1);
});

test("server-key signing rejects invalid key material and unregistered paths safely", () => {
  assert.throws(() => signServerKeyRequest({ keyId: "key", privateKeyPem: "not-a-key" }, new Uint8Array(), "/database/1/iCloud.com.example/development/public/zones/list", new Date()), /could not sign/);
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const credential = { keyId: "key", privateKeyPem: privateKey.export({ format: "pem", type: "pkcs8" }).toString() };
  assert.throws(() => signServerKeyRequest(credential, new Uint8Array(), "https://evil.example/database/1/path", new Date()), /outside the CloudKit/);
  for (const privateKeyPem of [
    generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
    generateKeyPairSync("ec", { namedCurve: "secp384r1" }).privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
  ]) {
    assert.throws(() => signServerKeyRequest({ keyId: "key", privateKeyPem }, new Uint8Array(), "/database/1/iCloud.com.example/development/public/zones/list", new Date()), /could not sign/);
  }
});
