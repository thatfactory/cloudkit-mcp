import assert from "node:assert/strict";
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
    assert.equal(tools.tools.length, 12);
    assert.equal(tools.tools.every((tool) => tool.annotations?.readOnlyHint === true), true);
    const context = await client.callTool({ name: "get_context", arguments: {} });
    assert.equal(context.isError, undefined);
    const resources = await client.listResources();
    assert.deepEqual(resources.resources.map((resource) => resource.uri).sort(), ["cloudkit://capabilities", "cloudkit://schemas/profiles", "cloudkit://schemas/result-envelope"]);
    assert.equal(networkCalls, 0);
  } finally { await client.close(); await server.close(); }
});
