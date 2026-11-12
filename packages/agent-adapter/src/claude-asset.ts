/**
 * Where this build's Claude Code CLI comes from (§20.3).
 *
 * `bundled` builds embed the SDK's platform binary as a file asset and extract
 * it at first use — a `bun build --compile` binary cannot resolve the CLI
 * inside `$bunfs`. `slim` builds embed nothing and use the host's own `claude`
 * (resolved by apps/runner/src/execution/claude-cli.ts).
 *
 * The generated shim is the switch: importing the platform package is what
 * pulls ~293 MB into the executable, so the slim shim has no such import.
 */

import { extractFromBunfs } from "@anthropic-ai/claude-agent-sdk/extract";
import { asset } from "./claude-asset.generated.ts";

/** The shape the generated shim exports; one arm per build variant. */
export type ClaudeAsset =
  | { readonly kind: "embedded"; readonly binPath: string }
  | { readonly kind: "external" };

const buildAsset: ClaudeAsset = asset;

export function claudeCliKind(): "embedded" | "external" {
  return buildAsset.kind === "embedded" ? "embedded" : "external";
}

/** The extracted path of the embedded CLI; `undefined` in a slim build. */
export function embeddedCliPath(): string | undefined {
  return buildAsset.kind === "embedded" ? extractFromBunfs(buildAsset.binPath) : undefined;
}
