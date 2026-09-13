/** CloudKit deployment environment selected by immutable startup policy. */
export type CloudKitEnvironment = "development" | "production";

/** Account-relative CloudKit database scope. */
export type DatabaseScope = "public" | "private" | "shared";

/** Supported authentication modes. */
export type AuthenticationMode = "server-key" | "web-user" | "api-token-public";

/** The only authenticated-user backend supported by the MVP. */
export type BackendKind = "web-services";

/** Allowed fields and record types for one profile. */
export interface RecordPolicy {
  readonly allowedTypes: readonly string[];
  readonly queryableFields: readonly string[];
  readonly readablePayloadFields: readonly string[];
  readonly discloseRecordNames: boolean;
  readonly discloseZoneNames: boolean;
}

/** Immutable configuration for one authorized CloudKit view. */
export interface Profile {
  readonly id: string;
  readonly containerId: string;
  readonly environment: CloudKitEnvironment;
  readonly backend: BackendKind;
  readonly authenticationMode: AuthenticationMode;
  readonly credentialRef: string;
  readonly allowedScopes: readonly DatabaseScope[];
  readonly recordPolicy: RecordPolicy;
}

/** A principal-bound account-relative database view. */
export interface ResolvedView {
  readonly profileId: string;
  readonly containerId: string;
  readonly environment: CloudKitEnvironment;
  readonly scope: DatabaseScope;
  readonly backend: BackendKind;
  readonly principalAlias: string;
  readonly principalEpoch: string;
  readonly principalBound: boolean;
}

/** Owner-aware zone identity. */
export interface ZoneIdentity {
  readonly zoneName: string;
  readonly ownerRecordName: string;
}

/** Full record identity within an account-relative view. */
export interface RecordIdentity {
  readonly zone: ZoneIdentity;
  readonly recordName: string;
}

/** Public execution semantics for every result. */
export type ExecutionStatus = "notStarted" | "started" | "completed" | "uncertain";

/** Public authentication-session effect for every result. */
export type SessionEffect = "unchanged" | "rotated" | "uncertain";

/** Completeness of the requested diagnostic observation. */
export type Completeness = "completeForRequest" | "partial" | "notEstablished";

/** Overall result status. */
export type ResultStatus = "ok" | "partial" | "unavailable" | "error";

/** Evidence state for one operation and context. */
export interface CapabilityEvidence {
  readonly documented: boolean;
  readonly implemented: boolean;
  readonly liveVerified: boolean;
  readonly currentlyAuthorized: boolean;
  readonly limitations: readonly string[];
}

/** Privacy-safe context included in a remote result. */
export interface ResultContext {
  readonly profileId: string;
  readonly containerId: string;
  readonly environment: CloudKitEnvironment;
  readonly scope: DatabaseScope;
  readonly backend: BackendKind;
}

/** Stable envelope used by all remote diagnostic results. */
export interface ResultEnvelope<T> {
  readonly status: ResultStatus;
  readonly execution: ExecutionStatus;
  readonly remoteDataEffect: "none";
  readonly sessionEffect: SessionEffect;
  readonly completeness: Completeness;
  readonly context: ResultContext;
  readonly observedAt: string;
  readonly limitations: readonly string[];
  readonly data: T;
}

/** A JSON value that preserves large CloudKit integers as strings when required. */
export type SafeJsonValue = null | boolean | number | string | readonly SafeJsonValue[] | { readonly [key: string]: SafeJsonValue };

/** Presence state prevents omitted, null, and redacted fields from being conflated. */
export type ProjectedField =
  | { readonly state: "notRequested" }
  | { readonly state: "unavailable" }
  | { readonly state: "redacted" }
  | { readonly state: "returned"; readonly value: SafeJsonValue };

/** Metadata-first record observation. */
export interface RecordObservation {
  readonly handle: string;
  readonly recordName?: string;
  readonly outcome: "present" | "notFoundInView" | "inaccessible" | "unknown";
  readonly recordType?: string;
  readonly changeTag?: string;
  readonly createdAt?: string;
  readonly modifiedAt?: string;
  readonly deleted: "observed" | "notObserved" | "unknown";
  readonly fields?: Readonly<Record<string, ProjectedField>>;
}

/** One normalized side of a comparison. */
export interface ViewObservation {
  readonly view: ResolvedView;
  readonly observedFrom: string;
  readonly observedTo: string;
  readonly identityMapping: "verified" | "explicitUnverified" | "unavailable";
  readonly records: Readonly<Record<string, RecordObservation>>;
  readonly limitations: readonly string[];
}
