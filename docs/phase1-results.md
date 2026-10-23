# Phase 1 — protocol primitives and transport

- Date: 2026-10-23
- Scope: enrollment, credentials, identity, hello negotiation, connection
  generations, command inbox, event outbox with a contiguous ACK watermark,
  reconciliation, runner and browser WebSocket transport, owner authentication,
  the central command outbox, the scheduler, and the runner reconnect loop.
- Status: **all four Phase 1 surfaces exist and are tested. Two integration
  seams are still stubbed: runner-credential verification and password
  verification (see "Known stubs").**

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
| `control-server/browser-gateway` | Origin allowlist first, then cookie; missing Origin is refused | unit |
| `control-server/server` | `/healthz`, `/auth/login`, both WS routes on one instance | unit + integration |
| `control-db/command-outbox` | Immutable fingerprint; identical re-enqueue is a no-op; terminal states are sticky | unit |
| `control-db/scheduler` | Offline → not-ready → capacity → duplicate → session-busy, in that order | unit |
| `runner/reconnect-loop` | hello → reconcile → ready; capped exponential backoff; 4000/4001 do not retry | unit |
| `runner/websocket-link` | Credential in the `Authorization` header, never the URL | unit |
| `runner/daemon` | Identity → loop, started without blocking on the network | integration |

182 unit tests across 20 files, 4 integration probes.

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

## Known stubs

These are wired but not real. Each is a seam with an obvious next step, not a
design gap:

- **Runner-credential verification** is injected into `createServer`, and
  `apps/control-server/src/index.ts` supplies `() => ({ ok: false, reason:
  "unknown" })`. Hashed credentials already exist in `control-db/runner-credentials`;
  this needs the lookup and hash comparison.
- **Password verification** is injected as `verifyPassword` and defaults to
  `async () => false`. Login therefore always fails in the real entrypoint until a
  hash library is wired.
- **`runner enroll`** is a placeholder that exits non-zero. Enrollment itself
  works and is tested; the CLI subcommand that calls it is missing.

## Not yet built

- Approval round-trip and `canUseTool` wiring.
- Dispatch on the live transport: the scheduler and the outbox are built and
  tested, but nothing yet pushes a queued command down a runner socket.
- The browser UI. `/ws/browser` exists and authenticates; nothing renders it.

None of these are blocked; the primitives above are what they will call.
