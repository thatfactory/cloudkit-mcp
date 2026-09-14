import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

export interface ReleasePreflightInput { readonly tag: string; readonly eventSha: string; readonly mainRef: string; readonly cwd?: string }

/** Proves that a release event, package version, checkout, and mainline commit are identical. */
export function verifyReleaseIdentity(input: ReleasePreflightInput): void {
  const cwd = input.cwd ?? process.cwd();
  if (!/^[0-9A-Za-z._-]+$/.test(input.tag) || !/^[0-9a-f]{40}$/.test(input.eventSha)) throw new Error("invalid release identity input");
  const packageDocument = JSON.parse(readFileSync(`${cwd}/package.json`, "utf8")) as { name?: string; version?: string; repository?: { url?: string } };
  if (packageDocument.name !== "@thatfactory/cloudkit-mcp" || !new Set(["git+https://github.com/thatfactory/cloudkit-mcp.git", "https://github.com/thatfactory/cloudkit-mcp.git", "git@github.com:thatfactory/cloudkit-mcp.git"]).has(packageDocument.repository?.url ?? "")) throw new Error("unexpected package repository identity");
  if (packageDocument.version !== input.tag) throw new Error("release tag does not match package version");
  const git = (...args: readonly string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
  const tagCommit = git("rev-parse", "--verify", `${input.tag}^{commit}`);
  if (tagCommit !== input.eventSha) throw new Error("release event SHA does not match tag commit");
  if (git("rev-parse", "HEAD") !== tagCommit) throw new Error("checkout does not match release tag commit");
  execFileSync("git", ["merge-base", "--is-ancestor", tagCommit, input.mainRef], { cwd, stdio: "pipe" });
  if (git("status", "--porcelain", "--untracked-files=no") !== "") throw new Error("tracked release source is dirty");
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const value = (flag: string) => { const index = process.argv.indexOf(flag); if (index < 0 || !process.argv[index + 1]) throw new Error(`missing ${flag}`); return process.argv[index + 1]!; };
  verifyReleaseIdentity({ tag: value("--tag"), eventSha: value("--event-sha"), mainRef: value("--main-ref") });
}
