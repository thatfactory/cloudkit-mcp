import type { AuthenticationMode, DatabaseScope } from "../domain/types.js";
import { safeError } from "../errors.js";

/** Identifier of a closed, read-only CloudKit operation. */
export type OperationId =
  | "probeCurrentUser"
  | "listZones"
  | "lookupZones"
  | "lookupRecords"
  | "queryRecords"
  | "listSubscriptions"
  | "getDatabaseChanges"
  | "getZoneChanges";

/** Runtime policy for one reachable upstream operation. */
export interface OperationPolicy {
  readonly id: OperationId;
  readonly method: "GET" | "POST";
  readonly path: `/${string}`;
  readonly effect: "read";
  readonly authenticationModes: readonly AuthenticationMode[];
  readonly documentedScopes: readonly DatabaseScope[];
  readonly unverifiedScopes: readonly DatabaseScope[];
  readonly retryClass: "idempotent" | "sessionTransactional";
}

const policies: Readonly<Record<OperationId, OperationPolicy>> = {
  probeCurrentUser: {
    id: "probeCurrentUser",
    method: "GET",
    path: "/public/users/caller",
    effect: "read",
    authenticationModes: ["api-token-public", "web-user"],
    documentedScopes: ["public", "private", "shared"],
    unverifiedScopes: [],
    retryClass: "sessionTransactional",
  },
  listZones: {
    id: "listZones",
    method: "GET",
    path: "/{scope}/zones/list",
    effect: "read",
    authenticationModes: ["server-key", "api-token-public", "web-user"],
    documentedScopes: ["public", "private"],
    unverifiedScopes: ["shared"],
    retryClass: "idempotent",
  },
  lookupZones: {
    id: "lookupZones",
    method: "POST",
    path: "/{scope}/zones/lookup",
    effect: "read",
    authenticationModes: ["server-key", "api-token-public", "web-user"],
    documentedScopes: ["public", "private"],
    unverifiedScopes: ["shared"],
    retryClass: "idempotent",
  },
  lookupRecords: {
    id: "lookupRecords",
    method: "POST",
    path: "/{scope}/records/lookup",
    effect: "read",
    authenticationModes: ["server-key", "api-token-public", "web-user"],
    documentedScopes: ["public", "private", "shared"],
    unverifiedScopes: [],
    retryClass: "idempotent",
  },
  queryRecords: {
    id: "queryRecords",
    method: "POST",
    path: "/{scope}/records/query",
    effect: "read",
    authenticationModes: ["server-key", "api-token-public", "web-user"],
    documentedScopes: ["public", "private", "shared"],
    unverifiedScopes: [],
    retryClass: "idempotent",
  },
  listSubscriptions: {
    id: "listSubscriptions",
    method: "GET",
    path: "/{scope}/subscriptions/list",
    effect: "read",
    authenticationModes: ["server-key", "api-token-public", "web-user"],
    documentedScopes: ["public", "private"],
    unverifiedScopes: ["shared"],
    retryClass: "idempotent",
  },
  getDatabaseChanges: {
    id: "getDatabaseChanges",
    method: "POST",
    path: "/{scope}/changes/database",
    effect: "read",
    authenticationModes: ["web-user"],
    documentedScopes: ["private", "shared"],
    unverifiedScopes: [],
    retryClass: "sessionTransactional",
  },
  getZoneChanges: {
    id: "getZoneChanges",
    method: "POST",
    path: "/{scope}/changes/zone",
    effect: "read",
    authenticationModes: ["web-user"],
    documentedScopes: ["private", "shared"],
    unverifiedScopes: [],
    retryClass: "sessionTransactional",
  },
};

/** Resolves one immutable operation policy. */
export function operationPolicy(id: OperationId): OperationPolicy {
  return policies[id];
}

/** Returns the complete closed operation registry. */
export function operationPolicies(): readonly OperationPolicy[] {
  return Object.values(policies);
}

/** Rejects unsupported operation context before credential material is resolved. */
export function preflightOperation(id: OperationId, mode: AuthenticationMode, scope: DatabaseScope): void {
  const policy = operationPolicy(id);
  if (!policy.authenticationModes.includes(mode)) throw safeError({ code: "authenticationRequired", message: "This credential class cannot authorize the selected operation.", execution: "notStarted", sessionEffect: "unchanged", retryable: false, retryConditions: [], nextStep: "Select a profile with the operation's documented credential class." });
  if (policy.unverifiedScopes.includes(scope)) throw safeError({ code: "unverifiedCapability", message: "This operation and database scope have not passed the required live capability gate.", execution: "notStarted", sessionEffect: "unchanged", retryable: false, retryConditions: [], nextStep: "Run the operator acceptance harness against a dedicated synthetic container before enabling this scope." });
  if (!policy.documentedScopes.includes(scope)) throw safeError({ code: "unsupportedCapability", message: "The selected operation is not supported for this database scope.", execution: "notStarted", sessionEffect: "unchanged", retryable: false, retryConditions: [], nextStep: "Choose a documented scope or use the named selector workflow described by get_context." });
}
