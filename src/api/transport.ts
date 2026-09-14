import { TextDecoder } from "node:util";
import { CloudKitMCPError, safeError, type SafeError } from "../errors.js";
import type { AuthenticationMode, DatabaseScope } from "../domain/types.js";
import { operationPolicy, type OperationId } from "./operations.js";
import { signServerKeyRequest, type ServerKeyCredential } from "./signing.js";

const CLOUDKIT_ORIGIN = "https://api.apple-cloudkit.com";
const identifierPattern = /^[A-Za-z0-9._:-]+$/;

/** Credential material available only inside the transport boundary. */
export type TransportCredential =
  | { readonly mode: "server-key"; readonly serverKey: ServerKeyCredential }
  | { readonly mode: "api-token-public"; readonly apiToken: string }
  | { readonly mode: "web-user"; readonly apiToken: string; readonly webAuthenticationToken: string };

/** Validated request context for a registered operation. */
export interface TransportContext {
  readonly containerId: string;
  readonly environment: "development" | "production";
  readonly scope: DatabaseScope;
}

/** Transport outcome including a possible rotating replacement token. */
export interface TransportResult {
  readonly body: unknown;
  readonly status: number;
  readonly replacementWebAuthenticationToken?: string;
  readonly error?: SafeError;
}

/** Injectable fetch subset used by deterministic tests. */
export type FetchTransport = (input: string | URL, init?: RequestInit) => Promise<Response>;

/** Executes only closed, read-only CloudKit Web Services operations with strict bounds. */
export class CloudKitTransport {
  readonly #semaphore = new Semaphore(4, 32);

  constructor(
    private readonly fetchTransport: FetchTransport = fetch,
    private readonly now: () => Date = () => new Date(),
    private readonly requestTimeoutMilliseconds = 15_000,
    private readonly maximumResponseBytes = 4 * 1024 * 1024,
  ) {}

  /** Performs one registered request and validates its bounded JSON response. */
  async execute(
    operationId: OperationId,
    context: TransportContext,
    credential: TransportCredential,
    body: unknown,
    parentSignal?: AbortSignal,
  ): Promise<TransportResult> {
    const policy = operationPolicy(operationId);
    validateContext(context);
    authorize(policy.authenticationModes, policy.documentedScopes, policy.unverifiedScopes, context.scope, credential.mode);
    const release = await this.#semaphore.acquire(parentSignal);
    try {
    if (parentSignal?.aborted) throw queueError("cancelled", "The CloudKit read was cancelled before dispatch.", false);
    const encodedBody = policy.method === "POST" ? Buffer.from(JSON.stringify(body ?? {}), "utf8") : Buffer.alloc(0);
    if (encodedBody.byteLength > 64 * 1024) {
      throw safeError({
        code: "invalidInput",
        message: "The upstream request exceeds the configured input bound.",
        execution: "notStarted",
        sessionEffect: "unchanged",
        retryable: false,
        retryConditions: [],
        nextStep: "Reduce record names, filters, fields, or other bounded inputs.",
      });
    }
    const url = buildURL(policy.path, context, credential);
    const headers: Record<string, string> = { Accept: "application/json" };
    if (policy.method === "POST") headers["Content-Type"] = "application/json";
    if (credential.mode === "server-key") {
      Object.assign(headers, signServerKeyRequest(credential.serverKey, encodedBody, `${url.pathname}${url.search}`, this.now()));
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort("deadline"), this.requestTimeoutMilliseconds);
    const abort = (): void => controller.abort(parentSignal?.reason);
    parentSignal?.addEventListener("abort", abort, { once: true });
    if (parentSignal?.aborted) controller.abort(parentSignal.reason);
    try {
      let response: Response;
      try {
        if (controller.signal.aborted) throw queueError("cancelled", "The CloudKit read was cancelled before dispatch.", false);
        response = await this.fetchTransport(url, {
          method: policy.method,
          headers,
          ...(policy.method === "POST" ? { body: encodedBody } : {}),
          redirect: "manual",
          signal: controller.signal,
        });
      } catch (error) {
        if (error instanceof CloudKitMCPError) throw error;
        throw safeError({
          code: parentSignal?.aborted ? "cancelled" : "timeout",
          message: parentSignal?.aborted ? "The CloudKit read was cancelled." : "The CloudKit read did not produce a bounded response.",
          execution: "uncertain",
          sessionEffect: credential.mode === "web-user" ? "uncertain" : "unchanged",
          retryable: credential.mode !== "web-user",
          retryConditions: credential.mode === "web-user" ? [] : ["The operation deadline permits one retry."],
          nextStep: credential.mode === "web-user" ? "Reauthenticate this credential slot before another request." : "Retry once when provider guidance and the remaining deadline permit it.",
        });
      }
      if (response.status >= 300 && response.status < 400) {
        throw safeError({
          code: "malformedResponse",
          message: "CloudKit returned a redirect, which this transport never follows.",
          execution: "completed",
          sessionEffect: credential.mode === "web-user" ? "uncertain" : "unchanged",
          retryable: false,
          retryConditions: [],
          nextStep: "Verify the fixed CloudKit endpoint and authentication configuration.",
        });
      }
      const bytes = await readBoundedBody(response, this.maximumResponseBytes, controller.signal, credential.mode === "web-user", parentSignal);
      const parsed = parseJson(bytes, credential.mode === "web-user");
      const replacement = extractReplacementToken(response, parsed);
      const apiTokenAuthenticationChallenge = operationId === "probeCurrentUser"
        && credential.mode === "api-token-public"
        && response.status === 421
        && isAuthenticationChallenge(parsed);
      return {
        body: parsed,
        status: response.status,
        ...(replacement === undefined ? {} : { replacementWebAuthenticationToken: replacement }),
        ...(response.ok || apiTokenAuthenticationChallenge ? {} : { error: classifyHttpError(response.status, credential.mode, replacement !== undefined).toSafeObject() }),
      };
    } finally {
      clearTimeout(timer);
      parentSignal?.removeEventListener("abort", abort);
    }
    } finally {
      release();
    }
  }
}

function isAuthenticationChallenge(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const object = value as Record<string, unknown>;
  return object.serverErrorCode === "AUTHENTICATION_REQUIRED" && typeof object.redirectURL === "string" && object.redirectURL.length > 0;
}

/** Small cancellable semaphore with a bounded pending queue. */
class Semaphore {
  #active = 0;
  readonly #queue: Array<{ readonly resolve: (release: () => void) => void; readonly reject: (error: unknown) => void; readonly signal?: AbortSignal; abort?: () => void }> = [];

  constructor(private readonly maximumActive: number, private readonly maximumPending: number) {}

  async acquire(signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) throw queueError("cancelled", "The queued CloudKit read was cancelled.", false);
    if (this.#active < this.maximumActive) {
      this.#active += 1;
      return this.#releaseFunction();
    }
    if (this.#queue.length >= this.maximumPending) throw queueError("queueExhausted", "The CloudKit request queue is full.", true);
    return new Promise((resolvePromise, reject) => {
      const entry: { resolve: (release: () => void) => void; reject: (error: unknown) => void; signal?: AbortSignal; abort?: () => void } = { resolve: resolvePromise, reject, ...(signal ? { signal } : {}) };
      this.#queue.push(entry);
      const abort = (): void => {
        const index = this.#queue.indexOf(entry);
        if (index >= 0) {
          this.#queue.splice(index, 1);
          reject(queueError("cancelled", "The queued CloudKit read was cancelled.", false));
        }
      };
      entry.abort = abort;
      signal?.addEventListener("abort", abort, { once: true });
    });
  }

  #releaseFunction(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.#queue.shift();
      if (next) {
        if (next.signal && next.abort) next.signal.removeEventListener("abort", next.abort);
        next.resolve(this.#releaseFunction());
      }
      else this.#active -= 1;
    };
  }
}

function queueError(code: "cancelled" | "queueExhausted", message: string, retryable: boolean) {
  return safeError({ code, message, execution: "notStarted", sessionEffect: "unchanged", retryable, retryConditions: retryable ? ["An active bounded request completes."] : [], nextStep: retryable ? "Retry after an active diagnostic completes." : "Issue a new request only if the diagnostic is still wanted." });
}

function validateContext(context: TransportContext): void {
  if (!/^iCloud\.[A-Za-z0-9.-]+$/.test(context.containerId) || !identifierPattern.test(context.environment) || !identifierPattern.test(context.scope)) {
    throw safeError({
      code: "invalidInput",
      message: "The CloudKit context contains an invalid identifier.",
      execution: "notStarted",
      sessionEffect: "unchanged",
      retryable: false,
      retryConditions: [],
      nextStep: "Use a validated configured container, environment, and scope.",
    });
  }
}

function authorize(
  modes: readonly AuthenticationMode[],
  documented: readonly DatabaseScope[],
  unverified: readonly DatabaseScope[],
  scope: DatabaseScope,
  mode: AuthenticationMode,
): void {
  if (!modes.includes(mode)) {
    throw safeError({ code: "authenticationRequired", message: "This credential class cannot authorize the selected operation.", execution: "notStarted", sessionEffect: "unchanged", retryable: false, retryConditions: [], nextStep: "Select a profile with the operation's documented credential class." });
  }
  if (unverified.includes(scope)) {
    throw safeError({ code: "unverifiedCapability", message: "This operation and database scope have not passed the required live capability gate.", execution: "notStarted", sessionEffect: "unchanged", retryable: false, retryConditions: [], nextStep: "Run the operator acceptance harness against a dedicated synthetic container before enabling this scope." });
  }
  if (!documented.includes(scope)) {
    throw safeError({ code: "unsupportedCapability", message: "The selected operation is not supported for this database scope.", execution: "notStarted", sessionEffect: "unchanged", retryable: false, retryConditions: [], nextStep: "Choose a documented scope or use the named selector workflow described by get_context." });
  }
}

function buildURL(pathTemplate: string, context: TransportContext, credential: TransportCredential): URL {
  const operationPath = pathTemplate.replace("{scope}", encodeURIComponent(context.scope));
  const url = new URL(`/database/1/${encodeURIComponent(context.containerId)}/${encodeURIComponent(context.environment)}${operationPath}`, CLOUDKIT_ORIGIN);
  if (credential.mode === "api-token-public" || credential.mode === "web-user") url.searchParams.set("ckAPIToken", credential.apiToken);
  if (credential.mode === "web-user") url.searchParams.set("ckSession", credential.webAuthenticationToken);
  if (url.origin !== CLOUDKIT_ORIGIN || url.username || url.password || url.port || url.hash) throw new Error("invariant violation");
  return url;
}

async function readBoundedBody(response: Response, maximumBytes: number, signal: AbortSignal, rotatingSession: boolean, parentSignal?: AbortSignal): Promise<Uint8Array> {
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let total = 0;
  const abort = (): void => { void reader.cancel(signal.reason).catch(() => undefined); };
  signal.addEventListener("abort", abort, { once: true });
  try {
    while (true) {
      if (signal.aborted) throw bodyReadAbort(parentSignal?.aborted === true, rotatingSession);
      const { done, value } = await reader.read();
      if (signal.aborted) throw bodyReadAbort(parentSignal?.aborted === true, rotatingSession);
      if (done) break;
      total += value.byteLength;
      if (total > maximumBytes) {
        await reader.cancel();
        throw safeError({ code: "responseBoundExceeded", message: "CloudKit returned more data than the configured response bound.", execution: "completed", sessionEffect: rotatingSession ? "uncertain" : "unchanged", retryable: false, retryConditions: [], nextStep: "Narrow the request or reduce the page size." });
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof CloudKitMCPError) throw error;
    if (signal.aborted) throw bodyReadAbort(parentSignal?.aborted === true, rotatingSession);
    throw safeError({ code: "malformedResponse", message: "CloudKit ended the response body unexpectedly.", execution: "uncertain", sessionEffect: rotatingSession ? "uncertain" : "unchanged", retryable: false, retryConditions: [], nextStep: rotatingSession ? "Reauthenticate this credential slot before another request." : "Inspect privacy-safe diagnostics and provider status." });
  } finally {
    signal.removeEventListener("abort", abort);
    reader.releaseLock();
  }
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

function bodyReadAbort(cancelled: boolean, rotatingSession: boolean): CloudKitMCPError {
  return safeError({
    code: cancelled ? "cancelled" : "timeout",
    message: cancelled ? "The CloudKit response read was cancelled." : "The CloudKit response did not complete before the deadline.",
    execution: "uncertain",
    sessionEffect: rotatingSession ? "uncertain" : "unchanged",
    retryable: false,
    retryConditions: [],
    nextStep: rotatingSession ? "Reauthenticate this credential slot before another request." : "Issue a new request only if the diagnostic is still required.",
  });
}

function parseJson(bytes: Uint8Array, rotatingSession: boolean): unknown {
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return text.length === 0 ? {} : JSON.parse(text);
  } catch {
    throw safeError({ code: "malformedResponse", message: "CloudKit returned an invalid bounded JSON response.", execution: "completed", sessionEffect: rotatingSession ? "uncertain" : "unchanged", retryable: false, retryConditions: [], nextStep: rotatingSession ? "Reauthenticate this credential slot before another request." : "Inspect privacy-safe diagnostics and provider status." });
  }
}

function extractReplacementToken(response: Response, body: unknown): string | undefined {
  const header = response.headers.get("x-apple-cloudkit-web-auth-token");
  if (header && header.length <= 4096) return header;
  if (typeof body === "object" && body !== null && "ckWebAuthToken" in body) {
    const token = (body as { ckWebAuthToken?: unknown }).ckWebAuthToken;
    if (typeof token === "string" && token.length > 0 && token.length <= 4096) return token;
  }
  return undefined;
}

function classifyHttpError(status: number, mode: AuthenticationMode, replacementReceived: boolean) {
  if (status === 401) return safeError({ code: "authenticationExpired", message: "CloudKit rejected the configured authentication.", execution: "completed", sessionEffect: mode === "web-user" && !replacementReceived ? "uncertain" : "unchanged", retryable: false, retryConditions: [], nextStep: "Reauthenticate the selected credential slot." });
  if (status === 403) return safeError({ code: "permissionDenied", message: "The authenticated principal is not permitted to perform this read in the selected view.", execution: "completed", sessionEffect: mode === "web-user" && !replacementReceived ? "uncertain" : "unchanged", retryable: false, retryConditions: [], nextStep: "Verify the profile scope and CloudKit sharing permission without changing credentials automatically." });
  if (status === 429) return safeError({ code: "rateLimited", message: "CloudKit rate-limited the read.", execution: "completed", sessionEffect: mode === "web-user" && !replacementReceived ? "uncertain" : "unchanged", retryable: false, retryConditions: [], nextStep: mode === "web-user" ? "Reauthenticate before issuing a new request because token rotation is not established." : "Issue a new request only after a separately verified provider delay and while the diagnostic is still required." });
  return safeError({ code: "partialFailure", message: "CloudKit returned a provider failure without safe detail disclosure.", execution: "completed", sessionEffect: mode === "web-user" && !replacementReceived ? "uncertain" : "unchanged", retryable: false, retryConditions: [], nextStep: "Inspect privacy-safe status diagnostics and narrow the operation." });
}
