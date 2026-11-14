import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  extractAgentIdFromResultText,
  extractWorkflowLaunchMap,
  extractWorkflowRunIdFromResultText,
  readWorkflowLaunchMapFromTranscript,
} from "./subagent-launch.ts";

/**
 * The transcripts pin a shape this repo got wrong once: the Workflow tool's
 * result is launch text naming the run, not JSON with a `workflowProgress`
 * array (the SDK never emits that field). Reading it as JSON meant no Workflow
 * was ever recognised, so every child agent folded into the run's own task row
 * and the popup showed one "0 events" subagent where five ran.
 *
 * These tests use the launch text verbatim from a real transcript.
 */
const REAL_LAUNCH_TEXT = [
  "Workflow launched in background. Task ID: wwgczx5jh",
  "Summary: Verify quickjs-ng assets/digests, yt-dlp runtime discovery, and the code wiring points for bundling a JS runtime",
  "Transcript dir: /home/u/.claude/projects/-mnt-Data-Ponta-pdm/1591ce94-7136-4c96-8eee-a326b5b28661/subagents/workflows/wf_af8103d7-91f",
  "Script file: /home/u/.claude/projects/-mnt-Data-Ponta-pdm/1591ce94/workflows/scripts/ytdlp-js-runtime-scout-wf_af8103d7-91f.js",
  '(Edit this file with Write/Edit and re-invoke Workflow with {scriptPath: "…"} to iterate without resending the script.)',
  "Run ID: wf_af8103d7-91f",
  'To resume after editing the script: Workflow({scriptPath: "…", resumeFromRunId: "wf_af8103d7-91f"}) — completed agents return cached results (cached results may themselves be empty — inspect journal.jsonl before assuming there is something to recover).',
  "",
  "You will be notified when it completes. Use /workflows to watch live progress.",
].join("\n");

describe("extractWorkflowRunIdFromResultText", () => {
  test("reads the Run ID out of a real Workflow launch", () => {
    expect(extractWorkflowRunIdFromResultText(REAL_LAUNCH_TEXT)).toBe("wf_af8103d7-91f");
  });

  test("a mention of a run id mid-sentence is not the launch line", () => {
    // The text quotes the id again in its resume instructions; only the
    // line-anchored `Run ID:` is the declaration.
    expect(
      extractWorkflowRunIdFromResultText('Use resumeFromRunId: "wf_deadbeef-1" to iterate.'),
    ).toBeUndefined();
  });

  test("text with no run id yields nothing", () => {
    expect(
      extractWorkflowRunIdFromResultText("Async agent launched.\nagentId: a1"),
    ).toBeUndefined();
  });

  test("an agent result is not a workflow launch", () => {
    expect(
      extractWorkflowRunIdFromResultText("Async agent launched successfully.\nagentId: abc"),
    ).toBeUndefined();
  });
});

describe("extractAgentIdFromResultText", () => {
  test("reads the agentId from a real Agent result", () => {
    const text =
      "Async agent launched successfully. (This tool result is internal metadata…)\nagentId: a004bc3d38e1acc56 (internal ID - do not mention to user.)";
    expect(extractAgentIdFromResultText(text)).toBe("a004bc3d38e1acc56");
  });

  test("text with no agent id yields nothing", () => {
    expect(extractAgentIdFromResultText("Workflow launched in background.")).toBeUndefined();
  });
});

describe("extractWorkflowLaunchMap", () => {
  const workflowCall = {
    type: "assistant",
    message: {
      content: [
        { type: "tool_use", id: "call_00_zlmqteg6c7sxiru8lyea2eej", name: "Workflow", input: {} },
      ],
    },
  };
  const workflowResult = {
    type: "user",
    message: {
      content: [
        {
          type: "tool_result",
          tool_use_id: "call_00_zlmqteg6c7sxiru8lyea2eej",
          content: [{ type: "text", text: REAL_LAUNCH_TEXT }],
        },
      ],
    },
  };

  test("pairs a Workflow call with the run id its result names", () => {
    const map = extractWorkflowLaunchMap([workflowCall, workflowResult]);

    expect(map.get("wf_af8103d7-91f")).toBe("call_00_zlmqteg6c7sxiru8lyea2eej");
  });

  test("ignores a result whose run id is absent", () => {
    const map = extractWorkflowLaunchMap([
      workflowCall,
      {
        type: "user",
        message: {
          content: [
            { type: "tool_result", tool_use_id: "call_00_zlmqteg6c7sxiru8lyea2eej", content: "ok" },
          ],
        },
      },
    ]);

    expect(map.size).toBe(0);
  });

  test("only Workflow calls are collected", () => {
    // An Explore agent's result has an agentId, not a run id — it must not be
    // mistaken for a workflow launch.
    const map = extractWorkflowLaunchMap([
      {
        type: "assistant",
        message: {
          content: [{ type: "tool_use", id: "call_agent", name: "Agent", input: {} }],
        },
      },
      {
        type: "user",
        message: {
          content: [{ type: "tool_result", tool_use_id: "call_agent", content: REAL_LAUNCH_TEXT }],
        },
      },
    ]);

    expect(map.size).toBe(0);
  });

  test("a transcript with no Workflow call costs nothing", () => {
    expect(extractWorkflowLaunchMap([{ type: "assistant", message: { content: [] } }]).size).toBe(
      0,
    );
  });
});

describe("readWorkflowLaunchMapFromTranscript", () => {
  const roots: string[] = [];

  async function writeTranscript(lines: unknown[]): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), "cc-web-transcript-"));
    roots.push(root);
    const file = join(root, "session.jsonl");
    // Trailing newline, like the real files: a transcript is line-delimited and
    // the append path below relies on the last line already being closed.
    await writeFile(file, lines.map((line) => `${JSON.stringify(line)}\n`).join(""));
    return file;
  }

  afterAll(async () => {
    await Promise.all(roots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  test("finds a launch the caller's message page never reached", () => {
    // The reason this reader exists: the SDK's read is windowed, and a long
    // session's Workflow call sits at the top of the file while the page the
    // browser asked for is its tail. Without the file the pairing is missing
    // exactly when a run is old enough to be worth inspecting.
    return writeTranscript([
      {
        type: "assistant",
        message: {
          content: [
            {
              type: "tool_use",
              id: "call_00_zlmqteg6c7sxiru8lyea2eej",
              name: "Workflow",
              input: {},
            },
          ],
        },
      },
      {
        type: "user",
        message: {
          content: [
            {
              type: "tool_result",
              tool_use_id: "call_00_zlmqteg6c7sxiru8lyea2eej",
              content: [{ type: "text", text: REAL_LAUNCH_TEXT }],
            },
          ],
        },
      },
      { type: "assistant", message: { content: [{ type: "text", text: "later, unrelated" }] } },
    ]).then((file) => {
      const map = readWorkflowLaunchMapFromTranscript(file);
      expect(map.get("wf_af8103d7-91f")).toBe("call_00_zlmqteg6c7sxiru8lyea2eej");
    });
  });

  test("skips a malformed line instead of losing the whole map", () => {
    return writeTranscript([])
      .then(() =>
        writeTranscript([
          { type: "assistant", message: { content: [] } },
          {
            type: "assistant",
            message: {
              content: [{ type: "tool_use", id: "call_wf", name: "Workflow", input: {} }],
            },
          },
          {
            type: "user",
            message: {
              content: [
                {
                  type: "tool_result",
                  tool_use_id: "call_wf",
                  content: [{ type: "text", text: REAL_LAUNCH_TEXT }],
                },
              ],
            },
          },
        ]),
      )
      .then(async (file) => {
        // A half-written last line is what a live session's file looks like.
        await writeFile(file, '{"type":"assistant","message":{"content":', { flag: "a" });
        expect(readWorkflowLaunchMapFromTranscript(file).size).toBe(1);
      });
  });

  test("a missing file answers with an empty map", () => {
    expect(readWorkflowLaunchMapFromTranscript("/nonexistent/cc-web/session.jsonl").size).toBe(0);
  });
});
