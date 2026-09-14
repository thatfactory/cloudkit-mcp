import type { AuthenticationMode, DatabaseScope } from "../domain/types.js";

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
