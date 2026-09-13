import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execute = promisify(execFile);
const { stdout } = await execute("npm", ["pack", "--json", "--dry-run", "--ignore-scripts"], { cwd: new URL("..", import.meta.url) });
const report = JSON.parse(stdout)[0];
const allowedTopLevel = new Set(["dist", "resources", "package.json", "README.md", "LICENSE"]);
for (const file of report.files) {
  const top = file.path.split("/")[0];
  if (!allowedTopLevel.has(top)) throw new Error(`unexpected package file: ${file.path}`);
  if (/\.map$/.test(file.path) || /(?<!\.d)\.ts$/.test(file.path) || /(?:^|\/)(?:fixtures?|contracts?|tests?)(?:\/|$)/i.test(file.path)) throw new Error(`unsafe package file: ${file.path}`);
}
for (const required of ["dist/index.js", "resources/capabilities.json", "package.json", "README.md", "LICENSE"]) if (!report.files.some((file) => file.path === required)) throw new Error(`missing package file: ${required}`);
