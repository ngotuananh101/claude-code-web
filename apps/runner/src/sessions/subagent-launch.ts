/**
 * Recognising the two shapes a spawning tool call returns (§12 session inspection).
 *
 * An `Agent`/`Task` result names its child outright: `agentId: <id>`. A
 * `Workflow` result does not — it is plain launch text naming the run:
 *
 *   Workflow launched in background. Task ID: wwgczx5jh
 *   Summary: Verify quickjs-ng assets/digests, …
 *   Transcript dir: …/subagents/workflows/wf_af8103d7-91f
 *   Script file: …/workflows/scripts/….js
 *   Run ID: wf_af8103d7-91f
 *
 * Neither result says which agents a run contains; that lives in each child's
 * `agent-<id>.meta.json` (see `subagent-meta.ts`). What the launch text does
 * give is the run's `Run ID`, which is the key that ties a directory of
 * workflow children back to the `Workflow` call that started it — and that
 * call's tool_use id is the parent every one of those children reports.
 */

import { readFileSync } from "node:fs";

/** `agentId: a51c84ff15e3201f4` — the Agent/Task result's own pointer. */
export function extractAgentIdFromResultText(text: string): string | undefined {
  const match = /\bagentId:\s*([A-Za-z0-9_-]+)/.exec(text);
  return match?.[1];
}

/**
 * `Run ID: wf_af8103d7-91f` — a Workflow launch's run id.
 *
 * Anchored to a line start with the exact label so an arbitrary mention of a
 * run id inside prose cannot masquerade as the launch. The transcript
 * directory carries the same id as its last segment, which is why a match here
 * is enough to identify the run without parsing the path.
 */
export function extractWorkflowRunIdFromResultText(text: string): string | undefined {
  const match = /^Run ID:\s*(wf_[A-Za-z0-9-]+)\s*$/m.exec(text);
  return match?.[1];
}

/** A `Workflow` tool call and the run it launched, once its result arrives. */
export type WorkflowLaunch = { toolUseId: string; runId: string };

type ContentBlock = Record<string, unknown>;

function contentBlocks(message: unknown): ContentBlock[] {
  if (typeof message !== "object" || message === null) return [];
  const content = (message as Record<string, unknown>)["content"];
  if (!Array.isArray(content)) return [];
  return content.filter(
    (block): block is ContentBlock => typeof block === "object" && block !== null,
  );
}

/** The plain text of a tool_result's content, whichever shape it arrived in. */
function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const item of content) {
    if (typeof item === "object" && item !== null) {
      const rec = item as Record<string, unknown>;
      if (rec["type"] === "text" && typeof rec["text"] === "string") parts.push(rec["text"]);
    }
  }
  return parts.join("\n");
}

/**
 * Pair every `Workflow` tool call in the main transcript with the run id in its
 * result.
 *
 * Returned as `runId → toolUseId`, which is the direction the workflow
 * children need: a child's meta names its run, and the browser groups children
 * under the spawning call.
 */
export function extractWorkflowLaunchMap(
  mainMessages: ReadonlyArray<{ type: string; message: unknown }>,
): Map<string, string> {
  const pendingToolUseIds = new Set<string>();
  for (const msg of mainMessages) {
    if (msg.type !== "assistant") continue;
    for (const block of contentBlocks(msg.message)) {
      if (block["type"] !== "tool_use" || block["name"] !== "Workflow") continue;
      const id = block["id"];
      if (typeof id === "string" && id !== "") pendingToolUseIds.add(id);
    }
  }

  const byRunId = new Map<string, string>();
  if (pendingToolUseIds.size === 0) return byRunId;

  for (const msg of mainMessages) {
    if (msg.type !== "user") continue;
    for (const block of contentBlocks(msg.message)) {
      if (block["type"] !== "tool_result") continue;
      const toolUseId = block["tool_use_id"];
      if (typeof toolUseId !== "string" || !pendingToolUseIds.has(toolUseId)) continue;
      const runId = extractWorkflowRunIdFromResultText(resultText(block["content"]));
      if (runId !== undefined) byRunId.set(runId, toolUseId);
    }
  }
  return byRunId;
}

/** A transcript line is worth parsing only if it could hold a launch. */
function mayCarryWorkflowLaunch(line: string): boolean {
  return line.includes('"name":"Workflow"') || line.includes("Run ID: wf_");
}

/**
 * The Workflow launch map read from a session's whole transcript file.
 *
 * `extractWorkflowLaunchMap` can only see the page the caller already holds,
 * and a `Workflow` call sits at the top of a long session while the browser's
 * page is its tail — so the pairing would be missing exactly when a run is old
 * enough to be worth inspecting. The file is the only complete copy, and only
 * the handful of lines naming a launch are parsed: a 16 MB transcript costs
 * tens of milliseconds, and the rest of it is never deserialized.
 *
 * Unreadable or malformed lines are skipped, not fatal: a missing parent id
 * degrades one link, and `sessions.messages` must still answer.
 */
export function readWorkflowLaunchMapFromTranscript(file: string): Map<string, string> {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return new Map();
  }

  const toolUseIds = new Set<string>();
  const resultLines: Record<string, unknown>[] = [];
  for (const line of text.split("\n")) {
    if (line === "" || !mayCarryWorkflowLaunch(line)) continue;
    let record: unknown;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof record !== "object" || record === null) continue;
    const msg = record as Record<string, unknown>;
    if (msg["isSidechain"] === true) continue;
    for (const block of contentBlocks(msg["message"])) {
      if (block["type"] === "tool_use" && block["name"] === "Workflow") {
        const id = block["id"];
        if (typeof id === "string" && id !== "") toolUseIds.add(id);
      } else if (block["type"] === "tool_result") {
        resultLines.push(block);
      }
    }
  }

  const byRunId = new Map<string, string>();
  if (toolUseIds.size === 0) return byRunId;
  for (const block of resultLines) {
    const toolUseId = block["tool_use_id"];
    if (typeof toolUseId !== "string" || !toolUseIds.has(toolUseId)) continue;
    const runId = extractWorkflowRunIdFromResultText(resultText(block["content"]));
    if (runId !== undefined) byRunId.set(runId, toolUseId);
  }
  return byRunId;
}
