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
  assert.match(workflow, /preflight:[\s\S]*permissions:\n\s+contents: read/); assert.match(workflow, /needs: preflight/);
  assert.match(workflow, /git\/ref\/tags\/\$RELEASE_TAG/); assert.match(workflow, /OBJECT_SHA" = "\$GITHUB_SHA/); assert.match(workflow, /ref: \$\{\{ needs\.preflight\.outputs\.sha \}\}/); assert.match(workflow, /release-artifact\.ts create/);
  assert.match(workflow, /release-artifact\.ts verify[\s\S]*npm publish "\$TARBALL" --access public --provenance --ignore-scripts/);
  assert.doesNotMatch(workflow, /npm publish --access public/); assert.doesNotMatch(workflow, /NPM_TOKEN|NODE_AUTH_TOKEN/);
});

test("trusted workflow preflight rejects moved tags, non-main commits, and unpublished release state", async (context) => {
  const workflow = await readFile(new URL("../.github/workflows/publish.yml", import.meta.url), "utf8");
  const match = workflow.match(/      - name: Resolve trusted release identity[\s\S]*?        run: \|\n([\s\S]*?)\n\n  publish:/); assert.ok(match);
  const script = match[1]!.split("\n").map((line) => line.slice(10)).join("\n").replaceAll("${{ github.event.release.draft }}", "false").replaceAll("${{ github.event.release.prerelease }}", "false");
  const root = await mkdtemp(join(tmpdir(), "cloudkit-workflow-preflight-")); context.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "gh"), `#!/bin/sh\ncase "$2" in\n */git/ref/tags/*) printf '%s\\t%s\\n' "$TEST_SHA" "$TEST_TYPE" ;;\n */git/tags/*) printf '%s\\tcommit\\n' "$TEST_SHA" ;;\n */compare/*) printf '%s\\n' "$TEST_STATUS" ;;\n *) exit 99 ;;\nesac\n`, { mode: 0o755 });
  const sha = "a".repeat(40); const output = join(root, "output"); const base = { ...process.env, PATH: `${root}:${process.env.PATH}`, GITHUB_REPOSITORY: "thatfactory/cloudkit-mcp", GITHUB_SHA: sha, RELEASE_TAG: "0.1.0", TEST_SHA: sha, TEST_TYPE: "commit", TEST_STATUS: "identical", GITHUB_OUTPUT: output };
  for (const change of [{}, { TEST_TYPE: "tag" }, { TEST_STATUS: "ahead" }]) { await writeFile(output, ""); execFileSync("bash", ["-euo", "pipefail", "-c", script], { env: { ...base, ...change } }); assert.equal((await readFile(output, "utf8")).trim(), `sha=${sha}`); }
  for (const change of [{ RELEASE_TAG: "bad;tag" }, { TEST_TYPE: "tree" }, { TEST_SHA: "b".repeat(40) }, { TEST_STATUS: "behind" }, { TEST_STATUS: "diverged" }]) { await writeFile(output, ""); assert.throws(() => execFileSync("bash", ["-euo", "pipefail", "-c", script], { env: { ...base, ...change }, stdio: "pipe" })); assert.equal(await readFile(output, "utf8"), ""); }
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
  await writeFile(join(root, "tracked"), "dirty"); execFileSync("git", ["add", "tracked"], { cwd: root }); execFileSync("git", ["commit", "-qm", "tracked"], { cwd: root });
  execFileSync("git", ["checkout", "--detach", "-q"], { cwd: root }); await writeFile(join(root, "other"), "branch"); execFileSync("git", ["add", "other"], { cwd: root }); execFileSync("git", ["commit", "-qm", "off-main"], { cwd: root });
  const offMain = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(); execFileSync("git", ["tag", "-f", "0.1.0"], { cwd: root });
  assert.throws(() => verifyReleaseIdentity({ cwd: root, tag: "0.1.0", eventSha: offMain, mainRef: "main" }));
});

test("one authoritative artifact is hashed and tampering is rejected", async (context) => {
  const cwd = await mkdtemp(join(tmpdir(), "cloudkit-release-source-")); const destination = await mkdtemp(join(tmpdir(), "cloudkit-release-artifact-")); context.after(() => Promise.all([rm(cwd, { recursive: true, force: true }), rm(destination, { recursive: true, force: true })]));
  const sourceSha = await initializeArtifactPackage(cwd);
  const manifest = createReleaseArtifact({ cwd, destination, tag: "0.1.0", sourceSha });
  assert.equal(verifyReleaseArtifact({ destination, tag: "0.1.0", sourceSha }).sha1, manifest.sha1);
  const manifestPath = join(destination, "release-artifact.json"); const originalManifest = await readFile(manifestPath, "utf8"); chmodSync(manifestPath, 0o644); await writeFile(manifestPath, `${JSON.stringify({ ...manifest, filename: "../escape.tgz" })}\n`);
  assert.throws(() => verifyReleaseArtifact({ destination, tag: "0.1.0", sourceSha }), /manifest identity mismatch/); await writeFile(manifestPath, originalManifest);
  const tarball = join(destination, manifest.filename); chmodSync(tarball, 0o644); await writeFile(tarball, Buffer.concat([await readFile(tarball), Buffer.from([0])]));
  assert.throws(() => verifyReleaseArtifact({ destination, tag: "0.1.0", sourceSha }), /integrity mismatch/);
});

test("authoritative packing ignores package lifecycle scripts", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "cloudkit-release-hostile-")); const destination = await mkdtemp(join(tmpdir(), "cloudkit-release-output-")); context.after(() => Promise.all([rm(root, { recursive: true, force: true }), rm(destination, { recursive: true, force: true })]));
  const sourceSha = await initializeArtifactPackage(root, "node -e \"require('node:fs').writeFileSync('lifecycle-ran','yes')\"");
  createReleaseArtifact({ cwd: root, destination, tag: "0.1.0", sourceSha });
  await assert.rejects(readFile(join(root, "lifecycle-ran")));
  const dirtyDestination = await mkdtemp(join(tmpdir(), "cloudkit-release-dirty-")); context.after(() => rm(dirtyDestination, { recursive: true, force: true })); await writeFile(join(root, "package.json"), "{}\n");
  assert.throws(() => createReleaseArtifact({ cwd: root, destination: dirtyDestination, tag: "0.1.0", sourceSha }), /source identity mismatch/);
});

async function initializeArtifactPackage(root: string, prepack?: string): Promise<string> {
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: root }); execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: root }); execFileSync("git", ["config", "user.name", "Test"], { cwd: root });
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "@thatfactory/cloudkit-mcp", version: "0.1.0", ...(prepack ? { scripts: { prepack } } : {}) })); await writeFile(join(root, "index.js"), "export {};\n");
  execFileSync("git", ["add", "."], { cwd: root }); execFileSync("git", ["commit", "-qm", "package"], { cwd: root }); return execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
}
