import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { safeError, sanitizeUnknownError } from "./errors.js";
import type { DiagnosticService, QueryFilter, ViewInput, ZoneInput } from "./diagnostics/service.js";

const packageDocument = createRequire(import.meta.url)("../package.json") as { version: string };
export const VERSION = packageDocument.version;

const viewSchema = z.object({ profileId: z.string().min(1).max(255), scope: z.enum(["public", "private", "shared"]) }).strict();
const zoneSchema = z.union([z.object({ handle: z.string().min(1).max(2048) }).strict(), z.object({ zoneName: z.string().min(1).max(255), ownerRecordName: z.string().min(1).max(1024).optional() }).strict()]);
const recordNamesSchema = z.array(z.string().min(1).max(1024)).min(1).max(20);
const fieldsSchema = z.array(z.string().min(1).max(255)).min(1).max(10);

/** Creates a side-effect-free MCP server with injected diagnostic behavior. */
export function createServer(service: DiagnosticService): McpServer {
  const server = new McpServer({ name: "cloudkit-mcp", version: VERSION });

  register(server, "get_context", "Report offline profile policy and capability state without loading credentials or contacting Apple.", { profileId: z.string().min(1).max(255).optional() }, async ({ profileId }) => service.getContext(profileId));
  register(server, "probe_access", "Perform one minimal authenticated read for an explicit profile and scope.", { view: viewSchema }, async ({ view }) => service.probeAccess(view));
  register(server, "list_zones", "List bounded owner-aware zones for an explicit view where the scope is verified.", { view: viewSchema }, async ({ view }) => service.listZones(view));
  register(server, "get_zone", "Look up one exact owner-aware zone.", { view: viewSchema, zone: zoneSchema }, async ({ view, zone }) => service.getZone(view, zone));
  register(server, "get_records", "Look up metadata for at most twenty exact records in one owner-aware zone.", { view: viewSchema, zone: zoneSchema, recordNames: recordNamesSchema }, async ({ view, zone, recordNames }) => service.getRecords(view, zone, recordNames));
  register(server, "query_records", "Run one bounded typed indexed query; arbitrary predicates and cross-zone scans are unavailable.", {
    view: viewSchema,
    zone: zoneSchema,
    recordType: z.string().min(1).max(255),
    filters: z.array(z.object({ fieldName: z.string().min(1).max(255), comparator: z.enum(["EQUALS", "NOT_EQUALS", "LESS_THAN", "LESS_THAN_OR_EQUALS", "GREATER_THAN", "GREATER_THAN_OR_EQUALS", "IN"]), fieldValue: z.unknown() }).strict()).max(10),
    limit: z.number().int().min(1).max(100).default(50),
    continuationHandle: z.string().max(2048).optional(),
  }, async ({ view, zone, recordType, filters, limit, continuationHandle }) => service.queryRecords(view, zone, recordType, filters as readonly QueryFilter[], limit, continuationHandle));
  register(server, "read_record_fields", "Read only exact payload fields enabled by immutable startup policy.", { view: viewSchema, zone: zoneSchema, recordNames: recordNamesSchema, fields: fieldsSchema }, async ({ view, zone, recordNames, fields }) => service.readRecordFields(view, zone, recordNames, fields));
  register(server, "get_share", "Inspect bounded privacy-safe share topology attached to a proven record.", { view: viewSchema, zone: zoneSchema, recordName: z.string().min(1).max(1024) }, async ({ view, zone, recordName }) => service.getShare(view, zone, recordName));
  register(server, "list_subscriptions", "List supported subscription structure without notification payloads or predicate values.", { view: viewSchema }, async ({ view }) => service.listSubscriptions(view));
  register(server, "get_database_changes", "Read bounded database change state with process-bound continuation handles.", { view: viewSchema, start: z.enum(["currentBaseline", "beginning"]), continuationHandle: z.string().max(2048).optional() }, async ({ view, start, continuationHandle }) => service.getDatabaseChanges(view, start, continuationHandle));
  register(server, "get_zone_changes", "Read bounded custom-zone changes and tombstones with process-bound continuation handles.", { view: viewSchema, zone: zoneSchema, start: z.enum(["currentBaseline", "beginning"]), continuationHandle: z.string().max(2048).optional() }, async ({ view, zone, start, continuationHandle }) => service.getZoneChanges(view, zone, start, continuationHandle));
  register(server, "compare_views", "Compare exact record observations made with two independently configured views.", { left: viewSchema, right: viewSchema, zone: zoneSchema, recordNames: recordNamesSchema }, async ({ left, right, zone, recordNames }) => service.compareViews(left, right, zone, recordNames));

  for (const [name, filename, mimeType] of [
    ["capabilities", "capabilities.json", "application/json"],
    ["profile-schema", "schemas/profiles.json", "application/schema+json"],
    ["result-schema", "schemas/result-envelope.json", "application/schema+json"],
  ] as const) {
    const uri = name === "capabilities" ? "cloudkit://capabilities" : name === "profile-schema" ? "cloudkit://schemas/profiles" : "cloudkit://schemas/result-envelope";
    server.registerResource(name, uri, { mimeType, description: "Packaged static CloudKit MCP safety and schema contract." }, async () => ({ contents: [{ uri, mimeType, text: await readFile(new URL(`../resources/${filename}`, import.meta.url), "utf8") }] }));
  }
  return server;
}

function register<T extends Record<string, z.ZodTypeAny>>(
  server: McpServer,
  name: string,
  description: string,
  inputSchema: T,
  handler: (input: z.infer<z.ZodObject<T>>) => Promise<unknown> | unknown,
): void {
  const callback = async (input: unknown) => {
    try {
      const result = await handler(input as z.infer<z.ZodObject<T>>);
      const text = JSON.stringify(result);
      if (Buffer.byteLength(text, "utf8") > 512 * 1024) throw safeError({ code: "outputBoundExceeded", message: "The serialized MCP result exceeds the configured output bound.", execution: "completed", sessionEffect: "unchanged", retryable: false, retryConditions: [], nextStep: "Narrow the record, field, participant, or page selection." });
      return { content: [{ type: "text" as const, text }], structuredContent: asStructured(result) };
    } catch (error) {
      const safe = sanitizeUnknownError(error);
      return { isError: true, content: [{ type: "text" as const, text: JSON.stringify(safe) }], structuredContent: asStructured(safe) };
    }
  };
  server.registerTool(name, { description, inputSchema, annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true } } as never, callback as never);
}

function asStructured(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : { value };
}

export type { ViewInput, ZoneInput };
