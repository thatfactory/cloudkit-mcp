import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Profile } from "../domain/types.js";
import { CloudKitTransport } from "../api/transport.js";
import type { WebUserCredential } from "./credential-store.js";
import { callbackOriginClasses, publicAppleHost, RecoveryFailure, type CallbackOrigin } from "./recovery-types.js";

export interface RecoveryProvider {
  authorize(profile: Profile, credential: WebUserCredential, signal: AbortSignal, awaitingUser: () => Promise<void>): Promise<{ token: string; origin?: string }>;
}

export type BrowserOpener = (localPage: string) => Promise<void>;

/** Only a token-free loopback page is passed to the OS, never Apple's authorization URL. */
export const openLocalBrowser: BrowserOpener = async (localPage) => {
  if (process.platform !== "darwin" && (!process.env.DISPLAY && !process.env.WAYLAND_DISPLAY)) throw new RecoveryFailure("browserUnavailable");
  try { await promisify(execFile)(process.platform === "darwin" ? "open" : "xdg-open", [localPage], { timeout: 10_000 }); }
  catch { throw new RecoveryFailure("browserUnavailable"); }
};

/** A single-use, bounded localhost receiver. Apple credentials exist only in volatile memory. */
export class PostMessageProvider implements RecoveryProvider {
  constructor(private readonly transport: CloudKitTransport, private readonly port = 0, private readonly openBrowser = openLocalBrowser) {}

  async authorize(profile: Profile, credential: WebUserCredential, signal: AbortSignal, awaitingUser: () => Promise<void>): Promise<{ token: string; origin: string }> {
    const [html, script] = await Promise.all([
      readFile(new URL("../../resources/recovery-page.html", import.meta.url), "utf8"),
      readFile(new URL("../../resources/recovery-page.js", import.meta.url), "utf8"),
    ]);
    const path = `/${randomBytes(24).toString("hex")}/`;
    let resolveToken!: (token: string) => void;
    let rejectToken!: (error: unknown) => void;
    const tokenPromise = new Promise<string>((resolve, reject) => { resolveToken = resolve; rejectToken = reject; });
    // A provider failure may happen before awaiting this promise.
    void tokenPromise.catch(() => {});
    let origin = "";
    let challenge: { url: string; origin: string } | undefined;
    let settled = false;
    const fail = (reason: "operatorCancelled" | "invalidCallback" | "callbackOriginMismatch" | "authorizationFailed", callbackOrigin?: CallbackOrigin, callbackHost?: string) => { if (!settled) { settled = true; rejectToken(new RecoveryFailure(reason, callbackOrigin, callbackHost)); } };
    const server = createServer((request, response) => { void handle(request, response).catch(() => { fail("invalidCallback"); if (!response.headersSent) response.writeHead(400); response.end(); }); });
    server.requestTimeout = 5_000;
    server.headersTimeout = 5_000;
    server.maxConnections = 8;
    const handle = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
      response.setHeader("Cache-Control", "no-store");
      response.setHeader("Referrer-Policy", "no-referrer");
      response.setHeader("X-Content-Type-Options", "nosniff");
      response.setHeader("Content-Security-Policy", "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
      if (request.headers.host !== origin.slice(7) || !request.url?.startsWith(path) || request.headers["sec-fetch-site"] === "cross-site") { response.writeHead(403).end(); return; }
      const route = request.url.slice(path.length);
      if (request.method === "GET" && route === "") { response.setHeader("Content-Type", "text/html; charset=utf-8"); response.end(html); return; }
      if (request.method === "GET" && route === "client.js") { response.setHeader("Content-Type", "text/javascript; charset=utf-8"); response.end(script); return; }
      if (request.method === "GET" && route === "challenge" && challenge && !settled) { response.setHeader("Content-Type", "application/json"); response.end(JSON.stringify({ ...challenge, callbackOrigins: [challenge.origin, "https://api.apple-cloudkit.com"], profileId: profile.id, environment: profile.environment })); return; }
      if (request.method !== "POST" || request.headers.origin !== origin || !["token", "cancel", "invalid"].includes(route)) { response.writeHead(403).end(); return; }
      if (settled) { response.writeHead(409).end(); return; }
      if (route === "cancel") { response.writeHead(204).end(); fail("operatorCancelled"); return; }
      if (route === "invalid" && request.headers["content-type"] !== "application/json") { response.writeHead(204).end(); fail("invalidCallback"); return; }
      if (request.headers["content-type"] !== "application/json") { response.writeHead(415).end(); fail("invalidCallback"); return; }
      const chunks: Buffer[] = []; let size = 0;
      for await (const chunk of request) {
        const bytes = Buffer.from(chunk as Buffer); size += bytes.byteLength;
        if (size > 16 * 1024) { response.writeHead(413).end(); request.destroy(); fail("invalidCallback"); return; }
        chunks.push(bytes);
      }
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
      if (route === "invalid") {
        const originClass = callbackOriginClasses.some((kind) => kind === body.originClass) ? body.originClass as CallbackOrigin : "other";
        response.writeHead(204).end(); fail(body.check === "origin" ? "callbackOriginMismatch" : body.check === "provider" ? "authorizationFailed" : "invalidCallback", originClass, publicAppleHost(body.callbackHost) ? body.callbackHost : undefined); return;
      }
      if (Object.keys(body).length !== 1 || typeof body.token !== "string" || body.token.length < 1 || body.token.length > 4096) { response.writeHead(400).end(); fail("invalidCallback"); return; }
      if (settled || signal.aborted) { response.writeHead(409).end(); return; }
      settled = true;
      response.writeHead(204).end();
      resolveToken(body.token);
    };
    const abort = () => rejectToken(new RecoveryFailure("interrupted"));
    signal.addEventListener("abort", abort, { once: true });
    try {
      if (signal.aborted) throw new RecoveryFailure("interrupted");
      try { await new Promise<void>((done, reject) => { server.once("error", reject); server.listen(this.port, "127.0.0.1", () => { server.off("error", reject); done(); }); }); }
      catch { throw new RecoveryFailure("browserUnavailable"); }
      const address = server.address();
      if (!address || typeof address === "string") throw new RecoveryFailure("browserUnavailable");
      origin = new URL(`http://127.0.0.1:${address.port}`).origin;
      challenge = await this.transport.authorizationChallenge({ containerId: profile.containerId, environment: profile.environment }, credential.apiToken, origin, signal);
      await awaitingUser();
      await this.openBrowser(`${origin}${path}`);
      return { token: await tokenPromise, origin };
    } finally {
      signal.removeEventListener("abort", abort);
      challenge = undefined;
      server.closeAllConnections();
      await new Promise<void>((done) => server.close(() => done()));
    }
  }
}
