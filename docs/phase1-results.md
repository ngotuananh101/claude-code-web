# Phase 1 — protocol primitives and transport

- Date: 2026-10-23
- Scope: enrollment, credentials, identity, hello negotiation, connection
  generations, command inbox, event outbox with a contiguous ACK watermark,
  reconciliation, runner and browser WebSocket transport, owner authentication,
  the central command outbox, the scheduler, the runner reconnect loop, dispatch
  on the live transport, execution of an accepted command on the runner, run
  cancel with a bounded shutdown drain, event ingestion from the runner's
  outbox into the server's journal, and browser replay of that journal.
- Status: **all four Phase 1 surfaces exist and are tested, the entrypoints are
  wired to real implementations, and a command dispatched by the scheduler now
  reaches a runner over a live socket, is receipted back, runs the SDK under a
  workspace lock with redacted, ordered events; those events arrive in the
  server's journal exactly once per event id however often they are resent, and
  a subscribed browser sees the same session — full replay from an offset, a
  live tail, no gaps or duplicates across the boundary.**

## What exists

| Module | Guarantee | Test kind |
| --- | --- | --- |
| `control-db/enrollment` | Token shown once, only a hash stored, single consumption | unit + 8-process + 8-container race |
| `control-db/runner-credentials` | Rotation kills the previous secret in the same transaction; revoke is owner-scoped | unit |
| `runner/identity-store` | Credential written `0600` via temp-file rename; partial identity rejected | unit |
| `protocol/handshake` | Shape → secrets → version, in that order; negotiated state is `connected`, never `ready` | unit |
| `protocol/connection-registry` | Superseded or forged generations rejected; a stale socket's close does not evict the live one | unit |
| `runner-db/inbox` | Command ID accepted once; same ID + different payload rejected and audited | unit |
| `protocol/reconcile` | The §14.4 conflict matrix; no action ever creates an attempt | unit |
| `protocol/run-registry` | Desired ≠ observed; terminal is idempotent; non-current attempts ignored | unit |
| `control-server/runner-gateway` | Authenticate → fence by generation → `connected` → reconcile → `ready` | unit |
| `control-server/route` | `/ws/runner` upgrade; unauthorized clients get HTTP 401, not a socket | integration (real socket) |
| `control-server/tokens` | HS256 pinned; `alg:none` refused; secret under 32 bytes refused at construction | unit |
| `control-server/auth-service` | Per-user `tokenVersion` revocation, read on every call | unit |
| `control-server/browser-gateway` | Origin allowlist first, then cookie; the WS upgrade route refuses a missing Origin itself, while shared `authorize` tolerates it for same-origin GET reads | unit |
| `control-server/server` | `/healthz`, `/auth/login`, both WS routes on one instance | unit + integration |
| `control-db/command-outbox` | Immutable fingerprint; identical re-enqueue is a no-op; terminal states are sticky | unit |
| `control-db/scheduler` | Offline → not-ready → capacity → duplicate → session-busy, in that order | unit |
| `runner/reconnect-loop` | hello → reconcile → ready; capped exponential backoff; 4000/4001 do not retry | unit |
| `runner/websocket-link` | Credential in the `Authorization` header, never the URL | unit |
| `control-server/password` | argon2id hashing; a malformed stored hash is a refusal, not a throw | unit |
| `control-server/enrollment-routes` | Owner-minted token, single use, `no-store`, one 401 for unknown/consumed/expired | unit |
| `control-server/config` | The real composition: login, credential verification, revocation | unit |
| `runner/enroll` | Token in the body, never argv or the URL; nothing saved unless accepted | unit |
| `control-server/dispatcher` | Drain to a `ready` socket only; `sent` ≠ delivered; envelope rebuilt from the row | unit |
| `control-server/dispatcher` (socket) | Queued command delivered on reconnect, receipted, never run twice | integration (real socket) |
| `runner/envelope` | One untrusted-frame parser; optionals of the wrong type are dropped, not stored | unit |
| `runner-db/attempts` | Lock + attempt row in one transaction; terminal written once; boot recovery | unit |
| `runner/executor` | `run.started` → SDK stream → terminal event once; lock released on every path | unit |
| `runner/run-controller` | Inbox dedupe → authorization → workspace lock → tracked execution | unit |
| `runner/redact` | Cost and credential fields stripped from every replayed event | unit |
| `agent-adapter` | SDK option mapping; `resume` by id, never `continue`; lazy import | unit |
| `runner/daemon` | Identity → loop → controller; `stop()` waits for in-flight runs | unit + integration |
| `control-db/journal` | Ingest answers stored/duplicate/conflict; session sequence allocated in-transaction; conflicts audited without payloads | unit |
| `control-server/runner-gateway` (events) | Events only from a `ready` connection; identity and type validated against the protocol before ingest | unit |
| `runner/event-pump` | Persist → send → ACK; bounded batches; an ACK self-drives the next batch | unit |
| runner → server journal | A run's events reach `run_events` in order; a lost ACK replayed after a restart is deduplicated and re-acknowledged | integration (real processes) |
| `control-db/replay` | Session read model in `session_sequence`: bounded ordered reads, watermark, earliest (retention gap), owner derivation | unit |
| `control-server/browser-gateway` (replay) | Ownership-checked subscribe (no-oracle refusal), bounded chained replay, registration-before-read so no live event falls between replay and tail, `resync_required` on gaps | unit + integration (real socket) |
| journal → browser | Replay-from-offset then live tail with no gap or duplicate across the boundary; retention gap answers `resync_required` and resubscribe-from-named-sequence recovers | integration (real processes) |
| `control-server/sessions-list` | `GET /api/sessions` answers the owner's sessions; missing-Origin same-origin reads allowed, foreign origins 403; `no-store` | unit |
| `web/session-stream` | Pure §12.5 client machine: own watermark dedup, gap → resubscribe from watermark, `resync_required` rewinds to earliest | unit |
| `web/sessions-store` | Frame delivery hands the journal a fresh events array (Vue's props compare is shallow — a reused reference never re-renders); live flag = listing OR frame | unit |
| `control-server/login-cookie` | `Secure` only when the request is https — a plain-http origin drops Secure cookies, turning login into a silent no-op | unit |

399 unit tests across 38 files, 10 integration probes.

## Integration evidence

### Enrollment race (§6.1)

```sh
bun run test:integration
bun run scripts/integration/enrollment-race.ts --docker
```

Eight consumers race one token; exactly one wins.

| Mode | Result |
| --- | --- |
| 8 OS processes, shared SQLite file | 1 winner, 7 `consumed` |
| 8 containers, shared volume, `--network none` | 1 winner, 7 `consumed` |

The container run is the meaningful one: separate filesystems, separate PID
namespaces, and only WAL locking between them.

### ACK gap across a crash (§12.2, §22.3)

```sh
bun run scripts/integration/ack-gap-crash.ts
bun run scripts/integration/ack-gap-crash.ts --docker
```

The writer appends 1, 2, 4 then honours an ACK for "up to 4". Both modes show:

```
watermark before crash: 2
after reopen:          {"acked":2,"pending":[4]}
```

The watermark stopped at the gap, and the unacknowledged event survived the
process death.

### Reconnect fencing (§6.3, §14.3, §22.3)

```sh
bun run scripts/integration/reconnect-fence.ts
bun run scripts/integration/reconnect-fence.ts --docker
```

A control server holds one run assigned to `runner-a`. Runner #1 connects,
negotiates and reconciles it as alive, then is SIGKILLed. Runner #2 connects
from a fresh process (or container) with an empty inventory:

```
PASS  first connection reconciles and promotes to ready: generation 1
PASS  reconnect after an unclean exit still promotes to ready: generation 2
PASS  the vanished run is interrupted, not silently completed or failed
PASS  both connections were promoted to ready
PASS  the reconnect holds a strictly higher generation than the dead connection
```

Both modes pass 5/5: separate OS processes on the host, and separate containers
with `--network host` so the reconnect crosses a real process boundary.

The result that matters is the third: with no process and no terminal outcome,
the run becomes `interrupted`. It is never reported as `completed` or `failed`,
and no new attempt is created.

**What this probe does not prove.** A SIGKILL denies the process cleanup, but the
kernel still closes its socket, so this is *not* a half-open connection. True
half-open needs a network partition, which `--network host` cannot produce. The
fencing of a socket that is still open is covered instead by `route.test.ts`,
which keeps the superseded socket alive and sends on it, asserting it receives
`stale_generation` and close code 4000.

### The real daemon against the real server (§6.2, §22.2)

```sh
bun run scripts/integration/daemon-e2e.ts
bun run scripts/integration/daemon-e2e.ts --docker
```

The reconnect-fence probe above drives a hand-written client. This one runs the
actual `startDaemon()` entrypoint, reading a real `identity.json` at mode `0600`,
against a real control server:

```
PASS  the runner daemon reaches ready over a real socket: promotions=1
PASS  the ready state is recorded on the server: state=ready
PASS  the server sees the connection go away: state=offline
PASS  the restarted runner reaches ready again: promotions=2
PASS  the reconnect holds a higher generation: first=1 second=2
PASS  a runner with a bad credential never promotes: promotions=2 (unchanged)
PASS  a refused credential is never reported as ready: no ready event
```

7/7 in both modes, with no containers left behind. Docker mode runs one container
per runner process, so a restart is a fresh container — the same shape as a real
deployment.

The last two checks are the interesting ones. A runner holding a credential the
server refuses still **starts**: it logs `disconnected` and retries with backoff.
Startup is not hostage to the control server. What it must never do is claim to
be `ready`, and it does not.

### Dispatch over a live socket (§9.2, §9.3)

```sh
bun run scripts/integration/dispatch-e2e.ts
bun run scripts/integration/dispatch-e2e.ts --docker
```

Every other dispatch test runs both halves in one process. This one crosses a
real process boundary with a real on-disk SQLite database on each side — the
server's outbox on one, the runner's inbox on the other — and drives the real
`Scheduler`, the real `Dispatcher` and the real `startDaemon()`:

```
PASS  the runner reaches ready before anything is dispatched: state=ready
PASS  the scheduler accepts the dispatch against a ready runner: commandId=cmd_…
PASS  the command reaches the runner and starts a run: calls=1
PASS  the run uses the dispatched prompt and the registered workspace: {"prompt":"hello from the harness","cwd":"…/project"}
PASS  the server records the receipt, so delivery is proven and not assumed: deliveryState=accepted
PASS  the run reaches a terminal state on the runner: state=finished
PASS  the run's events are persisted in order: run.started,session.updated,message.completed,run.finished
PASS  the persisted events carry no cost or credential fields: clean
PASS  the SDK session id is captured for a later resume: sdkSessionId=sdk-session-1
PASS  the workspace lock is released: free
PASS  a redelivered command id is answered from the inbox, not executed twice: calls=1 (unchanged)
PASS  the duplicate's receipt retires the command again: deliveryState=accepted
PASS  the server sees the runner go away: state=offline
PASS  the restarted runner is promoted again: promotions=2
PASS  the restarted runner does not execute the command a second time: calls=0
```

15/15. The model is faked at the adapter seam — a real one would be slow,
non-deterministic and need a provider credential — but everything around it is
the production path: the real daemon, inbox, workspace lock, executor and SQLite
files. The harness reads the runner's database back through a second connection,
so "the command was delivered" cannot satisfy the execution checks on its own.

Four of these are the point:

- **Delivery is proven, not assumed.** The check reads the outbox's
  `delivery_state` after the fact. A socket write would have left it `sent`; only
  the runner's receipt moves it to `accepted`.
- **Delivery is not execution.** The terminal-state, event-order, redaction,
  session-id and lock checks are all read from the runner's disk after the run
  finished. An `accepted` receipt with no events fails five of them.
- **A redelivery does not execute twice.** The harness forces the command back to
  `pending`, which is exactly what a lost ACK looks like, and the runner answers
  from the inbox.
- **The inbox is on disk.** The restarted process — a new OS process, and in
  Docker a new container — recognises the command it already handled.


## Bugs found while building this

1. **`ackUpTo` could report a lower watermark than reality.** A late or duplicate
   ACK carrying a small number returned that number even though the database still
   held the higher watermark. A caller using the return value would re-send events
   it had already retired. Fixed by returning `max(alreadyAcked, contiguous)`.

2. **A container's PID 1 cannot be killed from inside its own PID namespace.**
   `process.kill(process.pid, "SIGKILL")` succeeds on the host but is ignored in a
   container, so the crash test silently ran to completion instead of crashing.
   The harness now kills the container from outside, which is also a truer model
   of a host dying.

3. **Buffering a container's stdout deadlocks a process that waits to be killed.**
   `new Response(stream).text()` never returns if the process has not exited. The
   harness reads incrementally until a `READY` marker.

4. **A `ReadableStream` can only be locked once.** Reading a process's stdout
   twice — once for `READY`, once for the result — fails with `Invalid state:
   ReadableStream is locked`, far from the real cause. The harness now takes one
   reader for the process lifetime.

5. **Reconciliation was initially fed from the runner's own message.** The
   original gateway echoed `actions` back to the runner and reconciled against a
   `server` array it had sent. Both are wrong: §14.3 makes the actions the
   *server's* to apply, and letting a runner supply the server's inventory lets
   it talk the server out of its own state. Now the server contributes its
   registry, scoped by `runnerId`, and only the promotion is sent back.

6. **A fixed sleep made the container harness read state too early.** Sampling
   after 6s passed in process mode and failed in Docker, where a cold start is
   slower. The server now exposes `/state` and the harness polls for the
   consequence instead of guessing a delay.

7. **`Bun.$\`...\`.text()` deadlocks on a process that is meant to stay alive.**
   The Docker runner deliberately holds its socket open, so awaiting its output
   never returned and the harness timed out at 120s. Both branches now `spawn`
   and read incrementally.

8. **A promotion that ends immediately is invisible to a later state check.**
   The second container reconciles and exits, so `stateOf()` reads `offline`
   before the harness can sample `ready`. The gateway now counts promotions as
   they happen, and the harness asserts on the count rather than on a live
   reading.

9. **A superseded runner socket was never closed.** The server only fenced on
   the next message, so a stale runner that never spoke again stayed connected
   and believed it was ready, while the server had already given its identity to
   a newer connection. `attach()` now closes the previous socket immediately with
   code 4000. Found by the end-to-end test, not by inspection.

10. **`ReconnectLoop.start()` awaited the entire retry chain.** A runner whose
    first dial failed — a refused credential, a server that is not up yet — never
    returned from `start()`, so the daemon never reached the line that reports it
    started, and could never explain why it was not connected. Startup now awaits
    only the first attempt; the retries belong to the loop and are observed
    through `settle()`. Found by the daemon probe, which is why that probe exists.

11. **`pkill` and `pgrep` do not exist in the runner image.** The Docker branch
    of the daemon probe used `docker exec … pkill`, which failed silently and left
    a runner alive across a supposed kill. Each runner is now its own container,
    killed with `docker kill -s KILL`.

12. **An expired command was filtered out of the drain but never retired.** It
    stayed `pending` for the life of the database: never sent, never resolved, and
    invisible in any outbox-age metric except as work that never moved. `drain()`
    now retires what can no longer be delivered before choosing what to send.

13. **Dispatch only delivered on reconnect.** The scheduler wrote the command
    durably and returned; nothing pushed it, so a run submitted to a healthy,
    ready runner sat in the outbox until that runner happened to reconnect. Found
    by the socket-level end-to-end test, which is the only test that exercises
    "the runner is already up when the command is created". Delivery is now part
    of `dispatch()`: decide, persist, deliver.

14. **The Docker dispatch probe tried to `mkdir` a container path on the host.**
    The runner's database path was written as the container sees it (`/data/…`)
    and reused for the host-side `mkdir`, which failed with EACCES. Host and
    container paths are now separate constants, named for which side they belong
    to.

15. **The workspace lock and the attempt row were written in two transactions.**
    A crash between them leaves a lock with no attempt, which nothing can
    reconcile: the workspace looks busy forever. Both writes are now one
    `db.transaction()`, and boot recovery additionally deletes locks whose attempt
    no longer exists.

16. **Boot recovery freed orphaned locks but not the lock of the attempt it
    interrupted.** The attempt was marked `interrupted` and its workspace stayed
    locked until the next boot. Found by the recovery test, which asserted the
    workspace was usable after recovery, not just that the row said
    `interrupted`.

17. **A fire-and-forget run let `stop()` close the database underneath it.**
    `void executeRun(...)` meant shutdown could close SQLite while the run was
    still appending events, losing them and leaving the lock held. In-flight runs
    are now tracked and `stop()` awaits `settle()`. Verified by mutating
    `await runs.settle()` back to `void runs.settle()` and watching the daemon
    test fail.

18. **The expiry test passed for the wrong reason.** It used a past expiry date,
    so the wall clock rejected the command whether or not the injected clock was
    consulted — the test would have passed with the clock parameter deleted.
    Mutation testing found this: dropping `now` from `acceptCommand` still passed.
    The test now uses future dates on both sides, so only the injected clock can
    make it fail.

19. **A test asserted on `undefined` for a row that was `null`.** `bun:sqlite`'s
    `.get()` returns `null`, so "the workspace lock is released" failed while the
    lock was in fact free. Fixed the assertion, not the production code — the
    first step when a new check disagrees with reality is to decide which one is
    wrong.

20. **A thrown SDK error reached the event outbox unredacted.** `sanitizeError`
    truncated the message and dropped the stack, but performed no redaction — so
    a CLI failure that echoed its environment (`ANTHROPIC_API_KEY=sk-ant-…`) put
    the provider key into a row that is replayed to the browser and copied into
    the server journal. §19.4 forbids exactly this. Error text now goes through
    `redactErrorText`, which masks credential assignments and key-shaped tokens
    while keeping the rest of the message readable. Found by the review pass, not
    by the tests: the existing test used a literal `"boom"` error and asserted
    `"ANTHROPIC"` was absent, which was true for a reason unrelated to
    redaction.

21. **The first redaction rule over-redacted ordinary prose.** Requiring only a
    whitespace separator turned "the secret key was rejected" into "the secret
    [REDACTED] was rejected" — unreadable, and no safer. The separator is now
    `=` or `:`, which is the shape an assignment actually takes. Over-redaction
    is not the safe direction: an operator who cannot read the failure cannot act
    on it.

22. **The SDK's `cwd` reached the outbox.** `SDKSystemMessage` carries the
    absolute workspace path, and the key walk did not name it, so every
    `session.updated` event told the browser how the runner's filesystem is
    arranged. The browser addresses a workspace by id; the path is host detail
    (§19.4). Added to the redaction surface.

23. **Each token became its own outbox row.** With
    `includePartialMessages: true`, the executor mapped every `stream_event` to
    `run.status`, so a single short run wrote 2000 rows and ~350KB — one journal
    row and one browser frame per few bytes of text. §12.3 makes the adapter
    responsible for accumulating deltas and finalizing; until that normalizer
    exists, transient frames are not persisted and the durable transcript is
    built from complete messages.

24. **The workspace-locked early return left the refusing attempt's own lock
    held.** It wrote the terminal state and returned; `releaseAttempt` was only in
    the `finally`. Reachable when execution is pointed at a path the attempt was
    not begun against — a re-registered workspace or a resolved symlink. Found by
    the review pass and confirmed with a probe before it was fixed.

25. **A crash between the terminal write and the lock release blocked the
    workspace forever.** Recovery only looked at `starting` rows, so a
    `finished`/`failed`/`interrupted` attempt still holding a lock was never
    cleaned up — the workspace stayed unusable with no process to blame.
    `recoverStaleAttempts` now also releases locks whose attempt is terminal.

26. **A late throw turned a finished run into a failed attempt.** If the stream
    yielded `run.finished` and then threw, the catch set `state = "failed"` while
    the outbox still held `run.finished`. Reconciliation reads the attempt row
    and the browser reads the events, so the two disagreed about the same run.
    The catch now only marks failure when no terminal event was written.

27. **`run.started` sat outside the guard.** It is the first write after the
    lock check and it can fail — a database error, or a sequence already taken by
    a second writer. A throw there escaped past the `finally`, leaving the
    attempt `starting` and the workspace locked. Everything after the lock check
    is now inside the guarded region.

28. **A failed append burned a sequence number, wedging the ACK watermark.**
    `append` incremented its counter before writing, so a payload that failed to
    serialize (or lost a race for the sequence) left a hole at that number. The
    watermark stops at the first hole by design (§12.2), so every later event for
    the attempt could never be acknowledged. The counter now advances only after
    the row commits. Confirmed with a probe that produced sequences 1 and 3 and
    an `ackedThrough` of 1.

29. **An error `result` frame left the attempt `finished`.** The stream ended
    normally after reporting `error_max_turns`, so nothing reached the catch —
    and `state` kept its initial `"finished"` while the outbox held `run.failed`.
    The attempt row and the transcript disagreed about the same run. The loop now
    takes the state from the terminal event it wrote, and a test drives a
    non-success result frame to lock it (reverting the assignment fails it).

30. **The lock-conflict event published the holder's attempt id.** The refusal
    payload carried `holderAttemptId`. The outbox is replayed to the browser and
    copied into the server journal, so that id is a stable handle on a run the
    viewer was never shown — and it buys the UI nothing, because
    `workspace_locked` is the whole fact. The payload is now the reason alone.

31. **The redaction surface was only tested for four of its ten keys.** The
    per-key test named `apiKeySource`, `apiKeyHelper`, `authorization` and
    `credential`, so removing `cwd`, `directory`, `total_cost_usd`, `cost_usd`,
    `modelUsage` or `apiKey` from the redactor would have broken nothing. The
    test now walks every key on the list, at the top level, nested, and in
    upper case — and two mutations (drop `directory`, make the walk
    non-recursive) each fail it.

32. **An error `result` frame carried a credential through the message loop.**
    The SDK reports a failure two ways: as a thrown error, and as a `result`
    frame whose `result`/`errors` fields quote the CLI's own text. Only the
    thrown path was masked, so the same secret reached the same outbox by a
    different door — confirmed with a probe whose payload came back with
    `ANTHROPIC_API_KEY=sk-ant-api03-…` intact. Diagnostic fields are now
    redacted as free text. The rule is limited to `result`, `errors`, `error`,
    `reason`, `details` and `stderr`, because masking every string rewrites the
    transcript: an assistant message showing `password = "hunter2"` in a config
    example is output the user asked for, not a leak. The masking also stops at
    the message's own level: a tool call's `input` is arbitrary JSON the model
    produced, and a real tool can have a field called `reason` or `details` —
    walking into it rewrote the transcript, which a probe showed. Both directions
    are pinned by tests: masking everything, masking nothing, and removing the
    depth limit each fail one.

33. **`subtype: "success"` was read as success.** The SDK documents that frame as
    carrying the final assistant text *or, with `is_error: true`, the error text
    when the turn ended on an API error* — an overloaded or refused request
    arrives with a successful subtype. `eventTypeOf` checked only the subtype, so
    an API failure was recorded as `run.finished` and the attempt row, the
    journal and the browser all inherited it. The check now consults `is_error`
    first; removing that line fails the test.

34. **A command buffered on the socket could start a run after `stop()`.** Closing
    a socket does not discard what the runtime had already queued, and
    `#handleMessage` never checked `#stopped`. The daemon stops the loop, awaits
    `settle()`, then closes the database — so a handler entered after that point
    started a run against a closed handle and lost its events and its lock
    release. `settle()` cannot catch it, because the work had not started when it
    returned. A probe showed one command handled and one receipt sent after
    `stop()`; the message handler now returns early once stopped.

35. **A failed terminal write left the workspace locked for the life of the
    process.** `finishAttempt` and `releaseAttempt` were two statements in one
    `finally`, so a throw from the first — a busy timeout, a full disk — skipped
    the second. The row stays `starting` and boot recovery reconciles that, but
    the lock has no such backstop: nothing else frees it, and it only runs at
    startup, so the workspace is unusable until restart. Both release paths (the
    main `finally` and the lock-refusal early return) now release in their own
    `finally`. Confirmed with a probe: a trigger that aborts the terminal UPDATE
    left `workspace lock: attempt-1` before, `(free)` after.


## Design decisions worth remembering

- **Generations are per runner and monotonic.** A message claiming a *future*
  generation is rejected as `unknown_generation`, not accepted as newer. Accepting
  it would let a clone take over an identity by guessing the next number.
- **The ACK watermark is derived, not stored.** It is computed from acknowledged
  rows, so a gap closing later lets it jump forward with no second counter to keep
  in sync — and no way for the two to disagree.
- **`close()` checks identity before evicting.** Without that guard, the old
  socket's close event tears down the connection that replaced it. This is the
  classic post-reconnect race.
- **Capacity clamps downward only.** A runner advertising more than server policy
  is capped; advertising less is honoured. Over-committing the server is the
  failure that matters.
- **`connected` is not `ready`.** Only a completed reconciliation promotes. A
  runner that has negotiated but not reconciled is not dispatchable.
- **Reconciliation never creates an attempt.** It resolves what already exists;
  the scheduler is the only thing that starts work.
- **The outbox fingerprint is computed, not supplied.** A caller cannot declare
  two different commands "the same" by reusing an id, and an identical re-enqueue
  is a no-op rather than a duplicate execution.
- **Terminal outbox states are sticky.** `accepted` and `rejected` are not
  overwritten by a late `sent`, which is what an out-of-order ACK would do.
- **Revocation is read, never cached.** `AuthService` reads `token_version` on
  every call. A cache would keep a revoked session alive for its TTL.
- **Origin is checked before the cookie, and a missing Origin is a refusal.** A
  non-browser client can set any Origin it likes, so the check is not a security
  boundary on its own; it exists to stop a hostile page from driving a session the
  browser would attach for it.
- **One 401 for both "no such user" and "wrong password."** Distinguishing them
  turns the login endpoint into a username oracle.
- **`sent` is not `accepted`, and the outbox only advances on a receipt.** A
  socket write can be lost after it returns, so the command stays deliverable
  under the same id. The runner's inbox is what makes the redelivery harmless.
- **Dispatch is part of `dispatch()`.** The scheduler decides, persists and
  delivers in one call. Splitting delivery into a second call the caller must
  remember is how a command sits in the outbox while every unit test passes.
- **A receipt is answered only after the inbox commits.** Sending it first would
  promise durability for a command a crash can still erase, and the server would
  stop redelivering work nobody has.
- **The dispatcher refuses anything but `ready`.** Not `connected`: a runner that
  has negotiated but not reconciled may hold state the server does not know
  about, and work sent there can land on state neither side can vouch for.

## Design decisions worth remembering (execution)

- **Recovery is a boot-time sweep, not an executor branch.** §9.7's "ambiguous
  launch → `interrupted`" cannot be implemented inside `executeRun`, because the
  inbox dedupe means a redelivered command is never handed to the executor again.
  The code path that would detect the stale attempt is unreachable by
  construction. It runs in the controller's constructor instead, before the first
  command can be accepted.
- **The lock and the attempt are one transaction.** Two writes mean a crash
  window where the workspace is locked by an attempt that does not exist, and no
  later process can tell whether that lock is live.
- **Terminal state is written once, guarded by the database.** `finishAttempt`
  updates `WHERE state = 'starting'`, so a second terminal write is a no-op
  regardless of what the executor believes. Idempotence is enforced where the
  state lives, not by the caller remembering.
- **A receipt returns before the run is awaited.** `accepted` means durable, not
  finished (§9.4). Awaiting the run inside the receipt would hold the socket's
  message loop for the length of a model conversation.
- **The SDK session id is captured from the `init` frame, never from the result.**
  §10.4 resumes by explicit id; the id is only knowable once the stream has
  started, and a run that fails before it does has nothing to resume.
- **`resume` is passed by id and `continue` is never set.** `continue: true` picks
  whichever conversation was most recent, which after a crash is a different
  conversation than the one the run belongs to.
- **The SDK is imported lazily, inside the adapter.** An eager top-level import
  makes every test that touches the runner load a bundled binary it never uses
  (§4.2 — the adapter is the only module allowed to import the SDK at all).
- **Events are redacted at the write, not at the read.** Events are replayed to
  the browser and the server journal, so everything downstream is public. Cost
  and credential fields are stripped recursively and case-insensitively before the
  row is inserted, which is the only point where "never published" is enforceable.
- **Redaction covers free text too, not just key names.** A thrown SDK error is a
  string, so the key walk cannot reach it — and that string is persisted in
  `run.failed`. Error text is masked for credential assignments and key-shaped
  tokens, and truncation comes after redaction, because truncating a secret still
  leaves a secret.
- **Free-text masking is scoped to diagnostic fields, not applied to every
  string.** The SDK reports failures on two paths — a throw and a `result` frame
  — so both need masking; but the same pattern applied to the assistant's own
  output would redact the config example a user asked for. `result`, `errors`,
  `error`, `reason`, `details` and `stderr` are the fields that carry CLI
  diagnostics; everything else is run content.
- **Over-redaction is a failure too.** The pattern requires `=` or `:` as the
  separator, because `secret` and `authorization` are ordinary English words in
  error messages. A message an operator cannot read is not a safer message.
- **The event payload has no `usage` exemption.** `total_cost_usd` and
  `modelUsage` are dropped even though they are useful for a UI, because there is
  no path from the runner to the browser that is not also a path to the server and
  its logs.
- **An unknown workspace is refused before an attempt row exists.** The command
  stays accepted in the inbox — it was delivered, it just cannot run on this host
  — so nothing is left for reconciliation to explain.
- **`stop()` is async because the database is not crash-safe against its own
  writers.** Closing it under a run loses the run's events and its lock release.
- **A terminal event type is derived from the frame's own claim about failure,
  not its shape.** The SDK has two axes: `subtype` says which kind of turn ended,
  and `is_error` says whether it ended badly. Only the second one answers "did
  this run succeed".
- **A lock is released on every path, including a failing one.** The terminal
  write and the release are separate concerns: the write can fail and be
  reconciled at boot, but the lock has no other owner and no TTL, so it is
  released in its own `finally` rather than after the write.
- **Stopping is a state the message path also reads.** `#stopped` guards the retry
  chain and now the message handler too: a socket closed at shutdown can still
  deliver what it had buffered, and starting a run there writes to a database the
  daemon is about to close.
- **An event payload names no other run.** The lock-conflict refusal says
  `workspace_locked` and nothing else. Runner-internal ids are not published even
  where they are not secret: an event is a document the browser and the journal
  both keep, and a field with no rendering is a field nobody will notice carrying
  something that matters later.
- **A test that names keys one by one stops covering the list.** The redaction
  test now iterates the production key list at the top level, nested, and cased,
  so a key removed from the redactor fails a test rather than quietly becoming
  published.

## Design decisions worth remembering (transport)

- **Authentication happens before the upgrade.** A rejected credential returns
  HTTP 401 and no socket is created. Upgrading first and closing after would let
  a client hold a connection open while retrying in a loop.
- **The credential is read from a header, never the URL**, so it does not land in
  access logs.
- **Reconciliation reads the server's registry, not the runner's payload.** The
  runner contributes only its own inventory. This is what stops a reconnecting
  runner from rewriting server state.
- **Actions are never echoed to the runner.** The runner is told `ready` and
  nothing else; acting on decisions it did not make would be a second source of
  truth.
- **`unknown` is not `failed`.** A vanished process yields `interrupted`, which
  is an absence of knowledge, not a known error (§9.7).
- **Close 4000 and 4001 are terminal for the loop.** Superseded means another
  connection owns this identity; revoked means the credential is dead. Retrying
  either fights the server instead of recovering from it.
- **Backoff is capped and resets on success.** Uncapped, a long outage pushes the
  next attempt past any useful interval; never resetting punishes a healthy runner
  for an old outage.

## Former stubs, now real

Both composition seams that were injected-but-refusing are now wired to real
implementations. They are listed here because "wired but refusing" is
indistinguishable from "working" until somebody tries to log in or enroll a
runner, and that is exactly how they survived a phase:

- **Password verification** — `Bun.password` (argon2id) via
  `apps/control-server/src/auth/password.ts`. A malformed or empty stored hash
  is a refusal rather than a throw, so a corrupt row cannot turn a login into a
  500. The hash is never hand-rolled.
- **Runner-credential verification** — `verifyRunnerCredential` from
  `control-db`, wired in `apps/control-server/src/config.ts`. The gateway now
  reads the same rows the enrollment endpoint writes, so revocation reaches the
  transport.
- **`runner enroll`** — `apps/runner/src/enrollment/enroll.ts`, driven by a real
  subcommand. The token is read from `CC_WEB_ENROLL_TOKEN` or stdin, never argv,
  and travels in the request body, never a query string.

## The browser slice (2026-10-24)

The first client on top of the replay transport, verified in a real browser
against the real server, not just in unit tests:

- **What exists** — sign-in, the session rail with watermarks and live dots,
  and the event journal: numbered gutter, run-grouped transcript, machine-voice
  payload rendering, `resync_required` banner, honest empty states, bounded
  socket reconnect with a connection chip.
- **Three bugs the browser caught that unit tests did not** — a `Secure` cookie
  on plain http (login 200s and never sticks), `authorize` refusing the missing
  Origin of a same-origin GET (the cookie was fine; the read path was closed),
  and the router guard redirecting `/login` to itself forever.
- **One bug only a rendered component could catch** — the store mirrored
  machine state into a new object but reused the events array reference; Vue's
  shallow props compare saw "no change" and the journal kept its first (empty)
  render forever while the state beneath it was correct. `mirror()` now hands
  over a fresh array per frame, guarded by a store-level test.

## Not yet built

- Approval round-trip and `canUseTool` wiring. The executor passes no
  `canUseTool`, so the SDK's own default applies; §10's deny-by-default gate is
  not wired yet.
- The prompt composer. The browser reads the journal; sending a prompt waits on
  the §11 dispatch API for browser-originated commands.
- Session lifecycle views: dispatch controls, run cancel from the UI, run
  attempts beyond the first.
- A process supervisor. Execution is in-process (§3.3, slice-1 compatibility);
  a crash takes the run with it, which is why boot recovery marks it
  `interrupted` rather than resuming it.

None of these are blocked; the primitives above are what they will call.

