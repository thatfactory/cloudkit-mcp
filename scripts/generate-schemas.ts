import { readFile } from "node:fs/promises";
import { operationPolicies } from "../src/api/operations.js";

const packageDocument = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
const capabilities = JSON.parse(await readFile(new URL("../resources/capabilities.json", import.meta.url), "utf8")) as {
  version: string;
  tools: string[];
  authentication: Record<string, { implemented: boolean; liveVerifiedScopes: string[] }>;
  backendOperations: Array<{ id: string; implementationStatus: string; documentedScopes: string[]; unverifiedScopes: string[]; liveVerificationStatus: string; liveVerifiedScopes: string[]; lastObservedAt?: string }>;
  limitations: string[];
};
const provenance = JSON.parse(await readFile(new URL("../contracts/provenance.json", import.meta.url), "utf8")) as {
  recordedAt: string;
  sources: Array<{ id: string }>;
  backendDecision: { status: string };
  liveEvidence: { status: string; observedAt?: string; credentialClasses: string[]; limitations: string[] };
};
const policy = JSON.parse(await readFile(new URL("../contracts/operation-policy.json", import.meta.url), "utf8")) as {
  operations: Array<{
    id: string;
    effect: string;
    method: string;
    path: string;
    credentials: string[];
    documentedScopes: string[];
    unverifiedScopes?: string[];
    implementationStatus: string;
    liveVerificationStatus: string;
    liveVerifiedScopes: string[];
    lastObservedAt?: string;
  }>;
};
const expectedTools = ["get_context", "probe_access", "list_zones", "get_zone", "get_records", "query_records", "read_record_fields", "get_share", "list_subscriptions", "get_database_changes", "get_zone_changes", "compare_views"];
if (capabilities.version !== packageDocument.version) throw new Error("capability version does not match package version");
if (JSON.stringify(capabilities.tools) !== JSON.stringify(expectedTools)) throw new Error("capability tool registry is inconsistent");
if (Object.values(capabilities.authentication).some(({ implemented, liveVerifiedScopes }) => implemented !== true || !Array.isArray(liveVerifiedScopes))) throw new Error("authentication capability evidence is inconsistent");
if (capabilities.limitations.some((limitation) => /no operation has live cloudkit verification/i.test(limitation))) throw new Error("capability limitations contain stale live-evidence claims");
if (provenance.backendDecision.status !== "selectedAndCoreWorkflowLiveVerified" || provenance.liveEvidence.status !== "coreWorkflowVerified" || provenance.liveEvidence.observedAt === undefined) throw new Error("provenance does not record the verified core workflow");
const capabilityCredentialNames: Record<string, string> = { serverKey: "server-key", apiTokenPublic: "api-token-public", webUser: "api-token-plus-web-authentication-token" };
const liveCredentialClasses = Object.entries(capabilities.authentication)
  .filter(([, evidence]) => evidence.liveVerifiedScopes.length > 0)
  .map(([name]) => capabilityCredentialNames[name])
  .sort();
if (JSON.stringify([...provenance.liveEvidence.credentialClasses].sort()) !== JSON.stringify(liveCredentialClasses)) throw new Error("provenance credential classes do not match live authentication capabilities");
if (policy.operations.length !== 8 || policy.operations.some((operation) => operation.effect !== "read")) throw new Error("operation policy must contain exactly the closed read registry");
const runtimePolicies = operationPolicies();
if (JSON.stringify(policy.operations.map(({ id }) => id)) !== JSON.stringify(runtimePolicies.map(({ id }) => id))) throw new Error("operation contract ids do not match the runtime registry");
for (const operation of policy.operations) {
  const runtime = runtimePolicies.find(({ id }) => id === operation.id);
  if (runtime === undefined) throw new Error(`${operation.id} is not reachable through the runtime registry`);
  const runtimeCredentials = runtime.authenticationModes.map((mode) => mode === "server-key" ? "serverKey" : mode === "api-token-public" ? "apiTokenPublic" : "apiTokenWebUser");
  if (operation.method !== runtime.method || `/${operation.path}` !== runtime.path) throw new Error(`${operation.id} wire contract does not match the runtime registry`);
  if (JSON.stringify(operation.credentials) !== JSON.stringify(runtimeCredentials)) throw new Error(`${operation.id} credential contract does not match the runtime registry`);
  if (JSON.stringify(operation.documentedScopes) !== JSON.stringify(runtime.documentedScopes) || JSON.stringify(operation.unverifiedScopes ?? []) !== JSON.stringify(runtime.unverifiedScopes)) throw new Error(`${operation.id} scope contract does not match the runtime registry`);
  if (operation.implementationStatus !== "implemented") throw new Error(`${operation.id} must have an explicit implemented status`);
  if (!["verified", "partiallyVerified", "notVerified"].includes(operation.liveVerificationStatus)) throw new Error(`${operation.id} has an invalid live verification status`);
  const declaredScopes = new Set([...operation.documentedScopes, ...(operation.unverifiedScopes ?? [])]);
  if (operation.liveVerifiedScopes.some((scope) => !declaredScopes.has(scope))) throw new Error(`${operation.id} claims an undeclared live-verified scope`);
  const expectedStatus = operation.liveVerifiedScopes.length === 0 ? "notVerified" : operation.liveVerifiedScopes.length === declaredScopes.size ? "verified" : "partiallyVerified";
  if (operation.liveVerificationStatus !== expectedStatus) throw new Error(`${operation.id} live verification status does not match its verified scopes`);
  if ((operation.liveVerifiedScopes.length > 0) !== (operation.lastObservedAt !== undefined)) throw new Error(`${operation.id} must date every nonempty live verification claim`);
  if (operation.lastObservedAt !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(operation.lastObservedAt)) throw new Error(`${operation.id} has an invalid observation date`);
}
const publicOperations = policy.operations.map(({ id, implementationStatus, documentedScopes, unverifiedScopes = [], liveVerificationStatus, liveVerifiedScopes, lastObservedAt }) => ({ id, implementationStatus, documentedScopes, unverifiedScopes, liveVerificationStatus, liveVerifiedScopes, ...(lastObservedAt ? { lastObservedAt } : {}) }));
if (JSON.stringify(capabilities.backendOperations) !== JSON.stringify(publicOperations)) throw new Error("public operation evidence does not match the authoritative policy contract");
if (!/^\d{4}-\d{2}-\d{2}$/.test(provenance.recordedAt) || provenance.recordedAt < provenance.liveEvidence.observedAt!) throw new Error("provenance date is invalid or predates recorded live evidence");
if (!provenance.sources.some((source: { id?: string }) => source.id === "A8")) throw new Error("share topology provenance is missing A8");
for (const path of ["../resources/schemas/profiles.json", "../resources/schemas/result-envelope.json"]) JSON.parse(await readFile(new URL(path, import.meta.url), "utf8"));
if (!process.argv.includes("--check")) process.stdout.write("Schemas and policy are consistent.\n");
