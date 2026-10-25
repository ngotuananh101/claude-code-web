/**
 * Claude Agent SDK adapter — Runner-only.
 *
 * This is the only module that imports `@anthropic-ai/claude-agent-sdk`
 * (§4.2). Never import it from apps/web or apps/control-server: it pulls in the
 * SDK and the bundled Claude Code binary.
 *
 * The SDK function is a parameter for the same reason the executor's stream is:
 * unit tests drive the mapping without a model call. Production passes nothing
 * and the real `query` is loaded lazily — lazily because an eager import would
 * make every runner test load the bundled binary just by importing this module.
 */

import { claudeCliPath } from "./claude-asset.ts";

export { claudeCliPath } from "./claude-asset.ts";

/** The subset of the SDK's `query` this adapter uses. */
export type QueryFn = (params: {
  prompt: string;
  options?: Record<string, unknown>;
}) => AsyncIterable<Record<string, unknown>>;

export type SdkStreamInput = {
  prompt: string;
  cwd: string;
  resume?: string;
  abort?: AbortSignal;
  /** The run's permission mode; the executor always supplies one. */
  permissionMode?: string;
  /** The model the run named (§5.2); absent leaves the SDK's own default. */
  model?: string;
  /**
   * The approval gate (§13). Present means the runner wants to be asked;
   * absent leaves the SDK's own permission flow untouched.
   */
  canUseTool?: (
    toolName: string,
    input: unknown,
    options: { signal: AbortSignal },
  ) => Promise<
    { behavior: "allow"; updatedInput?: unknown } | { behavior: "deny"; message: string }
  >;
  /**
   * Where the SDK's CLI subprocess lives (§20.3). Production resolves the
   * embedded platform binary via `claudeCliPath()`; the field exists so tests
   * and exotic hosts can name another one.
   */
  pathToClaudeCodeExecutable?: string;
};

/**
 * Build the message stream for one run (§10.2).
 *
 * Option policy follows §8.1: an override that is absent is *omitted*. Nothing
 * here sets a default that merely looks like inheritance — the SDK's own
 * defaults and the host's config are what "inherit" means.
 */
export function createSdkStream(
  input: SdkStreamInput,
  load: () => QueryFn = defaultQuery,
): AsyncIterable<Record<string, unknown>> {
  // The abort controller the SDK sees is ours, linked to the caller's signal:
  // the adapter owns the CLI subprocess, so it owns the cancellation path that
  // reaches it (§14.2).
  const controller = new AbortController();
  if (input.abort) {
    if (input.abort.aborted) controller.abort();
    else input.abort.addEventListener("abort", () => controller.abort(), { once: true });
  }

  const options: Record<string, unknown> = {
    cwd: input.cwd,
    // §7.1: inherit the host's Claude Code configuration.
    settingSources: ["user", "project", "local"],
    systemPrompt: { type: "preset", preset: "claude_code" },
    // §12.3: partial messages are what let the browser stream rather than wait.
    includePartialMessages: true,
    abortController: controller,
  };

  // §10.4: resume a specific session by id. `continue: true` is never used — it
  // chooses whichever conversation happened to be newest.
  if (input.resume !== undefined) options["resume"] = input.resume;

  // §13: the permission mode rides the run payload and the approval gate is
  // the runner's own closure — both pass through verbatim.
  if (input.permissionMode !== undefined) options["permissionMode"] = input.permissionMode;
  if (input.model !== undefined) options["model"] = input.model;
  if (input.canUseTool !== undefined) options["canUseTool"] = input.canUseTool;
  // §20.3: unlike the options above there is no "inherit" to preserve — the
  // SDK's own resolution cannot find the CLI inside a compiled binary — so the
  // resolved path is always set: the caller's override, else the asset.
  options["pathToClaudeCodeExecutable"] = input.pathToClaudeCodeExecutable ?? claudeCliPath();

  // Loaded inside the generator body, so importing this module costs nothing.
  return (async function* () {
    const query = load();
    for await (const message of query({ prompt: input.prompt, options })) {
      yield message;
    }
  })();
}

/** The real SDK, imported on first use. */
function defaultQuery(): QueryFn {
  // A dynamic import inside a sync-looking factory would return a promise, so
  // the lookup is synchronous via Bun's resolver and the module is loaded the
  // first time a stream is actually consumed. `require` is Bun's supported way
  // to do that without making the whole call chain async.
  const sdk = require("@anthropic-ai/claude-agent-sdk") as { query: QueryFn };
  return sdk.query;
}
