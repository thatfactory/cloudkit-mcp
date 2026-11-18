import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execute = promisify(execFile);
const root = new URL("..", import.meta.url);
const temporary = await mkdtemp(join(tmpdir(), "cloudkit-mcp-smoke-"));
try {
  const tarballIndex = process.argv.indexOf("--tarball");
  const suppliedTarball = tarballIndex >= 0 ? process.argv[tarballIndex + 1] : undefined;
  const tarball = suppliedTarball ? pathToFileURL(resolve(suppliedTarball)) : await (async () => { const { stdout } = await execute("npm", ["pack", "--json"], { cwd: root, maxBuffer: 4 * 1024 * 1024 }); const report = JSON.parse(stdout)[0]; return new URL(`../${report.filename}`, import.meta.url); })();
  await execute("npm", ["init", "--yes"], { cwd: temporary });
  await execute("npm", ["install", tarball.pathname, "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund", ...(suppliedTarball ? ["--offline"] : [])], { cwd: temporary });
  const binary = join(temporary, "node_modules", ".bin", "cloudkit-mcp");
  const version = await execute(binary, ["--version"], { cwd: temporary });
  const installedPackage = JSON.parse(await readFile(join(temporary, "node_modules", "@thatfactory", "cloudkit-mcp", "package.json"), "utf8"));
  if (version.stdout.trim() !== installedPackage.version) throw new Error("external binary version mismatch");
  const help = await execute(binary, ["--help"], { cwd: temporary });
  if (!help.stdout.includes("The server is read-only")) throw new Error("external binary help mismatch");
  if (!help.stdout.includes("--recovery-mode post-message|manual") || !help.stdout.includes("--recovery-port")) throw new Error("external recovery options missing");
  const capabilities = JSON.parse(await readFile(join(temporary, "node_modules", "@thatfactory", "cloudkit-mcp", "resources", "capabilities.json"), "utf8"));
  if (capabilities.remoteDataEffect !== "none") throw new Error("packaged read-only invariant mismatch");
  if (!capabilities.tools.includes("recover_session")) throw new Error("packaged recovery tool missing");
  const resourceRoot = join(temporary, "node_modules", "@thatfactory", "cloudkit-mcp", "resources");
  if (!(await readFile(join(resourceRoot, "troubleshooting.md"), "utf8")).includes("Act As iCloud Account")) throw new Error("packaged account inspection guidance missing");
  if (!(await readFile(join(resourceRoot, "recovery-page.html"), "utf8")).includes("client.js") || !(await readFile(join(resourceRoot, "recovery-page.js"), "utf8")).includes("event.source !== popup")) throw new Error("packaged callback page missing");
  if (!suppliedTarball) await rm(tarball, { force: true });
} finally {
  await rm(temporary, { recursive: true, force: true });
}
