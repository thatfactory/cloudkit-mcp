import { execFile } from "node:child_process";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

const execute = promisify(execFile);
const tarballIndex = process.argv.indexOf("--tarball");
let report;
let temporary;
if (tarballIndex >= 0) {
  const tarball = resolve(process.argv[tarballIndex + 1]); temporary = await mkdtemp(join(tmpdir(), "cloudkit-package-verify-"));
  await execute("tar", ["-xzf", tarball, "-C", temporary]);
  const { stdout } = await execute("tar", ["-tzf", tarball]);
  report = { files: stdout.trim().split("\n").filter((path) => path && !path.endsWith("/")).map((path) => ({ path: path.replace(/^package\//, "") })) };
  const packaged = JSON.parse(await readFile(join(temporary, "package", "package.json"), "utf8"));
  if (packaged.name !== "@thatfactory/cloudkit-mcp" || typeof packaged.version !== "string") throw new Error("packaged identity mismatch");
} else {
  const { stdout } = await execute("npm", ["pack", "--json", "--dry-run", "--ignore-scripts"], { cwd: new URL("..", import.meta.url) }); report = JSON.parse(stdout)[0];
}
const allowedTopLevel = new Set(["dist", "resources", "package.json", "README.md", "LICENSE"]);
for (const file of report.files) {
  const top = file.path.split("/")[0];
  if (!allowedTopLevel.has(top)) throw new Error(`unexpected package file: ${file.path}`);
  if (/\.map$/.test(file.path) || /(?<!\.d)\.ts$/.test(file.path) || /(?:^|\/)(?:fixtures?|contracts?|tests?)(?:\/|$)/i.test(file.path)) throw new Error(`unsafe package file: ${file.path}`);
}
for (const required of ["dist/index.js", "resources/capabilities.json", "package.json", "README.md", "LICENSE"]) if (!report.files.some((file) => file.path === required)) throw new Error(`missing package file: ${required}`);
if (temporary) await rm(temporary, { recursive: true, force: true });
