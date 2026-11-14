/**
 * The on-disk metadata of a session's subagents (§12 session inspection).
 *
 * A subagent's transcript carries no label: the JSONL holds only messages, and
 * nothing in it says what the agent was asked to do or which Workflow it
 * belonged to. Claude Code keeps that beside the transcript as
 * `agent-<agentId>.meta.json`:
 *
 *   ~/.claude/projects/<project>/<sessionId>/subagents/agent-<agentId>.meta.json
 *   ~/.claude/projects/<project>/<sessionId>/subagents/workflows/<runId>/agent-<agentId>.meta.json
 *
 * The first shape carries the spawning tool call's `toolUseId`, which is the
 * link back to the `Agent`/`Task` block in the main transcript. A Workflow
 * child has no `toolUseId` — the whole run shares one — so its parent is
 * recovered from the run id in its directory name.
 *
 * Reading this is best effort on purpose: a missing or unreadable meta file
 * leaves the agent unlabelled, and the browser falls back to the agent id. The
 * transcript is the thing worth showing; the label is decoration.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type SubagentMeta = {
  /** The agent's human label — what the spawner called the task. */
  description?: string;
  agentType?: string;
  /** The workflow phase the agent ran in; only workflow children have one. */
  workflowPhase?: string;
  /** The spawning tool call. Absent for a Workflow child. */
  toolUseId?: string;
  /** The Workflow run this agent belongs to; only workflow children have one. */
  workflowRunId?: string;
};

/**
 * Where Claude Code keeps its project transcripts.
 *
 * `CLAUDE_CONFIG_DIR` relocates the whole config tree (the SDK honours it, and
 * the runner passes the environment through), so the projects directory moves
 * with it rather than always living under `$HOME`.
 */
export function claudeProjectsDir(env: NodeJS.ProcessEnv = process.env): string {
  const configDir = env["CLAUDE_CONFIG_DIR"]?.trim();
  if (configDir !== undefined && configDir !== "") return join(configDir, "projects");
  const home = env["HOME"]?.trim();
  return join(home !== undefined && home !== "" ? home : homedir(), ".claude", "projects");
}

/** Every subagent's metadata for one session, keyed by agent id. */
export type SubagentMetaIndex = ReadonlyMap<string, SubagentMeta>;

const EMPTY_INDEX: SubagentMetaIndex = new Map();

/**
 * The session's own transcript file, `<projects>/<project>/<sessionId>.jsonl`.
 *
 * Needed because the SDK's read is windowed: a `Workflow` call made early in a
 * long session falls outside the page the browser asked for, and the launch
 * text that ties a run to its call is only in that file. Scanned rather than
 * derived from the workspace path for the same reason the meta scan is — the
 * project-directory encoding is lossy.
 */
export function sessionTranscriptPath(
  projectsDir: string,
  sessionId: string,
  projectEntry?: string,
): string | undefined {
  if (sessionId === "") return undefined;
  const entries = tryReaddir(projectsDir);
  const ordered =
    projectEntry !== undefined && entries.includes(projectEntry)
      ? [projectEntry, ...entries.filter((e) => e !== projectEntry)]
      : entries;
  for (const project of ordered) {
    const file = join(projectsDir, project, `${sessionId}.jsonl`);
    if (isFile(file)) return file;
  }
  return undefined;
}

/**
 * Read every `agent-*.meta.json` this session has, both direct children and
 * Workflow children.
 *
 * The session's project directory is not derived from the workspace path: the
 * encoding Claude Code applies (`/` → `-`, leading `-`) is lossy — a folder
 * name containing a dash is indistinguishable from a nested path — so the scan
 * looks for the session id one level down instead of guessing the folder name.
 * `projectEntry` is the encoded name to try first when the caller knows it; the
 * scan still falls through to the rest, because that guess can be wrong.
 */
export function readSubagentMetaIndex(
  projectsDir: string,
  sessionId: string,
  projectEntry?: string,
): SubagentMetaIndex {
  if (sessionId === "") return EMPTY_INDEX;
  const index = new Map<string, SubagentMeta>();

  const entries = tryReaddir(projectsDir);
  const ordered =
    projectEntry !== undefined && entries.includes(projectEntry)
      ? [projectEntry, ...entries.filter((e) => e !== projectEntry)]
      : entries;

  for (const project of ordered) {
    const subagentsDir = join(projectsDir, project, sessionId, "subagents");
    if (!isDir(subagentsDir)) continue;

    for (const name of tryReaddir(subagentsDir)) {
      const agentId = agentIdFromMetaFile(name);
      if (agentId !== undefined) {
        const meta = readMeta(join(subagentsDir, name));
        if (meta !== undefined) index.set(agentId, meta);
      }
    }

    const workflowsDir = join(subagentsDir, "workflows");
    for (const runId of tryReaddir(workflowsDir)) {
      const runDir = join(workflowsDir, runId);
      if (!isDir(runDir)) continue;
      for (const name of tryReaddir(runDir)) {
        const agentId = agentIdFromMetaFile(name);
        if (agentId === undefined) continue;
        const meta = readMeta(join(runDir, name));
        if (meta !== undefined) index.set(agentId, { ...meta, workflowRunId: runId });
      }
    }
  }

  return index;
}

/** `agent-a51c84ff15e3201f4.meta.json` → `a51c84ff15e3201f4`; anything else → undefined. */
function agentIdFromMetaFile(name: string): string | undefined {
  if (!name.startsWith("agent-") || !name.endsWith(".meta.json")) return undefined;
  const id = name.slice("agent-".length, name.length - ".meta.json".length);
  return id === "" ? undefined : id;
}

function readMeta(file: string): SubagentMeta | undefined {
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const record = parsed as Record<string, unknown>;

  const meta: SubagentMeta = {};
  const description = asNonEmpty(record["description"]);
  if (description !== undefined) meta.description = description;
  const agentType = asNonEmpty(record["agentType"]);
  if (agentType !== undefined) meta.agentType = agentType;
  const workflowPhase = asNonEmpty(record["workflowPhase"]);
  if (workflowPhase !== undefined) meta.workflowPhase = workflowPhase;
  const toolUseId = asNonEmpty(record["toolUseId"]);
  if (toolUseId !== undefined) meta.toolUseId = toolUseId;
  return meta;
}

function asNonEmpty(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function tryReaddir(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}
