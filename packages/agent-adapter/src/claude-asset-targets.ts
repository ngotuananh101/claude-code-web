/**
 * Which SDK platform package carries the CLI binary for a build target (§20.3).
 *
 * The release matrix in `.github/workflows/runner-build.yml` is the source of
 * truth for which targets exist; this map is what turns a `--target` into the
 * `@anthropic-ai/claude-agent-sdk-<platform>` package the asset shim imports.
 * `"host"` resolves from the running platform, so dev machines and CI never
 * have to name their own architecture.
 */

type ClaudeAsset = { pkg: string; binary: string };

const TARGET_ASSETS: Record<string, ClaudeAsset> = {
  "bun-linux-x64": { pkg: "@anthropic-ai/claude-agent-sdk-linux-x64", binary: "claude" },
  "bun-linux-arm64": { pkg: "@anthropic-ai/claude-agent-sdk-linux-arm64", binary: "claude" },
  "bun-windows-x64": { pkg: "@anthropic-ai/claude-agent-sdk-win32-x64", binary: "claude.exe" },
  "bun-windows-arm64": { pkg: "@anthropic-ai/claude-agent-sdk-win32-arm64", binary: "claude.exe" },
};

/**
 * `bun build --target` names Windows `windows-*` while `process.platform` says
 * `win32`, so the host key is normalized into the target spelling.
 */
function hostTargetKey(): string {
  const platform = process.platform === "win32" ? "windows" : process.platform;
  return `bun-${platform}-${process.arch}`;
}

export function claudeAssetTarget(target: string): ClaudeAsset {
  const asset = TARGET_ASSETS[target === "host" ? hostTargetKey() : target];
  if (asset === undefined) {
    const host = `${process.platform}-${process.arch}`;
    throw new Error(
      `no Claude Agent SDK platform package is mapped for target ${target}` +
        (target === "host" ? ` (host is ${host})` : ""),
    );
  }
  return asset;
}
