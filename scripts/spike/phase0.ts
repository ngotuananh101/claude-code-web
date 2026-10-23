#!/usr/bin/env bun
/**
 * Phase 0 spike — runtime and config compatibility (ARCHITECTURE.md §22.1, §23).
 *
 * Runs in stages so a failure tells you which assumption broke:
 *
 *   1. binary  — bundled Claude Code resolves without a global `claude`
 *   2. settings — config cascade is readable and provider env arrives via it
 *   3. query   — streaming, session id, resume, cancel against the real gateway
 *
 * Stages 1–2 never call a model. Stage 3 does, and costs tokens, so it only
 * runs when explicitly requested.
 *
 *   bun run scripts/spike/phase0.ts            # stages 1–2 (free)
 *   bun run scripts/spike/phase0.ts --model    # stages 1–3 (spends tokens)
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveSettings } from "@anthropic-ai/claude-agent-sdk";

const runModel = process.argv.includes("--model");

type Stage = { name: string; status: "ok" | "fail" | "skip"; detail: string };
const stages: Stage[] = [];

function record(name: string, status: Stage["status"], detail: string): void {
  stages.push({ name, status, detail });
  const mark = status === "ok" ? "✓" : status === "skip" ? "–" : "✗";
  console.log(`${mark} ${name.padEnd(28)} ${detail}`);
}

/** Redact a secret-bearing value: show length and a masked prefix only. */
function mask(value: string): string {
  if (value.length === 0) return "(empty)";
  return `${value.slice(0, 2).replace(/./g, "•")}… (${value.length} chars)`;
}

// ---------------------------------------------------------------------------
// Stage 1 — bundled binary
// ---------------------------------------------------------------------------

async function stageBinary(): Promise<string | undefined> {
  // The platform package is an optional dependency of the SDK, so it is only
  // resolvable *relative to the SDK package* — not from our own cwd. A Runner
  // that changes directory at runtime must not lose the binary.
  const platform = `${process.platform}-${process.arch}`;
  const candidates = [
    `@anthropic-ai/claude-agent-sdk-${platform}`,
    `@anthropic-ai/claude-agent-sdk-${platform}-musl`,
  ];

  const sdkEntry = Bun.resolveSync("@anthropic-ai/claude-agent-sdk", import.meta.dir);
  const requireFromSdk = createRequire(sdkEntry);

  let found: string | undefined;
  for (const candidate of candidates) {
    try {
      const bin = requireFromSdk.resolve(
        `${candidate}/${process.platform === "win32" ? "claude.exe" : "claude"}`,
      );
      if (await Bun.file(bin).exists()) {
        found = bin;
        break;
      }
    } catch {
      // try next candidate
    }
  }

  if (!found) {
    record("bundled binary", "fail", `no platform package for ${platform}`);
    return undefined;
  }

  const stat = await Bun.file(found).stat();
  record("bundled binary", "ok", `${found.replace(/^.*node_modules\//, "")} (${(stat.size / 1e6).toFixed(0)} MB)`);

  // Prove it runs. `--version` is the cheapest liveness check that still proves
  // the binary is executable on this libc.
  const probe = Bun.spawnSync([found, "--version"], { stdout: "pipe", stderr: "pipe" });
  if (probe.exitCode !== 0) {
    record("binary executes", "fail", probe.stderr.toString().trim().slice(0, 200));
    return found;
  }
  record("binary executes", "ok", probe.stdout.toString().trim());

  // Confirm no global CLI is required: the spike must not depend on PATH.
  const globalClaude = Bun.spawnSync(["which", "claude"]);
  record(
    "global claude not required",
    "ok",
    globalClaude.exitCode === 0
      ? `present on PATH but unused (${globalClaude.stdout.toString().trim()})`
      : "absent from PATH — bundled binary is self-sufficient",
  );

  return found;
}

// ---------------------------------------------------------------------------
// Stage 2 — config cascade
// ---------------------------------------------------------------------------

async function stageSettings(cwd: string): Promise<boolean> {
  // resolveSettings uses the same merge engine as the CLI without spawning it.
  const resolved = await resolveSettings({
    cwd,
    settingSources: ["user", "project", "local"],
  });

  const sources = resolved.sources.map((s) => s.source).join(", ");
  record("settings sources", "ok", sources || "(none)");

  const provenance = Object.keys(resolved.provenance);
  record("settings provenance", "ok", `${provenance.length} keys traced`);

  // The critical Phase 0 question: does the gateway arrive via the settings
  // cascade, or only because this shell happens to export it? A systemd-run
  // Runner will not have the operator's shell.
  const envSource = resolved.sources.find((s) => s.settings.env?.ANTHROPIC_BASE_URL);
  if (!envSource) {
    record(
      "gateway via settings",
      "fail",
      "ANTHROPIC_BASE_URL absent from the cascade — only the shell provides it",
    );
    return false;
  }

  const baseUrl = envSource.settings.env?.ANTHROPIC_BASE_URL ?? "";
  const token = envSource.settings.env?.ANTHROPIC_AUTH_TOKEN ?? "";
  let where = "unparseable";
  try {
    const url = new URL(baseUrl);
    const host = url.hostname;
    where = /^(localhost|127\.|\[::1\])/.test(host)
      ? "loopback"
      : /^(10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[01])\.)/.test(host)
        ? "private"
        : "public";
    where = `${url.protocol}//${where}`;
  } catch {
    // leave as unparseable
  }

  record("gateway via settings", "ok", `${where}, from "${envSource.source}" tier`);
  record("provider token", "ok", mask(token));
  return true;
}

// ---------------------------------------------------------------------------
// Stage 3 — live query
// ---------------------------------------------------------------------------

async function stageQuery(
  binary: string | undefined,
  cwd: string,
): Promise<string | undefined> {
  const { query } = await import("@anthropic-ai/claude-agent-sdk");

  const controller = new AbortController();
  let sessionId: string | undefined;
  const toolNames: string[] = [];

  // §12.3: partial deltas and complete messages describe the SAME text. Accumulate
  // from exactly one of them. We take deltas for live streaming and treat the
  // assistant message as the authoritative final value — never append it.
  let streamed = "";
  let finalized = "";

  const started = performance.now();
  const stream = query({
    prompt: "Reply with exactly the word: ok",
    options: {
      cwd,
      settingSources: ["user", "project", "local"],
      systemPrompt: { type: "preset", preset: "claude_code" },
      includePartialMessages: true,
      permissionMode: "default",
      abortController: controller,
      ...(binary ? { pathToClaudeCodeExecutable: binary } : {}),
    },
  });

  try {
    for await (const message of stream) {
      if (message.type === "system" && "session_id" in message) {
        sessionId ??= String(message.session_id);
      }
      if (message.type === "stream_event") {
        const event = message.event as { type?: string; delta?: { text?: string } };
        if (event.type === "content_block_delta" && event.delta?.text) {
          streamed += event.delta.text;
        }
      }
      if (message.type === "assistant") {
        for (const block of message.message.content) {
          if (block.type === "text") finalized += block.text;
          if (block.type === "tool_use") toolNames.push(block.name);
        }
      }
    }
  } catch (error) {
    record("live query", "fail", (error as Error).message.slice(0, 300));
    return undefined;
  }

  const elapsed = Math.round(performance.now() - started);
  record("live query", "ok", `${elapsed} ms`);
  record("session id captured", sessionId ? "ok" : "fail", sessionId ?? "not reported");

  // The duplication check: deltas and final text must agree, not sum.
  const streamedTrimmed = streamed.trim();
  const finalTrimmed = finalized.trim();
  const duplicated = streamedTrimmed.length > 0 && finalTrimmed.length > streamedTrimmed.length;

  record(
    "streaming",
    streamedTrimmed.length > 0 ? "ok" : "fail",
    `${streamedTrimmed.length} delta chars`,
  );
  record(
    "no text duplication",
    duplicated ? "fail" : "ok",
    duplicated
      ? `delta="${streamedTrimmed}" final="${finalTrimmed}" — appended twice`
      : `delta="${streamedTrimmed}" final="${finalTrimmed}" agree`,
  );

  if (toolNames.length > 0) {
    record("tool calls", "ok", toolNames.join(", "));
  }

  return sessionId;
}

async function stageResume(
  binary: string | undefined,
  cwd: string,
  sessionId: string,
): Promise<void> {
  const { query } = await import("@anthropic-ai/claude-agent-sdk");

  // §10.4: resume by explicit ID. Never `continue: true`, which would pick the
  // most recent conversation and silently attach to the wrong session.
  let text = "";
  try {
    for await (const message of query({
      prompt: "What word did you just reply with? Answer with only that word.",
      options: {
        cwd,
        settingSources: ["user", "project", "local"],
        systemPrompt: { type: "preset", preset: "claude_code" },
        permissionMode: "default",
        resume: sessionId,
        ...(binary ? { pathToClaudeCodeExecutable: binary } : {}),
      },
    })) {
      if (message.type === "assistant") {
        for (const block of message.message.content) {
          if (block.type === "text") text += block.text;
        }
      }
    }
  } catch (error) {
    record("resume by session id", "fail", (error as Error).message.slice(0, 300));
    return;
  }

  // Proves the transcript was actually loaded, not a fresh conversation.
  const recalled = /\bok\b/i.test(text);
  record(
    "resume by session id",
    recalled ? "ok" : "fail",
    recalled ? `recalled context: "${text.trim().slice(0, 40)}"` : `no recall: "${text.trim().slice(0, 80)}"`,
  );
}
// ---------------------------------------------------------------------------
// Stage 4 — cancellation
// ---------------------------------------------------------------------------

async function stageCancel(binary: string | undefined, cwd: string): Promise<void> {
  const { query } = await import("@anthropic-ai/claude-agent-sdk");

  const controller = new AbortController();
  let sawEvent = false;
  let abortedAt: number | undefined;

  const started = performance.now();
  const stream = query({
    // Long enough that we can interrupt mid-stream.
    prompt: "Count slowly from 1 to 40, one number per line, with a short sentence about each.",
    options: {
      cwd,
      settingSources: ["user", "project", "local"],
      systemPrompt: { type: "preset", preset: "claude_code" },
      includePartialMessages: true,
      permissionMode: "default",
      abortController: controller,
      ...(binary ? { pathToClaudeCodeExecutable: binary } : {}),
    },
  });

  try {
    for await (const message of stream) {
      if (message.type === "stream_event") {
        if (!sawEvent) {
          sawEvent = true;
          // Abort only once real streaming has begun, so we interrupt a live
          // process rather than racing the spawn.
          abortedAt = performance.now() - started;
          controller.abort();
        }
      }
    }
  } catch (error) {
    // An abort surfaces as a throw in most SDK versions. That is the expected path.
    const name = (error as Error).name;
    const isAbort = name === "AbortError" || /abort/i.test((error as Error).message);
    record(
      "cancel",
      isAbort ? "ok" : "fail",
      isAbort
        ? `aborted after ${Math.round(abortedAt ?? 0)} ms (${name})`
        : `unexpected error: ${(error as Error).message.slice(0, 200)}`,
    );
    return;
  }

  // Reaching here means the stream ended cleanly despite the abort. Acceptable
  // only if it ended promptly — a slow tail would mean cancel did not take effect.
  const elapsed = Math.round(performance.now() - started);
  record(
    "cancel",
    sawEvent && elapsed < 30_000 ? "ok" : "fail",
    sawEvent ? `stream ended after abort (${elapsed} ms)` : "no stream events observed",
  );
}

// ---------------------------------------------------------------------------
// Stage 5 — error classification (ADR-0003)
// ---------------------------------------------------------------------------

async function stageErrorClassification(): Promise<void> {
  const { query } = await import("@anthropic-ai/claude-agent-sdk");

  // A port that is certainly closed. This must read as "gateway unreachable",
  // not as an auth failure — otherwise the operator debugs the wrong thing.
  const deadUrl = "http://127.0.0.1:1";

  const saved = {
    base: process.env["ANTHROPIC_BASE_URL"],
    token: process.env["ANTHROPIC_AUTH_TOKEN"],
  };
  process.env["ANTHROPIC_BASE_URL"] = deadUrl;
  process.env["ANTHROPIC_AUTH_TOKEN"] = "invalid-probe-token";

  const cwd = await mkdtemp(join(tmpdir(), "cc-web-phase0-err-"));
  let message = "";
  try {
    for await (const _ of query({
      prompt: "hi",
      options: {
        cwd,
        settingSources: [], // isolate from inherited config for this probe
        systemPrompt: { type: "preset", preset: "claude_code" },
        permissionMode: "default",
      },
    })) {
      // drain
    }
  } catch (error) {
    message = (error as Error).message;
  } finally {
    await rm(cwd, { recursive: true, force: true });
    if (saved.base === undefined) delete process.env["ANTHROPIC_BASE_URL"];
    else process.env["ANTHROPIC_BASE_URL"] = saved.base;
    if (saved.token === undefined) delete process.env["ANTHROPIC_AUTH_TOKEN"];
    else process.env["ANTHROPIC_AUTH_TOKEN"] = saved.token;
  }

  if (!message) {
    record("error classification", "fail", "dead endpoint did not produce an error");
    return;
  }

  const reachability = /ECONNREFUSED|ENOTFOUND|EHOSTUNREACH|fetch failed|Connection error|socket hang up/i;
  const auth = /\b401\b|\b403\b|invalid.*(api.?key|token)|authentication/i;

  if (reachability.test(message)) {
    record("error classification", "ok", "connection failure distinguished from auth");
  } else if (auth.test(message)) {
    // Wrong: a closed port must not look like bad credentials.
    record("error classification", "fail", `closed port reported as auth: ${message.slice(0, 160)}`);
  } else {
    record("error classification", "fail", `unclassified: ${message.slice(0, 160)}`);
  }
}

// ---------------------------------------------------------------------------

const workdir = await mkdtemp(join(tmpdir(), "cc-web-phase0-"));
try {
  await writeFile(join(workdir, "README.md"), "# phase0 scratch\n", "utf8");

  const binary = await stageBinary();
  const settingsOk = await stageSettings(workdir);

  if (!runModel) {
    record("live query", "skip", "pass --model to spend tokens");
  } else if (!settingsOk) {
    record("live query", "skip", "settings cascade incomplete");
  } else {
    const sessionId = await stageQuery(binary, workdir);
    if (sessionId) await stageResume(binary, workdir, sessionId);
    await stageCancel(binary, workdir);
  }
  await stageErrorClassification();
} finally {
  await rm(workdir, { recursive: true, force: true });
}

const failed = stages.filter((s) => s.status === "fail").length;
console.log(`\n${failed === 0 ? "PASS" : "FAIL"} — ${stages.length} checks, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
