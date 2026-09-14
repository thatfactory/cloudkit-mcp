import { randomUUID } from "node:crypto";
import type { ProfilesDocument } from "../config/profiles.js";
import { requireProfile } from "../config/profiles.js";
import type { DatabaseScope, Profile, RecordObservation, ResultEnvelope, ZoneIdentity } from "../domain/types.js";
import { CloudKitMCPError, safeError } from "../errors.js";
import { SessionManager } from "../auth/session.js";
import { HandleRegistry, type HandleContext } from "../state/handles.js";
import { compareObservations } from "./comparison.js";
import { projectRecord, selectorDigest, type WireRecord } from "./projection.js";
import { writeDiagnosticEvent } from "../observability/events.js";

/** Explicit view input shared by remote diagnostic tools. */
export interface ViewInput { readonly profileId: string; readonly scope: DatabaseScope }

/** Explicit owner-aware zone selector. */
export type ZoneInput = { readonly handle: string; readonly zoneName?: never; readonly ownerRecordName?: never } | { readonly handle?: never; readonly zoneName: string; readonly ownerRecordName?: string | undefined };

/** Deliberately narrow, JSON-safe query values supported by query_records. */
export type QueryScalar =
  | { readonly kind: "string"; readonly value: string }
  | { readonly kind: "boolean"; readonly value: boolean }
  | { readonly kind: "number"; readonly value: number }
  | { readonly kind: "timestamp"; readonly value: string };
export type QueryValue = QueryScalar | { readonly kind: "list"; readonly values: readonly QueryScalar[] };

/** Small typed filter supported by query_records. */
export interface QueryFilter { readonly fieldName: string; readonly comparator: "EQUALS" | "NOT_EQUALS" | "LESS_THAN" | "LESS_THAN_OR_EQUALS" | "GREATER_THAN" | "GREATER_THAN_OR_EQUALS" | "IN"; readonly fieldValue: QueryValue }
export type ChangeStart = { readonly kind: "beginning" } | { readonly kind: "cursor"; readonly handle: string };

interface QueryCursor { readonly marker: string; readonly seenMarkerDigests: readonly string[] }
interface ChangeCursor { readonly token: string; readonly traversalTokenDigests: readonly string[] }

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
      const apiTokenAccepted = profile.authenticationMode === "api-token-public" && object.serverErrorCode === "AUTHENTICATION_REQUIRED" && typeof object.redirectURL === "string";
      return {
        accessible: principal !== undefined,
        apiTokenAccepted,
        userAuthenticationRequired: apiTokenAccepted,
        principalObserved: principal !== undefined,
        principalAlias: principal ? this.sessions.alias("account", profile.containerId, principal) : undefined,
        capability: { documented: true, implemented: true, liveVerified: false, currentlyAuthorized: principal !== undefined },
      };
    });
  }

  /** Lists owner-aware zones without publishing raw names unless policy permits it. */
  async listZones(view: ViewInput) {
    return this.#remote("listZones", view, {}, (body, profile, context) => {
      const zones = boundedArray(asObject(body).zones, 100).map(parseZone);
      const handles = this.handles.issueBoundBatch("zone", zones.map((zone) => ({ context: { ...context, operation: "zone", selectorDigest: "discovered-zone", zoneOwner: zone.ownerRecordName, zoneName: zone.zoneName }, value: zone })));
      return zones.map((zone, index) => {
        const handle = handles[index]!;
        return { handle, ...(profile.recordPolicy.discloseZoneNames ? { zoneName: zone.zoneName } : {}), ownerAlias: this.sessions.alias("owner", profile.containerId, zone.ownerRecordName) };
      });
    });
  }

  /** Fetches one exact owner-aware zone. */
  async getZone(view: ViewInput, zoneInput: ZoneInput) {
    const profile = this.#profile(view);
    const zone = await this.#resolveZone(profile, view.scope, zoneInput);
    return this.#remote("lookupZones", view, { zones: [zone] }, (body, profile, context) => {
      const item = boundedArray(asObject(body).zones, 1)[0];
      if (!item) return { outcome: "notFoundInView" };
      const itemError = boundedString(asObject(item).serverErrorCode, 128);
      if (itemError) return { outcome: classifyProviderOutcome(itemError) };
      const observed = parseZone(item);
      return { outcome: "present", handle: this.handles.issue("zone", { ...context, operation: "zone", selectorDigest: "discovered-zone", zoneOwner: observed.ownerRecordName, zoneName: observed.zoneName }, observed), ...(profile.recordPolicy.discloseZoneNames ? { zoneName: observed.zoneName } : {}), ownerAlias: this.sessions.alias("owner", profile.containerId, observed.ownerRecordName) };
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
    if (filters.length > 10 || filters.some((filter) => !boundedIdentifier(filter.fieldName, 255) || !profile.recordPolicy.queryableFields.includes(filter.fieldName))) throw invalidInput("A query filter is not authorized by startup policy.");
    for (const filter of filters) validateQueryFilter(filter);
    const normalizedLimit = requireLimit(limit);
    const digest = selectorDigest({ recordType, filters, zone, limit: normalizedLimit, desiredKeys: [] });
    const context = this.#handleContext(await this.sessions.currentView(profile, view.scope), "queryRecords", digest, zone);
    const cursor = continuationHandle ? this.handles.resolve<QueryCursor>(continuationHandle, context) : undefined;
    const query = { recordType, filterBy: filters.map((filter) => ({ fieldName: filter.fieldName, comparator: filter.comparator, fieldValue: { value: queryWireValue(filter.fieldValue) } })) };
    const result = await this.#remote("queryRecords", view, { zoneID: zone, query, resultsLimit: normalizedLimit, desiredKeys: [], numbersAsStrings: true, ...(cursor ? { continuationMarker: cursor.marker } : {}) }, (body, selectedProfile) => {
      const object = asObject(body);
      const records = requireArray(object, "records", normalizedLimit).map((item) => projectRecord(asObject(item) as WireRecord, selectedProfile, zone, this.handles, { ...context, operation: "record", selectorDigest: digest }));
      const nextMarker = optionalContinuation(object, "continuationMarker");
      const nextDigest = nextMarker ? selectorDigest(nextMarker) : undefined;
      if (nextDigest && cursor?.seenMarkerDigests.includes(nextDigest)) throw malformedContinuation();
      const seenMarkerDigests = nextDigest ? [...(cursor?.seenMarkerDigests ?? []), nextDigest].slice(-16) : [];
      return { records, page: { completeness: nextMarker ? "partial" : "completeForRequest", continuationHandle: nextMarker ? this.handles.issue<QueryCursor>("query", context, { marker: nextMarker, seenMarkerDigests }) : undefined } };
    });
    return { ...result, limitations: ["CloudKit query indexes update asynchronously; an empty result does not establish authoritative absence. Use exact-name lookup when possible."] };
  }

  /** Projects share topology attached to a proven record without returning share URLs or participant identities. */
  async getShare(view: ViewInput, zoneInput: ZoneInput, recordName: string) {
    const profile = this.#profile(view);
    const zone = await this.#resolveZone(profile, view.scope, zoneInput);
    const referenceResult = await this.#remote("lookupRecords", view, { zoneID: zone, records: [{ recordName }], desiredKeys: [], numbersAsStrings: true }, (body) => exactLookupItem(body, recordName));
    const record = referenceResult.data;
    const referenceError = boundedString(record.serverErrorCode, 128);
    if (referenceError) {
      return { ...referenceResult, status: "unavailable" as const, limitations: ["The selected record lookup returned a per-item provider error."], data: { outcome: classifyProviderOutcome(referenceError) } };
    }
    const shareReference = asObject(record.share);
    const shareRecordName = boundedString(shareReference.recordName, 1024);
    if (!shareRecordName) {
      return { ...referenceResult, status: "unavailable" as const, completeness: "notEstablished" as const, limitations: ["The selected record did not expose a proven share-record reference in this view."], data: { outcome: "unavailable" } };
    }
    try {
      const shareResult = await this.#remote("lookupRecords", view, { zoneID: zone, records: [{ recordName: shareRecordName }], desiredKeys: [], numbersAsStrings: true }, (body) => {
        const share = exactLookupItem(body, shareRecordName);
        const shareError = boundedString(share.serverErrorCode, 128);
        if (shareError) return { outcome: classifyProviderOutcome(shareError), limitations: ["The share-record lookup returned a per-item provider error."] };
        const fields = asObject(share.fields);
        const currentParticipant = asObject(fieldValue(fields.currentUserParticipant) ?? share.currentUserParticipant);
        const participantsValue = fieldValue(fields.participants) ?? share.participants;
        const participants = participantsValue === undefined ? [] : requireArray({ participants: participantsValue }, "participants", 100);
        return {
          outcome: Object.keys(share).length ? "present" : "unavailable",
          mode: normalizeShareEnum(fieldValue(fields.shareType) ?? share.shareType),
          callerRole: normalizeShareEnum(currentParticipant.type ?? fieldValue(fields.currentUserParticipantRole) ?? share.currentUserParticipantRole),
          publicPermission: normalizeShareEnum(fieldValue(fields.publicPermission) ?? share.publicPermission),
          participants: participants.map((item) => {
            const participant = asObject(item);
            return { role: normalizeShareEnum(participant.type ?? participant.role), acceptanceStatus: normalizeShareEnum(participant.acceptanceStatus), permission: normalizeShareEnum(participant.permission) };
          }),
          limitations: ["Participant identities and share URLs are intentionally omitted."],
        };
      });
      const combined = { ...shareResult, sessionEffect: combineSessionEffects(referenceResult.sessionEffect, shareResult.sessionEffect) };
      return shareResult.data.outcome === "present" ? combined : { ...combined, status: "unavailable" as const, completeness: "notEstablished" as const };
    } catch (error) {
      if (referenceResult.sessionEffect === "rotated" && error instanceof CloudKitMCPError && error.details.sessionEffect === "unchanged") throw new CloudKitMCPError({ ...error.details, sessionEffect: "rotated" });
      throw error;
    }
  }

  /** Lists only safe structural subscription metadata for documented scopes. */
  async listSubscriptions(view: ViewInput) {
    const result = await this.#remote("listSubscriptions", view, {}, (body) => {
      const entries = requireArray(asObject(body), "subscriptions", 100);
      const failures = entries.filter((item) => boundedString(asObject(item).serverErrorCode, 128));
      const subscriptions = entries.filter((item) => !boundedString(asObject(item).serverErrorCode, 128)).map((item) => { const subscription = asObject(item); return { type: normalizeEnum(subscription.subscriptionType, ["query", "zone", "database"]), zonePresent: Object.keys(asObject(subscription.zoneID)).length > 0, predicatePresent: Object.keys(asObject(subscription.query)).length > 0 }; });
      return { subscriptions, errors: failures.map((item) => ({ outcome: classifyProviderOutcome(boundedString(asObject(item).serverErrorCode, 128)) })) };
    });
    return result.data.errors.length > 0 ? { ...result, status: "partial" as const, completeness: "partial" as const, limitations: ["Provider-visible subscription metadata does not establish client registration or notification delivery."] } : { ...result, limitations: ["Provider-visible subscription metadata does not establish client registration or notification delivery."] };
  }

  /** Reads database change state using a process-bound continuation handle. */
  async getDatabaseChanges(view: ViewInput, start: ChangeStart) {
    const profile = this.#profile(view);
    const digest = selectorDigest({ operation: "getDatabaseChanges", resultsLimit: 50 });
    const context = this.#handleContext(await this.sessions.currentView(profile, view.scope), "getDatabaseChanges", digest);
    const cursor = start.kind === "cursor" ? this.handles.resolve<ChangeCursor>(start.handle, context) : undefined;
    const result = await this.#remote("getDatabaseChanges", view, { resultsLimit: 50, ...(cursor ? { syncToken: cursor.token } : {}) }, (body) => {
      const object = asObject(body);
      const next = requiredContinuation(object, "syncToken"); const moreComing = requiredBoolean(object, "moreComing");
      const nextDigest = next ? selectorDigest(next) : undefined;
      if (moreComing && (!nextDigest || cursor?.traversalTokenDigests.includes(nextDigest))) throw malformedContinuation();
      const entries = requireArray(object, "zones", 100);
      const failures = entries.filter((item) => boundedString(asObject(item).serverErrorCode, 128)).map((item) => ({ item: asObject(item), zone: parseZone(item) }));
      const errors = failures.map(({ item, zone }) => ({ zoneHandle: this.handles.issueObservation("zone-error", { ...context, operation: "zone-error", selectorDigest: "changed-zone-error", zoneOwner: zone.ownerRecordName, zoneName: zone.zoneName }), outcome: classifyProviderOutcome(boundedString(item.serverErrorCode, 128)) }));
      const successful = entries.filter((item) => !boundedString(asObject(item).serverErrorCode, 128)).map((item) => ({ zone: parseZone(item), deleted: asObject(item).deleted === true }));
      const zoneKeys = successful.map((item) => selectorDigest(item.zone));
      if (new Set(zoneKeys).size !== zoneKeys.length) throw malformedRecordCollection();
      const traversalTokenDigests = nextDigest ? moreComing ? [...(cursor?.traversalTokenDigests ?? []), nextDigest].slice(-16) : [nextDigest] : [];
      const issued = this.handles.issueBoundBatch<ZoneIdentity | ChangeCursor>("change", [
        ...successful.map((item) => ({ context: { ...context, operation: "zone", selectorDigest: "discovered-zone", zoneOwner: item.zone.ownerRecordName, zoneName: item.zone.zoneName }, value: item.zone })),
        { context, value: { token: next, traversalTokenDigests } },
      ]);
      const zoneHandles = issued.slice(0, successful.length);
      const changedZones = successful.map((item, index) => ({ handle: zoneHandles[index]!, deleted: item.deleted }));
      return { changedZones, errors, coverage: cursor ? "sinceIssuedCursor" : "beginning", moreComing, continuationHandle: issued[successful.length] };
    });
    return result.data.errors.length > 0 ? { ...result, status: "partial" as const, completeness: "partial" as const } : result;
  }

  /** Reads custom-zone record changes and tombstones using a context-bound handle. */
  async getZoneChanges(view: ViewInput, zoneInput: ZoneInput, start: ChangeStart) {
    const profile = this.#profile(view);
    const zone = await this.#resolveZone(profile, view.scope, zoneInput);
    if (zone.zoneName === "_defaultZone") throw unsupportedDefaultZoneChanges();
    const digest = selectorDigest({ operation: "getZoneChanges", zone, desiredKeys: [], resultsLimit: 50 });
    const context = this.#handleContext(await this.sessions.currentView(profile, view.scope), "getZoneChanges", digest, zone);
    const cursor = start.kind === "cursor" ? this.handles.resolve<ChangeCursor>(start.handle, context) : undefined;
    const result = await this.#remote("getZoneChanges", view, { zones: [{ zoneID: zone, ...(cursor ? { syncToken: cursor.token } : {}), desiredKeys: [], numberAsStrings: true, resultsLimit: 50 }] }, (body, selectedProfile) => {
      const zoneResult = asObject(requireArray(asObject(body), "zones", 1)[0]);
      if (Object.keys(zoneResult).length === 0) throw malformedShape();
      const zoneError = boundedString(zoneResult.serverErrorCode, 128);
      if (zoneError) {
        const errorZone = parseZone(zoneResult);
        if (errorZone.zoneName !== zone.zoneName || errorZone.ownerRecordName !== zone.ownerRecordName) throw malformedRecordCollection();
        return { changes: [], errors: [{ zoneHandle: this.handles.issueObservation("zone-error", { ...context, operation: "zone-error", selectorDigest: "zone-change-error" }), outcome: classifyProviderOutcome(zoneError) }], coverage: cursor ? "sinceIssuedCursor" : "beginning", moreComing: false };
      }
      const observedZone = parseZone(zoneResult);
      if (observedZone.zoneName !== zone.zoneName || observedZone.ownerRecordName !== zone.ownerRecordName) throw malformedRecordCollection();
      const next = requiredContinuation(zoneResult, "syncToken");
      const moreComing = requiredBoolean(zoneResult, "moreComing");
      const nextDigest = next ? selectorDigest(next) : undefined;
      if (moreComing && (!nextDigest || cursor?.traversalTokenDigests.includes(nextDigest))) throw malformedContinuation();
      const traversalTokenDigests = nextDigest ? moreComing ? [...(cursor?.traversalTokenDigests ?? []), nextDigest].slice(-16) : [nextDigest] : [];
      const changes = requireArray(zoneResult, "records", 50).map((item) => {
        const record = asObject(item);
        if (Object.keys(asObject(record.zoneID)).length > 0) {
          const recordZone = parseZone(record.zoneID);
          if (recordZone.zoneName !== zone.zoneName || recordZone.ownerRecordName !== zone.ownerRecordName) throw malformedRecordCollection();
        }
        return projectRecord(record as WireRecord, selectedProfile, zone, this.handles, { ...context, operation: "record", selectorDigest: digest });
      });
      return { changes, errors: [], coverage: cursor ? "sinceIssuedCursor" : "beginning", moreComing, continuationHandle: this.handles.issue<ChangeCursor>("zoneCursor", context, { token: next, traversalTokenDigests }) };
    });
    return result.data.errors.length > 0 ? { ...result, status: "partial" as const, completeness: "partial" as const } : result;
  }

  /** Compares exact record lookups performed independently through two profiles. */
  async compareViews(left: ViewInput, right: ViewInput, leftZoneInput: ZoneInput, rightZoneInput: ZoneInput, recordNames: readonly string[]) {
    const leftProfile = this.#profile(left); const rightProfile = this.#profile(right);
    const [leftZone, rightZone, leftIdentityBefore, rightIdentityBefore] = await Promise.all([
      this.#resolveZone(leftProfile, left.scope, leftZoneInput),
      this.#resolveZone(rightProfile, right.scope, rightZoneInput),
      this.sessions.currentView(leftProfile, left.scope),
      this.sessions.currentView(rightProfile, right.scope),
    ]);
    const leftObservedFrom = this.now().toISOString();
    const leftPromise = this.getRecords(left, leftZone, recordNames);
    const rightObservedFrom = this.now().toISOString();
    const rightPromise = this.getRecords(right, rightZone, recordNames);
    const [leftResult, rightResult] = await Promise.allSettled([leftPromise, rightPromise]);
    const leftObservedTo = this.now().toISOString();
    const rightObservedTo = this.now().toISOString();
    const leftRecords = leftResult.status === "fulfilled" ? leftResult.value.data as readonly RecordObservation[] : [];
    const rightRecords = rightResult.status === "fulfilled" ? rightResult.value.data as readonly RecordObservation[] : [];
    const [leftResolved, rightResolved] = await Promise.all([this.sessions.currentView(leftProfile, left.scope), this.sessions.currentView(rightProfile, right.scope)]);
    const keyed = (names: readonly string[], records: readonly RecordObservation[]): Readonly<Record<string, RecordObservation>> => Object.fromEntries(names.map((name, index) => [selectorDigest(name), records[index] ?? { handle: `missing_${index}`, outcome: "unknown" as const, deleted: "unknown" as const }]));
    const identitiesStable = leftIdentityBefore.principalEpoch === leftResolved.principalEpoch && rightIdentityBefore.principalEpoch === rightResolved.principalEpoch;
    const zonesCorrespond = leftZone.zoneName === rightZone.zoneName && leftZone.ownerRecordName === rightZone.ownerRecordName;
    const mapping = identitiesStable && zonesCorrespond && leftResolved.principalBound && rightResolved.principalBound && leftResolved.containerId === rightResolved.containerId && leftResolved.environment === rightResolved.environment ? "verified" as const : "explicitUnverified" as const;
    return {
      left: comparisonSide(leftResult),
      right: comparisonSide(rightResult),
      samePrincipal: leftResolved.principalAlias === rightResolved.principalAlias,
      identityMapping: mapping,
      observationWindows: { left: { from: leftObservedFrom, to: leftObservedTo }, right: { from: rightObservedFrom, to: rightObservedTo } },
      conclusions: compareObservations({ view: leftResolved, observedFrom: leftObservedFrom, observedTo: leftObservedTo, identityMapping: mapping, records: keyed(recordNames, leftRecords), limitations: leftResult.status === "rejected" ? ["Left view failed independently."] : [] }, { view: rightResolved, observedFrom: rightObservedFrom, observedTo: rightObservedTo, identityMapping: mapping, records: keyed(recordNames, rightRecords), limitations: rightResult.status === "rejected" ? ["Right view failed independently."] : [] }),
    };
  }

  async #records(view: ViewInput, zoneInput: ZoneInput, recordNames: readonly string[], fields: readonly string[]): Promise<ResultEnvelope<readonly RecordObservation[]>> {
    if (recordNames.length === 0 || recordNames.length > 20 || recordNames.some((name) => !boundedIdentifier(name, 1024))) throw invalidInput("Record lookup requires between one and twenty bounded exact names.");
    const profile = this.#profile(view);
    const zone = await this.#resolveZone(profile, view.scope, zoneInput);
    if (fields.some((field) => !profile.recordPolicy.readablePayloadFields.includes(field))) throw invalidInput("A requested payload field is not authorized by startup policy.");
    const digest = selectorDigest({ zone, recordNames, fields });
    const handleContext = this.#handleContext(await this.sessions.currentView(profile, view.scope), "lookupRecords", digest, zone);
    return this.#remote("lookupRecords", view, { zoneID: zone, records: recordNames.map((recordName) => ({ recordName })), desiredKeys: fields, numbersAsStrings: true }, (body, selectedProfile) => {
      const returned = requireArray(asObject(body), "records", recordNames.length);
      const requested = new Set(recordNames);
      const byName = new Map<string, WireRecord>();
      for (const item of returned) {
        const wire = asObject(item) as WireRecord;
        const recordName = boundedString(wire.recordName, 1024);
        if (!recordName || !requested.has(recordName) || byName.has(recordName)) throw malformedRecordCollection();
        byName.set(recordName, wire);
      }
      const payloadBudget = { remainingBytes: 64 * 1024 };
      return recordNames.map((recordName, index) => byName.has(recordName)
        ? projectRecord(byName.get(recordName)!, selectedProfile, zone, this.handles, { ...handleContext, operation: "record" }, fields, payloadBudget)
        : { handle: this.handles.issueObservation("record", { ...handleContext, operation: `record-${index}` }), outcome: "unknown" as const, deleted: "unknown" as const });
    });
  }

  async #remote<T>(operation: Parameters<SessionManager["execute"]>[2], view: ViewInput, body: unknown, project: (body: unknown, profile: Profile, context: HandleContext) => T): Promise<ResultEnvelope<T>> {
    const started = Date.now(); const requestId = randomUUID(); const profile = this.#profile(view);
    try {
      const result = await this.sessions.execute(profile, view.scope, operation, body);
      const providerCode = boundedString(asObject(result.body).serverErrorCode, 128);
      const expectedPublicChallenge = operation === "probeCurrentUser" && profile.authenticationMode === "api-token-public" && providerCode === "AUTHENTICATION_REQUIRED";
      if (providerCode && !expectedPublicChallenge) throw providerError(providerCode, result.replacementWebAuthenticationToken !== undefined);
      const context = this.#handleContext(result.resolvedView, operation, selectorDigest(body));
      let data: T;
      try {
        data = project(result.body, profile, context);
      } catch (error) {
        if (result.replacementWebAuthenticationToken !== undefined && error instanceof CloudKitMCPError && error.details.sessionEffect === "unchanged") {
          throw new CloudKitMCPError({ ...error.details, sessionEffect: "rotated" });
        }
        throw error;
      }
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
function requireArray(object: Record<string, unknown>, key: string, maximum: number): readonly unknown[] { if (!Array.isArray(object[key])) throw malformedShape(); return boundedArray(object[key], maximum); }
function asObject(value: unknown): Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function normalizeEnum(value: unknown, supported: readonly string[]): string { return typeof value === "string" && supported.includes(value) ? value : "unknown"; }
function normalizeShareEnum(value: unknown): string {
  if (typeof value !== "string") return "unknown";
  const normalized = value.toUpperCase().replaceAll("_", "");
  return ({ ZONEWIDE: "zoneWide", RECORDHIERARCHY: "recordHierarchy", OWNER: "owner", ADMINISTRATOR: "administrator", USER: "user", PUBLICUSER: "publicUser", INVITED: "invited", PENDING: "invited", ACCEPTED: "accepted", REMOVED: "removed", NONE: "none", READONLY: "readOnly", READWRITE: "readWrite" } as Record<string, string>)[normalized] ?? "unknown";
}
function classifyProviderOutcome(code: string | undefined): "notFoundInView" | "inaccessible" | "unknown" { if (code === "NOT_FOUND") return "notFoundInView"; if (code === "ACCESS_DENIED" || code === "AUTHENTICATION_REQUIRED") return "inaccessible"; return "unknown"; }
function fieldValue(value: unknown): unknown { const object = asObject(value); return "value" in object ? object.value : undefined; }
function invalidInput(message: string) { return safeError({ code: "invalidInput", message, execution: "notStarted", sessionEffect: "unchanged", retryable: false, retryConditions: [], nextStep: "Use the bounded schema and values returned by get_context or discovery." }); }
function malformedContinuation() { return safeError({ code: "malformedResponse", message: "CloudKit repeated the active continuation marker.", execution: "completed", sessionEffect: "unchanged", retryable: false, retryConditions: [], nextStep: "Stop traversal and inspect provider compatibility before continuing." }); }
function malformedShape() { return safeError({ code: "malformedResponse", message: "CloudKit returned a response with a missing or invalid required collection.", execution: "completed", sessionEffect: "unchanged", retryable: false, retryConditions: [], nextStep: "Inspect provider compatibility using privacy-safe contract diagnostics." }); }
function malformedRecordCollection() { return safeError({ code: "malformedResponse", message: "CloudKit returned contradictory or unbound record identities.", execution: "completed", sessionEffect: "unchanged", retryable: false, retryConditions: [], nextStep: "Stop comparison and inspect provider compatibility using privacy-safe contract diagnostics." }); }
function unsupportedDefaultZoneChanges() { return safeError({ code: "unsupportedCapability", message: "Zone-change diagnostics require an explicit custom record zone.", execution: "notStarted", sessionEffect: "unchanged", retryable: false, retryConditions: [], nextStep: "Select a discovered custom zone or use database-change diagnostics." }); }

function optionalContinuation(object: Record<string, unknown>, key: string): string | undefined {
  if (!(key in object) || object[key] === null) return undefined;
  const marker = boundedString(object[key], 8192);
  if (!marker) throw malformedContinuation();
  return marker;
}
function requiredContinuation(object: Record<string, unknown>, key: string): string { const value = optionalContinuation(object, key); if (!value) throw malformedContinuation(); return value; }
function requiredBoolean(object: Record<string, unknown>, key: string): boolean { if (typeof object[key] !== "boolean") throw malformedShape(); return object[key]; }

function exactLookupItem(body: unknown, expectedRecordName: string): Record<string, unknown> {
  const records = requireArray(asObject(body), "records", 1);
  if (records.length === 0) return {};
  const record = asObject(records[0]);
  if (boundedString(record.recordName, 1024) !== expectedRecordName) throw malformedRecordCollection();
  return record;
}

function validateQueryFilter(filter: QueryFilter): void {
  const value = filter.fieldValue;
  if (filter.comparator === "IN") {
    if (value.kind !== "list" || value.values.length === 0 || value.values.length > 100) throw invalidInput("IN query filters require between one and one hundred bounded homogeneous scalar values.");
    const kinds = new Set(value.values.map((item) => item.kind));
    if (kinds.size !== 1) throw invalidInput("IN query filters require between one and one hundred bounded homogeneous scalar values.");
    for (const item of value.values) validateQueryScalar(item);
    return;
  }
  if (value.kind === "list") throw invalidInput("Only IN query filters accept list values.");
  validateQueryScalar(value);
}

function validateQueryScalar(value: QueryScalar): void {
  if (value.kind === "string" && Buffer.byteLength(value.value, "utf8") <= 4096) return;
  if (value.kind === "boolean") return;
  if (value.kind === "number" && Number.isFinite(value.value) && (!Number.isInteger(value.value) || Number.isSafeInteger(value.value))) return;
  if (value.kind === "timestamp" && normalizeTimestamp(value.value) !== undefined) return;
  throw invalidInput("Query filters require a bounded string, boolean, finite safe number, or valid timestamp value.");
}

function queryWireValue(value: QueryValue): unknown {
  if (value.kind === "list") return value.values.map(queryWireValue);
  return value.kind === "timestamp" ? normalizeTimestamp(value.value) : value.value;
}

function normalizeTimestamp(value: string): number | undefined {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)) return undefined;
  const timestamp = Date.parse(value);
  if (!Number.isSafeInteger(timestamp)) return undefined;
  const normalized = value.length === 20 ? value.replace("Z", ".000Z") : value;
  return new Date(timestamp).toISOString() === normalized ? timestamp : undefined;
}

function providerError(code: string, rotated: boolean) {
  const sessionEffect = rotated ? "rotated" as const : "unchanged" as const;
  if (code === "NOT_FOUND" || code === "ZONE_NOT_FOUND") return safeError({ code: "notFoundInView", message: "CloudKit did not find the selected resource in this view.", execution: "completed", sessionEffect, retryable: false, retryConditions: [], nextStep: "Verify the exact view and owner-aware selector." });
  if (code === "ACCESS_DENIED") return safeError({ code: "permissionDenied", message: "CloudKit denied access to the selected resource.", execution: "completed", sessionEffect, retryable: false, retryConditions: [], nextStep: "Verify the selected account, scope, and share permissions." });
  if (code === "AUTHENTICATION_REQUIRED" || code === "AUTHENTICATION_FAILED") return safeError({ code: "authenticationExpired", message: "CloudKit rejected the authenticated session.", execution: "completed", sessionEffect, retryable: false, retryConditions: [], nextStep: "Reauthenticate the selected profile before another request." });
  if (code === "THROTTLED") return safeError({ code: "rateLimited", message: "CloudKit rate-limited the read.", execution: "completed", sessionEffect, retryable: false, retryConditions: [], nextStep: "Retry only after provider guidance and within a fresh diagnostic deadline." });
  return safeError({ code: "partialFailure", message: "CloudKit returned a provider failure without safe detail disclosure.", execution: "completed", sessionEffect, retryable: false, retryConditions: [], nextStep: "Inspect privacy-safe status diagnostics and narrow the operation." });
}
function combineSessionEffects(left: import("../domain/types.js").SessionEffect, right: import("../domain/types.js").SessionEffect) { if (left === "uncertain" || right === "uncertain") return "uncertain" as const; if (left === "rotated" || right === "rotated") return "rotated" as const; return "unchanged" as const; }
function comparisonSide(result: PromiseSettledResult<unknown>) { return result.status === "fulfilled" ? { status: "fulfilled" as const } : { status: "rejected" as const, errorCode: result.reason instanceof CloudKitMCPError ? result.reason.details.code : "partialFailure" as const }; }
