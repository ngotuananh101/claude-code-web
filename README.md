# cc-web

Web control plane for Claude coding agents: a browser chat UI that drives Claude
Agent SDK runs on one or more remote Runners.

**Status:** scaffolding only. No runtime code yet — see [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
(blueprint v2.0) and the roadmap in §23. Phase 0 is a headless runtime/config spike.

## Topology

```
Browser (Vue)  ──HTTPS/WSS──▶  Control Server (Bun + Hono)  ◀──outbound WSS──  Runner(s) (Bun + Agent SDK)
                               auth, scheduling, outbox,                      config, workspace, SDK process,
                               event journal, projections                    local inbox/outbox, locks
```

The Control Server never reads a Runner filesystem directly. Runners dial out;
no inbound port is required on a Runner host.

## Layout

| Path | Contents |
| --- | --- |
| `apps/web` | Vue 3 + Vite + Tailwind + shadcn-vue, CodeMirror 6 editor/diff |
| `apps/control-server` | Hono HTTP API, browser + runner WebSocket gateways, scheduling, journal |
| `apps/runner` | Runner daemon: connection loop, inbox/outbox, supervisor, worker processes |
| `packages/protocol` | Wire envelopes, command/event schemas — shared by server, runner and web |
| `packages/agent-adapter` | Claude Agent SDK adapter. Runner-only; never imported by server or web |
| `packages/control-db` | Control DB schema and repository interfaces |
| `packages/runner-db` | Runner-local SQLite schema (inbox, outbox, attempts, locks) |
| `packages/shared` | Pure helpers with no secrets, no SDK import, safe for the web bundle |
| `infra/` | Caddy, systemd and Docker deployment assets |
| `scripts/` | `doctor.ts`, backup/restore helpers |
| `docs/adr/` | Architecture decision records |

## Toolchain

First target: **Fedora Linux / x86_64** — chosen to settle supervisor semantics
before portability work. Versions are not hand-pinned; the committed `bun.lock`
is the source of truth. See [ADR-0002](docs/adr/0002-toolchain.md).

| Component | Verified version |
| --- | --- |
| Bun | 1.4.3 |
| Node (tooling only) | v24.21.0 |
| Git | 2.56.0 |

```sh
bun install
bun run doctor        # static runtime/config probe; never calls a model
```

## Decisions

Architecture decisions that needed more than a table row live in
[`docs/adr/`](docs/adr/):

- [ADR-0001](docs/adr/0001-auth-jwt.md) — owner auth with JWT access tokens + `tokenVersion` revocation
- [ADR-0002](docs/adr/0002-toolchain.md) — Fedora target, lockfile-over-pins policy

## Invariants worth remembering

- One active run per session; one managed writer per workspace.
- Server outbox → runner inbox → runner event outbox → server journal. At-least-once
  with idempotent processing — never exactly-once for shell, file or Git side effects.
- `desiredState` and `observedExecutionState` are separate. A closed socket does not
  turn `running` into `failed`.
- Ambiguous launches are marked `interrupted/unknown`; they are never auto-respawned.
- Overrides are explicit. `inherit` means the SDK option is omitted, not set to a default.
