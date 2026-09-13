import { randomUUID } from "node:crypto";
import type { ProfilesDocument } from "../config/profiles.js";
import { requireProfile } from "../config/profiles.js";
import type { DatabaseScope, Profile, RecordObservation, ResultEnvelope, ZoneIdentity } from "../domain/types.js";
import { safeError } from "../errors.js";
import { SessionManager } from "../auth/session.js";
import { HandleRegistry, type HandleContext } from "../state/handles.js";
import { compareObservations } from "./comparison.js";
import { projectRecord, selectorDigest, type WireRecord } from "./projection.js";
import { writeDiagnosticEvent } from "../observability/events.js";

/** Explicit view input shared by remote diagnostic tools. */
export interface ViewInput { readonly profileId: string; readonly scope: DatabaseScope }

/** Explicit owner-aware zone selector. */
export type ZoneInput = { readonly handle: string; readonly zoneName?: never; readonly ownerRecordName?: never } | { readonly handle?: never; readonly zoneName: string; readonly ownerRecordName?: string | undefined };

/** Small typed filter supported by query_records. */
export interface QueryFilter { readonly fieldName: string; readonly comparator: "EQUALS" | "NOT_EQUALS" | "LESS_THAN" | "LESS_THAN_OR_EQUALS" | "GREATER_THAN" | "GREATER_THAN_OR_EQUALS" | "IN"; readonly fieldValue: unknown }

/** Implements the account-relative read-only diagnostic surface. */
export class DiagnosticService {
  constructor(
    private readonly profiles: ProfilesDocument,
    private readonly sessions: SessionManager,
    private readonly handles = new HandleRegistry(),
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** Returns static configuration and capability state without touching secrets or the network. */
  getContext(profileId?: string) {
    const selected = profileId ? [requireProfile(this.profiles, profileId)] : this.profiles.profiles;
    return {
      status: "ok",
      authenticationAttempted: false,
      remoteProbeAttempted: false,
      profiles: selected.map((profile) => ({
        id: profile.id,
        containerId: profile.containerId,
        environment: profile.environment,
        backend: profile.backend,
        authenticationMode: profile.authenticationMode,
        allowedScopes: profile.allowedScopes,
        recordPolicy: profile.recordPolicy,
      })),
      capabilityState: { documented: true, implemented: true, liveVerified: false, currentlyAuthorized: false },
      limitations: ["Live CloudKit capability and current authorization are established only by an explicit probe or diagnostic call."],
    };
  }

  /** Performs the minimum documented current-user read for one profile and scope. */
  async probeAccess(view: ViewInput) {
    return this.#remote("probeCurrentUser", view, {}, (body, profile) => {
      const object = asObject(body);
      const principal = boundedString(object.userRecordName, 1024);
      return {
        accessible: principal !== undefined,
        principalObserved: principal !== undefined,
        principalAlias: principal ? `account_${selectorDigest([profile.containerId, principal]).slice(0, 20)}` : undefined,
        capability: { documented: true, implemented: true, liveVerified: false, currentlyAuthorized: principal !== undefined },
      };
    });
  }

  /** Lists owner-aware zones without publishing raw names unless policy permits it. */
  async listZones(view: ViewInput) {
    return this.#remote("listZones", view, {}, (body, profile, context) => {
      const zones = boundedArray(asObject(body).zones, 100);
      return zones.map((item) => {
        const zone = parseZone(item);
        const handle = this.handles.issue("zone", { ...context, operation: "zone", selectorDigest: "discovered-zone", zoneOwner: zone.ownerRecordName, zoneName: zone.zoneName }, zone);
        return { handle, ...(profile.recordPolicy.discloseZoneNames ? { zoneName: zone.zoneName } : {}), ownerAlias: `owner_${selectorDigest([profile.containerId, zone.ownerRecordName]).slice(0, 20)}` };
      });
    });
  }

  /** Fetches one exact owner-aware zone. */
  async getZone(view: ViewInput, zoneInput: ZoneInput) {
    const profile = this.#profile(view);
    const zone = await this.#resolveZone(profile, view.scope, zoneInput);
    return this.#remote("lookupZones", view, { zones: [{ zoneID: zone }] }, (body, profile, context) => {
      const item = boundedArray(asObject(body).zones, 1)[0];
      if (!item) return { outcome: "notFoundInView" };
      const observed = parseZone(item);
      return { outcome: "present", handle: this.handles.issue("zone", { ...context, operation: "zone", selectorDigest: "discovered-zone", zoneOwner: observed.ownerRecordName, zoneName: observed.zoneName }, observed), ...(profile.recordPolicy.discloseZoneNames ? { zoneName: observed.zoneName } : {}), ownerAlias: `owner_${selectorDigest([profile.containerId, observed.ownerRecordName]).slice(0, 20)}` };
    });
  }

  /** Looks up bounded named records using metadata-only upstream projection. */
  async getRecords(view: ViewInput, zoneInput: ZoneInput, recordNames: readonly string[]) {
    return this.#records(view, zoneInput, recordNames, []);
  }

  /** Reads only exact payload fields authorized by immutable startup policy. */
  async readRecordFields(view: ViewInput, zoneInput: ZoneInput, recordNames: readonly string[], fields: readonly string[]) {
    if (fields.length === 0 || fields.length > 10) throw invalidInput("read_record_fields requires between one and ten exact fields.");
    return this.#records(view, zoneInput, recordNames, fields);
  }

  /** Runs one bounded indexed query with no arbitrary predicate body. */
  async queryRecords(view: ViewInput, zoneInput: ZoneInput, recordType: string, filters: readonly QueryFilter[], limit: number, continuationHandle?: string) {
    const profile = this.#profile(view);
    const zone = await this.#resolveZone(profile, view.scope, zoneInput);
    if (!profile.recordPolicy.allowedTypes.includes(recordType)) throw invalidInput("The requested record type is not authorized by startup policy.");
    if (filters.length > 10 || filters.some((filter) => !profile.recordPolicy.queryableFields.includes(filter.fieldName))) throw invalidInput("A query filter is not authorized by startup policy.");
    const normalizedLimit = requireLimit(limit);
    const digest = selectorDigest({ recordType, filters, zone, limit: normalizedLimit, desiredKeys: [] });
    const context = this.#handleContext(await this.sessions.currentView(profile, view.scope), "queryRecords", digest, zone);
    const marker = continuationHandle ? this.handles.resolve<string>(continuationHandle, context) : undefined;
    const query = { recordType, filterBy: filters.map((filter) => ({ fieldName: filter.fieldName, comparator: filter.comparator, fieldValue: { value: filter.fieldValue } })) };
    return this.#remote("queryRecords", view, { zoneID: zone, query, resultsLimit: normalizedLimit, desiredKeys: [], ...(marker ? { continuationMarker: marker } : {}) }, (body, selectedProfile) => {
      const object = asObject(body);
      const records = boundedArray(object.records, normalizedLimit).map((item) => projectRecord(asObject(item) as WireRecord, selectedProfile, zone, this.handles, { ...context, operation: "record", selectorDigest: digest }));
      const nextMarker = boundedString(object.continuationMarker, 8192);
      if (marker !== undefined && nextMarker === marker) throw malformedContinuation();
      return { records, page: { completeness: nextMarker ? "partial" : "completeForRequest", continuationHandle: nextMarker ? this.handles.issue("query", context, nextMarker) : undefined } };
    });
  }

  /** Projects share topology attached to a proven record without returning share URLs or participant identities. */
  async getShare(view: ViewInput, zoneInput: ZoneInput, recordName: string) {
    const profile = this.#profile(view);
    const zone = await this.#resolveZone(profile, view.scope, zoneInput);
    const referenceResult = await this.sessions.execute(profile, view.scope, "lookupRecords", { records: [{ recordName, zoneID: zone }], desiredKeys: [] });
    const record = asObject(boundedArray(asObject(referenceResult.body).records, 1)[0]);
    const shareReference = asObject(record.share);
    const shareRecordName = boundedString(shareReference.recordName, 1024);
    if (!shareRecordName) {
      return { status: "unavailable", execution: "completed", remoteDataEffect: "none" as const, sessionEffect: referenceResult.replacementWebAuthenticationToken ? "rotated" as const : "unchanged" as const, completeness: "notEstablished" as const, context: { profileId: profile.id, containerId: profile.containerId, environment: profile.environment, scope: view.scope, backend: profile.backend }, observedAt: this.now().toISOString(), limitations: ["The selected record did not expose a proven share-record reference in this view."], data: { outcome: "unavailable" } };
    }
    return this.#remote("lookupRecords", view, { records: [{ recordName: shareRecordName, zoneID: zone }], desiredKeys: [] }, (body) => {
      const share = asObject(boundedArray(asObject(body).records, 1)[0]);
      const fields = asObject(share.fields);
      const participantsValue = fieldValue(fields.participants) ?? share.participants;
      const participants = boundedArray(participantsValue, 100);
      return {
        outcome: Object.keys(share).length ? "present" : "unavailable",
        mode: normalizeEnum(fieldValue(fields.shareType) ?? share.shareType, ["zoneWide", "recordHierarchy"]),
        callerRole: normalizeEnum(fieldValue(fields.currentUserParticipantRole) ?? share.currentUserParticipantRole, ["owner", "privateUser", "publicUser"]),
        publicPermission: normalizeEnum(fieldValue(fields.publicPermission) ?? share.publicPermission, ["none", "readOnly", "readWrite"]),
        participants: participants.map((item) => {
          const participant = asObject(item);
          return { role: normalizeEnum(participant.role, ["owner", "privateUser", "publicUser"]), acceptanceStatus: normalizeEnum(participant.acceptanceStatus, ["pending", "accepted", "removed"]), permission: normalizeEnum(participant.permission, ["none", "readOnly", "readWrite"]) };
        }),
        limitations: ["Participant identities and share URLs are intentionally omitted."],
      };
    });
  }

  /** Lists only safe structural subscription metadata for documented scopes. */
  async listSubscriptions(view: ViewInput) {
    return this.#remote("listSubscriptions", view, {}, (body) => ({ subscriptions: boundedArray(asObject(body).subscriptions, 100).map((item) => { const subscription = asObject(item); return { type: normalizeEnum(subscription.subscriptionType, ["query", "zone", "database"]), zonePresent: subscription.zoneID !== undefined, predicatePresent: subscription.query !== undefined }; }) }));
  }

  /** Reads database change state using a process-bound continuation handle. */
  async getDatabaseChanges(view: ViewInput, start: "currentBaseline" | "beginning", continuationHandle?: string) {
    if (start === "currentBaseline" && continuationHandle === undefined) {
      throw invalidInput("A verified current-baseline operation is not available for the selected backend; use beginning for an explicit bounded scan.");
    }
    const profile = this.#profile(view);
    const digest = selectorDigest({ start });
    const context = this.#handleContext(await this.sessions.currentView(profile, view.scope), "getDatabaseChanges", digest);
    const token = continuationHandle ? this.handles.resolve<string>(continuationHandle, context) : undefined;
    return this.#remote("getDatabaseChanges", view, token ? { syncToken: token } : {}, (body) => {
      const object = asObject(body);
      const next = boundedString(object.syncToken, 8192);
      if (token !== undefined && next === token) throw malformedContinuation();
      return { changedZones: boundedArray(object.zones, 100).map((item) => { const changedZone = parseZone(item); return { handle: this.handles.issue("zone", { ...context, operation: "zone", selectorDigest: "discovered-zone", zoneOwner: changedZone.ownerRecordName, zoneName: changedZone.zoneName }, changedZone), deleted: asObject(item).deleted === true }; }), coverage: token ? "sinceIssuedCursor" : start, continuationHandle: next ? this.handles.issue("databaseCursor", context, next) : undefined };
    });
  }

  /** Reads custom-zone record changes and tombstones using a context-bound handle. */
  async getZoneChanges(view: ViewInput, zoneInput: ZoneInput, start: "currentBaseline" | "beginning", continuationHandle?: string) {
    if (start === "currentBaseline" && continuationHandle === undefined) {
      throw invalidInput("A verified current-baseline operation is not available for the selected backend; use beginning for an explicit bounded scan.");
    }
    const profile = this.#profile(view);
    const zone = await this.#resolveZone(profile, view.scope, zoneInput);
    const digest = selectorDigest({ start, zone, desiredKeys: [] });
    const context = this.#handleContext(await this.sessions.currentView(profile, view.scope), "getZoneChanges", digest, zone);
    const token = continuationHandle ? this.handles.resolve<string>(continuationHandle, context) : undefined;
    return this.#remote("getZoneChanges", view, { zones: [{ zoneID: zone, ...(token ? { syncToken: token } : {}), desiredKeys: [] }] }, (body, selectedProfile) => {
      const zoneResult = asObject(boundedArray(asObject(body).zones, 1)[0]);
      const next = boundedString(zoneResult.syncToken, 8192);
      if (token !== undefined && next === token) throw malformedContinuation();
      return { changes: boundedArray(zoneResult.records, 100).map((item) => projectRecord(asObject(item) as WireRecord, selectedProfile, zone, this.handles, { ...context, operation: "record", selectorDigest: digest })), coverage: token ? "sinceIssuedCursor" : start, continuationHandle: next ? this.handles.issue("zoneCursor", context, next) : undefined };
    });
  }

  /** Compares exact record lookups performed independently through two profiles. */
  async compareViews(left: ViewInput, right: ViewInput, zone: ZoneInput, recordNames: readonly string[]) {
    const [leftResult, rightResult] = await Promise.allSettled([this.getRecords(left, zone, recordNames), this.getRecords(right, zone, recordNames)]);
    const leftRecords = leftResult.status === "fulfilled" ? leftResult.value.data as readonly RecordObservation[] : [];
    const rightRecords = rightResult.status === "fulfilled" ? rightResult.value.data as readonly RecordObservation[] : [];
    const leftProfile = this.#profile(left); const rightProfile = this.#profile(right);
    const [leftResolved, rightResolved] = await Promise.all([this.sessions.currentView(leftProfile, left.scope), this.sessions.currentView(rightProfile, right.scope)]);
    const keyed = (names: readonly string[], records: readonly RecordObservation[]): Readonly<Record<string, RecordObservation>> => Object.fromEntries(names.map((name, index) => [selectorDigest(name), records[index] ?? { handle: `missing_${index}`, outcome: "unknown" as const, deleted: "unknown" as const }]));
    const mapping = leftResolved.containerId === rightResolved.containerId && leftResolved.environment === rightResolved.environment ? "verified" as const : "explicitUnverified" as const;
    return { left: leftResult.status, right: rightResult.status, samePrincipal: leftResolved.principalAlias === rightResolved.principalAlias, conclusions: compareObservations({ view: leftResolved, observedFrom: this.now().toISOString(), observedTo: this.now().toISOString(), identityMapping: mapping, records: keyed(recordNames, leftRecords), limitations: leftResult.status === "rejected" ? ["Left view failed independently."] : [] }, { view: rightResolved, observedFrom: this.now().toISOString(), observedTo: this.now().toISOString(), identityMapping: mapping, records: keyed(recordNames, rightRecords), limitations: rightResult.status === "rejected" ? ["Right view failed independently."] : [] }) };
  }

  async #records(view: ViewInput, zoneInput: ZoneInput, recordNames: readonly string[], fields: readonly string[]): Promise<ResultEnvelope<readonly RecordObservation[]>> {
    if (recordNames.length === 0 || recordNames.length > 20 || recordNames.some((name) => !boundedIdentifier(name, 1024))) throw invalidInput("Record lookup requires between one and twenty bounded exact names.");
    const profile = this.#profile(view);
    const zone = await this.#resolveZone(profile, view.scope, zoneInput);
    if (fields.some((field) => !profile.recordPolicy.readablePayloadFields.includes(field))) throw invalidInput("A requested payload field is not authorized by startup policy.");
    const digest = selectorDigest({ zone, recordNames, fields });
    const handleContext = this.#handleContext(await this.sessions.currentView(profile, view.scope), "lookupRecords", digest, zone);
    return this.#remote("lookupRecords", view, { records: recordNames.map((recordName) => ({ recordName, zoneID: zone })), desiredKeys: fields }, (body, selectedProfile) => {
      const returned = boundedArray(asObject(body).records, recordNames.length);
      return recordNames.map((_, index) => returned[index]
        ? projectRecord(asObject(returned[index]) as WireRecord, selectedProfile, zone, this.handles, { ...handleContext, operation: "record" }, fields)
        : { handle: this.handles.issue("record", { ...handleContext, operation: "record" }, { index }), outcome: "unknown" as const, deleted: "unknown" as const });
    });
  }

  async #remote<T>(operation: Parameters<SessionManager["execute"]>[2], view: ViewInput, body: unknown, project: (body: unknown, profile: Profile, context: HandleContext) => T): Promise<ResultEnvelope<T>> {
    const started = Date.now(); const requestId = randomUUID(); const profile = this.#profile(view);
    try {
      const result = await this.sessions.execute(profile, view.scope, operation, body);
      const context = this.#handleContext(result.resolvedView, operation, selectorDigest(body));
      const data = project(result.body, profile, context);
      writeDiagnosticEvent({ event: "operationCompleted", requestId, operation, durationMilliseconds: Date.now() - started, ...(Array.isArray(data) ? { count: data.length } : {}) });
      return { status: "ok", execution: "completed", remoteDataEffect: "none", sessionEffect: result.replacementWebAuthenticationToken ? "rotated" : "unchanged", completeness: "completeForRequest", context: { profileId: profile.id, containerId: profile.containerId, environment: profile.environment, scope: view.scope, backend: profile.backend }, observedAt: this.now().toISOString(), limitations: [], data };
    } catch (error) {
      const code = typeof error === "object" && error !== null && "details" in error ? String((error as { details?: { code?: unknown } }).details?.code ?? "partialFailure") : "partialFailure";
      writeDiagnosticEvent({ event: "operationFailed", requestId, operation, durationMilliseconds: Date.now() - started, code });
      throw error;
    }
  }

  #profile(view: ViewInput): Profile {
    const profile = requireProfile(this.profiles, view.profileId);
    if (!profile.allowedScopes.includes(view.scope)) throw invalidInput("The selected profile does not authorize this database scope.");
    return profile;
  }

  async #resolveZone(profile: Profile, scope: DatabaseScope, input: ZoneInput): Promise<ZoneIdentity> {
    if (input.handle !== undefined) {
      const resolved = await this.sessions.currentView(profile, scope);
      return this.handles.resolveBound<ZoneIdentity>(input.handle, this.#handleContext(resolved, "zone", "discovered-zone"));
    }
    return requireExactZone(scope, input as Extract<ZoneInput, { zoneName: string }>);
  }

  #handleContext(view: import("../domain/types.js").ResolvedView, operation: string, digest: string, zone?: ZoneIdentity): HandleContext {
    return { principalEpoch: view.principalEpoch, profileId: view.profileId, containerId: view.containerId, environment: view.environment, scope: view.scope, backend: view.backend, operation, selectorDigest: digest, ...(zone ? { zoneOwner: zone.ownerRecordName, zoneName: zone.zoneName } : {}) };
  }
}

function requireExactZone(scope: DatabaseScope, input: Extract<ZoneInput, { zoneName: string }>): ZoneIdentity {
  if (!boundedIdentifier(input.zoneName, 255)) throw invalidInput("The zone name is invalid.");
  if (scope === "shared" && !input.ownerRecordName) throw invalidInput("Shared-zone selectors require the exact observed owner.");
  const owner = input.ownerRecordName ?? "_defaultOwner";
  if (!boundedIdentifier(owner, 1024)) throw invalidInput("The zone owner is invalid.");
  return { zoneName: input.zoneName, ownerRecordName: owner };
}

function parseZone(input: unknown): ZoneIdentity {
  const object = asObject(input); const zoneID = Object.keys(asObject(object.zoneID)).length ? asObject(object.zoneID) : object;
  const zoneName = boundedString(zoneID.zoneName, 255); const ownerRecordName = boundedString(zoneID.ownerRecordName, 1024);
  if (!zoneName || !ownerRecordName) throw safeError({ code: "malformedResponse", message: "CloudKit returned a zone without its owner-aware identity.", execution: "completed", sessionEffect: "unchanged", retryable: false, retryConditions: [], nextStep: "Inspect provider compatibility using privacy-safe contract diagnostics." });
  return { zoneName, ownerRecordName };
}

function requireLimit(limit: number): number { if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw invalidInput("The page limit must be between one and one hundred."); return limit; }
function boundedIdentifier(value: string, maximum: number): boolean { return value.length > 0 && value.length <= maximum && !/[\u0000-\u001F\u007F]/.test(value); }
function boundedString(value: unknown, maximum: number): string | undefined { return typeof value === "string" && value.length > 0 && value.length <= maximum ? value : undefined; }
function boundedArray(value: unknown, maximum: number): readonly unknown[] { if (!Array.isArray(value)) return []; if (value.length > maximum) throw safeError({ code: "responseBoundExceeded", message: "CloudKit returned too many collection entries.", execution: "completed", sessionEffect: "unchanged", retryable: false, retryConditions: [], nextStep: "Narrow the selector or page size." }); return value; }
function asObject(value: unknown): Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function normalizeEnum(value: unknown, supported: readonly string[]): string { return typeof value === "string" && supported.includes(value) ? value : "unknown"; }
function fieldValue(value: unknown): unknown { const object = asObject(value); return "value" in object ? object.value : undefined; }
function invalidInput(message: string) { return safeError({ code: "invalidInput", message, execution: "notStarted", sessionEffect: "unchanged", retryable: false, retryConditions: [], nextStep: "Use the bounded schema and values returned by get_context or discovery." }); }
function malformedContinuation() { return safeError({ code: "malformedResponse", message: "CloudKit repeated the active continuation marker.", execution: "completed", sessionEffect: "unchanged", retryable: false, retryConditions: [], nextStep: "Stop traversal and inspect provider compatibility before continuing." }); }
