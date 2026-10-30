/**
 * The models this runner's Claude Code offers (§5.2), discovered at boot.
 *
 * Claude Code resolves its own model lineup from the host: environment
 * overrides (`ANTHROPIC_DEFAULT_*_MODEL`), `~/.claude/settings.json`
 * (`modelPicker`, `modelOverrides`), and the built-in models. The only honest
 * way to learn that list is to ask Claude Code itself — so the runner starts a
 * session, reads the initialization result, and closes it without running a
 * turn. The answer rides the hello; the composer lists what this host actually
 * has, custom names included.
 *
 * Discovery is best-effort. A host where the probe fails (no credentials yet,
 * a crashed CLI, an exotic environment) still runs: it advertises no models,
 * and the control plane falls back to the protocol's own `MODEL_IDS`. It is
 * never worth refusing to start a runner over a missing picker.
 */

import { claudeCliPath } from "@cc-web/agent-adapter";
import { parseRunnerModels, type RunnerModel } from "@cc-web/protocol";

/** The subset of the SDK's `Query` this module uses. */
export type ModelCatalogQuery = {
  initializationResult(): Promise<{ models?: unknown }>;
  close?: () => void;
};

/** The SDK seam: a `query()` that can be closed after its init is read. */
export type ModelCatalogLoad = (params: {
  prompt: AsyncIterable<never>;
  options: Record<string, unknown>;
}) => ModelCatalogQuery;

export type DiscoverModelsOptions = {
  /**
   * The directory the probe runs in. Its project settings are read exactly as
   * a run's would be, so a model configured in the project shows up too.
   */
  cwd: string;
  /** Overrides the SDK seam for tests; production loads the real one lazily. */
  load?: ModelCatalogLoad;
  /** Hard cap on the probe; past it, the runner reports no models. */
  timeoutMs?: number;
};

const DEFAULT_TIMEOUT_MS = 15_000;

/**
 * The models this host's Claude Code offers, or `[]` when the probe could not
 * answer — never a rejection: a failed probe degrades the picker, not the
 * runner.
 */
export async function discoverModels(options: DiscoverModelsOptions): Promise<RunnerModel[]> {
  let query: ModelCatalogQuery | undefined;
  try {
    const load = options.load ?? loadSdk();
    query = load({
      // No turn is ever started: an async iterable that yields nothing is how
      // streaming input says "nothing to send yet". The init frame arrives
      // regardless, and `close()` in the finally ends the subprocess.
      prompt: noTurns(),
      options: {
        cwd: options.cwd,
        // §7.1: inherit the host's Claude Code configuration — the same
        // sources a run reads, so what the picker offers is what a run accepts.
        settingSources: ["user", "project", "local"],
        // §20.3: a compiled binary cannot let the SDK resolve the CLI itself.
        pathToClaudeCodeExecutable: claudeCliPath(),
      },
    });
    const init = await withTimeout(
      query.initializationResult(),
      options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    );
    // Extra SDK fields (resolvedModel, supportsAdaptiveThinking, …) are
    // dropped by the protocol parser — only what the wire carries survives.
    return parseRunnerModels(init.models) ?? [];
  } catch {
    return [];
  } finally {
    // Closing is what stops the spawned CLI; a probe that timed out must not
    // leave a process behind.
    query?.close?.();
  }
}

async function* noTurns(): AsyncGenerator<never> {
  // Intentionally never yields.
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`model discovery timed out after ${ms}ms`));
    }, ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/** The real SDK, resolved synchronously and only when a probe actually runs. */
function loadSdk(): ModelCatalogLoad {
  const sdk = require("@anthropic-ai/claude-agent-sdk") as { query: ModelCatalogLoad };
  return sdk.query;
}
