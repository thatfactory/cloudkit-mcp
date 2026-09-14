import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

const execute = promisify(execFile);
const root = new URL("..", import.meta.url);
const temporary = await mkdtemp(join(tmpdir(), "cloudkit-mcp-smoke-"));
try {
  const tarballIndex = process.argv.indexOf("--tarball");
  const suppliedTarball = tarballIndex >= 0 ? process.argv[tarballIndex + 1] : undefined;
  const tarball = suppliedTarball ? new URL(`file://${resolve(suppliedTarball)}`) : await (async () => { const { stdout } = await execute("npm", ["pack", "--json"], { cwd: root, maxBuffer: 4 * 1024 * 1024 }); const report = JSON.parse(stdout)[0]; return new URL(`../${report.filename}`, import.meta.url); })();
  await execute("npm", ["init", "--yes"], { cwd: temporary });
  await execute("npm", ["install", tarball.pathname, "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund", ...(suppliedTarball ? ["--offline"] : [])], { cwd: temporary });
  const binary = join(temporary, "node_modules", ".bin", "cloudkit-mcp");
  const version = await execute(binary, ["--version"], { cwd: temporary });
  const installedPackage = JSON.parse(await readFile(join(temporary, "node_modules", "@thatfactory", "cloudkit-mcp", "package.json"), "utf8"));
  if (version.stdout.trim() !== installedPackage.version) throw new Error("external binary version mismatch");
  const help = await execute(binary, ["--help"], { cwd: temporary });
  if (!help.stdout.includes("The server is read-only")) throw new Error("external binary help mismatch");
  const capabilities = JSON.parse(await readFile(join(temporary, "node_modules", "@thatfactory", "cloudkit-mcp", "resources", "capabilities.json"), "utf8"));
  if (capabilities.remoteDataEffect !== "none") throw new Error("packaged read-only invariant mismatch");
  if (!suppliedTarball) await rm(tarball, { force: true });
} finally {
  await rm(temporary, { recursive: true, force: true });
}
