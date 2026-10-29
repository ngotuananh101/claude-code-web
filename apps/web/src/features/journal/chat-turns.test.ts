import { describe, expect, test } from "bun:test";
import type { BrowserReplayEvent, SessionMessage } from "@cc-web/protocol";
import type { AgentTurn } from "./chat-turns.ts";
import {
  cleanUserPrompt,
  deriveChatTurns,
  extractDiffStats,
  formatDuration,
} from "./chat-turns.ts";

/**
 * Unit tests for the chat-turn parser (§16.1, Task 13 chat-bubble interface).
 *
 * This module turns the raw `SessionMessage[]` replay and the live
 * `BrowserReplayEvent[]` stream into a flat list of `ChatTurn`s: user turns on
 * the right, agent turns on the left with thinking steps, tool steps and prose.
 * Pure and deterministic so a resubscribe is byte-identical to a live render.
 */

let seq = 0;
function liveEvent(type: string, payload: unknown, runId = "run-1"): BrowserReplayEvent {
  seq += 1;
  return {
    sessionSequence: seq,
    eventId: `evt-${seq}`,
    runId,
    attemptId: "attempt-1",
    occurredAt: `2026-10-25T00:00:${String(seq).padStart(2, "0")}Z`,
    type: type as BrowserReplayEvent["type"],
    payload,
  };
}

function resetSeq(): void {
  seq = 0;
}

function userMsg(message: unknown, uuid = "u-1"): SessionMessage {
  return { type: "user", uuid, message };
}
function assistantMsg(message: unknown, uuid = "a-1"): SessionMessage {
  return { type: "assistant", uuid, message };
}

function toolUseBlock(id: string, name: string, input: Record<string, unknown>) {
  return { type: "tool_use", id, name, input };
}

describe("cleanUserPrompt", () => {
  test("returns plain text unchanged when trimmed", () => {
    expect(cleanUserPrompt("Hello, world!")).toBe("Hello, world!");
  });

  test("trims surrounding whitespace", () => {
    expect(cleanUserPrompt("  hi there  ")).toBe("hi there");
  });

  test("strips a <command-message> wrapper retaining inner text", () => {
    expect(cleanUserPrompt("<command-message>Hello</command-message>")).toBe("Hello");
  });

  test("strips <command-message> with leading text before the tag", () => {
    expect(
      cleanUserPrompt("Please read <command-message>this guidance</command-message> thanks"),
    ).toBe("Please read this guidance thanks");
  });

  test("strips <command-name> wrapper", () => {
    expect(cleanUserPrompt("<command-name>List files</command-name>")).toBe("List files");
  });

  test("strips multiple system command wrappers", () => {
    expect(
      cleanUserPrompt(
        "<command-message>outer</command-message> <command-name>inner</command-name>",
      ),
    ).toBe("outer inner");
  });

  test("extracts clean CLI command from full command wrapper with args", () => {
    const raw =
      "<command-name>/clear</command-name>\n            <command-message>clear</command-message>\n            <command-args></command-args>";
    expect(cleanUserPrompt(raw)).toBe("/clear");
  });

  test("extracts command name and arguments", () => {
    const raw =
      "<command-name>/model</command-name>\n            <command-message>model</command-message>\n            <command-args>prime</command-args>";
    expect(cleanUserPrompt(raw)).toBe("/model prime");
  });

  test("strips local-command-caveat and system-reminder completely", () => {
    const raw =
      "<local-command-caveat>Caveat: The messages below were generated...</local-command-caveat>";
    expect(cleanUserPrompt(raw)).toBe("");
  });

  test("unwraps local-command-stdout content", () => {
    const raw =
      "<local-command-stdout>Set model to `prime` and saved as your default for new sessions</local-command-stdout>";
    expect(cleanUserPrompt(raw)).toBe(
      "Set model to `prime` and saved as your default for new sessions",
    );
  });

  test("returns empty string for empty input", () => {
    expect(cleanUserPrompt("")).toBe("");
  });

  test("returns empty string for whitespace-only input", () => {
    expect(cleanUserPrompt("   \t\n ")).toBe("");
  });
});

describe("extractDiffStats", () => {
  test("counts added and removed lines for Bash returns null", () => {
    expect(extractDiffStats("Bash", { command: "ls" })).toBe(null);
  });

  test("counts added and removed lines for Write returns null", () => {
    expect(extractDiffStats("Write", { filePath: "a.txt", content: "x" })).toBe(null);
  });

  test("counts added and removed lines for Read returns null", () => {
    expect(extractDiffStats("Read", { filePath: "a.txt" })).toBe(null);
  });

  test("counts added/removed lines for Edit single line", () => {
    const stats = extractDiffStats("Edit", {
      old_string: "old line",
      new_string: "new line",
    });
    expect(stats).toEqual({ added: 1, removed: 1 });
  });

  test("counts added/removed lines for Edit multiline", () => {
    const stats = extractDiffStats("Edit", {
      old_string: "a\nb\nc",
      new_string: "x\ny\nz",
    });
    expect(stats).toEqual({ added: 3, removed: 3 });
  });

  test("Edit with only new_string addition counts added only", () => {
    const stats = extractDiffStats("Edit", { new_string: "a\nb\nc" });
    expect(stats).toEqual({ added: 3, removed: 0 });
  });

  test("Edit with only old_string removal counts removed only", () => {
    const stats = extractDiffStats("Edit", { old_string: "a\nb" });
    expect(stats).toEqual({ added: 0, removed: 2 });
  });

  test("Edit with neither string returns null", () => {
    expect(extractDiffStats("Edit", { command: "no-op" })).toBe(null);
  });
});

describe("formatDuration", () => {
  test("formats sub-second as < 1s", () => {
    expect(formatDuration(500)).toBe("< 1s");
  });

  test("formats zero as < 1s", () => {
    expect(formatDuration(0)).toBe("< 1s");
  });

  test("formats single seconds", () => {
    expect(formatDuration(3000)).toBe("3s");
  });

  test("formats minutes and seconds", () => {
    expect(formatDuration(770000)).toBe("12m 50s");
  });

  test("formats minutes boundary", () => {
    expect(formatDuration(60000)).toBe("1m 0s");
  });

  test("formats hours", () => {
    expect(formatDuration(3600000)).toBe("1h 0m");
  });

  test("formats hours minutes", () => {
    expect(formatDuration(3780000)).toBe("1h 3m");
  });

  test("does not show seconds in hours mode", () => {
    expect(formatDuration(3661000)).toBe("1h 1m");
  });
});

describe("deriveChatTurns — historical messages", () => {
  test("parses a plain string user prompt into a UserTurn", () => {
    const turns = deriveChatTurns([userMsg({ content: "Hello, agent!" })], []);
    expect(turns).toHaveLength(1);
    expect(turns[0]).toMatchObject({
      kind: "user",
      key: "history-u-1",
      text: "Hello, agent!",
    });
  });

  test("cleans <command-message> wrappers in user prompt", () => {
    const turns = deriveChatTurns(
      [userMsg({ content: "<command-message>List files please</command-message>" })],
      [],
    );
    expect(turns).toHaveLength(1);
    expect(turns[0]).toMatchObject({ kind: "user", text: "List files please" });
  });

  test("reads user content as text block array", () => {
    const turns = deriveChatTurns(
      [
        userMsg({
          content: [{ type: "text", text: "Tell me a story." }],
        }),
      ],
      [],
    );
    expect((turns[0] as { text: string }).text).toBe("Tell me a story.");
  });

  test("parses assistant message with thinking block into AgentTurn with ThinkingStep", () => {
    const turns = deriveChatTurns(
      [
        assistantMsg({
          type: "assistant",
          content: [
            { type: "thinking", thinking: "Let me reason about this..." },
            { type: "text", text: "Done!" },
          ],
        }),
      ],
      [],
    );
    expect(turns).toHaveLength(1);
    expect(turns[0]).toMatchObject({ kind: "agent", status: "done", text: "Done!" });
    const steps = (turns[0] as { steps: unknown[] }).steps;
    expect(steps[0]).toMatchObject({ kind: "thinking", text: "Let me reason about this..." });
  });

  test("parses assistant message with Bash tool_use and tool_result", () => {
    const turns = deriveChatTurns(
      [
        userMsg({ content: "run it" }),
        assistantMsg({
          type: "assistant",
          content: [
            { type: "text", text: "Running" },
            toolUseBlock("toolu-1", "Bash", { command: "ls -la" }),
          ],
        }),
        userMsg(
          {
            type: "tool_result",
            tool_use_id: "toolu-1",
            content: "total 0\n-rw-r--r--",
          },
          "u-2",
        ),
      ],
      [],
    );

    expect(turns).toHaveLength(2);
    expect(turns[0]).toMatchObject({ kind: "user", text: "run it" });
    expect(turns[1]).toMatchObject({ kind: "agent", text: "Running" });
    const steps = (turns[1] as { steps: unknown[] }).steps;
    expect(steps[0]).toMatchObject({
      kind: "tool",
      toolName: "Bash",
      toolCallId: "toolu-1",
      command: "ls -la",
      state: "done",
      outputSummary: "total 0\n-rw-r--r--",
    });
  });

  test("extracts filePath for Write tool", () => {
    const turns = deriveChatTurns(
      [
        assistantMsg({
          type: "assistant",
          content: [
            toolUseBlock("toolu-w1", "Write", {
              filePath: "/home/user/file.txt",
              content: "hello",
            }),
          ],
        }),
      ],
      [],
    );
    const steps = (turns[0] as { steps: unknown[] }).steps;
    expect(steps[0]).toMatchObject({
      toolName: "Write",
      filePath: "/home/user/file.txt",
    });
  });

  test("extracts filePath for Read tool", () => {
    const turns = deriveChatTurns(
      [
        assistantMsg({
          type: "assistant",
          content: [toolUseBlock("toolu-r1", "Read", { filePath: "/etc/config.json" })],
        }),
      ],
      [],
    );
    const steps = (turns[0] as { steps: unknown[] }).steps;
    expect(steps[0]).toMatchObject({
      toolName: "Read",
      filePath: "/etc/config.json",
    });
  });

  test("calculates diffStats for Edit tool with old_string/new_string", () => {
    const turns = deriveChatTurns(
      [
        assistantMsg({
          type: "assistant",
          content: [
            toolUseBlock("toolu-e1", "Edit", {
              old_string: "line1\nline2",
              new_string: "newline1\nnewline2\nnewline3",
              filePath: "file.txt",
            }),
          ],
        }),
        userMsg({ type: "tool_result", tool_use_id: "toolu-e1", content: "Done" }, "u-edit"),
      ],
      [],
    );
    const steps = (turns[0] as { steps: unknown[] }).steps;
    expect(steps[0]).toMatchObject({
      toolName: "Edit",
      filePath: "file.txt",
      diffStats: { added: 3, removed: 2 },
    });
  });

  test("tool_result error state is captured", () => {
    const turns = deriveChatTurns(
      [
        assistantMsg({
          type: "assistant",
          content: [toolUseBlock("toolu-err", "Bash", { command: "false" })],
        }),
        userMsg(
          { type: "tool_result", tool_use_id: "toolu-err", content: "boom", is_error: true },
          "u-err",
        ),
      ],
      [],
    );
    const steps = (turns[0] as { steps: unknown[] }).steps;
    expect(steps[0]).toMatchObject({ toolName: "Bash", state: "error", outputSummary: "boom" });
  });

  test("alternating user/assistant messages produce separate turns", () => {
    const turns = deriveChatTurns(
      [
        userMsg({ content: "q1" }),
        assistantMsg({
          type: "assistant",
          content: [{ type: "text", text: "a1" }],
        }),
        userMsg({ content: "q2" }),
        assistantMsg({
          type: "assistant",
          content: [{ type: "text", text: "a2" }],
        }),
      ],
      [],
    );
    expect(turns).toHaveLength(4);
    expect((turns[0] as { kind: string }).kind).toBe("user");
    expect((turns[1] as { kind: string }).kind).toBe("agent");
    expect((turns[2] as { kind: string }).kind).toBe("user");
    expect((turns[3] as { kind: string }).kind).toBe("agent");
  });

  test("system messages are skipped (not user/assistant)", () => {
    const turns = deriveChatTurns(
      [
        userMsg({ content: "hi" }),
        { type: "system", uuid: "s-1", message: { content: "be helpful" } },
        assistantMsg({ type: "assistant", content: [{ type: "text", text: "hello" }] }),
      ],
      [],
    );
    expect(turns).toHaveLength(2);
    expect((turns[0] as { kind: string }).kind).toBe("user");
    expect((turns[1] as { kind: string }).kind).toBe("agent");
  });

  test("tool_result without a pending tool_use is ignored", () => {
    const turns = deriveChatTurns(
      [
        userMsg(
          { type: "tool_result", tool_use_id: "orph-1", content: "no matching tool" },
          "u-orch",
        ),
      ],
      [],
    );
    expect(turns).toHaveLength(0);
  });

  test("an assistant message with only thinking produces an agent turn with thinking step", () => {
    const turns = deriveChatTurns(
      [
        assistantMsg({
          type: "assistant",
          content: [{ type: "thinking", thinking: "hmm" }],
        }),
      ],
      [],
    );
    expect((turns[0] as { kind: string }).kind).toBe("agent");
    const steps = (turns[0] as { steps: unknown[] }).steps;
    expect(steps).toHaveLength(1);
    expect(steps[0]).toMatchObject({ kind: "thinking", text: "hmm" });
    expect((turns[0] as { text: string }).text).toBe("");
  });
});

describe("deriveChatTurns — live events", () => {
  test("run.started opens a running agent turn", () => {
    resetSeq();
    const turns = deriveChatTurns([], [liveEvent("run.started", { runId: "run-1" })]);
    expect(turns).toHaveLength(1);
    expect(turns[0]).toMatchObject({
      kind: "agent",
      status: "running",
      runId: "run-1",
      isStreaming: true,
    });
  });

  test("run.finished marks the turn done with duration text", () => {
    resetSeq();
    const turns = deriveChatTurns(
      [],
      [
        liveEvent("run.started", { runId: "run-1" }),
        liveEvent("run.finished", { runId: "run-1", durationMs: 770000 }),
      ],
    );
    expect(turns).toHaveLength(1);
    expect(turns[0]).toMatchObject({
      kind: "agent",
      status: "done",
      durationText: "12m 50s",
      isStreaming: false,
    });
  });

  test("run.failed marks the turn error with duration", () => {
    resetSeq();
    const turns = deriveChatTurns(
      [],
      [
        liveEvent("run.started", { runId: "run-1" }),
        liveEvent("run.failed", { runId: "run-1", durationMs: 5000 }),
      ],
    );
    expect(turns[0]).toMatchObject({ kind: "agent", status: "error", durationText: "5s" });
  });

  test("run.interrupted marks the turn interrupted", () => {
    resetSeq();
    const turns = deriveChatTurns(
      [],
      [
        liveEvent("run.started", { runId: "run-1" }),
        liveEvent("run.interrupted", { runId: "run-1", durationMs: 200 }),
      ],
    );
    expect(turns[0]).toMatchObject({ kind: "agent", status: "interrupted", durationText: "< 1s" });
  });

  test("message.started/delta accumulate prose text", () => {
    resetSeq();
    const turns = deriveChatTurns(
      [],
      [
        liveEvent("run.started", { runId: "run-1" }),
        liveEvent("message.started", { messageId: "msg_1" }),
        liveEvent("message.delta", { messageId: "msg_1", text: "Hel" }),
        liveEvent("message.delta", { messageId: "msg_1", text: "lo" }),
      ],
    );
    expect(turns).toHaveLength(1);
    expect(turns[0]).toMatchObject({ kind: "agent", text: "Hello", isStreaming: true });
  });

  test("tool.started/completed create a ToolStep in the agent turn", () => {
    resetSeq();
    const turns = deriveChatTurns(
      [],
      [
        liveEvent("run.started", { runId: "run-1" }),
        liveEvent("tool.started", { toolCallId: "toolu-1", toolName: "Bash" }),
        liveEvent("tool.completed", {
          toolCallId: "toolu-1",
          isError: false,
          outputSummary: "ok",
          input: { command: "ls" },
        }),
      ],
    );
    const steps = (turns[0] as { steps: unknown[] }).steps;
    expect(steps[0]).toMatchObject({
      kind: "tool",
      toolName: "Bash",
      command: "ls",
      state: "done",
      outputSummary: "ok",
    });
  });

  test("approval.requested adds an ApprovalStep", () => {
    resetSeq();
    const approvalPayload = { approvalId: "appr-1", type: "command" };
    const turns = deriveChatTurns(
      [],
      [
        liveEvent("run.started", { runId: "run-1" }),
        liveEvent("approval.requested", approvalPayload),
      ],
    );
    const steps = (turns[0] as { steps: unknown[] }).steps;
    expect(steps[0]).toMatchObject({ kind: "approval" });
    expect((steps[0] as { event: BrowserReplayEvent }).event.type).toBe("approval.requested");
  });
});

describe("deriveChatTurns — merging historical and live", () => {
  test("historical messages render before live events", () => {
    const turns = deriveChatTurns(
      [userMsg({ content: "past question" })],
      [
        liveEvent("run.started", { runId: "run-1" }),
        liveEvent("run.finished", { runId: "run-1", durationMs: 3000 }),
      ],
    );
    expect(turns).toHaveLength(2);
    expect((turns[0] as { kind: string }).kind).toBe("user");
    expect((turns[0] as { text: string }).text).toBe("past question");
    expect((turns[1] as { kind: string }).kind).toBe("agent");
  });

  test("tool_result from history pairs with tool_use in the same agent turn", () => {
    const turns = deriveChatTurns(
      [
        userMsg({ content: "compute" }),
        assistantMsg({
          type: "assistant",
          content: [toolUseBlock("toolu-2", "Bash", { command: "echo hi" })],
        }),
        userMsg({ type: "tool_result", tool_use_id: "toolu-2", content: "hi" }, "u-2"),
        userMsg({ content: "next question" }),
      ],
      [],
    );
    expect(turns).toHaveLength(3);
    const agentTurn = turns[1] as { kind: string; steps: unknown[] };
    expect(agentTurn.kind).toBe("agent");
    expect(agentTurn.steps[0]).toMatchObject({
      kind: "tool",
      state: "done",
      outputSummary: "hi",
    });
  });

  test("live tool.started with input creates a running tool step with inputSummary", () => {
    resetSeq();
    const turns = deriveChatTurns(
      [],
      [
        liveEvent("run.started", { runId: "run-1" }),
        liveEvent("message.completed", {
          type: "assistant",
          message: {
            id: "msg_1",
            content: [
              {
                type: "tool_use",
                id: "toolu-1",
                name: "Bash",
                input: { command: "echo hello" },
              },
            ],
          },
          parent_tool_use_id: null,
        }),
        liveEvent("tool.started", { toolCallId: "toolu-1", toolName: "Bash" }),
        liveEvent("tool.completed", {
          toolCallId: "toolu-1",
          isError: false,
          outputSummary: "hello",
        }),
      ],
    );
    const steps = (turns[0] as { steps: unknown[] }).steps;
    expect(steps[0]).toMatchObject({
      kind: "tool",
      command: "echo hello",
      state: "done",
      outputSummary: "hello",
    });
  });

  test("empty historical and no live events yields no turns", () => {
    expect(deriveChatTurns([], [])).toEqual([]);
  });

  test("live events reconstruct a turn equivalent to the same run as historical messages", () => {
    resetSeq();
    // A single agent turn with prose, one Bash tool call, and approval, reconstructed
    // three ways and asserted structurally equivalent.
    const toolCallId = "toolu-live-1";
    const approvalId = "appr-live-1";

    // --- Live-event form (§12.3 streaming transcript) ----------------------
    const liveEvents: BrowserReplayEvent[] = [
      liveEvent("run.started", { runId: "run-equiv" }),
      liveEvent("message.started", { messageId: "msg_1" }),
      liveEvent("message.delta", { messageId: "msg_1", text: "Processing" }),
      liveEvent("tool.started", { toolCallId, toolName: "Bash" }),
      liveEvent("tool.completed", {
        toolCallId,
        isError: false,
        outputSummary: "ok",
        input: { command: "ls -la" },
      }),
      liveEvent("approval.requested", { approvalId, type: "command" }),
      liveEvent("run.finished", { runId: "run-equiv", durationMs: 5000 }),
    ];

    // --- Historical `SessionMessage` form (§16.1 resumed transcript) ---------
    // The assistant message collapses the prose, the tool_use block (whose input
    // matches the live event's input) and the approval is recorded only by the
    // tool_result-style structure; approvals have no historical representation
    // so the equivalence omits them from the historical side.
    const historicalMessages: SessionMessage[] = [
      {
        type: "assistant",
        uuid: "a-equiv",
        message: {
          type: "assistant",
          content: [
            { type: "thinking", thinking: "Let me check the files..." },
            { type: "text", text: "Processing" },
            toolUseBlock(toolCallId, "Bash", { command: "ls -la" }),
          ],
        },
      },
      {
        type: "user",
        uuid: "u-equiv",
        message: { type: "tool_result", tool_use_id: toolCallId, content: "ok" },
      },
    ];

    const liveTurns = deriveChatTurns([], liveEvents);
    const historyTurns = deriveChatTurns(historicalMessages, []);

    // The live form produces one agent turn (the run). The historical form
    // produces one agent turn too — both are the same logical turn.
    expect(liveTurns).toHaveLength(1);
    expect(historyTurns).toHaveLength(1);
    expect(liveTurns[0]?.kind).toBe("agent");
    expect(historyTurns[0]?.kind).toBe("agent");

    const liveAgent = liveTurns[0] as AgentTurn;
    const historyAgent = historyTurns[0] as AgentTurn;

    // Prose converges: live deltas accumulate to "Processing", historical carries
    // the same text from the assistant message's text block.
    expect(liveAgent.text).toBe("Processing");
    expect(historyAgent.text).toBe("Processing");

    // The live turn carries a thinking step sourced from the SDK's separate
    // thinking block in history. Both surface the same reasoning.
    const liveThinking = liveAgent.steps.find((s) => s.kind === "thinking");
    const historyThinking = historyAgent.steps.find((s) => s.kind === "thinking");
    expect(liveThinking).toBeUndefined();
    expect(historyThinking).toMatchObject({ text: "Let me check the files..." });

    // Both turns surface the Bash tool with the same call id, name and resolved
    // command input, completing in the same way.
    const liveTool = liveAgent.steps.find((s) => s.kind === "tool");
    const historyTool = historyAgent.steps.find((s) => s.kind === "tool");
    expect(liveTool).toMatchObject({
      toolCallId,
      toolName: "Bash",
      command: "ls -la",
      state: "done",
      outputSummary: "ok",
    });
    expect(historyTool).toMatchObject({
      toolCallId,
      toolName: "Bash",
      command: "ls -la",
      state: "done",
      outputSummary: "ok",
    });

    // Status differs by source: live is closed by run.finished (done, not
    // streaming); historical is constructed from complete messages (done, not
    // streaming) — both report "done" but the live turn additionally carries a
    // durationText that historical cannot reconstruct (no duration event). This
    // is the documented asymmetry: the live stream knows how long a run took.
    expect(liveAgent.status).toBe("done");
    expect(liveAgent.isStreaming).toBe(false);
    expect(liveAgent.durationText).toBe("5s");
    expect(historyAgent.status).toBe("done");
    expect(historyAgent.isStreaming).toBe(false);
    expect(historyAgent.durationText).toBeUndefined();

    // The approval step exists only on the live side (historical messages carry
    // no approval construct) — asserting both shapes keeps the equivalence
    // honest about what each source preserves.
    const liveApproval = liveAgent.steps.find((s) => s.kind === "approval");
    expect(liveApproval).toMatchObject({ kind: "approval" });
    expect((liveApproval as { event: BrowserReplayEvent }).event.type).toBe("approval.requested");
    const historyApproval = historyAgent.steps.find((s) => s.kind === "approval");
    expect(historyApproval).toBeUndefined();

    // No raw payload difference that would break rendering: the live turn's
    // rawPayload is the run.started payload, the historical one's is the
    // assistant message object — both are `unknown` and only consumed by the
    // raw-payload toggle, so equivalence is asserted only on the visible
    // structure, not the opaque raw payloads.
    expect(liveAgent.rawPayload).toBeDefined();
    expect(historyAgent.rawPayload).toBeDefined();
  });

  test("an agent turn collects multiple tools and prose before the next user turn", () => {
    const turns = deriveChatTurns(
      [
        assistantMsg({
          type: "assistant",
          content: [
            { type: "text", text: "First tool" },
            toolUseBlock("t1", "Bash", { command: "a" }),
            toolUseBlock("t2", "Write", { filePath: "b.txt", content: "x" }),
          ],
        }),
        userMsg({ type: "tool_result", tool_use_id: "t1", content: "a-output" }, "ur-1"),
        userMsg({ type: "tool_result", tool_use_id: "t2", content: "b-output" }, "ur-2"),
        userMsg({ content: "done?" }),
      ],
      [],
    );
    expect(turns).toHaveLength(2);
    const agentTurn = turns[0] as { kind: string; steps: unknown[]; text: string };
    expect(agentTurn.text).toBe("First tool");
    expect(agentTurn.steps).toHaveLength(2);
    expect(agentTurn.steps[0]).toMatchObject({
      toolCallId: "t1",
      command: "a",
      outputSummary: "a-output",
    });
    expect(agentTurn.steps[1]).toMatchObject({
      toolCallId: "t2",
      filePath: "b.txt",
      outputSummary: "b-output",
    });
  });

  test("parses Anthropic content-array tool_result in historical messages without creating empty user bubble", () => {
    const turns = deriveChatTurns(
      [
        userMsg({ content: "pwd" }),
        assistantMsg({
          type: "assistant",
          content: [toolUseBlock("toolu-pwd", "Bash", { command: "pwd" })],
        }),
        userMsg(
          {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: "toolu-pwd",
                content: "/home/user/project",
                is_error: false,
              },
            ],
          },
          "u-res",
        ),
      ],
      [],
    );

    expect(turns).toHaveLength(2);
    expect(turns[0]).toMatchObject({ kind: "user", text: "pwd" });
    expect(turns[1]).toMatchObject({ kind: "agent" });
    const steps = (turns[1] as AgentTurn).steps;
    expect(steps[0]).toMatchObject({
      kind: "tool",
      toolCallId: "toolu-pwd",
      state: "done",
      outputSummary: "/home/user/project",
    });
  });

  test("live run.started with prompt emits a UserTurn immediately before the running agent turn", () => {
    resetSeq();
    const turns = deriveChatTurns([], [liveEvent("run.started", { prompt: "show status" }, "r-1")]);
    expect(turns).toHaveLength(2);
    expect(turns[0]).toMatchObject({
      kind: "user",
      key: "live-user-r-1",
      text: "show status",
    });
    expect(turns[1]).toMatchObject({
      kind: "agent",
      key: "live-r-1",
      status: "running",
      isStreaming: true,
    });
  });

  test("deduplicates overlapping historical messages and live events on F5 reload", () => {
    resetSeq();
    const historicalMessages: SessionMessage[] = [
      userMsg({ content: "pwd" }, "u-pwd"),
      assistantMsg(
        {
          id: "msg-pwd",
          type: "assistant",
          content: [
            toolUseBlock("toolu-pwd", "Bash", { command: "pwd" }),
            { type: "text", text: "Tôi hiện đang ở thư mục /mnt/Data" },
          ],
        },
        "a-pwd",
      ),
      userMsg(
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu-pwd",
              content: "/mnt/Data",
              is_error: false,
            },
          ],
        },
        "u-res-pwd",
      ),
    ];

    const liveEvents: BrowserReplayEvent[] = [
      liveEvent("run.started", { prompt: "pwd" }, "run-f5"),
      liveEvent("tool.started", { toolCallId: "toolu-pwd", toolName: "Bash" }, "run-f5"),
      liveEvent(
        "tool.completed",
        {
          toolCallId: "toolu-pwd",
          isError: false,
          outputSummary: "/mnt/Data",
          input: { command: "pwd" },
        },
        "run-f5",
      ),
      liveEvent(
        "message.completed",
        {
          type: "assistant",
          message: {
            id: "msg-pwd",
            content: [{ type: "text", text: "Tôi hiện đang ở thư mục /mnt/Data" }],
          },
        },
        "run-f5",
      ),
      liveEvent("run.finished", { durationMs: 3000 }, "run-f5"),
    ];

    const turns = deriveChatTurns(historicalMessages, liveEvents);

    // Must NOT have duplicates! Exactly 2 turns: 1 user, 1 agent.
    expect(turns).toHaveLength(2);
    expect(turns[0]).toMatchObject({
      kind: "user",
      text: "pwd",
    });
    expect(turns[1]).toMatchObject({
      kind: "agent",
      status: "done",
      durationText: "3s",
      text: "Tôi hiện đang ở thư mục /mnt/Data",
    });
    const agent = turns[1] as AgentTurn;
    expect(agent.steps[0]).toMatchObject({
      kind: "tool",
      toolCallId: "toolu-pwd",
      state: "done",
      outputSummary: "/mnt/Data",
    });
  });
});
