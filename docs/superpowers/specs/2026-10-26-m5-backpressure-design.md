# Backpressure and Spool Limits — Design (M5)

> Brainstorm output for the roadmap's M5 (§12.6). The owner opted out of the
> question round ("tự đi đi", standing roadmap authorization of 2026-10-26);
> every ruling below is the implementer's call, marked as such, and the whole
> document is what the owner reviews.
>
> Unlike M4, this milestone is **numbers first**: three measurements were taken
> before any ruling was written, and every threshold below is derived from one
> of them. The measurements are recorded in full in Appendix A.

## Intent and why

§12.6 asks for six things and the implementation currently delivers one of
them, partially. The outbox is durable and the pump batches 64 events per
frame — but nothing measures those 64 events in bytes, the outbox read parses
the whole unacked backlog before discarding 99% of it, no spool threshold
exists anywhere, and both socket writes ignore what Bun tells them about the
connection. The failure §12.6 explicitly forbids is reachable today: Bun drops
a message that arrives while a connection is over `backpressureLimit` and
reports it as `send() === 0`, and neither writer looks. The server would
believe a frame was delivered because no exception was thrown, while the
browser never receives it.

This milestone makes the transport bounded, and makes the one unbounded thing
that already exists — the offline spool — say so out loud.

## Goals

- A frame is bounded **in bytes**, not only in event count, so no single
  `send()` can exceed a size derived from Bun's own limits.
- The pump stops parsing events it is not about to send.
- A socket write that Bun reports as over-limit (`0`) is treated as a failed
  send, never as a delivered frame.
- A slow browser is disconnected and left to replay, rather than being fed
  from an unbounded buffer.
- The runner's offline spool has explicit warning and critical thresholds, and
  the critical path is the one §12.6 demands: stop the run and leave a durable
  failure record — never drop and then report success.
- Payloads that already have a cap keep it; the caps are asserted rather than
  assumed.

## Non-goals (M5 and stated for later)

- No new event types, no protocol shape change. M5 is transport and thresholds.
- No local disk quota enforcement. §12.6 asks for "local disk quotas"; what
  M5 ships is the *signal* at the thresholds that precede a quota problem
  (Ruling 6), which is the part that protects a run. Enforcing a quota means
  refusing appends, which needs its own design for what the operator sees and
  what happens to the run; ledgered as the next slice.
- No change to replay, retention, or `resync_required` (§12.5 works and is
  tested).
- No per-event-type byte budget for `tool.started` inputs beyond the existing
  cap (Ruling 4).
- No runner-side socket backpressure: the runner→server link is a single
  frame at a time, gated on the ACK.

## Anti-goals — what would make this a failure

- **Dropping events to stay under a limit.** §12.6's last bullet is the one
  line of this section that is a prohibition, not a preference. Any design
  where an event can disappear while the run reports success is wrong,
  regardless of how much memory it saves.
- A threshold constant with no measurement behind it. If a number is in the
  code, Appendix A must show where it came from.
- Growing an in-memory buffer as the remedy for a connection that cannot keep
  up. The remedy is disconnect-and-replay; the durability is already in
  SQLite.
- Killing a run because a browser tab is slow. The spool critical path is
  about the *runner's own disk*, not about the transport.
- A timer that keeps a frame half-full waiting while the transcript stalls.
  Batching by time must not become a latency floor.

## Rulings (all the implementer's calls)

### 1. Frame bounds are (count, bytes, time) — all three, in that order of precedence

`EventPump` gains two constants beside the existing `BATCH_LIMIT`:

- `BATCH_BYTES_LIMIT = 256 * 1024` — the byte ceiling for one frame.
- no timer for a *small* batch; instead `BATCH_LINGER_MS = 50` is the **retry
  delay after a refused send**, not a batching delay (Ruling 2).

Why 256 KiB and not 512 KiB or 1 MiB: Appendix A measures a worst-case
64-event frame at **557,981 bytes** (64 events each carrying an 8 KiB `Write`
tool input). Bun's `backpressureLimit` defaults to 16 MiB and its
`maxPayloadLength` (receive side) to 16 MiB. A 256 KiB ceiling gives a 64×
margin against `backpressureLimit` — one stuck connection can hold at most 64
frames' worth before Bun starts refusing, instead of 30 — while staying far
above the realistic 46–53 KiB frame, so ordinary traffic still fills frames by
count and pays no extra frames. 256 KiB is also the largest power of two that
keeps a frame inside a single TCP-friendly burst on a slow link.

The byte accounting is over the **serialized frame** (`JSON.stringify` of the
batch), because that is what Bun buffers and what `backpressureLimit` is
compared against. Counting payload bytes alone would under-count the measured
359 B/event of envelope overhead by ~30% on a delta-heavy stream.

The count limit stays first: the pump stops at whichever of count-or-bytes
arrives first, so a frame is always ≤ `BATCH_LIMIT` events **and** ≤
`BATCH_BYTES_LIMIT` bytes, with the exception in Ruling 4.

### 2. A refused send is retried on a timer; a successful send is not delayed

`flush()` today is only called from the daemon's send path and from
`handleAck`. If a send is refused (link down, or — after Ruling 3 — a socket
reporting backpressure), the rows stay pending, and the *only* thing that
would ever retry them is the next event arriving or the next reconnect. A run
that goes quiet (the SDK thinking, a long tool call) can leave a pending row
unsent indefinitely.

Ruling: when a send is refused, the pump arms a `setTimeout(…, LINGER_MS)`
that re-runs `flush()`; the timer is not re-armed if one is already pending,
and is cleared on a successful flush. Success **never** waits on a timer — the
first `flush()` after an event is immediate. This is the "time threshold" of
§12.6's first bullet, and it is deliberately a *retry* threshold rather than a
*batching* threshold because a batching delay would add latency to every
event in exchange for slightly larger frames, and the byte measurement shows
frames are already in the 46–53 KiB range without waiting.

`LINGER_MS = 50`: below human perception for a transcript that just went
quiet, far above the pump's own work (a full 64-event frame is 1.9 MiB of
parsing at the worst measured backlog, and the `LIMIT 64` read is 0.4 ms).

### 3. `send() === 0` is a failed send, `-1` is a successful one

Bun's `ServerWebSocket.send()` returns a `number` (Appendix A, "Bun semantics"):

| Return | Meaning | Our treatment |
| --- | --- | --- |
| `-1` | Enqueued, but the connection is under backpressure | **Success.** The bytes are buffered and will be written. |
| `0` | Dropped: connection closed, or already over `backpressureLimit` | **Failure.** The frame was not delivered and will not be. |
| `1+` | Bytes sent | **Success.** |

The browser gateway's `#send` (the only place a frame reaches a browser
socket) reads the return and treats `0` as "this socket cannot take it":

- the socket is dropped from the subscriber set and closed with a dedicated
  close code, so the client's own reconnect + replay (§12.5) is what recovers
  it — the durability is in the journal, not in the socket buffer;
- the caller is told the frame was not delivered, so nothing downstream
  records it as sent.

This is the anti-goal made mechanical: there is no code path where a dropped
frame is indistinguishable from a delivered one.

Note that a *close* is already what an over-limit connection is heading for —
Bun reaches `backpressureLimit` because the peer is not reading. Disconnecting
makes that explicit and bounded instead of letting the buffer grow to 16 MiB
first.

### 4. One oversized event still goes alone; the frame ceiling is not a reason to drop

The byte ceiling cannot be absolute: a single `message.completed` carrying a
Write tool result was measured at 8,240 bytes, and tool inputs are capped
elsewhere at 2,000 characters. If an event's own serialized size exceeds
`BATCH_BYTES_LIMIT`, the pump sends that event **alone** in a one-event frame
rather than refusing it. The frame is then over the byte ceiling by exactly
that one event, which is bounded by the existing per-event caps, not by the
backlog.

The alternative — refuse to send it — is the anti-goal. The alternative —
split it across frames — would corrupt an event's atomicity, which the server
dedupes on.

### 5. `pendingEvents` takes a LIMIT, and the pump passes its own ceiling

Appendix A measures the current read at 84.5 ms and **38.2 MiB** of parsed
payload for a 100k-event backlog — to build a 64-event frame. Two changes:

- `pendingEvents(db, attemptId, { limit })` applies the limit in SQL
  (`LIMIT ?`), so the rows are never materialized. Default `64` keeps any
  other caller bounded.
- `EventPump.#flushAttempt` passes its own ceiling and stops calling
  `.slice()`, because the query now returns at most what it will send.

The measured effect: 0.4 ms and ~19 KiB, flat, at every depth from 5k to 100k.
The read is no longer a function of the backlog.

A LIMIT larger than the frame will send is deliberately avoided: the pump must
not parse an event it is going to throw away, and the per-event `JSON.parse`
is the dominant cost at depth (Appendix A).

### 6. Spool thresholds are (warning, critical) on both count and bytes; critical stops the run

The runner's outbox is the one genuinely unbounded structure. §12.6 wants a
warning threshold, a critical threshold, and an explicit critical policy.

Rulings, with the measurement behind each:

| Threshold | Value | Derived from |
| --- | --- | --- |
| warning | 5,000 unacked events **or** 16 MiB of unacked payload | Appendix A: 5,000 events is the first measured point where the un-limited read crosses 1.9 MiB; it is one frame's worth 78× over. |
| critical | 25,000 unacked events **or** 64 MiB of unacked payload | Appendix A: 25,000 sits between the 20k (9.6 MiB read) and 50k (25.3 MiB read) measurements — the point where a single flush's accidental full read would be a multi-tens-of-MiB allocation. |

Both are checked by the pump, which already walks `pendingEventAttempts` on
every flush, so the check costs one aggregate query per flush and no new
timer.

**Critical policy (§12.6's explicit requirement): stop the run, record a
minimal failure record, and report the run failed. Never drop mandatory events
and report success.**

The mechanism that satisfies this, and why the "reserved budget" framing from
an earlier draft was dropped: the pump owns no `local_sequence` for any
attempt — the attempt's sequence space is single-writer (the executor's private
closure at `executor.ts:170`), a fact the pump's own doc comment states (the
pump holds no sequence and owns no run). Writing a `run.failed` row from the
pump would either collide with the executor's next write or forge a sequence
the executor's watermark then refuses to advance past. There is no second, in-
memory, preallocated writer available to the pump, so "emit on a reserved
budget" is not an operation the pump can perform.

What is in force is the existing single-writer path routed by the controller,
which *does* own both the sequence closure and the SDK signal:

1. The pump detects the crossing once (the `#critical` set dedupes, and a
   critical report suppresses any pending warning) and hands the report —
   counts only, no payload, §19.4 — to `onSpoolCritical`.
2. The daemon's `onSpoolCritical` calls `runs.cancel(attemptId, "spool_critical")`,
   which records the reason on the run controller and aborts the run's SDK
   signal. This is the existing deliberate-cancel lane (§14.2), not a new one.
3. The executor observes the abort (its own signal firing) and reads
   `abortReason` at that moment: a reason present means the stop was a policy
   decision, so `recordAborted()` writes `run.failed { error:
   "spool_critical", …counts… }` — the minimal failure record — through the
   attempt's closure, so it lands at the correct next sequence.
4. The backlog is **kept on disk**. It is not deleted, not truncated, not
   silently dropped. When the link recovers, the remaining events replay in
   order ahead of the failure record (they are unacked and precede it in
   `local_sequence`), so the transcript stays truthful: the operator sees what
   the run did, then why it stopped.
5. The run is reported **failed** — the terminal row `recordAborted` wrote is
   `run.failed`, and the `finally` below it calls `finishAttempt(..., state)`
   with `state = "failed"`. There is no path in this design where crossing the
   critical threshold ends in `run.finished`.


### 7. Warning is a signal, not a behaviour change

At warning the pump emits a `spool.warning` event (once per crossing, not per
flush — tracked in memory, reset when the depth falls back below) and keeps
sending normally. §12.6 says "tăng đến warning threshold rồi critical
threshold"; a threshold that already changed behaviour would just be a lower
critical.

The event is additive to the protocol's event-type union. If the owner prefers
no new type, the fallback is logging it runner-side only — ledgered as the
alternative, not the ruling, because an operator staring at a UI is exactly
who needs to see it.

### 8. `maxPayloadLength` is set explicitly on both servers

Neither `Bun.serve` sets `maxPayloadLength`, so both inherit Bun's 16 MiB
default for inbound messages. 16 MiB is far beyond any frame either endpoint
legitimately sends (the largest measured is 558 KiB), and an inbound limit is
free to tighten: a peer that sends a 16 MiB message is not a peer we have a
use for.

Ruling: `maxPayloadLength: 4 * 1024 * 1024` (4 MiB) on the control server's
and the runner's servers, ≈7× the largest measured legitimate frame. This is
hardening rather than a fix: it turns "a malformed 16 MiB hello occupies the
server until it is parsed" into a `1009` close at the transport.

`idleTimeout` and `sendPings` stay at their defaults: the reconnect loop and
heartbeat (§14.1) already own liveness, and a second, quieter liveness
mechanism at the transport layer would make failures harder to attribute.

### 9. The transport does not get a buffer, and this is not a regression

Bun's own `backpressureLimit` is the buffer; it is bounded at 16 MiB and now
bounded in practice by the 256 KiB frame ceiling. The browser gateway will not
add a queue in front of it. When a socket reports over-limit, Ruling 3
disconnects it and the client replays — which is what §12.6 asks for in
"slow browser có thể bị ngắt và replay; không giữ unlimited buffer", and it is
only safe because §12.5's replay is already built and tested.

### 10. What "mandatory events" means here

§12.6 says events must not be silently dropped, and the codebase has no
event-type split into mandatory and optional. Ruling: **all** events in the
outbox are mandatory, and the pump has no drop path at all. This is how the
current code behaves; M5's job is to keep it true while adding limits, and to
make the critical policy an explicit stop rather than an implicit overflow.

## What is left to the plan

Task order; the exact shape of the byte-accounting seam (whether the pump
serializes to measure or the frame builder reports its size); where the spool
depth query lives (`runner-db` aggregate vs. pump-side count); the fake-socket
seam for the `send() === 0` tests; and whether the browser disconnect uses an
existing close code or a new one. All mechanical, decided by the plan.

---

## Appendix A — Measurements (2026-10-26, Bun 1.4.3, this machine)

### Bun semantics (from `bun-types@1.4.4` docs and type declarations)

Quoted from `node_modules/.bun/bun-types@1.4.4/node_modules/bun-types/docs/runtime/http/websockets.mdx`:

> The `.send(message)` method of `ServerWebSocket` returns a `number` indicating
> the result of the operation.
>
> - `-1` — The message was enqueued but there is backpressure
> - `0` — The message was dropped because the connection is closed or already
>   has more than `backpressureLimit` bytes buffered
> - `1+` — The number of bytes sent

> | `maxPayloadLength`  | 16 MB | `0` to `2^32 - 1` | Only empty messages are accepted |
> | `backpressureLimit` | 16 MB | `0` to `2^32 - 1` | No limit                         |

> After `-1`, Bun calls the `drain` handler once the buffered data has been written.

The `drain?(ws)` handler exists on `WebSocketHandler` (`serve.d.ts:476`), but
the handler object in `apps/control-server/src/server.ts` does not declare it,
so **a `-1` today has no drain hook** — the only signal of recovery is the
next successful `send`. That is why Ruling 3 treats `-1` as success and
`0` as failure rather than building a drain-driven pump.

### Per-event payload bytes (envelope included)

| Event | Bytes |
| --- | --- |
| `message.delta` | 36–435 |
| `message.completed` (text) | 1,419 |
| `message.completed` (Write tool) | 8,240 |
| `tool.completed` (2,000-char cap) | 2,063 |
| `tool.started` | 47 |
| `message.started` | 25 |
| `run.started` | 25 |
| `run.finished` | 148 |
| **wire overhead per event** | **359** |

### Frame sizes at `BATCH_LIMIT = 64`

| Frame composition | Bytes |
| --- | --- |
| 64 small deltas | 46,749 |
| realistic mixed stream | 52,665 |
| 64 × 8 KiB tool inputs | **557,981** |

### Frame rates

| Event rate | Frames | Rate |
| --- | --- | --- |
| 1 ev/s | 1 frame / 64 s | 0.4 KiB/s |
| 40 ev/s | 1 frame / 1.6 s | 14.5 KiB/s |
| 200 ev/s | 1 frame / 0.32 s | 72.5 KiB/s |

### Outbox read cost vs. backlog depth (this is the Ruling 5 evidence)

5,000 events written to an in-memory `runner-db` outbox in 41 ms; each row a
231-byte payload.

| Depth | `LIMIT 64` read | `LIMIT` all (today) | Heap delta (all) |
| --- | --- | --- | --- |
| 5,000 | 0.3 ms | 4.2 ms | 1.70 MiB |
| 20,000 | 0.4 ms | 17.2 ms | 9.63 MiB |
| 50,000 | 0.4 ms | 43.8 ms | 25.31 MiB |
| 100,000 | 0.4 ms | **84.5 ms** | **34.27 MiB heap / 38.22 MiB parsed** |

The `LIMIT 64` column is flat because it is the query, not the backlog, that
is being paid for; the unbounded column is linear in the whole transcript.

### Not measured, and why

- **Real socket backpressure under a slow browser.** Inducing a genuinely
  slow TCP peer in-process is flaky in CI and would not change a ruling: the
  treatment is defined by the return value's *documented* meaning, which is
  what the tests will pin. Ledgered.
- **Disk throughput for the spool.** The thresholds are count/byte based, so
  disk speed changes when an operator hits them, not whether the signal is
  correct.
