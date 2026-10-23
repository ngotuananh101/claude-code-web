# Docker harness

Runs several isolated Runners and a Control Server on one machine so protocol
behaviour can be tested across real process and filesystem boundaries.

This is a **test harness**, not the production deployment path. Production is
host-native under systemd (§20.3), because the Runner must inherit the operator's
Claude config and provider credentials.

## Build

```sh
bun run docker:build
```

`oven/bun:1.4.3-debian` is pinned to the Bun version that Phase 0 verified.

## Two Runners + control server

```sh
bun run docker:runners
docker compose -f infra/docker/compose.runners.yml logs -f runner-a
docker compose -f infra/docker/compose.runners.yml down -v
```

Each Runner gets its own named volume, so `down` without `-v` preserves identity
across restarts — the same property a real Runner needs (§6.3).

The repository is mounted read-only at `/app` and each container's writable state
lives in its volume. Editing source on the host is picked up on the next run
without a rebuild.

## Integration probes

```sh
bun run test:integration                 # 8 OS processes, one shared SQLite file
bun run scripts/integration/enrollment-race.ts --docker   # 8 containers
```

### `enrollment-race.ts`

Seeds one enrollment token, then has N consumers race to consume it. Asserts
exactly one succeeds and every loser reports `consumed`.

Why both modes: the in-memory unit test proves the conditional `UPDATE` is
correct within one process. The process and container variants prove the
guarantee survives WAL locking, busy timeouts, separate filesystems and separate
process tables — the conditions that actually break naive read-then-write code.

## What Docker does not prove

- **Provider auth.** Containers have no `~/.claude/settings.json`, so a
  containerised Runner cannot reach the gateway the way a host-native one can.
  That path is proven by `scripts/spike/phase0.ts` on the host instead.
- **Multi-machine topology.** Separate containers are still one kernel. Network
  partition behaviour (§22.3) needs either `docker network disconnect` on a live
  container or two physical hosts.
- **systemd semantics.** Process containment and cgroup escalation (§14.2) are
  host concerns; the container's PID 1 is not systemd.

For those, the harness can still inject faults — stopping a container mid-run is
a realistic equivalent of a Runner daemon crash — but it is not a substitute for
the host-native test.
