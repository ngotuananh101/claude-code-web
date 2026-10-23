# Phase 1 — protocol primitives

- Date: 2026-10-23
- Scope: enrollment, credentials, identity, hello negotiation, connection
  generations, command inbox, event outbox with a contiguous ACK watermark,
  reconciliation, and the runner WebSocket transport.
- Status: **runner transport wired and tested; browser transport not started.**

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

110 unit tests, 3 integration probes.

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

## Not yet built

- `/ws/browser`: the owner-facing transport, and the JWT auth middleware in front
  of it (ADR-0001).
- The Runner's reconnect loop with backoff. The server side is ready for it —
  generations and reconciliation are both exercised above — but nothing on the
  Runner dials out yet.
- Scheduler and central command outbox on the control side.
- Approval round-trip and `canUseTool` wiring.

None of these are blocked; the primitives above are what they will call.

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
