import { createHmac, randomBytes } from "node:crypto";
import { safeError } from "../errors.js";

/** Context that must match before an opaque value may be reused. */
export interface HandleContext {
  readonly principalEpoch: string;
  readonly profileId: string;
  readonly containerId: string;
  readonly environment: "development" | "production";
  readonly scope: "public" | "private" | "shared";
  readonly backend: "web-services";
  readonly operation: string;
  readonly selectorDigest: string;
  readonly zoneOwner?: string;
  readonly zoneName?: string;
}

interface HandleEntry<T> {
  readonly context: HandleContext;
  readonly value: T;
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly estimatedBytes: number;
}

/** Bounded in-process registry that never exposes raw provider cursors or identifiers. */
export class HandleRegistry {
  readonly #secret: Buffer;
  readonly #entries = new Map<string, HandleEntry<unknown>>();
  #totalBytes = 0;

  constructor(
    private readonly now: () => number = Date.now,
    private readonly maximumEntries = 128,
    private readonly maximumBytes = 4 * 1024 * 1024,
    private readonly lifetimeMilliseconds = 15 * 60 * 1000,
  ) {
    this.#secret = randomBytes(32);
  }

  /** Stores a provider value and returns an unguessable process-local handle. */
  issue<T>(kind: string, context: HandleContext, value: T): string {
    this.#purgeExpired();
    const estimatedBytes = Buffer.byteLength(JSON.stringify({ context, value }), "utf8");
    if (estimatedBytes > this.maximumBytes || this.#entries.size >= this.maximumEntries || this.#totalBytes + estimatedBytes > this.maximumBytes) {
      throw safeError({
        code: "outputBoundExceeded",
        message: "The opaque handle registry has reached its configured bound.",
        execution: "completed",
        sessionEffect: "unchanged",
        retryable: true,
        retryConditions: ["Previously issued handles expire or are released."],
        nextStep: "Finish or narrow the diagnostic and retry after unused handles expire.",
      });
    }
    const nonce = randomBytes(18).toString("base64url");
    const digest = createHmac("sha256", this.#secret).update(`${kind}\0${nonce}`).digest("base64url").slice(0, 24);
    const handle = `${kind}_${nonce}.${digest}`;
    const createdAt = this.now();
    this.#entries.set(handle, { context, value, createdAt, expiresAt: createdAt + this.lifetimeMilliseconds, estimatedBytes });
    this.#totalBytes += estimatedBytes;
    return handle;
  }

  /** Returns an opaque observation identity without consuming retrievable registry capacity. */
  issueObservation(kind: string, context: HandleContext): string {
    const nonce = randomBytes(18).toString("base64url");
    const digest = createHmac("sha256", this.#secret).update(`${kind}\0${nonce}\0${JSON.stringify(context)}`).digest("base64url").slice(0, 24);
    return `${kind}_${nonce}.${digest}`;
  }

  /** Resolves an issued value only when every context dimension still matches. */
  resolve<T>(handle: string, expected: HandleContext): T {
    this.#purgeExpired();
    const entry = this.#entries.get(handle);
    if (!entry) {
      throw safeError({
        code: "cursorInvalid",
        message: "The opaque handle is invalid or expired.",
        execution: "notStarted",
        sessionEffect: "unchanged",
        retryable: false,
        retryConditions: [],
        nextStep: "Repeat the bounded discovery operation to obtain a fresh handle.",
      });
    }
    if (JSON.stringify(entry.context) !== JSON.stringify(expected)) {
      throw safeError({
        code: "cursorContextMismatch",
        message: "The opaque handle does not belong to this diagnostic context.",
        execution: "notStarted",
        sessionEffect: "unchanged",
        retryable: false,
        retryConditions: [],
        nextStep: "Use a handle issued for the same profile, principal epoch, scope, zone, operation, and selector.",
      });
    }
    return entry.value as T;
  }

  /** Resolves a discovered identity while binding every non-identity context dimension. */
  resolveBound<T>(handle: string, expected: Omit<HandleContext, "zoneOwner" | "zoneName">): T {
    this.#purgeExpired();
    const entry = this.#entries.get(handle);
    if (!entry) throw safeError({ code: "cursorInvalid", message: "The opaque handle is invalid or expired.", execution: "notStarted", sessionEffect: "unchanged", retryable: false, retryConditions: [], nextStep: "Repeat the bounded discovery operation to obtain a fresh handle." });
    for (const [key, value] of Object.entries(expected)) {
      if (entry.context[key as keyof HandleContext] !== value) throw safeError({ code: "cursorContextMismatch", message: "The opaque handle does not belong to this diagnostic context.", execution: "notStarted", sessionEffect: "unchanged", retryable: false, retryConditions: [], nextStep: "Use a handle issued for the same profile, principal epoch, scope, operation, and selector." });
    }
    return entry.value as T;
  }

  /** Removes one handle when its diagnostic is complete. */
  release(handle: string): void {
    const entry = this.#entries.get(handle);
    if (entry) {
      this.#totalBytes -= entry.estimatedBytes;
      this.#entries.delete(handle);
    }
  }

  #purgeExpired(): void {
    const now = this.now();
    for (const [handle, entry] of this.#entries) {
      if (entry.expiresAt <= now) {
        this.#totalBytes -= entry.estimatedBytes;
        this.#entries.delete(handle);
      }
    }
  }
}
