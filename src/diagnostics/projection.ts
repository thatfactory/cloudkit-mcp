import { createHash } from "node:crypto";
import type { Profile, ProjectedField, RecordObservation, SafeJsonValue, ZoneIdentity } from "../domain/types.js";
import { safeError } from "../errors.js";
import type { HandleContext } from "../state/handles.js";
import { HandleRegistry } from "../state/handles.js";

/** Minimal CloudKit wire record accepted by the projection boundary. */
export interface WireRecord {
  readonly recordName?: unknown;
  readonly recordType?: unknown;
  readonly recordChangeTag?: unknown;
  readonly created?: unknown;
  readonly modified?: unknown;
  readonly deleted?: unknown;
  readonly fields?: unknown;
  readonly zoneID?: unknown;
  readonly serverErrorCode?: unknown;
}

/** Produces a stable selector digest without exposing its values. */
export function selectorDigest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("base64url");
}

/** Projects one record into metadata-only or explicitly allowed selected fields. */
export function projectRecord(
  wire: WireRecord,
  profile: Profile,
  zone: ZoneIdentity,
  registry: HandleRegistry,
  handleContext: HandleContext,
  requestedFields: readonly string[] = [],
  payloadBudget: { remainingBytes: number } = { remainingBytes: 64 * 1024 },
): RecordObservation {
  const code = boundedString(wire.serverErrorCode, 128);
  const observationContext = { ...handleContext, zoneOwner: zone.ownerRecordName, zoneName: zone.zoneName };
  if (code) return { handle: registry.issueObservation("record", observationContext), outcome: classifyOutcome(code), deleted: "unknown" };
  const recordName = boundedString(wire.recordName, 1024);
  if (!recordName) {
    throw safeError({ code: "malformedResponse", message: "CloudKit returned a successful record item without a bounded record identity.", execution: "completed", sessionEffect: "unchanged", retryable: false, retryConditions: [], nextStep: "Inspect provider compatibility using privacy-safe contract diagnostics." });
  }
  const handle = registry.issueObservation("record", observationContext);
  const recordType = boundedString(wire.recordType, 255);
  const changeTag = boundedString(wire.recordChangeTag, 1024);
  const createdAt = extractTimestamp(wire.created);
  const modifiedAt = extractTimestamp(wire.modified);
  const output: RecordObservation = {
    handle,
    ...(profile.recordPolicy.discloseRecordNames ? { recordName } : {}),
    outcome: "present",
    deleted: wire.deleted === true ? "observed" : wire.deleted === false ? "notObserved" : "unknown",
    ...(recordType ? { recordType } : {}),
    ...(changeTag ? { changeTag } : {}),
    ...(createdAt ? { createdAt } : {}),
    ...(modifiedAt ? { modifiedAt } : {}),
  };
  if (requestedFields.length === 0) return output;
  const allowed = new Set(profile.recordPolicy.readablePayloadFields);
  const fields = typeof wire.fields === "object" && wire.fields !== null ? wire.fields as Record<string, unknown> : {};
  const projected: Record<string, ProjectedField> = {};
  let totalBytes = 0;
  for (const field of requestedFields) {
    if (!allowed.has(field)) {
      throw safeError({ code: "disallowedScope", message: "A requested payload field is not authorized by startup policy.", execution: "notStarted", sessionEffect: "unchanged", retryable: false, retryConditions: [], nextStep: "Request only fields listed by get_context." });
    }
    if (!(field in fields)) {
      projected[field] = { state: "unavailable" };
      continue;
    }
    const fieldObject = fields[field];
    const rawValue = typeof fieldObject === "object" && fieldObject !== null && "value" in fieldObject ? (fieldObject as { value: unknown }).value : undefined;
    if (rawValue === undefined) {
      projected[field] = { state: "unavailable" };
      continue;
    }
    if (requiresWholeFieldRedaction(rawValue)) {
      projected[field] = { state: "redacted" };
      continue;
    }
    const value = safeJson(rawValue, 0);
    const bytes = Buffer.byteLength(JSON.stringify(value), "utf8");
    totalBytes += bytes;
    if (bytes > 64 * 1024 || totalBytes > 64 * 1024 || bytes > payloadBudget.remainingBytes) throw safeError({ code: "outputBoundExceeded", message: "Selected payload fields exceed the configured output bound.", execution: "completed", sessionEffect: "unchanged", retryable: false, retryConditions: [], nextStep: "Request fewer or smaller fields." });
    payloadBudget.remainingBytes -= bytes;
    projected[field] = { state: "returned", value };
  }
  return { ...output, fields: projected };
}

function classifyOutcome(code: string | undefined): RecordObservation["outcome"] {
  if (code === "NOT_FOUND") return "notFoundInView";
  if (code === "ACCESS_DENIED" || code === "AUTHENTICATION_REQUIRED") return "inaccessible";
  return "unknown";
}

function boundedString(value: unknown, maximum: number): string | undefined {
  return typeof value === "string" && value.length <= maximum ? value : undefined;
}

function extractTimestamp(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null || !("timestamp" in value)) return undefined;
  const rawTimestamp = (value as { timestamp?: unknown }).timestamp;
  const timestamp = typeof rawTimestamp === "number"
    ? rawTimestamp
    : typeof rawTimestamp === "string" && /^-?\d+$/.test(rawTimestamp) ? Number(rawTimestamp) : Number.NaN;
  if (!Number.isSafeInteger(timestamp)) return undefined;
  const date = new Date(timestamp);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function safeJson(value: unknown, depth: number): SafeJsonValue {
  if (depth > 6) throw projectionBound("Selected payload nesting exceeds the configured bound.");
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") {
    if (Buffer.byteLength(value, "utf8") > 4096) throw projectionBound("A selected payload string exceeds the configured bound.");
    if (/^(?:https?:\/\/|[A-Za-z0-9+/]{80,}={0,2}$)/.test(value)) return "[redacted]";
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value) || Number.isInteger(value) && !Number.isSafeInteger(value)) throw malformedNumericValue();
    return value;
  }
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) {
    if (value.length > 100) throw projectionBound("A selected payload array exceeds the configured bound.");
    return value.map((item) => safeJson(item, depth + 1));
  }
  if (typeof value === "object") {
    const input = value as Record<string, unknown>;
    if (isSensitiveStructure(input)) return "[redacted]";
    const output: Record<string, SafeJsonValue> = {};
    const entries = Object.entries(input);
    if (entries.length > 50) throw projectionBound("A selected payload object exceeds the configured bound.");
    for (const [key, item] of entries) {
      if (/token|password|secret|email|phone|url/i.test(key)) output[key] = "[redacted]";
      else output[key] = safeJson(item, depth + 1);
    }
    return output;
  }
  return "[unavailable]";
}

function requiresWholeFieldRedaction(value: unknown): boolean {
  if (typeof value === "string") return /^(?:https?:\/\/|[A-Za-z0-9+/]{80,}={0,2}$)/.test(value);
  return typeof value === "object" && value !== null && !Array.isArray(value)
    && isSensitiveStructure(value as Record<string, unknown>);
}

function isSensitiveStructure(value: Record<string, unknown>): boolean {
  return "downloadURL" in value || "fileChecksum" in value || "wrappingKey" in value
    || "recordName" in value || "ownerRecordName" in value || "userRecordName" in value || "zoneID" in value;
}

function malformedNumericValue() {
  return safeError({ code: "malformedResponse", message: "CloudKit returned a numeric payload value that cannot be represented without precision loss.", execution: "completed", sessionEffect: "unchanged", retryable: false, retryConditions: [], nextStep: "Keep numbersAsStrings enabled and inspect provider compatibility using privacy-safe diagnostics." });
}

function projectionBound(message: string) {
  return safeError({ code: "outputBoundExceeded", message, execution: "completed", sessionEffect: "unchanged", retryable: false, retryConditions: [], nextStep: "Request fewer or smaller fields." });
}
