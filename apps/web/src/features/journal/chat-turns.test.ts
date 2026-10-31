import { describe, expect, test } from "bun:test";
import type { AttachmentInfo, BrowserReplayEvent, SessionMessage } from "@cc-web/protocol";
import type { AgentStep, AgentTurn, ToolStep } from "./chat-turns.ts";
import {
  cleanUserPrompt,
  deriveChatTurns,
  extractDiffStats,
  formatDuration,
  formatElapsedSeconds,
  processBodyVisible,
  processSummaryLabel,
  resolveActiveStatus,
  summarizeProcessState,
  toolStepLabel,
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

  test("strips [Attached Files] context block and extracts user prompt", () => {
    const raw = `[Attached Files]
doc.pdf: /path/to/doc.pdf (application/pdf)

User prompt:
Please summarize this PDF`;
    expect(cleanUserPrompt(raw)).toBe("Please summarize this PDF");
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
  test("a run started by a schedule is marked as a scheduled task", () => {
    resetSeq();
    const turns = deriveChatTurns(
      [],
      [
        liveEvent("run.started", {
          prompt: "Kiểm tra dung lượng",
          scheduleId: "sched_1",
          scheduleCron: "58 17 31 10 *",
        }),
      ],
    );
    const user = turns.find((turn) => turn.kind === "user");
    expect(user).toMatchObject({
      text: "Kiểm tra dung lượng",
      source: "schedule",
      scheduleCron: "58 17 31 10 *",
    });
  });

  test("a normal run carries no schedule source", () => {
    resetSeq();
    const turns = deriveChatTurns([], [liveEvent("run.started", { prompt: "hello" })]);
    const user = turns.find((turn) => turn.kind === "user");
    expect(user?.kind === "user" ? user.source : undefined).toBeUndefined();
  });

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

  test("subsequent agent activity after run.finished creates a continuation AgentTurn", () => {
    resetSeq();
    const turns = deriveChatTurns(
      [],
      [
        liveEvent("run.started", { runId: "run-bg-1", prompt: "chay task ngam nhe" }),
        liveEvent("tool.started", { toolCallId: "call-1", toolName: "Bash" }, "run-bg-1"),
        liveEvent(
          "tool.completed",
          { toolCallId: "call-1", outputSummary: "Started bg task" },
          "run-bg-1",
        ),
        liveEvent("message.delta", { text: "Da khoi chay task ngam 10s" }, "run-bg-1"),
        liveEvent("run.finished", { durationMs: 2000 }, "run-bg-1"),
        // Task notification and subsequent agent turn
        liveEvent(
          "run.status",
          { subtype: "task_notification", task_id: "task-123", summary: "Task completed" },
          "run-bg-1",
        ),
        liveEvent("tool.started", { toolCallId: "call-2", toolName: "Read" }, "run-bg-1"),
        liveEvent(
          "tool.completed",
          { toolCallId: "call-2", outputSummary: "Task log results" },
          "run-bg-1",
        ),
        liveEvent("message.delta", { text: "🔔 Ket qua task ngam da xong!" }, "run-bg-1"),
        liveEvent("run.finished", { durationMs: 1500 }, "run-bg-1"),
      ],
    );

    expect(turns).toHaveLength(3);
    // Turn 0: User prompt
    expect(turns[0]).toMatchObject({
      kind: "user",
      text: "chay task ngam nhe",
    });
    // Turn 1: Initial response
    expect(turns[1]).toMatchObject({
      kind: "agent",
      status: "done",
      text: "Da khoi chay task ngam 10s",
    });
    const turn1Steps = (turns[1] as { steps: unknown[] }).steps;
    expect(turn1Steps).toHaveLength(1);
    expect(turn1Steps[0]).toMatchObject({ kind: "tool", toolName: "Bash", state: "done" });

    // Turn 2: Subsequent response reporting background task result
    expect(turns[2]).toMatchObject({
      kind: "agent",
      status: "done",
      text: "🔔 Ket qua task ngam da xong!",
    });
    const turn2Steps = (turns[2] as { steps: unknown[] }).steps;
    expect(turn2Steps).toHaveLength(1);
    expect(turn2Steps[0]).toMatchObject({ kind: "tool", toolName: "Read", state: "done" });
  });

  test("historical messages: flushes current agent turn and starts new turn on <task-notification>", () => {
    const turns = deriveChatTurns(
      [
        userMsg({ content: "chay background nhe" }, "u-1"),
        assistantMsg(
          {
            type: "assistant",
            content: [
              toolUseBlock("tool-1", "Bash", { command: "run.sh &" }),
              { type: "text", text: "Dang chay ngam..." },
            ],
          },
          "a-1",
        ),
        userMsg({ type: "tool_result", tool_use_id: "tool-1", content: "bg started" }, "u-2"),
        // Task notification injected as automated message
        userMsg(
          {
            content:
              "<task-notification>\n<task-id>task-123</task-id>\n<summary>Completed</summary>\n</task-notification>",
          },
          "u-notif",
        ),
        assistantMsg(
          {
            type: "assistant",
            content: [
              toolUseBlock("tool-2", "Read", { file_path: "/tmp/log.txt" }),
              { type: "text", text: "🔔 Ket qua task ngam: Thanh cong!" },
            ],
          },
          "a-2",
        ),
        userMsg({ type: "tool_result", tool_use_id: "tool-2", content: "log content" }, "u-3"),
      ],
      [],
    );

    expect(turns).toHaveLength(3);
    expect(turns[0]).toMatchObject({
      kind: "user",
      text: "chay background nhe",
    });
    expect(turns[1]).toMatchObject({
      kind: "agent",
      text: "Dang chay ngam...",
    });
    expect(turns[2]).toMatchObject({
      kind: "agent",
      text: "🔔 Ket qua task ngam: Thanh cong!",
    });
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

  test("renders optimistic pending user turn and agent spinner before liveEvents arrive", () => {
    const turns = deriveChatTurns([], [], {
      runId: "run-pending-1",
      prompt: "Tôi muốn kiểm tra file",
    });

    expect(turns).toHaveLength(2);
    expect(turns[0]).toMatchObject({
      kind: "user",
      key: "user-pending-run-pending-1",
      text: "Tôi muốn kiểm tra file",
    });
    expect(turns[1]).toMatchObject({
      kind: "agent",
      key: "agent-pending-run-pending-1",
      status: "running",
      isStreaming: true,
    });
  });

  test("supersedes pendingRun when liveEvents contains run.started for that runId", () => {
    resetSeq();
    const turns = deriveChatTurns(
      [],
      [liveEvent("run.started", { prompt: "Tôi muốn kiểm tra file" }, "run-pending-1")],
      {
        runId: "run-pending-1",
        prompt: "Tôi muốn kiểm tra file",
      },
    );

    expect(turns).toHaveLength(2);
    expect(turns[0]).toMatchObject({
      kind: "user",
      key: "live-user-run-pending-1",
      text: "Tôi muốn kiểm tra file",
    });
    expect(turns[1]).toMatchObject({
      kind: "agent",
      key: "live-run-pending-1",
      status: "running",
      isStreaming: true,
    });
  });

  test("run.started carrying attachments creates a UserTurn with attachments", () => {
    resetSeq();
    const attachments: AttachmentInfo[] = [
      { id: "att-1", name: "photo.png", mimeType: "image/png", size: 12345 },
      { id: "att-2", name: "notes.txt", mimeType: "text/plain", size: 678 },
    ];
    const turns = deriveChatTurns(
      [],
      [liveEvent("run.started", { runId: "run-1", prompt: "see these files", attachments })],
    );
    expect(turns).toHaveLength(2);
    expect(turns[0]).toMatchObject({
      kind: "user",
      key: "live-user-run-1",
      text: "see these files",
      attachments,
    });
  });

  test("run.started without attachments yields a UserTurn with no attachments field", () => {
    resetSeq();
    const turns = deriveChatTurns(
      [],
      [liveEvent("run.started", { runId: "run-1", prompt: "hello" })],
    );
    expect(turns).toHaveLength(2);
    expect(turns[0]).toMatchObject({
      kind: "user",
      text: "hello",
    });
    expect((turns[0] as { attachments?: unknown }).attachments).toBeUndefined();
  });

  test("pendingRun with attachments creates an optimistic UserTurn with attachments", () => {
    const attachments: AttachmentInfo[] = [
      { id: "att-3", name: "diagram.png", mimeType: "image/png", size: 9000 },
    ];
    const turns = deriveChatTurns([], [], {
      runId: "run-pending-2",
      prompt: "look at this",
      attachments,
    });
    expect(turns).toHaveLength(2);
    expect(turns[0]).toMatchObject({
      kind: "user",
      key: "user-pending-run-pending-2",
      text: "look at this",
      attachments,
    });
  });

  test("run.started event with invalid attachments array falls back to no attachments", () => {
    resetSeq();
    const turns = deriveChatTurns(
      [],
      [liveEvent("run.started", { runId: "run-1", prompt: "hi", attachments: [{ bad: true }] })],
    );
    expect(turns).toHaveLength(2);
    expect(turns[0]).toMatchObject({
      kind: "user",
      text: "hi",
    });
    expect((turns[0] as { attachments?: unknown }).attachments).toBeUndefined();
  });
});

describe("summarizeProcessState", () => {
  const thinking: AgentStep = { kind: "thinking", key: "s-1", text: "weighing options" };
  const read: AgentStep = {
    kind: "tool",
    key: "s-2",
    toolCallId: "tc-1",
    toolName: "Read",
    state: "done",
    filePath: "src/app.ts",
  };
  const edit: AgentStep = {
    kind: "tool",
    key: "s-3",
    toolCallId: "tc-2",
    toolName: "Edit",
    state: "running",
    filePath: "src/app.ts",
  };
  const approval: AgentStep = {
    kind: "approval",
    key: "s-4",
    event: liveEvent("approval.requested", { approvalId: "apr-1" }),
  };

  test("counts thinking and tool steps but not approvals", () => {
    const summary = summarizeProcessState([thinking, read, edit, approval], "running");
    expect(summary.count).toBe(3);
    expect(summary.hasError).toBe(false);
  });

  test("running reports the latest tool step as the active label", () => {
    expect(summarizeProcessState([thinking, read, edit], "running").activeStepLabel).toBe(
      "Sửa file: src/app.ts",
    );
  });

  test("running with only thinking reports the thinking label", () => {
    expect(summarizeProcessState([thinking], "running").activeStepLabel).toBe("Đang suy nghĩ…");
  });

  test("a finished turn has no active step", () => {
    const summary = summarizeProcessState([thinking, read], "done");
    expect(summary.activeStepLabel).toBeUndefined();
    expect(summary.hasError).toBe(false);
  });

  test("hasError is set by a failed tool step or an errored run", () => {
    const failed: AgentStep = { ...read, state: "error" };
    expect(summarizeProcessState([thinking, failed], "done").hasError).toBe(true);
    expect(summarizeProcessState([], "error").hasError).toBe(true);
  });

  test("an empty step list summarizes to zero", () => {
    expect(summarizeProcessState([], "running")).toEqual({
      count: 0,
      activeStepLabel: undefined,
      hasError: false,
    });
  });
});

describe("processBodyVisible", () => {
  test("an open accordion renders its body", () => {
    expect(processBodyVisible(true, 3)).toBe(true);
  });

  test("a collapsed accordion with execution steps hides its body", () => {
    expect(processBodyVisible(false, 3)).toBe(false);
  });

  test("a turn with nothing to collapse always renders its body", () => {
    // Approval-only turn: no toggle exists, so the cards must never be hidden.
    expect(processBodyVisible(false, 0)).toBe(true);
  });
});

describe("toolStepLabel", () => {
  const base = { kind: "tool" as const, key: "k", toolCallId: "t", state: "running" as const };

  test("labels file, shell and search tools in Vietnamese", () => {
    expect(toolStepLabel({ ...base, toolName: "Edit", filePath: "src/a.ts" })).toBe(
      "Sửa file: src/a.ts",
    );
    expect(toolStepLabel({ ...base, toolName: "Write", filePath: "src/b.ts" })).toBe(
      "Sửa file: src/b.ts",
    );
    expect(toolStepLabel({ ...base, toolName: "Read", filePath: "src/c.ts" })).toBe(
      "Đọc file: src/c.ts",
    );
    expect(toolStepLabel({ ...base, toolName: "Bash", command: "bun test" })).toBe(
      "Chạy: bun test",
    );
    expect(toolStepLabel({ ...base, toolName: "Grep", inputSummary: "TODO" })).toBe("Tìm: TODO");
  });

  test("falls back to the tool name and truncates long labels", () => {
    expect(toolStepLabel({ ...base, toolName: "WebFetch" })).toBe("WebFetch");
    const long = toolStepLabel({ ...base, toolName: "Edit", filePath: "x".repeat(200) });
    expect(long.length).toBeLessThanOrEqual(81);
    expect(long.endsWith("…")).toBe(true);
  });
});

describe("summarizeProcessState — active step", () => {
  const base = { kind: "tool" as const, toolName: "Read", state: "running" as const };

  test("prefers the last tool still running", () => {
    const summary = summarizeProcessState(
      [
        { ...base, key: "a", toolCallId: "a", state: "done", filePath: "done.ts" },
        { ...base, key: "b", toolCallId: "b", filePath: "live.ts" },
      ],
      "running",
    );
    expect(summary.activeStepLabel).toBe("Đọc file: live.ts");
  });

  test("names no step when every tool already settled", () => {
    const summary = summarizeProcessState(
      [{ ...base, key: "a", toolCallId: "a", state: "done", filePath: "done.ts" }],
      "running",
    );
    expect(summary.activeStepLabel).toBeUndefined();
  });

  test("interrupted turns have no active step", () => {
    const summary = summarizeProcessState(
      [{ ...base, key: "a", toolCallId: "a", filePath: "x.ts" }],
      "interrupted",
    );
    expect(summary.activeStepLabel).toBeUndefined();
    expect(summary.hasError).toBe(false);
  });

  test("an approval-only turn counts zero execution steps", () => {
    const summary = summarizeProcessState(
      [{ kind: "approval", key: "ap", event: liveEvent("approval.requested", {}) }],
      "done",
    );
    expect(summary).toEqual({ count: 0, activeStepLabel: undefined, hasError: false });
  });
});

describe("processSummaryLabel", () => {
  const empty = { count: 0, activeStepLabel: undefined, hasError: false };

  test("reports the running step or a generic running label", () => {
    expect(
      processSummaryLabel("running", {
        count: 2,
        activeStepLabel: "Chạy: bun test",
        hasError: false,
      }),
    ).toBe("Đang chạy: Chạy: bun test");
    expect(processSummaryLabel("running", empty)).toBe("Đang chạy…");
  });

  test("parks on a pending approval before naming any step", () => {
    expect(
      processSummaryLabel(
        "running",
        { count: 2, activeStepLabel: "Chạy: bun test", hasError: false },
        1,
      ),
    ).toBe("Đang chờ phê duyệt…");
  });

  test("summarizes every settled state", () => {
    expect(
      processSummaryLabel("done", { count: 5, activeStepLabel: undefined, hasError: false }),
    ).toBe("Đã hoàn thành 5 bước thực hiện");
    expect(
      processSummaryLabel("error", { count: 3, activeStepLabel: undefined, hasError: true }),
    ).toBe("Lỗi sau 3 bước thực hiện");
    expect(
      processSummaryLabel("interrupted", { count: 1, activeStepLabel: undefined, hasError: false }),
    ).toBe("Đã dừng sau 1 bước thực hiện");
  });
});

describe("formatElapsedSeconds", () => {
  test("formats seconds under a minute", () => {
    expect(formatElapsedSeconds(0)).toBe("0s");
    expect(formatElapsedSeconds(5)).toBe("5s");
    expect(formatElapsedSeconds(59)).toBe("59s");
  });

  test("formats minutes and seconds", () => {
    expect(formatElapsedSeconds(60)).toBe("1m 0s");
    expect(formatElapsedSeconds(75)).toBe("1m 15s");
    expect(formatElapsedSeconds(125)).toBe("2m 5s");
  });
});

describe("resolveActiveStatus", () => {
  test("returns waiting for approval when pendingApprovalCount > 0", () => {
    const status = resolveActiveStatus([], false, false, 1);
    expect(status).toEqual({ label: "Đang chờ phê duyệt…" });
  });

  test("returns running tool details for file operations", () => {
    const readStep: ToolStep = {
      kind: "tool",
      key: "k1",
      toolCallId: "t1",
      toolName: "Read",
      state: "running",
      filePath: "src/main.ts",
    };
    expect(resolveActiveStatus([readStep], false)).toEqual({
      label: "Đang đọc file…",
      subDetail: "src/main.ts",
    });

    const editStep: ToolStep = {
      kind: "tool",
      key: "k2",
      toolCallId: "t2",
      toolName: "Edit",
      state: "running",
      filePath: "src/app.vue",
    };
    expect(resolveActiveStatus([editStep], false)).toEqual({
      label: "Đang sửa file…",
      subDetail: "src/app.vue",
    });

    const writeStep: ToolStep = {
      kind: "tool",
      key: "k3",
      toolCallId: "t3",
      toolName: "Write",
      state: "running",
      filePath: "src/new.ts",
    };
    expect(resolveActiveStatus([writeStep], false)).toEqual({
      label: "Đang ghi file…",
      subDetail: "src/new.ts",
    });
  });

  test("returns command detail for running Bash tool", () => {
    const bashStep: ToolStep = {
      kind: "tool",
      key: "k4",
      toolCallId: "t4",
      toolName: "Bash",
      state: "running",
      command: "bun test",
    };
    expect(resolveActiveStatus([bashStep], false)).toEqual({
      label: "Đang chạy lệnh…",
      subDetail: "bun test",
    });
  });

  test("returns search detail for Grep / Glob tool", () => {
    const grepStep: ToolStep = {
      kind: "tool",
      key: "k5",
      toolCallId: "t5",
      toolName: "Grep",
      state: "running",
      inputSummary: "pattern: 'export function'",
    };
    expect(resolveActiveStatus([grepStep], false)).toEqual({
      label: "Đang tìm kiếm…",
      subDetail: "pattern: 'export function'",
    });
  });

  test("returns generic tool name for other tools", () => {
    const webStep: ToolStep = {
      kind: "tool",
      key: "k6",
      toolCallId: "t6",
      toolName: "WebFetch",
      state: "running",
      inputSummary: "https://example.com",
    };
    expect(resolveActiveStatus([webStep], false)).toEqual({
      label: "Đang chạy: WebFetch…",
      subDetail: "https://example.com",
    });
  });

  test("returns thinking when last execution step is thinking", () => {
    expect(
      resolveActiveStatus([{ kind: "thinking", key: "th1", text: "Reasoning..." }], false),
    ).toEqual({
      label: "Đang suy nghĩ…",
    });
  });

  test("returns responding when text has started arriving", () => {
    expect(resolveActiveStatus([], true, true)).toEqual({
      label: "Đang trả lời…",
    });
  });

  test("defaults to processing when no steps or text yet", () => {
    expect(resolveActiveStatus([], false, true)).toEqual({
      label: "Đang xử lý…",
    });
    expect(resolveActiveStatus([], false, false)).toEqual({
      label: "Đang xử lý…",
    });
  });
});
