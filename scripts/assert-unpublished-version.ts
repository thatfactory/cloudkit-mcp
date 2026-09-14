import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

type Fetch = typeof fetch;

export async function assertVersionUnpublished(options: {
  packageName: string;
  packageVersion: string;
  registryBase?: string;
  fetchImpl?: Fetch;
}): Promise<void> {
  const { packageName, packageVersion } = options;
  if (!packageName || !packageVersion) throw new Error("release manifest package identity is missing");
  const registryBase = (options.registryBase ?? "https://registry.npmjs.org").replace(/\/$/, "");
  const url = `${registryBase}/${encodeURIComponent(packageName)}/${encodeURIComponent(packageVersion)}`;
  const response = await (options.fetchImpl ?? fetch)(url, { redirect: "error" });
  if (response.status === 404) return;
  if (response.ok) throw new Error(`${packageName}@${packageVersion} is already published`);
  throw new Error(`npm registry lookup failed with HTTP ${response.status}`);
}

export async function run(manifestPath: string | undefined): Promise<void> {
  if (!manifestPath) throw new Error("ARTIFACT_MANIFEST is required");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
    packageName?: unknown;
    packageVersion?: unknown;
  };
  if (typeof manifest.packageName !== "string" || typeof manifest.packageVersion !== "string") {
    throw new Error("release manifest package identity is invalid");
  }
  await assertVersionUnpublished({
    packageName: manifest.packageName,
    packageVersion: manifest.packageVersion,
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await run(process.env.ARTIFACT_MANIFEST);
}
