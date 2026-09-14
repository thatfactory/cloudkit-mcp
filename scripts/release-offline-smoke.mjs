import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execute = promisify(execFile); const root = new URL("..", import.meta.url); const destination = await mkdtemp(join(tmpdir(), "cloudkit-release-offline-"));
try {
  const packageDocument = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  const { stdout: sourceSha } = await execute("git", ["rev-parse", "HEAD"], { cwd: root });
  await execute("node", ["--import", "tsx", "scripts/release-artifact.ts", "create", "--destination", destination, "--tag", packageDocument.version, "--source-sha", sourceSha.trim()], { cwd: root });
  const manifest = JSON.parse(await readFile(join(destination, "release-artifact.json"), "utf8")); const tarball = join(destination, manifest.filename);
  await execute("node", ["scripts/verify-package.mjs", "--tarball", tarball], { cwd: root });
  await execute("node", ["scripts/pack-smoke.mjs", "--tarball", tarball], { cwd: root });
  await execute("node", ["--import", "tsx", "scripts/release-artifact.ts", "verify", "--destination", destination, "--tag", packageDocument.version, "--source-sha", sourceSha.trim()], { cwd: root });
} finally { await rm(destination, { recursive: true, force: true }); }
