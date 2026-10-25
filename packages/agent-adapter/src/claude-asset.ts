/**
 * The spawnable path of the Agent SDK's native CLI (§20.3).
 *
 * A `bun build --compile` binary cannot resolve the CLI at runtime — the SDK's
 * own node_modules lookup fails inside `$bunfs`. The README-documented recipe
 * embeds the platform package's binary as a file asset and extracts it to a
 * real temp directory before spawning; `extractFromBunfs` is self-guarding, so
 * a plain node_modules path (running from source) passes through unchanged and
 * one call serves both modes.
 */

import { extractFromBunfs } from "@anthropic-ai/claude-agent-sdk/extract";
import binPath from "./claude-asset.generated.ts";

export function claudeCliPath(): string {
  return extractFromBunfs(binPath);
}
