import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DISTRIBUTION_REPOSITORY = "wh1teee/product-foundry-runtime-packages";
const EXACT_GIT_REVISION = /^[0-9a-f]{40}$/u;
const EXACT_SEMVER = /^\d+\.\d+\.\d+$/u;
const INTEGRITY = /^sha512-[A-Za-z0-9+/]+={0,2}$/u;
const REGISTRY_PATH = /^registry\/@product-foundry\/([a-z0-9][a-z0-9-]*)$/u;

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function exactInstant(value, field) {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) throw new Error(`${field} must be an exact publication timestamp`);
  return new Date(value).toISOString();
}

function expectedTarball(packageId, version) {
  return `https://github.com/${DISTRIBUTION_REPOSITORY}/releases/download/${packageId}-v${version}/product-foundry-${packageId}-${version}.tgz`;
}

export function validateRegistryMetadataDelta({ registryPath, before, after }) {
  const match = typeof registryPath === "string" ? registryPath.match(REGISTRY_PATH) : null;
  if (!match) throw new Error("registry path must identify one @product-foundry package");
  if (!after || typeof after !== "object" || Array.isArray(after)) throw new Error("registry metadata must be an object");
  const packageId = match[1];
  const packageName = `@product-foundry/${packageId}`;
  if (after.name !== packageName) throw new Error("registry metadata name must match its package path");
  if (!after["dist-tags"] || Object.keys(after["dist-tags"]).length !== 0) throw new Error("registry dist-tags must remain empty");
  if (!after.versions || typeof after.versions !== "object" || Array.isArray(after.versions)) throw new Error("registry versions must be an object");
  if (!after.time || typeof after.time !== "object" || Array.isArray(after.time)) throw new Error("registry time must be an object");

  const previous = before ?? { name: packageName, "dist-tags": {}, versions: {}, time: {} };
  if (previous.name !== packageName) throw new Error("existing registry metadata name must match its package path");
  for (const [version, metadata] of Object.entries(previous.versions ?? {})) {
    if (after.versions[version] === undefined) throw new Error(`existing registry version removed: ${packageName}@${version}`);
    if (canonicalJson(after.versions[version]) !== canonicalJson(metadata)) {
      throw new Error(`existing registry version changed: ${packageName}@${version}`);
    }
  }
  for (const [key, value] of Object.entries(previous.time ?? {})) {
    if (key === "modified") continue;
    if (after.time[key] !== value) throw new Error(`existing registry time changed: ${packageName}@${key}`);
  }

  const addedVersions = Object.keys(after.versions).filter((version) => previous.versions?.[version] === undefined);
  if (addedVersions.length !== 1) throw new Error("registry publication PR must append exactly one package version");
  const version = addedVersions[0];
  if (!EXACT_SEMVER.test(version)) throw new Error("new registry version must be exact semver");
  const metadata = after.versions[version];
  if (metadata?.name !== packageName || metadata?.version !== version) throw new Error("new registry version identity is inconsistent");
  const tarball = metadata?.dist?.tarball;
  const integrity = metadata?.dist?.integrity;
  if (tarball !== expectedTarball(packageId, version)) throw new Error("new registry version must point to its immutable GitHub release asset");
  if (typeof integrity !== "string" || !INTEGRITY.test(integrity)) throw new Error("new registry version requires sha512 integrity");
  const publishedAt = exactInstant(after.time[version], `registry ${packageName}@${version} time`);
  const expectedCreated = before ? exactInstant(previous.time?.created, "existing registry created time") : publishedAt;
  if (exactInstant(after.time.created, "registry created time") !== expectedCreated) throw new Error("registry created time changed unexpectedly");
  const previousModified = before ? exactInstant(previous.time?.modified, "existing registry modified time") : publishedAt;
  const expectedModified = previousModified > publishedAt ? previousModified : publishedAt;
  if (exactInstant(after.time.modified, "registry modified time") !== expectedModified) throw new Error("registry modified time is not deterministic");

  return Object.freeze([Object.freeze({ packageId, packageName, version, tarball, integrity, publishedAt })]);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: options.cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed: ${(result.stderr || result.stdout || "").trim()}`);
  return result.stdout.trim();
}

function exactRevision(value, field) {
  if (typeof value !== "string" || !EXACT_GIT_REVISION.test(value)) throw new Error(`${field} must be an exact 40-hex revision`);
  return value;
}

function changedRegistryFiles(root, baseSha, sourceSha) {
  const output = run("git", ["diff", "--name-status", "--diff-filter=ACMR", baseSha, sourceSha, "--", "registry/"], { cwd: root });
  if (output === "") return [];
  return output.split("\n").map((line) => {
    const [status, registryPath] = line.split("\t");
    if (!new Set(["A", "M"]).has(status)) throw new Error(`registry publication does not permit ${status} ${registryPath}`);
    if (!registryPath?.match(REGISTRY_PATH)) throw new Error(`unsupported registry path: ${registryPath}`);
    return Object.freeze({ status, registryPath });
  });
}

function previousRegistryMetadata(root, baseSha, entry) {
  if (entry.status === "A") return null;
  return JSON.parse(run("git", ["show", `${baseSha}:${entry.registryPath}`], { cwd: root }));
}

async function verifyImmutableRelease(addition, token) {
  const tag = `${addition.packageId}-v${addition.version}`;
  const headers = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2026-03-10",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
  const releaseResponse = await fetch(`https://api.github.com/repos/${DISTRIBUTION_REPOSITORY}/releases/tags/${encodeURIComponent(tag)}`, { headers });
  if (!releaseResponse.ok) throw new Error(`${addition.packageName}@${addition.version}: immutable release lookup failed with ${releaseResponse.status}`);
  const release = await releaseResponse.json();
  if (release.tag_name !== tag || release.draft === true) throw new Error(`${addition.packageName}@${addition.version}: release identity is invalid`);
  if (exactInstant(release.published_at, "GitHub release published_at") !== addition.publishedAt) {
    throw new Error(`${addition.packageName}@${addition.version}: registry publication time does not match immutable release`);
  }
  const sourceMatch = String(release.body ?? "").match(/Product Foundry source HEAD:\s*([0-9a-f]{40})/u);
  if (!sourceMatch) throw new Error(`${addition.packageName}@${addition.version}: immutable release lacks exact Product Foundry source identity`);
  exactRevision(sourceMatch[1], "immutable release Product Foundry source HEAD");
  const expectedAssetName = path.basename(new URL(addition.tarball).pathname);
  if (!Array.isArray(release.assets) || !release.assets.some((asset) => asset?.name === expectedAssetName)) {
    throw new Error(`${addition.packageName}@${addition.version}: immutable release asset is missing`);
  }
  const assetResponse = await fetch(addition.tarball, { redirect: "follow" });
  if (!assetResponse.ok) throw new Error(`${addition.packageName}@${addition.version}: immutable release asset download failed with ${assetResponse.status}`);
  const bytes = Buffer.from(await assetResponse.arrayBuffer());
  const integrity = `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
  if (integrity !== addition.integrity) throw new Error(`${addition.packageName}@${addition.version}: registry integrity does not match immutable release asset`);
  return Object.freeze({ ...addition, sourceHead: sourceMatch[1] });
}

export async function verifyRegistryPullRequest({ root, baseSha, sourceSha, token = process.env.GITHUB_TOKEN }) {
  const exactBase = exactRevision(baseSha, "registry PR base SHA");
  const exactSource = exactRevision(sourceSha, "registry PR source SHA");
  const currentHead = run("git", ["rev-parse", "HEAD"], { cwd: root });
  if (currentHead !== exactSource) throw new Error(`registry verification requires exact PR source HEAD ${exactSource}; current HEAD is ${currentHead}`);
  const files = changedRegistryFiles(root, exactBase, exactSource);
  const verified = [];
  for (const entry of files) {
    const before = previousRegistryMetadata(root, exactBase, entry);
    const after = JSON.parse(await readFile(path.join(root, entry.registryPath), "utf8"));
    const additions = validateRegistryMetadataDelta({ registryPath: entry.registryPath, before, after });
    for (const addition of additions) verified.push(await verifyImmutableRelease(addition, token));
  }
  return Object.freeze({ baseSha: exactBase, sourceSha: exactSource, registryFiles: files.length, verified: Object.freeze(verified) });
}

async function main() {
  const baseSha = process.argv[2];
  const sourceSha = process.argv[3];
  if (!baseSha && !sourceSha) return;
  if (!baseSha || !sourceSha) throw new Error("usage: verify-registry-pr.mjs <base-sha> <source-sha>");
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  console.log(JSON.stringify(await verifyRegistryPullRequest({ root, baseSha, sourceSha })));
}

await main();
