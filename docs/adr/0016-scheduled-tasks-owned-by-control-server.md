# ADR-0016 — Scheduled tasks owned by the Control Server

- Status: accepted
- Date: 2026-10-31
- Refines: ARCHITECTURE.md §11.5

## Context

`CronCreate` registers an in-memory timer inside the Claude Code CLI process,
and the CLI itself reports the task as session-only ("dies when Claude exits").
cc-web runs every turn as its own CLI process: when the last turn returns
`result`, the runner ends the attempt and the process exits. The timer dies
with it, so a schedule made through the web never fires — the observed bug:
`CronCreate` answered success, the due time passed, and no result turn ever
appeared in the chat.

A probe confirmed the mechanism. With a plain string prompt the SDK iterator
ends ~300 ms after `result` and the CLI exits, and the cron never fires. With
an `AsyncIterable` prompt (stdin held open) the CLI stays alive, the cron
fires at its scheduled time, and a second turn with its own `result` follows.

Keeping the process alive until the schedule is due is not an option either. A
runner advertises `maxConcurrentRuns = 1` and holds the workspace lock for the
whole attempt (§11.3, §11.4): parking a process until a cron slot would occupy
the only slot — for hours, or forever for a recurring task — and block every
other session in the same workspace with `workspace_busy`. A runner restart
would lose the timers anyway.

## Decision

The Control Server owns scheduled tasks. The runner mirrors `schedule.created`
and `schedule.cancelled` events from the CLI's structured tool result; the
server projects them into the durable `scheduled_tasks` table (SQLite) and,
every 15 seconds, dispatches each due row as an ordinary `run.start` through
`Scheduler.dispatch` — same capacity, same session pin, same workspace lock as
a user-started run. One-shot rows finish after the fire; recurring rows advance
to the next slot after the one they fired, with no catch-up of missed slots.

Two guards keep one slot from firing twice. The server yields to the origin
attempt's own in-process timer while that attempt is still active, so a
session that is mid-turn at the due time is not doubled. And the `runId` is
deterministic per (schedule, fireAt) with `runKnown` deduplication across
`active_runs`, `command_outbox` and `run_events`, so a server crash between
dispatch and advance cannot fire the same slot again on the next boot.

## Consequences

Schedules survive a server restart, fire at their time without keeping any
process alive, and cost no runner capacity or workspace lock while waiting.
The fire path is an ordinary run: capacity, locks, recovery and the event
journal are unchanged.

`CronList` and `CronDelete` in a new CLI process cannot see server-side
schedules — they only know the timers of the process that created them, and a
`CronDelete` outside that process is a no-op. The web compensates with an
owner-scoped list/cancel tab; the model may still create duplicates unless the
active schedules are injected into the run context, which is future work.

`schedule.created` / `schedule.cancelled` are additive protocol event types,
but the server refuses a frame carrying an unknown type, so server and runner
must be upgraded together.

A runner can still refuse a dispatched `run.start` (a busy workspace, a
revoked runner). A rejected command is not a fire: `runKnown` ignores
`rejected` outbox rows, the dispatcher's rejection callback frees the slot,
and the server reopens the one-shot row — only when the run id is exactly the
row's current slot and the journal never saw the run start — so the next tick
dispatches it again. A recurring row's refused slot stays missed, consistent
with the no-catch-up rule.

The design adds `cron-parser` as a dependency of `packages/control-db` for
next-fire computation.
