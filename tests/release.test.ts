import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createReleaseArtifact, verifyReleaseArtifact } from "../scripts/release-artifact.js";
import { verifyReleaseIdentity } from "../scripts/release-preflight.js";

test("publish workflow is release-only and publishes the reverified exact tarball", async () => {
  const workflow = await readFile(new URL("../.github/workflows/publish.yml", import.meta.url), "utf8");
  assert.match(workflow, /release:\n\s+types: \[published\]/);
  assert.doesNotMatch(workflow, /workflow_dispatch:|\n\s+push:/);
  assert.match(workflow, /environment: npm-publish/); assert.match(workflow, /id-token: write/);
  assert.match(workflow, /release-preflight\.ts/); assert.match(workflow, /release-artifact\.ts create/);
  assert.match(workflow, /release-artifact\.ts verify[\s\S]*npm publish "\$TARBALL" --access public --provenance --ignore-scripts/);
  assert.doesNotMatch(workflow, /npm publish --access public/); assert.doesNotMatch(workflow, /NPM_TOKEN|NODE_AUTH_TOKEN/);
});

test("release identity accepts immutable lightweight and annotated tags and rejects mismatches", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "cloudkit-release-git-")); context.after(() => rm(root, { recursive: true, force: true }));
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: root }); execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: root }); execFileSync("git", ["config", "user.name", "Test"], { cwd: root });
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "@thatfactory/cloudkit-mcp", version: "0.1.0", repository: { url: "git+https://github.com/thatfactory/cloudkit-mcp.git" } }));
  execFileSync("git", ["add", "package.json"], { cwd: root }); execFileSync("git", ["commit", "-qm", "release"], { cwd: root });
  const sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  execFileSync("git", ["tag", "0.1.0"], { cwd: root }); verifyReleaseIdentity({ cwd: root, tag: "0.1.0", eventSha: sha, mainRef: "main" });
  execFileSync("git", ["tag", "-d", "0.1.0"], { cwd: root }); execFileSync("git", ["tag", "-a", "0.1.0", "-m", "annotated"], { cwd: root }); verifyReleaseIdentity({ cwd: root, tag: "0.1.0", eventSha: sha, mainRef: "main" });
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "@thatfactory/cloudkit-mcp", version: "0.1.1", repository: { url: "git+https://github.com/thatfactory/cloudkit-mcp.git" } }));
  assert.throws(() => verifyReleaseIdentity({ cwd: root, tag: "0.1.0", eventSha: sha, mainRef: "main" }));
  execFileSync("git", ["reset", "--hard", "-q", sha], { cwd: root });
  assert.throws(() => verifyReleaseIdentity({ cwd: root, tag: "0.1.0", eventSha: "b".repeat(40), mainRef: "main" }));
});

test("one authoritative artifact is hashed and tampering is rejected", async (context) => {
  const destination = await mkdtemp(join(tmpdir(), "cloudkit-release-artifact-")); context.after(() => rm(destination, { recursive: true, force: true }));
  const cwd = new URL("..", import.meta.url).pathname; const sourceSha = "a".repeat(40);
  const manifest = createReleaseArtifact({ cwd, destination, tag: "0.1.0", sourceSha });
  assert.equal(verifyReleaseArtifact({ destination, tag: "0.1.0", sourceSha }).sha1, manifest.sha1);
  const tarball = join(destination, manifest.filename); chmodSync(tarball, 0o644); await writeFile(tarball, Buffer.concat([await readFile(tarball), Buffer.from([0])]));
  assert.throws(() => verifyReleaseArtifact({ destination, tag: "0.1.0", sourceSha }), /integrity mismatch/);
});

test("authoritative packing ignores package lifecycle scripts", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "cloudkit-release-hostile-")); const destination = await mkdtemp(join(tmpdir(), "cloudkit-release-output-")); context.after(() => Promise.all([rm(root, { recursive: true, force: true }), rm(destination, { recursive: true, force: true })]));
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "@thatfactory/cloudkit-mcp", version: "0.1.0", scripts: { prepack: "node -e \"require('node:fs').writeFileSync('lifecycle-ran','yes')\"" } }));
  createReleaseArtifact({ cwd: root, destination, tag: "0.1.0", sourceSha: "a".repeat(40) });
  await assert.rejects(readFile(join(root, "lifecycle-ran")));
});
