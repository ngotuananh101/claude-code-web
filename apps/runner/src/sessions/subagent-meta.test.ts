import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeProjectsDir, readSubagentMetaIndex } from "./subagent-meta.ts";

/**
 * A subagent's label lives beside its transcript, not inside it: Claude Code
 * writes `agent-<id>.meta.json` next to `agent-<id>.jsonl`, and for a Workflow
 * child it nests both under `subagents/workflows/<runId>/`.
 *
 * This module is what lets the runner tell the browser "this agent was called
 * plan-critique in the Scout phase" instead of leaving it with an opaque id,
 * and it recovers the toolUseId that links an Agent child back to the block
 * that spawned it (a Workflow child has none — the run is its parent).
 */

const roots: string[] = [];

async function makeRoot(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "cc-web-meta-"));
  roots.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function writeMeta(dir: string, agentId: string, body: unknown): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `agent-${agentId}.meta.json`), JSON.stringify(body));
}

describe("readSubagentMetaIndex", () => {
  test("reads an Agent child's label, type and spawning toolUseId", async () => {
    const root = await makeRoot();
    const dir = join(root, "-mnt-Data-proj", "sess-1", "subagents");
    await writeMeta(dir, "a004bc3d38e1acc56", {
      agentType: "Explore",
      description: "Explore app architecture and features",
      toolUseId: "call_00_Y8ig307NrOx00BiFLb846928",
      spawnDepth: 1,
    });

    const index = readSubagentMetaIndex(root, "sess-1");

    expect(index.get("a004bc3d38e1acc56")).toEqual({
      agentType: "Explore",
      description: "Explore app architecture and features",
      toolUseId: "call_00_Y8ig307NrOx00BiFLb846928",
    });
  });

  test("reads a Workflow child's label and phase from its run directory", async () => {
    const root = await makeRoot();
    const dir = join(root, "-mnt-Data-proj", "sess-1", "subagents", "workflows", "wf_af8103d7-91f");
    await writeMeta(dir, "a51c84ff15e3201f4", {
      agentType: "workflow-subagent",
      description: "plan-critique",
      workflowPhase: "Scout",
      spawnDepth: 1,
    });

    const index = readSubagentMetaIndex(root, "sess-1");

    // No `toolUseId`: every agent in a run shares the Workflow's, so the run
    // directory name is the link instead.
    expect(index.get("a51c84ff15e3201f4")).toEqual({
      agentType: "workflow-subagent",
      description: "plan-critique",
      workflowPhase: "Scout",
      workflowRunId: "wf_af8103d7-91f",
    });
  });

  test("indexes direct children and workflow children of the same session together", async () => {
    const root = await makeRoot();
    const subagents = join(root, "-mnt-Data-proj", "sess-1", "subagents");
    await writeMeta(subagents, "adirect", { agentType: "Explore", description: "Direct" });
    await writeMeta(join(subagents, "workflows", "wf_1"), "aworkflow", {
      agentType: "workflow-subagent",
      description: "Nested",
      workflowPhase: "Scout",
    });

    const index = readSubagentMetaIndex(root, "sess-1");

    expect([...index.keys()].sort()).toEqual(["adirect", "aworkflow"]);
  });

  test("only reads the named session", async () => {
    const root = await makeRoot();
    const project = join(root, "-mnt-Data-proj");
    await writeMeta(join(project, "sess-1", "subagents"), "amine", { description: "Mine" });
    await writeMeta(join(project, "sess-2", "subagents"), "athem", { description: "Theirs" });

    const index = readSubagentMetaIndex(root, "sess-1");

    expect([...index.keys()]).toEqual(["amine"]);
  });

  test("ignores files that are not agent meta files", async () => {
    const root = await makeRoot();
    const dir = join(root, "-mnt-Data-proj", "sess-1", "subagents");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "agent-a1.jsonl"), "{}");
    await writeFile(join(dir, "journal.jsonl"), "{}");
    await writeMeta(dir, "a1", { description: "Real" });

    const index = readSubagentMetaIndex(root, "sess-1");

    expect([...index.keys()]).toEqual(["a1"]);
  });

  test("skips malformed JSON rather than failing the whole scan", async () => {
    const root = await makeRoot();
    const dir = join(root, "-mnt-Data-proj", "sess-1", "subagents");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "agent-abroken.meta.json"), "{not json");
    await writeMeta(dir, "agood", { description: "Fine" });

    const index = readSubagentMetaIndex(root, "sess-1");

    expect([...index.keys()]).toEqual(["agood"]);
  });

  test("a missing projects directory yields nothing", async () => {
    expect(readSubagentMetaIndex(join(tmpdir(), "cc-web-meta-does-not-exist"), "s").size).toBe(0);
  });

  test("an empty session id reads nothing", async () => {
    const root = await makeRoot();
    expect(readSubagentMetaIndex(root, "").size).toBe(0);
  });

  test("drops empty labels instead of reporting blank strings", async () => {
    const root = await makeRoot();
    const dir = join(root, "-mnt-Data-proj", "sess-1", "subagents");
    await writeMeta(dir, "a1", { description: "   ", agentType: "Explore" });

    const index = readSubagentMetaIndex(root, "sess-1");

    expect(index.get("a1")).toEqual({ agentType: "Explore" });
  });
});

describe("claudeProjectsDir", () => {
  test("follows CLAUDE_CONFIG_DIR when the environment sets one", () => {
    expect(claudeProjectsDir({ CLAUDE_CONFIG_DIR: "/srv/claude-config" })).toBe(
      "/srv/claude-config/projects",
    );
  });

  test("falls back to the home directory's .claude", () => {
    // The runner passes the agent environment through, and a relocated config
    // directory moves the transcripts with it.
    expect(claudeProjectsDir({ HOME: "/home/op" })).toBe("/home/op/.claude/projects");
  });

  test("an empty CLAUDE_CONFIG_DIR is not a path", () => {
    expect(claudeProjectsDir({ CLAUDE_CONFIG_DIR: "  ", HOME: "/home/op" })).toBe(
      "/home/op/.claude/projects",
    );
  });
});
