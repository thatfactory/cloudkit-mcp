#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { createServer, VERSION } from "./server.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CloudKitTransport } from "./api/transport.js";
import { CredentialStore, type StoredCredential } from "./auth/credential-store.js";
import { SessionManager } from "./auth/session.js";
import { loadProfilesFile, requireProfile, type ProfilesDocument } from "./config/profiles.js";
import { DiagnosticService } from "./diagnostics/service.js";
import { sanitizeUnknownError } from "./errors.js";

interface CommonOptions { readonly profilesPath?: string; readonly credentialStorePath?: string }

/** Runs the CLI without loading credentials for help, version, or static discovery. */
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === "--help") return writeHelp();
  if (args.length === 1 && args[0] === "--version") return void process.stdout.write(`${VERSION}\n`);
  const command = args[0]?.startsWith("-") || args.length === 0 ? "serve" : args[0];
  const remainder = command === "serve" && args[0] !== "serve" ? args : args.slice(1);
  if (command === "serve") return serve(parseCommonOptions(remainder));
  if (command === "auth") return authCommand(remainder);
  throw new Error("Unknown command. Run cloudkit-mcp --help.");
}

function writeHelp(): void {
  process.stdout.write(`cloudkit-mcp ${VERSION}\n\nUsage:\n  cloudkit-mcp serve [--profiles <absolute-json-path>] [--credential-store <absolute-directory>]\n  cloudkit-mcp auth import --profile <id> --profiles <absolute-json-path> --credential-store <absolute-directory>\n  cloudkit-mcp auth status --profile <id> --profiles <absolute-json-path> --credential-store <absolute-directory>\n  cloudkit-mcp auth remove --profile <id> --profiles <absolute-json-path> --credential-store <absolute-directory>\n  cloudkit-mcp --help\n  cloudkit-mcp --version\n\nThe server is read-only. --allow-writes is rejected and cannot enable mutations.\n`);
}

async function serve(options: CommonOptions): Promise<void> {
  const profiles: ProfilesDocument = options.profilesPath ? await loadProfilesFile(options.profilesPath) : { schemaVersion: 1, profiles: [] };
  const store = new CredentialStore(options.credentialStorePath ?? defaultCredentialStore());
  const service = new DiagnosticService(profiles, new SessionManager(store, new CloudKitTransport()));
  const server = createServer(service);
  const transport = new StdioServerTransport();
  let closing = false;
  const close = (): void => { if (closing) return; closing = true; void server.close().finally(() => process.stdin.destroy()); };
  process.once("SIGINT", close); process.once("SIGTERM", close); process.stdin.once("end", close);
  await server.connect(transport);
}

async function authCommand(args: readonly string[]): Promise<void> {
  const action = args[0]; const parsed = parseAuthOptions(args.slice(1));
  if (!parsed.profilesPath || !parsed.credentialStorePath || !parsed.profileId) throw new Error("auth commands require --profile, --profiles, and --credential-store.");
  const profiles = await loadProfilesFile(parsed.profilesPath); const profile = requireProfile(profiles, parsed.profileId); const store = new CredentialStore(parsed.credentialStorePath); await store.initialize();
  if (action === "status") { process.stdout.write(`${JSON.stringify(await store.status(profile.credentialRef))}\n`); return; }
  if (action === "remove") { await store.remove(profile.credentialRef); process.stderr.write(`${JSON.stringify({ subsystem: "com.thatfactory.cloudkit-mcp", event: "credentialChanged", action: "removed", profileId: profile.id })}\n`); return; }
  if (action !== "import") throw new Error("Unknown auth action.");
  if (!process.stdin.isTTY || !process.stdin.setRawMode) throw new Error("auth import requires an interactive terminal with hidden input.");
  const credential = await promptCredential(profile.authenticationMode);
  await store.write(profile.credentialRef, credential);
  process.stderr.write(`${JSON.stringify({ subsystem: "com.thatfactory.cloudkit-mcp", event: "credentialChanged", action: "imported", profileId: profile.id, credentialClass: credential.class })}\n`);
}

async function promptCredential(mode: "server-key" | "web-user" | "api-token-public"): Promise<StoredCredential> {
  if (mode === "api-token-public") return { schemaVersion: 1, class: mode, apiToken: await hiddenPrompt("CloudKit API token: "), generation: 0 };
  if (mode === "web-user") return { schemaVersion: 1, class: mode, apiToken: await hiddenPrompt("CloudKit API token: "), webAuthenticationToken: await hiddenPrompt("CloudKit web authentication token: "), generation: 0, principalEpoch: randomUUID(), uncertain: false };
  return { schemaVersion: 1, class: mode, keyId: await hiddenPrompt("CloudKit key ID: "), privateKeyPem: Buffer.from(await hiddenPrompt("Base64-encoded PEM private key: "), "base64").toString("utf8"), generation: 0 };
}

async function hiddenPrompt(label: string): Promise<string> {
  process.stderr.write(label); process.stdin.setRawMode?.(true); process.stdin.resume();
  return new Promise((resolvePromise, reject) => {
    let value = "";
    const finish = (): void => { process.stdin.setRawMode?.(false); process.stdin.pause(); process.stdin.off("data", onData); process.stderr.write("\n"); value ? resolvePromise(value) : reject(new Error("Empty credential input.")); };
    const onData = (chunk: Buffer): void => { for (const byte of chunk) { if (byte === 3) { process.stdin.setRawMode?.(false); process.exitCode = 130; reject(new Error("Credential import cancelled.")); return; } if (byte === 10 || byte === 13) { finish(); return; } if (byte === 127) value = value.slice(0, -1); else if (byte >= 32) value += String.fromCharCode(byte); } };
    process.stdin.on("data", onData);
  });
}

function parseCommonOptions(args: readonly string[]): CommonOptions {
  let profilesPath: string | undefined; let credentialStorePath: string | undefined;
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index]; const value = args[index + 1];
    if (flag === "--allow-writes") throw new Error("--allow-writes cannot activate any MVP behavior.");
    if (!value) throw new Error(`Missing value for ${flag ?? "argument"}.`);
    if (flag === "--profiles") profilesPath = value; else if (flag === "--credential-store") credentialStorePath = value; else throw new Error(`Unknown flag ${flag}.`);
  }
  return { ...(profilesPath ? { profilesPath } : {}), ...(credentialStorePath ? { credentialStorePath } : {}) };
}

function parseAuthOptions(args: readonly string[]): CommonOptions & { readonly profileId?: string } {
  const commonArgs: string[] = []; let profileId: string | undefined;
  for (let index = 0; index < args.length; index += 2) { const flag = args[index]; const value = args[index + 1]; if (!value) throw new Error(`Missing value for ${flag ?? "argument"}.`); if (flag === "--profile") profileId = value; else commonArgs.push(flag ?? "", value); }
  return { ...parseCommonOptions(commonArgs), ...(profileId ? { profileId } : {}) };
}

function defaultCredentialStore(): string {
  const base = process.env.XDG_DATA_HOME;
  if (!base) throw new Error("--credential-store is required unless XDG_DATA_HOME is explicitly configured.");
  return `${base}/cloudkit-mcp/credentials`;
}

main().catch((error: unknown) => { process.stderr.write(`${JSON.stringify(sanitizeUnknownError(error))}\n`); process.exitCode = 1; });

export type { ProfilesDocument };
