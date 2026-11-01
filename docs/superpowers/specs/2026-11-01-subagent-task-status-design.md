# Subagent & background-task status in the web client

Status: research complete 2026-11-01. Proposal — not yet accepted for
implementation. Research was read-only; no production file was touched while
this document was produced.

## 1. Why this exists

A background workflow (three subagents) was still running when the main turn's
final message landed. The web client hid the Stop button and painted the
session as finished. The owner's read: "not really a bug, Claude Code CLI
behaves the same; research whether we can show subagent/task status if the data
exists."

The data exists end-to-end and is dropped at the last mile. This document
records where, and proposes the smallest honest fix.

## 2. What the SDK already emits

The installed `@anthropic-ai/claude-agent-sdk` declares five task-lifecycle
messages (`node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts`):

| Subtype (`type: "system"`) | Key fields | Declared at |
| --- | --- | --- |
| `task_started` | `task_id`, `run_id?`, `tool_use_id?`, `description`, `subagent_type?`, `is_backgrounded?`, `spawn_depth?`, `parent_task_id?`, `task_type?`, `workflow_name?`, `prompt?`, `skip_transcript?`, `ambient?` | `sdk.d.ts:6342-6385` |
| `task_progress` | `task_id`, `run_id?`, `tool_use_id?`, `description`, `subagent_type?`, `usage {total_tokens, tool_uses, duration_ms}`, `last_tool_name?`, `summary?` | `sdk.d.ts:6313-6340` |
| `task_updated` | `task_id`, `run_id?`, `patch {status?, description?, end_time?, total_paused_ms?, error?, is_backgrounded?}` | `sdk.d.ts:6387-6408` |
| `task_notification` | `task_id`, `run_id?`, `tool_use_id?`, `status (completed\|failed\|stopped)`, `reason?`, `output_file`, `summary`, `usage?`, `resource_links?`, `ambient?` | `sdk.d.ts:6277-6311` |
| `background_tasks_changed` | `tasks[]` entries with `task_id`, `run_id?`, `task_type?`, `subagent_type?`, `parent_task_id?`, `ambient?` | `sdk.d.ts:3788-3821` |

Two semantics matter:

- `background_tasks_changed` is a **level signal**, not an edge. The SDK
  documents that a consumer which only needs "is background work running"
  should **replace** its set with each payload rather than pair start/end
  edges, so a missed bookend cannot wedge a stale running indicator
  (`sdk.d.ts:3788`). The level is per CLI process and resets on restart; an
  `initialize` against an already-running process is answered with a snapshot.
- `ambient` / `skip_transcript` mark housekeeping tasks (watchers, observers).
  Hosts must exclude them from activity indicators (`sdk.d.ts:6305-6308`,
  `6375-6382`).

The SDK also exposes control methods: `stopTask(taskId)` emits a
`task_notification` with `status: "stopped"` (`sdk.d.ts:3291-3294`),
`backgroundTasks(toolUseId?)` (`sdk.d.ts:3296-3310`), and `interrupt()` kills
background tasks (`sdk.d.ts:1828-1839`).

`tool_use_id` is the correlation key between a task and the `Task`/`Agent`
tool step the web already renders. `agent_id` on subagent assistant messages
equals the task's `task_id` (`sdk.d.ts:3725-3735`), which is what a later
transcript phase would join on.

## 3. Where it is lost today

| Layer | Behaviour | Evidence |
| --- | --- | --- |
| Adapter | Forwards the raw SDK stream unchanged; no filter or transform | `packages/agent-adapter/src/index.ts:73-137` |
| Runner executor | Recognises only three frame classes (`system/init`, `stream_event`, pure `user` tool_result). **Every other frame, including all five task messages, is written as `run.status`** | `apps/runner/src/execution/executor.ts:559-605`, `646-660` |
| Protocol / DB | `payload: unknown`, stored as opaque JSON; validation checks the envelope and that the type is in `EVENT_TYPES`, never per-type payload shape. Adding a type needs **no DB migration** | `packages/protocol/src/index.ts:86,89-149`; `packages/control-db/src/journal.ts:42`; `packages/control-db/src/db.ts:159-174`; `apps/control-server/src/websocket/runner/runner-gateway.ts:731-787` |
| Web | No handler for task semantics. Activity is derived only from run/message/tool/approval events | `apps/web/src/features/journal/chat-turns.ts:600-1041` |

Consequence: the journal already contains the task frames — inside `run.status`
payloads — but nothing types, joins or renders them. A quick prototype could
scrape `payload.subtype`, but that is a dead end; typed events are cheap
because the storage layer is type-agnostic.

## 4. The gap, precisely

The client answers **"is this run still running?"**. That question becomes
false at `run.finished`, while the SDK stream can remain open and background
tasks can keep running inside the same attempt.

Two places make this observable:

1. `SessionView.vue:122-151` derives `liveRunId` by walking the journal
   backwards to the newest `run.started` with no terminal event after it. At
   `run.finished` it returns `null`.
2. `Composer.vue:786-794` renders Stop only when `activeRunId !== null`, so the
   button disappears with the run.

The runner, meanwhile, is still inside the `for await` loop
(`executor.ts:559-605`): it sets `terminalWritten` on `result` but does **not**
break, and only calls `finishAttempt`/`releaseAttempt` in the `finally` block
when the stream closes (`executor.ts:625-641`). Background tasks can therefore
outlive the run *inside the same attempt*, holding the workspace lock.

## 5. Why the Stop button cannot simply come back

`run.cancel` is routed through `Scheduler.cancel`, which requires a row in
`active_runs` (`packages/control-db/src/scheduler.ts:302-330`). The control
server releases that slot the moment a terminal event commits
(`apps/control-server/src/server.ts:307-316`). After `run.finished`,
`run.cancel` returns 404 even though the runner's attempt is still alive.

So restoring Stop needs a different command and routing, not a UI toggle. That
is phased as P3 below, and it is deliberately **not** part of the first slice.

## 6. Design

### D1 — Typed journal events, not `run.status` scraping

Add five event types and map the SDK frames to them in a pure module. The
payload is normalised to camelCase at the runner boundary, matching the rest of
the protocol's vocabulary.

### D2 — Event catalogue

| Journal type | SDK source | Payload |
| --- | --- | --- |
| `task.started` | `system/task_started` | `taskId`, `description`, plus optional `runId`, `toolUseId`, `subagentType`, `isBackgrounded`, `spawnDepth`, `parentTaskId`, `taskType`, `workflowName`, `ambient`, `skipTranscript` |
| `task.progress` | `system/task_progress` | `taskId`, optional `runId`, `toolUseId`, `description`, `subagentType`, `usage`, `lastToolName`, `summary` |
| `task.updated` | `system/task_updated` | `taskId`, optional `runId`, `patch {status?, description?, endTime?, totalPausedMs?, error?, isBackgrounded?}` |
| `task.completed` | `system/task_notification` | `taskId`, `status ("completed"\|"failed"\|"stopped")`, optional `runId`, `toolUseId`, `reason`, `summary`, `outputFile`, `usage`, `ambient`, `skipTranscript` |
| `tasks.changed` | `system/background_tasks_changed` | `tasks: TaskRef[]` (level set) |

`TaskRef` is the subset needed to identify a live task: `taskId`, optional
`runId`, `taskType`, `subagentType`, `parentTaskId`, `ambient`.

No new DB table and no migration: `run_events` stores `type TEXT` + `payload
TEXT`, and the gateway validates only membership in `EVENT_TYPES`.

### D3 — The level signal is authoritative for "busy"

The web keeps two structures:

- `tasks: Map<taskId, BackgroundTask>` — built from the edges
  (`started`/`progress`/`updated`/`completed`), carrying description, last tool,
  usage and final status.
- `liveTaskIds: Set<taskId>` — **replaced** on every `tasks.changed`.

`isBackgroundBusy` = at least one id in `liveTaskIds` whose task is not
`ambient`. A missed `task.completed` edge can never leave a permanent spinner,
because the level set is what decides.

### D4 — Ambient tasks are hidden from activity

`ambient` and `skip_transcript` tasks are excluded from the activity indicator
and from the band, per the SDK's own guidance. They may still be kept in the
map for a future diagnostics panel.

### D5 — Payload hygiene

- `prompt` from `task_started` is **dropped**: it can be large and may quote
  user content; `description` is the UI-facing line.
- `output_file` is kept as a path string only; it is not read in P1/P2.
  Reading it is P4.
- Free text (`description`, `summary`, `patch.error`) goes through
  `redactErrorText` (`apps/runner/src/execution/redact.ts:79-83`); the generic
  `redactSdkMessage` walk only masks diagnostic keys at the message's own
  level, so it would miss `patch.error` and does not know these field names.
- Every payload still passes `boundEventPayload`
  (`apps/runner/src/execution/payload-bound.ts`), which caps oversized strings
  with a visible truncation marker.

### D6 — UI: a sticky band, plus a badge on the spawning tool step

Primary slot: a compact band at the top of the journal scroll content in
`EventJournal.vue`, using the existing `needsResync` pattern
(`EventJournal.vue:297-302`) and rendered above the turns:

- Collapsed: `● 2 task nền đang chạy` with the oldest task's elapsed time.
- Expanded: one row per task — status dot, `description` (falling back to
  `subagentType` / `workflowName` / `taskType`), `last_tool_name`, elapsed,
  and, after completion, `summary` + usage (`total_tokens`, `tool_uses`).
- Visible while `isBackgroundBusy`; completed rows collapse into an
  "Đã xong" section for the remainder of the session view.

Secondary slot (same slice if cheap, otherwise P2b): the `Task`/`Agent` tool
step already rendered by `AgentToolStep.vue` gets a status dot + elapsed +
final summary, joining `task.toolUseId` to the tool step's `tool_use_id`. This
is the natural place to answer "what did that subagent do?".

Copy follows the existing Vietnamese UI strings; identifiers and code remain
English.

### D7 — Stop semantics

- P2 does **not** resurrect Stop. The run is over; `run.cancel` cannot reach
  the still-open attempt (section 5). The band is the honest indicator, and it
  also explains a later `workspace_busy` rejection.
- P3 adds a per-task stop action backed by a new `task.stop` command routed to
  the runner that holds the session pin (not `active_runs`), calling the SDK's
  `stopTask(taskId)`. The resulting `task_notification (stopped)` updates the
  row.
- P2 must not fake a "session running" state: the pulsing session dot keeps
  meaning "a run is live". Background work is a separate concept with its own
  indicator.

## 7. Non-goals for P1 + P2

- No change to run lifecycle, attempt finalisation or slot release.
- No new DB table, migration or projection hook.
- No background-task transcript (P4) and no `forwardSubagentText` option.
- No task cancellation (P3).
- No task state persisted outside the journal: reloading a session replays the
  same events and rebuilds the same view.

## 8. Phases

| Phase | Scope | Rough size | Risk |
| --- | --- | --- | --- |
| P1 | Protocol types + parsers; runner mapper; executor wiring; tests | Small (one focused session) | Low — additive events, no migration |
| P2 | Web task state module; band in EventJournal; tool-step badge | Medium | Medium — UI plumbing through `AgentChatTurn` → `AgentProcessAccordion` → `AgentToolStep` |
| P3 | `task.stop` command end-to-end | Medium/large | Medium — new command kind and a routing path that survives slot release |
| P4 | `forwardSubagentText` + nested subagent transcript | Large | High — payload size, privacy, UI complexity |

## 9. Risks and deployment order

- **Upgrade order:** the control server refuses an event whose type is not in
  `EVENT_TYPES` (`runner-gateway.ts:731-787`). Deploy **server first**, then the
  runner. The reverse order makes a runner's whole event frame rejected.
- **Old web clients:** verify that an unknown event type falls through the
  chat-turn reducer rather than throwing; if it does not, deploy web before the
  runner emits. (Check `apps/web/src/features/journal/chat-turns.ts` default
  path before rollout.)
- **Level signal lifetime:** it is per CLI process. cc-web starts a process per
  attempt, so the runner must reset any local task state at attempt start; the
  web rebuilds from journal events on replay.
- **Out-of-order frames:** the SDK says level/bookend ordering is unspecified
  for the same transition. The set-replace rule (D3) is the only safe consumer
  rule.
- **Late frames:** `run_id` values sort in the order runs opened; a frame
  naming an older run is late. P1 does not need ordering logic; P2 should
  ignore a task update older than the one held.
- **Payload growth:** five new event kinds multiply journal rows for workflow
  runs. `task.progress` is the noisy one (every change); consider emitting it
  at most once per SDK frame as-is and rely on `boundEventPayload` for size.
  If replay cost becomes a problem, a later slice can coalesce progress.
- **Housekeeping noise:** without D4 the band fills with watchers; the SDK
  explicitly marks them `ambient`.

## 10. Open questions

1. Should completed tasks linger in the band until the next run, or fade after
   N seconds? (No timers in the pure module; the component owns presentation.)
2. Should the band also show **foreground** subagents while the run is live?
   The SDK sends `task_started` with `is_backgrounded: false` for those, so the
   data supports it; the UI copy differs ("đang chạy" vs "task nền").
3. For P3, should `run.cancel` be taught to wait for the attempt instead of
   returning 404 after `run.finished`? A `task.stop` lane is cleaner, but the
   session slot has already been freed — confirm the dispatcher can address the
   runner by session pin.
4. Is `agentProgressSummaries` enabled by any profile? `task_progress.summary`
   is model-generated only when it is on (`sdk.d.ts:6333-6336`).

## 11. References

- SDK: `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts:1828-1839`,
  `2914`, `3291-3310`, `3725-3735`, `3788-3821`, `6277-6408`.
- Adapter: `packages/agent-adapter/src/index.ts:73-137`.
- Executor: `apps/runner/src/execution/executor.ts:559-605`, `625-641`,
  `646-660`; `redact.ts:79-83`; `payload-bound.ts`.
- Protocol: `packages/protocol/src/index.ts:86`, `89-149`;
  `packages/control-db/src/journal.ts:42`; `db.ts:159-174`.
- Server: `apps/control-server/src/server.ts:307-316`;
  `websocket/runner/runner-gateway.ts:731-787`;
  `packages/control-db/src/scheduler.ts:302-330`.
- Web: `apps/web/src/views/SessionView.vue:122-176`;
  `components/Composer.vue:786-794`;
  `components/EventJournal.vue:297-302`;
  `components/chat/AgentToolStep.vue`;
  `features/journal/chat-turns.ts:600-1041`.
- ADR-0016 (per-turn CLI process, and why schedules moved server-side):
  `docs/adr/0016-scheduled-tasks-owned-by-control-server.md`.
