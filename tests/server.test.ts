import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CloudKitTransport } from "../src/api/transport.js";
import { CredentialStore } from "../src/auth/credential-store.js";
import { SessionManager } from "../src/auth/session.js";
import { parseProfilesDocument } from "../src/config/profiles.js";
import { DiagnosticService } from "../src/diagnostics/service.js";
import { createServer } from "../src/server.js";

test("offline MCP discovery never touches credentials or network", async () => {
  let networkCalls = 0;
  const profiles = parseProfilesDocument({ schemaVersion: 1, profiles: [{ id: "offline", containerId: "iCloud.com.example", environment: "development", backend: "web-services", authenticationMode: "api-token-public", credentialRef: "missing", allowedScopes: ["public"], recordPolicy: {} }] });
  const service = new DiagnosticService(profiles, new SessionManager(new CredentialStore("/path/that/must/not/be/read"), new CloudKitTransport(async () => { networkCalls += 1; throw new Error("network forbidden"); })));
  const server = createServer(service); const client = new Client({ name: "test", version: "1" }); const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    const tools = await client.listTools();
    const capabilities = JSON.parse(await readFile(new URL("../resources/capabilities.json", import.meta.url), "utf8")) as { tools: string[] };
    assert.deepEqual(tools.tools.map((tool) => tool.name), capabilities.tools);
    assert.equal(tools.tools.every((tool) => tool.annotations?.readOnlyHint === true), true);
    assert.match(tools.tools.find((tool) => tool.name === "probe_access")?.description ?? "", /authentication\/current-principal/);
    assert.match(tools.tools.find((tool) => tool.name === "probe_access")?.description ?? "", /challenge without database access/);
    const properties = (name: string) => Object.keys((tools.tools.find((tool) => tool.name === name)?.inputSchema as { properties?: Record<string, unknown> }).properties ?? {});
    assert.deepEqual(properties("list_zones"), ["view"]);
    assert.deepEqual(properties("get_zone"), ["view", "zone"]);
    assert.deepEqual(properties("get_share"), ["view", "zone", "recordName"]);
    assert.deepEqual(properties("list_subscriptions"), ["view"]);
    assert.deepEqual(properties("get_database_changes"), ["view", "start"]);
    assert.deepEqual(properties("get_zone_changes"), ["view", "zone", "start"]);
    assert.deepEqual(properties("compare_views"), ["left", "right", "leftZone", "rightZone", "recordNames"]);
    for (const name of ["get_database_changes", "get_zone_changes"]) {
      const schema = tools.tools.find((tool) => tool.name === name)?.inputSchema as unknown as {
        properties: {
          start: {
            oneOf: Array<{
              properties: { kind: { const: string }; handle?: unknown };
              required: string[];
              additionalProperties: boolean;
            }>;
          };
        };
      };
      const start = schema.properties.start;
      assert.deepEqual(start.oneOf.map((alternative) => alternative.properties.kind.const), ["beginning", "cursor"]);
      assert.deepEqual(start.oneOf.map((alternative) => alternative.required), [["kind"], ["kind", "handle"]]);
      assert.equal(start.oneOf.every((alternative) => alternative.additionalProperties === false), true);
    }
    const context = await client.callTool({ name: "get_context", arguments: {} });
    assert.equal(context.isError, undefined);
    const resources = await client.listResources();
    assert.deepEqual(resources.resources.map((resource) => resource.uri).sort(), ["cloudkit://capabilities", "cloudkit://schemas/profiles", "cloudkit://schemas/result-envelope"]);
    assert.equal(networkCalls, 0);
  } finally { await client.close(); await server.close(); }
});

test("MCP cancellation reaches a running change diagnostic", async () => {
  let observedSignal: AbortSignal | undefined;
  const service = {
    getDatabaseChanges: async (_view: unknown, _start: unknown, signal?: AbortSignal) => {
      observedSignal = signal;
      await new Promise<void>((_resolve, reject) => signal?.addEventListener("abort", () => reject(new Error("cancelled")), { once: true }));
    },
  } as unknown as DiagnosticService;
  const server = createServer(service); const client = new Client({ name: "test", version: "1" }); const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    const controller = new AbortController();
    const request = client.callTool({ name: "get_database_changes", arguments: { view: { profileId: "owner", scope: "private" }, start: { kind: "beginning" } } }, undefined, { signal: controller.signal });
    while (!observedSignal) await new Promise((resolve) => setImmediate(resolve));
    controller.abort();
    await assert.rejects(request);
    assert.equal(observedSignal.aborted, true);
  } finally { await client.close(); await server.close(); }
});
