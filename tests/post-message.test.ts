import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import { CloudKitTransport } from "../src/api/transport.js";
import { PostMessageProvider } from "../src/auth/post-message.js";
import { RecoveryFailure } from "../src/auth/recovery-types.js";
import type { Profile } from "../src/domain/types.js";
import type { WebUserCredential } from "../src/auth/credential-store.js";

const profile: Profile = { id: "owner", containerId: "iCloud.com.example", environment: "development", backend: "web-services", authenticationMode: "web-user", credentialRef: "owner", allowedScopes: ["private"], recordPolicy: { allowedTypes: [], queryableFields: [], readablePayloadFields: [], discloseRecordNames: false, discloseZoneNames: false } };
const credential: WebUserCredential = { schemaVersion: 1, class: "web-user", apiToken: "synthetic-api", webAuthenticationToken: "synthetic-token", generation: 0, principalEpoch: "epoch" };

test("loopback flow uses the exact origin, bounds its receiver and never exposes tokens in HTML or URLs", async () => {
  let requestedOrigin = ""; let pageURL = ""; let handedOff = false;
  const transport = new CloudKitTransport(async (url, init) => {
    assert.equal(new URL(url).origin, "https://api.apple-cloudkit.com");
    assert.equal(new URL(url).searchParams.has("ckWebAuthToken"), false);
    requestedOrigin = (init!.headers as Record<string, string>).Origin!;
    return new Response(JSON.stringify({ serverErrorCode: "AUTHENTICATION_REQUIRED", redirectURL: "https://idmsa.apple.com/synthetic-signin" }), { status: 421 });
  });
  const provider = new PostMessageProvider(transport, 0, async (localPage) => {
    pageURL = localPage; assert.equal(new URL(localPage).origin, requestedOrigin);
    assert.equal(localPage.includes("synthetic"), false);
    const html = await fetch(localPage); assert.equal(html.headers.get("cache-control"), "no-store"); assert.match(html.headers.get("content-security-policy")!, /frame-ancestors 'none'/);
    const text = await html.text(); assert.equal(text.includes("synthetic-api"), false); assert.equal(text.includes("idmsa.apple.com"), false);
    assert.equal((await fetch(`${localPage}challenge`, { headers: { "Sec-Fetch-Site": "cross-site" } })).status, 403);
    const challenge = await (await fetch(`${localPage}challenge`)).json(); assert.equal(challenge.origin, "https://idmsa.apple.com"); assert.deepEqual(challenge.callbackOrigins, ["https://cdn.apple-cloudkit.com"]);
    assert.equal((await fetch(`${localPage}token`, { method: "POST", headers: { Origin: "https://untrusted.example", "Content-Type": "application/json" }, body: JSON.stringify({ token: "synthetic-fresh" }) })).status, 403);
    assert.equal((await fetch(`${localPage}token`, { method: "POST", headers: { Origin: requestedOrigin, "Content-Type": "application/json" }, body: JSON.stringify({ token: "synthetic-fresh" }) })).status, 204);
  });
  const result = await provider.authorize(profile, credential, new AbortController().signal, async () => { handedOff = true; });
  assert.equal(handedOff, true); assert.equal(result.token, "synthetic-fresh"); assert.equal(result.origin, requestedOrigin);
  await assert.rejects(fetch(pageURL));
});

for (const route of ["cancel", "invalid"] as const) test(`local ${route} is terminal and leaves no receiver`, async () => {
  let pageURL = "";
  const transport = new CloudKitTransport(async () => new Response(JSON.stringify({ serverErrorCode: "AUTHENTICATION_REQUIRED", redirectURL: "https://idmsa.apple.com/synthetic-signin" }), { status: 421 }));
  const provider = new PostMessageProvider(transport, 0, async (page) => {
    pageURL = page; const response = await fetch(`${page}${route}`, { method: "POST", headers: { Origin: new URL(page).origin } }); assert.equal(response.status, 204);
  });
  await assert.rejects(provider.authorize(profile, credential, new AbortController().signal, async () => {}), (error: unknown) => error instanceof RecoveryFailure && error.reason === (route === "cancel" ? "operatorCancelled" : "invalidCallback"));
  await assert.rejects(fetch(pageURL));
});

test("unsupported authorization targets and unavailable browsers return safe failures", async () => {
  for (const target of ["https://untrusted.example/signin", "http://idmsa.apple.com/signin", "https://idmsa.apple.com.untrusted.example/signin", "https://user@idmsa.apple.com/signin"]) {
    const transport = new CloudKitTransport(async () => new Response(JSON.stringify({ serverErrorCode: "AUTHENTICATION_REQUIRED", redirectURL: target }), { status: 421 }));
    await assert.rejects(transport.authorizationChallenge({ containerId: profile.containerId, environment: profile.environment }, "synthetic-api", "http://127.0.0.1:8765", new AbortController().signal), /authorizationFailed/);
  }
  const transport = new CloudKitTransport(async () => new Response(JSON.stringify({ serverErrorCode: "AUTHENTICATION_REQUIRED", redirectURL: "https://idmsa.apple.com/synthetic-signin" }), { status: 421 }));
  const provider = new PostMessageProvider(transport, 0, async () => { throw new RecoveryFailure("browserUnavailable"); });
  await assert.rejects(provider.authorize(profile, credential, new AbortController().signal, async () => {}), /browserUnavailable/);
});

test("an oversized or malformed callback fails closed", async () => {
  for (const body of [JSON.stringify({ token: "x".repeat(20_000) }), JSON.stringify({ token: "" }), "[1]"]) {
    const transport = new CloudKitTransport(async () => new Response(JSON.stringify({ serverErrorCode: "AUTHENTICATION_REQUIRED", redirectURL: "https://idmsa.apple.com/synthetic-signin" }), { status: 421 }));
    const provider = new PostMessageProvider(transport, 0, async (page) => {
      await fetch(`${page}token`, { method: "POST", headers: { Origin: new URL(page).origin, "Content-Type": "application/json" }, body }).catch(() => {});
    });
    await assert.rejects(provider.authorize(profile, credential, new AbortController().signal, async () => {}), /invalidCallback/);
  }
});

async function browser() {
  const handlers = new Map<string, (event?: any) => any>(); const calls: Array<{ route: string; body?: string }> = [];
  const elements = new Map(["signin", "cancel", "status", "context"].map((id) => [id, { disabled: false, textContent: "", addEventListener: (_event: string, handler: (event?: any) => any) => handlers.set(id, handler), click: () => handlers.get(id)?.() }]));
  const popup = { closed: false, close: () => { popup.closed = true; } };
  const source = await readFile(new URL("../resources/recovery-page.js", import.meta.url), "utf8");
  runInNewContext(source, {
    URL,
    document: { getElementById: (id: string) => elements.get(id) },
    window: { location: { origin: "http://127.0.0.1:8765" }, addEventListener: (name: string, handler: (event?: any) => any) => handlers.set(name, handler), removeEventListener: () => {}, open: () => popup },
    navigator: { sendBeacon: () => {} }, setInterval: () => 1, clearInterval: () => {},
    fetch: async (route: string, init?: { body: string }) => { calls.push({ route, ...(init ? { body: init.body } : {}) }); return { ok: true, json: async () => ({ url: "https://idmsa.apple.com/synthetic-signin", origin: "https://idmsa.apple.com", callbackOrigins: ["https://cdn.apple-cloudkit.com"] }) }; },
  });
  await new Promise((done) => setImmediate(done));
  handlers.get("signin")!();
  return { send: handlers.get("message")!, popup, calls, elements };
}

test("trusted page rejects wrong source, wrong origin and conflicting fields; accepts each Apple token shape once", async () => {
  for (const field of ["ckWebAuthToken", "ckSession"]) {
    const b = await browser();
    await b.send({ source: {}, origin: "https://cdn.apple-cloudkit.com", data: { [field]: "synthetic-fresh" } });
    assert.equal(b.calls.some((call) => call.route === "token"), false);
    const event = { source: b.popup, origin: "https://cdn.apple-cloudkit.com", data: { [field]: "synthetic-fresh" } };
    await Promise.all([b.send(event), b.send(event)]);
    assert.equal(b.calls.filter((call) => call.route === "token").length, 1);
    assert.equal(b.elements.get("status")!.textContent.includes("synthetic-fresh"), false);
  }
  for (const event of [
    { origin: "https://untrusted.example", data: { ckSession: "synthetic-fresh" } },
    { origin: "https://idmsa.apple.com", data: { ckSession: "synthetic-fresh" } },
    { origin: "https://cdn.apple-cloudkit.com", data: { ckSession: "a", ckWebAuthToken: "b" } },
    { origin: "https://cdn.apple-cloudkit.com", data: { ckSession: "" } },
    { origin: "https://cdn.apple-cloudkit.com", data: { errorMessage: "synthetic-private-provider-text" } },
  ]) {
    const b = await browser(); await b.send({ ...event, source: b.popup });
    assert.equal(b.calls.some((call) => call.route === "token"), false); assert.equal(b.calls.filter((call) => call.route === "invalid").length, 1);
    assert.equal(b.elements.get("status")!.textContent.includes("synthetic-private-provider-text"), false);
  }
});

test("popup readiness messages do not terminate recovery and default HTTPS ports are canonicalized", async () => {
  const b = await browser();
  await b.send({ source: b.popup, origin: "https://untrusted.example", data: { readiness: true } });
  assert.equal(b.calls.some((call) => call.route === "invalid"), false);
  await b.send({ source: b.popup, origin: "https://cdn.apple-cloudkit.com:443", data: { ckSession: "synthetic-fresh" } });
  assert.equal(b.calls.filter((call) => call.route === "token").length, 1);
});

test("callback diagnostics omit query, path, token and untrusted hostnames", async () => {
  for (const origin of ["https://untrusted.example", "https://idmsa.apple.com.untrusted.example", "null"]) {
    const b = await browser(); await b.send({ source: b.popup, origin, data: { ckSession: "synthetic-fresh" } });
    const invalid = b.calls.find((call) => call.route === "invalid"); assert.ok(invalid);
    assert.equal(invalid.body!.includes("synthetic-fresh"), false);
    assert.equal(JSON.parse(invalid.body!).callbackHost, undefined);
  }
});
