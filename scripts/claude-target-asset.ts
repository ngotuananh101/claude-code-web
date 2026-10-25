#!/usr/bin/env bun
/**
 * Places one target platform's SDK CLI package where the asset shim can
 * resolve it (§20.3).
 *
 * `bun install --os/--cpu` looks like the cross-target answer but is not one:
 * bun treats an already-resolved lockfile as satisfied and relinks nothing,
 * with or without --frozen-lockfile. A cross-compiled build then fails on the
 * shim's bare specifier. This script installs the target's package directly:
 * the tarball is fetched from the npm registry at the exact version of the
 * installed SDK (the platform packages release in lockstep), its sha512 is
 * verified against the registry's published integrity, and it is extracted
 * into packages/agent-adapter/node_modules/@anthropic-ai/<platform package> —
 * the location bun itself would have linked.
 *
 * Run after `bun install` (an install can rebuild package node_modules and
 * drop a placed package; re-running restores it). Idempotent: a present
 * package at the expected version is left alone, a stale one is replaced.
 *
 *   bun run scripts/claude-target-asset.ts --target bun-windows-x64
 */

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { claudeAssetTarget } from "../packages/agent-adapter/src/claude-asset-targets.ts";

const ADAPTER_NODE_MODULES = new URL("../packages/agent-adapter/node_modules/", import.meta.url)
  .pathname;
const SDK_MAIN_PACKAGE = join(ADAPTER_NODE_MODULES, "@anthropic-ai/claude-agent-sdk");

export function parseArgs(argv: string[]): { target: string } {
  const known = ["--target"];
  let target: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i] ?? "";
    const flag = known.find((f) => token === f || token.startsWith(`${f}=`));
    if (flag === undefined) throw new Error(`unknown claude-target-asset flag: ${token}`);
    const value = token === flag ? argv[i + 1] : token.slice(flag.length + 1);
    if (value === undefined || value === "") throw new Error(`${flag} requires a value`);
    target = value;
    if (token === flag) i++;
  }
  return { target: target ?? "host" };
}

/**
 * Whether the target's package is already placed, and if not whether what is
 * there must be replaced: a stale version must never be embedded just because
 * it exists.
 */
export function assetDecision(
  destDir: string,
  expectedVersion: string,
): "present" | "stale" | "missing" {
  const manifest = join(destDir, "package.json");
  if (!existsSync(manifest)) return "missing";
  try {
    const version = JSON.parse(readFileSync(manifest, "utf8"))["version"];
    return version === expectedVersion ? "present" : "stale";
  } catch {
    return "stale";
  }
}

export function registryMetadataUrl(pkg: string, version: string): string {
  return `https://registry.npmjs.org/${pkg}/${version}`;
}

export function registryTarballUrl(pkg: string, version: string): string {
  const name = pkg.slice(pkg.lastIndexOf("/") + 1);
  return `https://registry.npmjs.org/${pkg}/-/${name}-${version}.tgz`;
}

/** The installed SDK's exact version — the platform packages release with it. */
function installedSdkVersion(): string {
  const manifest = join(SDK_MAIN_PACKAGE, "package.json");
  if (!existsSync(manifest)) {
    throw new Error(`the Agent SDK is not installed (${manifest}) — run \`bun install\` first`);
  }
  const version = JSON.parse(readFileSync(manifest, "utf8"))["version"];
  if (typeof version !== "string" || version === "") {
    throw new Error(`the Agent SDK manifest has no version (${manifest})`);
  }
  return version;
}

async function fetchJson(url: string): Promise<Record<string, unknown>> {
  const response = await fetch(url, { signal: AbortSignal.timeout(60_000) });
  if (!response.ok) throw new Error(`registry metadata ${response.status} for ${url}`);
  return (await response.json()) as Record<string, unknown>;
}

async function fetchVerifiedTarball(url: string, integrity: string): Promise<Uint8Array> {
  const response = await fetch(url, { signal: AbortSignal.timeout(600_000) });
  if (!response.ok) throw new Error(`registry tarball ${response.status} for ${url}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  // sha512-<base64> as npm publishes it; the download is worthless on mismatch.
  const expected = integrity.replace(/^sha512-/, "");
  const actual = new Bun.CryptoHasher("sha512").update(bytes).digest("base64");
  if (actual !== expected) throw new Error(`tarball integrity mismatch for ${url}`);
  return bytes;
}

/** Fetch, verify and extract the target's package into the adapter's node_modules. */
async function placePackage(pkg: string, binary: string, version: string): Promise<void> {
  const metadata = await fetchJson(registryMetadataUrl(pkg, version));
  const dist = metadata["dist"] as { tarball?: string; integrity?: string } | undefined;
  if (dist?.integrity === undefined) {
    throw new Error(`registry metadata for ${pkg}@${version} carries no dist.integrity`);
  }
  const bytes = await fetchVerifiedTarball(registryTarballUrl(pkg, version), dist.integrity);

  // Scratch inside the same node_modules so the final rename stays on one
  // device; extracted tarballs always root at package/.
  const dest = join(ADAPTER_NODE_MODULES, pkg);
  const scratch = join(ADAPTER_NODE_MODULES, `.claude-target-${pkg.replace("/", "__")}`);
  rmSync(scratch, { recursive: true, force: true });
  mkdirSync(scratch, { recursive: true });
  const tgz = join(scratch, "package.tgz");
  writeFileSync(tgz, bytes);
  const tar = Bun.spawnSync(["tar", "-xzf", tgz, "-C", scratch]);
  if (tar.exitCode !== 0) throw new Error(`tar extraction failed for ${pkg}@${version}`);

  const extractedVersion = JSON.parse(readFileSync(join(scratch, "package/package.json"), "utf8"))[
    "version"
  ];
  if (extractedVersion !== version) {
    throw new Error(`extracted ${pkg} at ${extractedVersion}, expected ${version}`);
  }
  if (!existsSync(join(scratch, "package", binary))) {
    throw new Error(`extracted ${pkg} is missing its CLI binary (${binary})`);
  }

  rmSync(dest, { recursive: true, force: true });
  renameSync(join(scratch, "package"), dest);
  rmSync(scratch, { recursive: true, force: true });
}

async function main(): Promise<void> {
  const { target } = parseArgs(process.argv.slice(2));
  const asset = claudeAssetTarget(target);
  const version = installedSdkVersion();
  const dest = join(ADAPTER_NODE_MODULES, asset.pkg);

  const decision = assetDecision(dest, version);
  if (decision === "present") {
    console.log(`${asset.pkg}@${version} already placed for ${target}`);
    return;
  }
  if (decision === "stale") console.log(`replacing stale ${asset.pkg} with ${version}`);
  console.log(`fetching ${asset.pkg}@${version} (~280MB, the SDK's native CLI)`);
  await placePackage(asset.pkg, asset.binary, version);
  console.log(`${asset.pkg}@${version} placed for target ${target}`);
}

if (import.meta.main) {
  await main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
