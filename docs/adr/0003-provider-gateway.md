# ADR-0003 — Provider auth via local Anthropic-compatible gateway

- Status: accepted
- Date: 2026-10-23
- Refines: ARCHITECTURE.md §7.5, §8.2, §10.3, §19.4, §24.2.

## Context

§7.5 states that config inheritance does not prove provider auth works and does
not promise reuse of a Pro/Max subscription; a distributed product must use an
approved auth method. §24.2 lists the real provider/auth path as a gate before
implementation.

The operator's actual setup, observed on the target host:

| Fact | Observed value |
| --- | --- |
| Endpoint | `ANTHROPIC_BASE_URL` = **private LAN host** (RFC 1918 `10/8`), plain `http`, port 20128 |
| Credential | `ANTHROPIC_AUTH_TOKEN`, 35 chars, opaque gateway token — not an `sk-ant-…` key |
| Where configured | `~/.claude/settings.json` → `env` block, also present in the shell env |
| Model mapping | gateway-specific names: `prime` (sonnet), `titan` (opus), `nano` (haiku) |
| Reachability at scaffold time | listening |

Two consequences follow immediately.

1. The gateway speaks the Anthropic Messages API but is **not** Anthropic. Model
   ids are gateway aliases, so the control plane cannot validate `model` against
   a hardcoded Anthropic enum.
2. The gateway is on a **different machine on a private network**, reached over
   plain `http`. The bearer token and all prompt/completion traffic cross that
   segment in cleartext. Acceptable only because the segment is a trusted private
   network; it becomes a hard failure the moment the gateway is reachable from a
   public network or the LAN is not trusted.

## Decision

**Provider auth stays a Runner-local concern.** The Runner inherits the gateway
configuration through normal Claude config discovery; the Control Server never
sees the token, the base URL, or the model aliases as credentials (§19.4).

Specifically:

- **No new auth mechanism.** The Runner does not get a second, app-specific
  provider credential. It uses whatever `~/.claude/settings.json` (or the service
  environment) already provides, which is the whole point of config inheritance
  (§7.1).
- **Never pass SDK `env` for provider settings.** §10.3 is explicit that SDK
  `env` *replaces* rather than merges. If a worker needs an explicit env for
  another reason, it must forward `ANTHROPIC_BASE_URL` and `ANTHROPIC_AUTH_TOKEN`
  verbatim, or the run silently loses its gateway.
- **Model overrides are opaque strings.** `Override<string>` for `model` is
  validated by shape and length only, never against an enum. A profile that
  hardcodes `claude-sonnet-4-5` is wrong on this Runner; the operator sets
  `prime`/`titan`/`nano`.
- **Capabilities are advertised, not assumed.** `RunnerHello` (§6.2) gains a
  redacted provider descriptor: gateway host class (`loopback` / `private` /
  `public`), scheme, and whether a credential is present — never the values.
  The UI shows "provider: gateway (loopback, token present)", and a
  `SDK_AUTH_ERROR` is a first-class failure, not a silent provider switch.
- **Doctor reports presence, never values.** Already implemented this way; it
  warns on plain `http` to any non-loopback host and fails on `http` to a public
  host.

The owner-facing JWT from ADR-0001 is a **different** credential for a different
boundary. It never reaches a Runner, and the gateway token never reaches the
browser.

## Consequences

- **Phase 0 depends on a reachable gateway.** It was up when checked, but it is
  a separate host, so the spike must fail loudly when it is down rather than
  hang. The spike must also prove the SDK picks up `ANTHROPIC_BASE_URL` from
  *inherited settings*, not merely from an ambient `process.env` — the Runner
  service will not have the operator's shell.
- Because the endpoint is on another host, the Runner service needs network
  egress to that LAN address from whatever account and sandbox it runs under.
  A systemd unit with a restrictive network namespace would break provider
  access; that is a deployment test, not an assumption.
- A gateway that is down looks identical to a dead provider. The Runner must
  distinguish connection-refused (gateway offline) from 401 (bad token) in its
  error mapping, or the operator will chase the wrong cause.
- Plain `http` across a LAN means the token is only as safe as that segment.
  If the gateway ever gains a public route, TLS is mandatory before Phase 1 —
  not a later hardening item.
- Model names are per-Runner. A profile copied between Runners can silently
  select a nonexistent model — validate at run start and fail with
  `CONFIG_INVALID` rather than letting the gateway return an opaque error.
- If the gateway later needs TLS or auth beyond a bearer token, that is a
  Runner-environment change, not a control-plane change. The boundary is
  deliberately drawn here so the app never grows gateway-specific code.
- This setup is **not** a shippable auth story for third parties (§7.5). It is
  correct for a single-operator deployment and must be re-decided before any
  multi-tenant work (§21.8).
