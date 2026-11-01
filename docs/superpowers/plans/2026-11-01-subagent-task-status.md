# Subagent & Background-Task Status Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show the operator that background subagents/tasks are still running after a run's terminal event, by carrying the SDK's task lifecycle into typed journal events and rendering it in the web client.

**Architecture:**
The SDK already emits `task_started`, `task_progress`, `task_updated`, `task_notification`, and the level signal `background_tasks_changed`; the runner currently folds every one of them into `run.status`. Add five additive journal event types (no DB migration — payloads are opaque JSON), map the SDK frames in a pure runner module, and build the journal events into a pure web state module. The UI is a sticky band inside the journal plus an optional badge on the spawning tool step. Cancellation and nested transcripts are deliberately later phases.

**Tech Stack:** Bun, TypeScript 7, Hono control server, Vue 3 SFC, Tailwind + shadcn-vue, `@anthropic-ai/claude-agent-sdk`.

**Spec:** `docs/superpowers/specs/2026-11-01-subagent-task-status-design.md`

## Global Constraints

- **Read-only research is over; this plan changes production files.** Follow TDD: write the failing test first, then the implementation.
- **Never edit generated shadcn-vue files**: `apps/web/src/components/ui/**`, `apps/web/src/lib/utils.ts`, `apps/web/src/styles/index.css`, `apps/web/components.json`.
- **Theme**: use the generated CSS variables / Tailwind utilities only.
- **Payload hygiene**: never journal `prompt`; run free text through `redactErrorText`; every event still passes `boundEventPayload`.
- **Upgrade order**: control server first, then runner (`runner-gateway.ts` rejects unknown event types).
- **Gates**: every task ends with `bun test`, `bun run typecheck`, `bun run lint`, and `cd apps/web && bun run build`.
- **`bun` lives in `~/.ponta/bin`** in this environment: `export PATH="$HOME/.ponta/bin:$PATH"` before running gates.
- Do not commit or push unless the owner asks.

## Review Focus

1. **No stale "running" indicator.** The level signal (`tasks.changed`) must be authoritative; a missed `task_notification` must not leave the band spinning forever.
2. **Ambient filtering.** Watchers/observers (`ambient`, `skip_transcript`) never appear in the activity band.
3. **Payload size and secrets.** `task_started.prompt` is dropped; summaries are redacted and bounded; no per-event row may exceed the payload ceiling.
4. **Ordering.** Level/bookend ordering for one transition is unspecified; a late `task_updated` for an older `run_id` must not overwrite newer state.
5. **Honest Stop button.** P1/P2 must not resurrect Stop; the band explains the run/session mismatch without promising cancellation.

---

### Task 1: Protocol — task event types and payload parsers

**Files:**
- Create: `packages/protocol/src/task-events.ts`
- Create: `packages/protocol/src/task-events.test.ts`
- Modify: `packages/protocol/src/index.ts` (EventType union at ~L89, `EVENT_TYPES` at ~L118, re-export next to the other modules)
- Modify: `packages/protocol/src/event-types.test.ts` (pin the new names)

**Interfaces:**
```ts
export type TaskUsage = { totalTokens: number; toolUses: number; durationMs: number };
export type TaskRef = {
  taskId: string;
  runId?: string;
  taskType?: string;
  subagentType?: string;
  parentTaskId?: string;
  ambient?: boolean;
};
export type TaskStartedPayload = TaskRef & {
  toolUseId?: string;
  description: string;
  isBackgrounded?: boolean;
  spawnDepth?: number;
  workflowName?: string;
  skipTranscript?: boolean;
};
export type TaskProgressPayload = {
  taskId: string;
  runId?: string;
  toolUseId?: string;
  description?: string;
  subagentType?: string;
  usage?: TaskUsage;
  lastToolName?: string;
  summary?: string;
};
export type TaskUpdatedPayload = {
  taskId: string;
  runId?: string;
  patch: {
    status?: "pending" | "running" | "completed" | "failed" | "killed" | "paused";
    description?: string;
    endTime?: number;
    totalPausedMs?: number;
    error?: string;
    isBackgrounded?: boolean;
  };
};
export type TaskCompletedPayload = {
  taskId: string;
  runId?: string;
  toolUseId?: string;
  status: "completed" | "failed" | "stopped";
  reason?: "worker_restart";
  summary?: string;
  outputFile?: string;
  usage?: TaskUsage;
  ambient?: boolean;
  skipTranscript?: boolean;
};
export type TasksChangedPayload = { tasks: TaskRef[] };

export function parseTaskStartedPayload(value: unknown): TaskStartedPayload | null;
export function parseTaskProgressPayload(value: unknown): TaskProgressPayload | null;
export function parseTaskUpdatedPayload(value: unknown): TaskUpdatedPayload | null;
export function parseTaskCompletedPayload(value: unknown): TaskCompletedPayload | null;
export function parseTasksChangedPayload(value: unknown): TasksChangedPayload | null;
```
Every parser returns `null` when `taskId` is missing or not a non-empty string; optional fields are copied only when their type matches (no `undefined` keys).

- [ ] **Step 1: Write the failing tests**

```ts
// packages/protocol/src/task-events.test.ts
import { describe, expect, test } from "bun:test";
import {
  parseTaskCompletedPayload,
  parseTaskStartedPayload,
  parseTasksChangedPayload,
} from "./task-events.ts";

describe("task payload parsers", () => {
  test("started keeps the UI fields and rejects a missing taskId", () => {
    const parsed = parseTaskStartedPayload({
      taskId: "task-1",
      runId: "run-2",
      toolUseId: "toolu-9",
      description: "Sweep the repo",
      subagentType: "Explore",
      isBackgrounded: true,
      spawnDepth: 1,
      ambient: false,
    });
    expect(parsed).toEqual({
      taskId: "task-1",
      runId: "run-2",
      toolUseId: "toolu-9",
      description: "Sweep the repo",
      subagentType: "Explore",
      isBackgrounded: true,
      spawnDepth: 1,
      ambient: false,
    });
    expect(parseTaskStartedPayload({ description: "no id" })).toBeNull();
    expect(parseTaskStartedPayload(null)).toBeNull();
  });

  test("completed narrows status and keeps usage", () => {
    expect(
      parseTaskCompletedPayload({
        taskId: "task-1",
        status: "stopped",
        summary: "stopped by operator",
        usage: { totalTokens: 1200, toolUses: 4, durationMs: 9000 },
      }),
    ).toEqual({
      taskId: "task-1",
      status: "stopped",
      summary: "stopped by operator",
      usage: { totalTokens: 1200, toolUses: 4, durationMs: 9000 },
    });
    expect(parseTaskCompletedPayload({ taskId: "task-1", status: "bogus" })).toBeNull();
  });

  test("tasks.changed is a level set with the same ref shape", () => {
    expect(
      parseTasksChangedPayload({
        tasks: [{ taskId: "a", ambient: false }, { taskId: "b", parentTaskId: "a" }],
      }),
    ).toEqual({ tasks: [{ taskId: "a", ambient: false }, { taskId: "b", parentTaskId: "a" }] });
    expect(parseTasksChangedPayload({ tasks: "nope" })).toBeNull();
  });
});
```

```ts
// packages/protocol/src/event-types.test.ts — add
test("task lifecycle event types are accepted on the wire", () => {
  for (const type of [
    "task.started",
    "task.progress",
    "task.updated",
    "task.completed",
    "tasks.changed",
  ] as const) {
    expect(EVENT_TYPES).toContain(type);
  }
});
```

- [ ] **Step 2: Run the tests and confirm they fail**

```sh
export PATH="$HOME/.ponta/bin:$PATH"
cd /mnt/Data/Ponta/cc-web
bun test packages/protocol/src/task-events.test.ts packages/protocol/src/event-types.test.ts
```

- [ ] **Step 3: Implement**

Add the five members to `EventType` and `EVENT_TYPES`; add
`export * from "./task-events.ts";` next to the other module re-exports. Implement
the parsers with small helpers: `asString`, `asBoolean`, `asNumber`, `asUsage`.

- [ ] **Step 4: Run tests + typecheck**

```sh
bun test packages/protocol/src
bun run typecheck
bun run lint
```

---

### Task 2: Runner — SDK frame → journal event mapper

**Files:**
- Create: `apps/runner/src/execution/task-events.ts`
- Create: `apps/runner/src/execution/task-events.test.ts`

**Interfaces:**
```ts
import type { EventType } from "@cc-web/protocol";

export type TaskJournalEvent = { type: EventType; payload: Record<string, unknown> };

/** null for every frame that is not a task-lifecycle system message. */
export function taskEventOf(message: Record<string, unknown>): TaskJournalEvent | null;
```
Mapping:
- `system/task_started` → `task.started`; omit absent optionals; **drop `prompt`**, `uuid`, `session_id`.
- `system/task_progress` → `task.progress`.
- `system/task_updated` → `task.updated`; carry `patch` with camelCase keys; drop unknown patch keys.
- `system/task_notification` → `task.completed`; `status` must be `completed|failed|stopped`, otherwise return `null` (an unexpected shape must stay visible on the `run.status` path).
- `system/background_tasks_changed` → `tasks.changed`; each entry normalised to `TaskRef`.
- Anything else → `null`.
- Apply `redactErrorText` to `description`, `summary`, `patch.error`, `lastToolName` after normalisation.

- [ ] **Step 1: Write the failing tests**

```ts
// apps/runner/src/execution/task-events.test.ts
import { describe, expect, test } from "bun:test";
import { taskEventOf } from "./task-events.ts";

describe("taskEventOf", () => {
  test("maps task_started to task.started and drops the prompt", () => {
    const event = taskEventOf({
      type: "system",
      subtype: "task_started",
      task_id: "task-1",
      run_id: "run-2",
      tool_use_id: "toolu-9",
      description: "Sweep the repo",
      subagent_type: "Explore",
      is_backgrounded: true,
      spawn_depth: 1,
      parent_task_id: "task-0",
      task_type: "local_agent",
      workflow_name: "cc-web-smoke-sweep",
      prompt: "SECRET",
      ambient: false,
      uuid: "u-1",
      session_id: "s-1",
    });
    expect(event).toEqual({
      type: "task.started",
      payload: {
        taskId: "task-1",
        runId: "run-2",
        toolUseId: "toolu-9",
        description: "Sweep the repo",
        subagentType: "Explore",
        isBackgrounded: true,
        spawnDepth: 1,
        parentTaskId: "task-0",
        taskType: "local_agent",
        workflowName: "cc-web-smoke-sweep",
        ambient: false,
      },
    });
    expect(JSON.stringify(event)).not.toContain("SECRET");
  });

  test("maps notification status and redacts free text", () => {
    const event = taskEventOf({
      type: "system",
      subtype: "task_notification",
      task_id: "task-1",
      status: "failed",
      summary: "failed with api_key=abcdef123456",
      output_file: "/tmp/task-1.txt",
      usage: { total_tokens: 10, tool_uses: 2, duration_ms: 500 },
    });
    expect(event?.type).toBe("task.completed");
    expect(event?.payload["summary"]).toContain("api_key=[REDACTED]");
    expect(event?.payload["status"]).toBe("failed");
  });

  test("background_tasks_changed replaces a level set", () => {
    const event = taskEventOf({
      type: "system",
      subtype: "background_tasks_changed",
      tasks: [
        { task_id: "a", task_type: "local_agent", subagent_type: "Explore", ambient: false },
        { task_id: "b", ambient: true },
      ],
    });
    expect(event?.type).toBe("tasks.changed");
    expect(event?.payload).toEqual({
      tasks: [
        { taskId: "a", taskType: "local_agent", subagentType: "Explore", ambient: false },
        { taskId: "b", ambient: true },
      ],
    });
  });

  test("leaves unknown frames and malformed statuses on the generic path", () => {
    expect(taskEventOf({ type: "system", subtype: "init" })).toBeNull();
    expect(taskEventOf({ type: "assistant" })).toBeNull();
    expect(
      taskEventOf({ type: "system", subtype: "task_notification", task_id: "t", status: "weird" }),
    ).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test and confirm it fails**

```sh
bun test apps/runner/src/execution/task-events.test.ts
```

- [ ] **Step 3: Implement** the pure mapper. Use `redactErrorText` from
  `./redact.ts`. Keep the payload free of `undefined` keys so `toEqual` can pin
  it.

- [ ] **Step 4: Run tests + gates**

```sh
bun test apps/runner/src/execution/task-events.test.ts
bun run typecheck
bun run lint
```

---

### Task 3: Runner — wire the mapper into the executor

**Files:**
- Modify: `apps/runner/src/execution/executor.ts` (inside the `for await` loop, after the `system/init` block at ~L568-574 and before the `stream_event` branch at ~L581)
- Modify: `apps/runner/src/execution/executor.test.ts` (new describe block)

**Wiring:**
```ts
const taskEvent = taskEventOf(sdkMessage);
if (taskEvent !== null) {
  append(taskEvent.type, taskEvent.payload);
  continue;
}
```
Rationale: task frames are `system` messages and must not reach
`eventTypeOf`'s `run.status` fallback. `append` already applies the payload
bound and outbox write.

- [ ] **Step 1: Write the failing test** (reuse the existing `events(db)` helper
  at `executor.test.ts:67` and the `runStream` pattern used by the clean-run
  test):

```ts
test("task frames become typed events, not run.status", async () => {
  // stream: init → task_started → background_tasks_changed → task_notification → result
  // expect events(db).map(e => e.type) to contain task.started, tasks.changed, task.completed
  // expect no run.status row whose payload contains subtype "task_started"
  // expect the last event to be run.finished
});
```

- [ ] **Step 2: Run it and confirm it fails** (`run.status` rows today).

```sh
bun test apps/runner/src/execution/executor.test.ts
```

- [ ] **Step 3: Implement the wiring** and re-run.

- [ ] **Step 4: Full runner gates**

```sh
bun test apps/runner/src
bun run typecheck
bun run lint
```

---

### Task 4: Web — background task state module

**Files:**
- Create: `apps/web/src/features/journal/background-tasks.ts`
- Create: `apps/web/src/features/journal/background-tasks.test.ts`

**Interfaces:**
```ts
import type { EventType, TaskUsage } from "@cc-web/protocol";

export type BackgroundTaskStatus = "running" | "completed" | "failed" | "stopped";

export type BackgroundTask = {
  taskId: string;
  description: string;
  subagentType?: string;
  taskType?: string;
  workflowName?: string;
  parentTaskId?: string;
  toolUseId?: string;
  ambient: boolean;
  status: BackgroundTaskStatus;
  lastToolName?: string;
  summary?: string;
  usage?: TaskUsage;
  startedAt: string; // the journal envelope's occurredAt
  updatedAt: string;
};

export type BackgroundTaskState = {
  tasks: ReadonlyMap<string, BackgroundTask>;
  liveTaskIds: ReadonlySet<string>;
};

export const EMPTY_TASK_STATE: BackgroundTaskState;

export function applyTaskEvent(
  state: BackgroundTaskState,
  event: { type: EventType; payload: unknown; occurredAt: string },
): BackgroundTaskState;

export function taskStateFromEvents(
  events: ReadonlyArray<{ type: EventType; payload: unknown; occurredAt: string }>,
): BackgroundTaskState;

/** Live, non-ambient tasks, oldest first. */
export function liveActivityTasks(state: BackgroundTaskState): BackgroundTask[];
```
Rules:
- Edges (`task.started`/`progress`/`updated`/`completed`) create/update the map
  entry and add/remove from `liveTaskIds` as a fallback.
- `tasks.changed` **replaces** `liveTaskIds` with the set of ids in the payload
  (the level signal is authoritative).
- `ambient` tasks stay in `tasks` but are excluded by `liveActivityTasks`.
- Unknown/unparsable payloads return the same state object (identity), so Vue
  computeds do not churn.
- A late update whose `runId` sorts before the held task's `runId` is ignored
  (plain string comparison, per the SDK's ordering note).

- [ ] **Step 1: Write the failing tests**

```ts
// apps/web/src/features/journal/background-tasks.test.ts
import { describe, expect, test } from "bun:test";
import {
  applyTaskEvent,
  EMPTY_TASK_STATE,
  liveActivityTasks,
  taskStateFromEvents,
} from "./background-tasks.ts";

const at = (n: number) => `2026-11-01T00:00:0${n}.000Z`;

describe("background task state", () => {
  test("started adds a live task; tasks.changed replaces the live set", () => {
    let state = applyTaskEvent(EMPTY_TASK_STATE, {
      type: "task.started",
      occurredAt: at(1),
      payload: { taskId: "a", description: "Sweep", subagentType: "Explore", ambient: false },
    });
    expect(liveActivityTasks(state).map((t) => t.taskId)).toEqual(["a"]);

    state = applyTaskEvent(state, {
      type: "tasks.changed",
      occurredAt: at(2),
      payload: { tasks: [] },
    });
    expect(liveActivityTasks(state)).toEqual([]);
  });

  test("an edge that never got its completion cannot survive a level reset", () => {
    // started → level says empty (process restarted / task settled) → no stale row
  });

  test("progress and completion update the row", () => {
    // task.progress → lastToolName/summary; task.completed → status + usage + removed from live
  });

  test("ambient tasks never appear in the activity list", () => {
    // task.started ambient:true → tasks map has it, liveActivityTasks() does not
  });

  test("unknown events keep the state object identity", () => {
    const state = applyTaskEvent(EMPTY_TASK_STATE, {
      type: "run.status",
      occurredAt: at(3),
      payload: {},
    });
    expect(state).toBe(EMPTY_TASK_STATE);
  });
});
```

- [ ] **Step 2: Run and confirm failure**

```sh
bun test apps/web/src/features/journal/background-tasks.test.ts
```

- [ ] **Step 3: Implement** the pure module using
  `parseTaskStartedPayload` etc. from `@cc-web/protocol`.

- [ ] **Step 4: Run tests + typecheck**

```sh
bun test apps/web
bun run typecheck:vue
```

---

### Task 5: Web — the background-task band

**Files:**
- Create: `apps/web/src/components/chat/BackgroundTaskBand.vue`
- Modify: `apps/web/src/components/EventJournal.vue` (render the band above the
  `needsResync` paragraph at ~L297, inside the scroll content)
- Modify: `apps/web/src/views/SessionView.vue` (derive the task state from
  `sessions.stream?.events` and pass it to `EventJournal`)

**Component contract:**
```ts
const props = defineProps<{
  /** Live, non-ambient tasks; empty hides the band. */
  tasks: BackgroundTask[];
}>();
```
Behaviour:
- Collapsed: `● N task nền đang chạy` + the oldest task's elapsed time (from
  `startedAt`), `aria-expanded` on a real button.
- Expanded: one row per task — status dot, `description` (fallback
  `subagentType` / `workflowName` / `taskType`), `subagentType` badge,
  `lastToolName`, elapsed, and after completion `summary` + usage.
- Styling follows the `needsResync` band (`border-l-2`, theme variables,
  `text-[13px]`); Vietnamese copy, no custom palette.
- No timers in the pure module; the component may use `setInterval` only for
  the elapsed label, and must clear it on unmount.

**Wiring:** in `SessionView.vue`, add:
```ts
const backgroundTasks = computed(() =>
  liveActivityTasks(taskStateFromEvents(sessions.stream?.events ?? [])),
);
```
and pass `:background-tasks="backgroundTasks"` to `EventJournal`. Do **not**
change `liveRunId` or the Composer's `activeRunId`: the Stop button stays tied
to the run.

- [ ] **Step 1:** Write a pure test for the derivation if any logic escapes the
  component (`taskStateFromEvents` already covers the reducer; the band itself
  stays presentation-only).
- [ ] **Step 2:** Implement the component and wiring.
- [ ] **Step 3:** Gates, including `bun run typecheck:vue` (templates are only
  checked there) and `cd apps/web && bun run build`.
- [ ] **Step 4:** Manual check: replay the failed-run scenario — a run that
  spawns a background workflow, then finishes; the band must appear at
  `run.finished` and disappear when `tasks.changed` empties.

---

### Task 6 (P2b, optional): badge on the spawning tool step

**Files:**
- Modify: `apps/web/src/components/chat/AgentToolStep.vue` (accept an optional
  `task?: BackgroundTask` prop)
- Modify: `AgentProcessAccordion.vue` and `AgentChatTurn.vue` to pass a
  `taskFor(toolUseId)` lookup down
- Modify: `EventJournal.vue` / `SessionView.vue` to supply the lookup from the
  task state

Show a status dot + elapsed next to the `Task`/`Agent` tool row, joined by
`toolUseId`. This is the natural place to answer "what did that subagent do?";
keep it out of the plan's critical path if plumbing grows.

---

### Task 7 (P3, optional): stop a background task

**Files:**
- Modify: `packages/protocol/src/index.ts` (`CommandKind` + payload parser)
- Modify: `packages/agent-adapter/src/index.ts` (expose the SDK `Query` control
  handle; `createSdkStream` currently returns only the async iterable and
  discards `stopTask`)
- Modify: `apps/runner/src/execution/executor.ts` / `run-controller.ts` (hold
  the control handle for the attempt; handle `task.stop`)
- Modify: `apps/control-server/src/...` (route a `task.stop` command to the
  runner holding the **session pin** — `active_runs` is already gone after
  `run.finished`, see spec §5)
- Modify: `BackgroundTaskBand.vue` (per-task stop button)

The SDK's `stopTask(taskId)` emits `task_notification` with
`status: "stopped"` (`sdk.d.ts:3291-3294`). Do not reuse `run.cancel`; it
returns 404 after the terminal event.

---

### Task 8 (P4, optional): subagent transcript

Expose `forwardSubagentText` in `SdkStreamInput`, map subagent messages by
`parent_tool_use_id`/`agent_id`, and render a nested transcript or link
`task_notification.output_file`. Larger; only after P1–P3 prove useful.

---

## Verification

```sh
export PATH="$HOME/.ponta/bin:$PATH"
cd /mnt/Data/Ponta/cc-web
bun test
bun run typecheck
bun run lint
cd apps/web && bun run build
```

Expected after P1: the new protocol/runner tests pass, `EVENT_TYPES` contains
the five names, and an executor run emits `task.*` events instead of
`run.status` for task frames. After P2: a session whose run finished with live
background tasks shows the band, and it disappears only when the level set
empties.

## Resume notes

- HEAD when this plan was written: `db9bde8` on `main`, working tree clean
  apart from this spec/plan pair.
- Start with Task 1; do not skip the failing-test step.
- If a `runtime` message shape differs from `sdk.d.ts`, fix the mapper's
  expectation first (the SDK file is the authority) and keep unknown shapes on
  the generic `run.status` path so nothing is silently lost.
- The research workflow's transcript (if still present) is under
  `~/.claude/projects/-mnt-Data-Ponta-cc-web/…/subagents/workflows/`; the spec
  already records every load-bearing citation, so the code is the source of
  truth.
