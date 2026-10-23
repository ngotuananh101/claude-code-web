# Phase 1 — protocol primitives

- Date: 2026-10-23
- Scope: enrollment, credentials, identity, hello negotiation, connection
  generations, command inbox, event outbox with a contiguous ACK watermark.
- Status: **primitives complete and tested; transport not yet wired.**

## What exists

| Module | Guarantee | Test kind |
| --- | --- | --- |
| `control-db/enrollment` | Token shown once, only a hash stored, single consumption | unit + 8-process + 8-container race |
| `control-db/runner-credentials` | Rotation kills the previous secret in the same transaction; revoke is owner-scoped | unit |
| `runner/identity-store` | Credential written `0600` via temp-file rename; partial identity rejected | unit |
| `protocol/handshake` | Shape → secrets → version, in that order; negotiated state is `connected`, never `ready` | unit |
| `protocol/connection-registry` | Superseded or forged generations rejected; a stale socket's close does not evict the live one | unit |
| `runner-db/inbox` | Command ID accepted once; same ID + different payload rejected and audited | unit |
| `runner-db/event-outbox` | ACK advances only across a contiguous run | unit + SIGKILL crash (process and container) |

61 unit tests, 2 integration probes.

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

- The WebSocket transport itself: `/ws/runner` and `/ws/browser`, auth middleware,
  and the reconnect loop.
- Reconciliation (§14.3): the protocol that promotes `connected` to `ready`.
- Scheduler and central command outbox on the control side.
- Approval round-trip and `canUseTool` wiring.

None of these are blocked; the primitives above are what they will call.
