import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";

export interface ReleaseArtifactManifest {
  readonly schemaVersion: 1; readonly packageName: string; readonly packageVersion: string;
  readonly releaseTag: string; readonly sourceSha: string; readonly filename: string;
  readonly size: number; readonly sha1: string; readonly integritySha512: string;
  readonly nodeVersion: string; readonly npmVersion: string;
}

function hashes(path: string) { const bytes = readFileSync(path); return { size: bytes.byteLength, sha1: createHash("sha1").update(bytes).digest("hex"), integritySha512: `sha512-${createHash("sha512").update(bytes).digest("base64")}` }; }

export function createReleaseArtifact(input: { readonly cwd: string; readonly destination: string; readonly tag: string; readonly sourceSha: string }): ReleaseArtifactManifest {
  const git = (...args: readonly string[]) => execFileSync("git", args, { cwd: input.cwd, encoding: "utf8" }).trim();
  if (git("rev-parse", "HEAD") !== input.sourceSha || git("status", "--porcelain", "--untracked-files=no") !== "") throw new Error("release artifact source identity mismatch");
  mkdirSync(input.destination, { recursive: true });
  if (readdirSync(input.destination).length !== 0) throw new Error("release artifact destination must be empty");
  const output = execFileSync("npm", ["pack", "--json", "--ignore-scripts", "--pack-destination", input.destination], { cwd: input.cwd, encoding: "utf8", maxBuffer: 4 * 1024 * 1024 });
  const reports = JSON.parse(output) as Array<{ filename: string; size: number; shasum: string; integrity: string }>;
  if (reports.length !== 1) throw new Error("npm pack did not produce exactly one artifact");
  const report = reports[0]!; const packageDocument = JSON.parse(readFileSync(join(input.cwd, "package.json"), "utf8")) as { name: string; version: string };
  if (packageDocument.version !== input.tag) throw new Error("release tag does not match package version");
  const filename = basename(report.filename); const path = resolve(input.destination, filename); const calculated = hashes(path);
  if (report.size !== calculated.size || report.shasum !== calculated.sha1 || report.integrity !== calculated.integritySha512) throw new Error("npm pack integrity report does not match artifact bytes");
  const manifest: ReleaseArtifactManifest = { schemaVersion: 1, packageName: packageDocument.name, packageVersion: packageDocument.version, releaseTag: input.tag, sourceSha: input.sourceSha, filename, ...calculated, nodeVersion: process.version, npmVersion: execFileSync("npm", ["--version"], { encoding: "utf8" }).trim() };
  writeFileSync(join(input.destination, "release-artifact.json"), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o444 }); chmodSync(path, 0o444); return manifest;
}

export function verifyReleaseArtifact(input: { readonly destination: string; readonly tag: string; readonly sourceSha: string }): ReleaseArtifactManifest {
  const manifest = JSON.parse(readFileSync(join(input.destination, "release-artifact.json"), "utf8")) as ReleaseArtifactManifest;
  if (manifest.schemaVersion !== 1 || manifest.packageName !== "@thatfactory/cloudkit-mcp" || manifest.packageVersion !== input.tag || manifest.releaseTag !== input.tag || manifest.sourceSha !== input.sourceSha || basename(manifest.filename) !== manifest.filename) throw new Error("release artifact manifest identity mismatch");
  if (manifest.nodeVersion !== process.version || manifest.npmVersion !== execFileSync("npm", ["--version"], { encoding: "utf8" }).trim()) throw new Error("release artifact toolchain identity mismatch");
  const calculated = hashes(resolve(input.destination, manifest.filename));
  if (calculated.size !== manifest.size || calculated.sha1 !== manifest.sha1 || calculated.integritySha512 !== manifest.integritySha512) throw new Error("release artifact integrity mismatch");
  return manifest;
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const value = (flag: string) => { const index = process.argv.indexOf(flag); if (index < 0 || !process.argv[index + 1]) throw new Error(`missing ${flag}`); return process.argv[index + 1]!; };
  const command = process.argv[2]; const destination = resolve(value("--destination")); const tag = value("--tag"); const sourceSha = value("--source-sha");
  const manifest = command === "create" ? createReleaseArtifact({ cwd: process.cwd(), destination, tag, sourceSha }) : command === "verify" ? verifyReleaseArtifact({ destination, tag, sourceSha }) : (() => { throw new Error("expected create or verify"); })();
  process.stdout.write(`${JSON.stringify(manifest)}\n`);
}
