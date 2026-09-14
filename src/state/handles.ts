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
  readonly derivedHandles?: readonly string[];
}

interface BoundGroupItem<T> { readonly context: HandleContext; readonly value: T }

/** Bounded in-process registry that never exposes raw provider cursors or identifiers. */
export class HandleRegistry {
  readonly #secret: Buffer;
  readonly #entries = new Map<string, HandleEntry<unknown>>();
  readonly #derived = new Map<string, { readonly parent: string; readonly index: number }>();
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
    return this.issueBatch([{ kind, context, value }])[0]!;
  }

  /** Atomically stores a bounded group so projection cannot leak a partial page of handles. */
  issueBatch<T>(items: readonly { readonly kind: string; readonly context: HandleContext; readonly value: T }[]): readonly string[] {
    this.#purgeExpired();
    const prepared = items.map(({ kind, context, value }) => {
      const estimatedBytes = Buffer.byteLength(JSON.stringify({ context, value }), "utf8");
      const nonce = randomBytes(18).toString("base64url");
      const digest = createHmac("sha256", this.#secret).update(`${kind}\0${nonce}`).digest("base64url").slice(0, 24);
      return { handle: `${kind}_${nonce}.${digest}`, context, value, estimatedBytes };
    });
    const addedBytes = prepared.reduce((sum, item) => sum + item.estimatedBytes, 0);
    if (prepared.some((item) => item.estimatedBytes > this.maximumBytes) || this.#entries.size + prepared.length > this.maximumEntries || this.#totalBytes + addedBytes > this.maximumBytes) {
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
    const createdAt = this.now();
    for (const item of prepared) this.#entries.set(item.handle, { context: item.context, value: item.value, createdAt, expiresAt: createdAt + this.lifetimeMilliseconds, estimatedBytes: item.estimatedBytes });
    this.#totalBytes += addedBytes;
    return prepared.map((item) => item.handle);
  }

  /** Returns an opaque observation identity without consuming retrievable registry capacity. */
  issueObservation(kind: string, context: HandleContext): string {
    const nonce = randomBytes(18).toString("base64url");
    const digest = createHmac("sha256", this.#secret).update(`${kind}\0${nonce}\0${JSON.stringify(context)}`).digest("base64url").slice(0, 24);
    return `${kind}_${nonce}.${digest}`;
  }

  /** Stores many independently bound identities in one bounded registry entry. */
  issueBoundBatch<T>(kind: string, items: readonly BoundGroupItem<T>[]): readonly string[] {
    if (items.length === 0) return [];
    this.#purgeExpired();
    const parentNonce = randomBytes(18).toString("base64url");
    const parent = `group_${parentNonce}`;
    const handles = items.map((item, index) => {
      const nonce = randomBytes(12).toString("base64url");
      const digest = createHmac("sha256", this.#secret).update(`${kind}\0${parent}\0${index}\0${nonce}\0${JSON.stringify(item.context)}`).digest("base64url").slice(0, 24);
      return `${kind}_${nonce}.${digest}`;
    });
    const estimatedBytes = Buffer.byteLength(JSON.stringify({ items, handles }), "utf8");
    if (estimatedBytes > this.maximumBytes || this.#entries.size >= this.maximumEntries || this.#totalBytes + estimatedBytes > this.maximumBytes) throw registryBound();
    const createdAt = this.now();
    this.#entries.set(parent, { context: items[0]!.context, value: items, createdAt, expiresAt: createdAt + this.lifetimeMilliseconds, estimatedBytes, derivedHandles: handles });
    handles.forEach((handle, index) => this.#derived.set(handle, { parent, index }));
    this.#totalBytes += estimatedBytes;
    return handles;
  }

  /** Resolves an issued value only when every context dimension still matches. */
  resolve<T>(handle: string, expected: HandleContext): T {
    const found = this.#lookup(handle);
    if (found && found.entry.expiresAt <= this.now()) {
      this.#remove(found.key, found.entry);
      throw expiredHandle();
    }
    this.#purgeExpired();
    if (!found) {
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
    if (JSON.stringify(found.context) !== JSON.stringify(expected)) {
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
    return found.value as T;
  }

  /** Resolves a discovered identity while binding every non-identity context dimension. */
  resolveBound<T>(handle: string, expected: Omit<HandleContext, "zoneOwner" | "zoneName">): T {
    const found = this.#lookup(handle);
    if (found && found.entry.expiresAt <= this.now()) {
      this.#remove(found.key, found.entry);
      throw expiredHandle();
    }
    this.#purgeExpired();
    if (!found) throw safeError({ code: "cursorInvalid", message: "The opaque handle is invalid or expired.", execution: "notStarted", sessionEffect: "unchanged", retryable: false, retryConditions: [], nextStep: "Repeat the bounded discovery operation to obtain a fresh handle." });
    for (const [key, value] of Object.entries(expected)) {
      if (found.context[key as keyof HandleContext] !== value) throw safeError({ code: "cursorContextMismatch", message: "The opaque handle does not belong to this diagnostic context.", execution: "notStarted", sessionEffect: "unchanged", retryable: false, retryConditions: [], nextStep: "Use a handle issued for the same profile, principal epoch, scope, operation, and selector." });
    }
    return found.value as T;
  }

  /** Removes one handle when its diagnostic is complete. */
  release(handle: string): void {
    const found = this.#lookup(handle);
    if (found) this.#remove(found.key, found.entry);
  }

  #purgeExpired(): void {
    const now = this.now();
    for (const [handle, entry] of this.#entries) {
      if (entry.expiresAt <= now) {
        this.#remove(handle, entry);
      }
    }
  }

  #remove(handle: string, entry: HandleEntry<unknown>): void {
    for (const derived of entry.derivedHandles ?? []) this.#derived.delete(derived);
    this.#totalBytes -= entry.estimatedBytes;
    this.#entries.delete(handle);
  }

  #lookup(handle: string): { readonly key: string; readonly entry: HandleEntry<unknown>; readonly context: HandleContext; readonly value: unknown } | undefined {
    const direct = this.#entries.get(handle);
    if (direct) return { key: handle, entry: direct, context: direct.context, value: direct.value };
    const derived = this.#derived.get(handle);
    const parent = derived ? this.#entries.get(derived.parent) : undefined;
    const item = parent && derived ? (parent.value as readonly BoundGroupItem<unknown>[])[derived.index] : undefined;
    return parent && derived && item ? { key: derived.parent, entry: parent, context: item.context, value: item.value } : undefined;
  }
}

function expiredHandle() {
  return safeError({ code: "cursorExpired", message: "The opaque handle has expired.", execution: "notStarted", sessionEffect: "unchanged", retryable: false, retryConditions: [], nextStep: "Repeat the bounded discovery operation to obtain a fresh handle or baseline." });
}

function registryBound() {
  return safeError({ code: "outputBoundExceeded", message: "The opaque handle registry has reached its configured bound.", execution: "completed", sessionEffect: "unchanged", retryable: true, retryConditions: ["Previously issued handles expire or are released."], nextStep: "Finish or narrow the diagnostic and retry after unused handles expire." });
}
