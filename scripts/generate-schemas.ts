import { readFile } from "node:fs/promises";

const packageDocument = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
const capabilities = JSON.parse(await readFile(new URL("../resources/capabilities.json", import.meta.url), "utf8")) as { version: string; tools: string[] };
const policy = JSON.parse(await readFile(new URL("../contracts/operation-policy.json", import.meta.url), "utf8")) as { operations: Array<{ id: string; effect: string }> };
const expectedTools = ["get_context", "probe_access", "list_zones", "get_zone", "get_records", "query_records", "read_record_fields", "get_share", "list_subscriptions", "get_database_changes", "get_zone_changes", "compare_views"];
if (capabilities.version !== packageDocument.version) throw new Error("capability version does not match package version");
if (JSON.stringify(capabilities.tools) !== JSON.stringify(expectedTools)) throw new Error("capability tool registry is inconsistent");
if (policy.operations.length !== 8 || policy.operations.some((operation) => operation.effect !== "read")) throw new Error("operation policy must contain exactly the closed read registry");
for (const path of ["../resources/schemas/profiles.json", "../resources/schemas/result-envelope.json", "../contracts/provenance.json"]) JSON.parse(await readFile(new URL(path, import.meta.url), "utf8"));
if (!process.argv.includes("--check")) process.stdout.write("Schemas and policy are consistent.\n");
