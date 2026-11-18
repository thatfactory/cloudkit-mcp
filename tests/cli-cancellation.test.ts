import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { CredentialStore } from "../src/auth/credential-store.js";

for (const prompt of ["1", "2"]) test(`Ctrl+C at hidden import prompt ${prompt} restores the terminal and leaves the slot unchanged`, { timeout: 15_000 }, async (context) => {
  const root = await mkdtemp(join(tmpdir(), "cloudkit-import-cancel-")); context.after(() => rm(root, { recursive: true, force: true }));
  const profilesPath = join(root, "profiles.json"); const storePath = join(root, "credentials");
  await writeFile(profilesPath, JSON.stringify({ schemaVersion: 1, profiles: [{ id: "owner", containerId: "iCloud.com.example", environment: "development", backend: "web-services", authenticationMode: "web-user", credentialRef: "owner", allowedScopes: ["private"], recordPolicy: {} }] }));
  await new CredentialStore(storePath).write("owner", { schemaVersion: 1, class: "web-user", apiToken: "synthetic-saved-api", webAuthenticationToken: "synthetic-saved-token", generation: 4, principalEpoch: "saved-epoch" });
  const before = await readFile(join(storePath, "owner.json"), "utf8");
  const result = await promisify(execFile)("python3", [fileURLToPath(new URL("helpers/auth-cancellation.py", import.meta.url)), process.execPath, fileURLToPath(new URL("..", import.meta.url)), profilesPath, storePath, prompt]);
  const observed = JSON.parse(result.stdout) as { exitCode: number; terminalRestored: boolean; output: string };
  assert.equal(observed.exitCode, 130); assert.equal(observed.terminalRestored, true);
  assert.equal(observed.output.includes("synthetic-hidden-api-input"), false);
  assert.match(observed.output, /"code":"cancelled"/); assert.match(observed.output, /"execution":"notStarted"/); assert.match(observed.output, /"sessionEffect":"unchanged"/);
  assert.equal(observed.output.includes("malformedResponse"), false);
  assert.equal(await readFile(join(storePath, "owner.json"), "utf8"), before);
});
