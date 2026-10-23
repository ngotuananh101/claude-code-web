# Phase 0 — runtime/config spike results

- Date: 2026-10-23
- Host: Fedora Linux, x86_64
- Verdict: **PASS — 14/14 checks**

Closes the §22.1 compatibility gate for the Linux target. This is evidence about
*this* host and *this* gateway, not a portability claim.

## Toolchain observed

| Component | Version |
| --- | --- |
| Bun | 1.4.3 |
| @anthropic-ai/claude-agent-sdk | 0.3.309 |
| Bundled Claude Code | 2.1.309 (293 MB, glibc ELF x86-64) |
| TypeScript | 7.0.2 |

## What was proven

| # | Claim | Evidence |
| --- | --- | --- |
| 1 | Bundled binary resolves with no global CLI | resolved via SDK-relative `require.resolve`; global `claude` on PATH went unused |
| 2 | Binary executes on this libc | `claude --version` → `2.1.309` |
| 3 | Config cascade is readable | `resolveSettings()` reported the `user` tier, 11 keys with provenance |
| 4 | Gateway arrives **via settings**, not the shell | `ANTHROPIC_BASE_URL` traced to `~/.claude/settings.json` `env` block, `user` tier |
| 5 | Token present, never printed | masked as `••… (35 chars)` |
| 6 | Streaming works | 2 delta chars, first event in ~2.2 s |
| 7 | Partial and final text do not double | `delta="ok"` and `final="ok"` — see the bug below |
| 8 | Session id captured | UUID from the `system` init message |
| 9 | Resume by explicit id loads transcript | second query recalled `ok` from the first |
| 10 | Cancel interrupts a live run | abort at 1782 ms, stream terminated, no orphaned process |
| 11 | Connection failure ≠ auth failure | closed port classified as reachability, not 401 |

## Bug found and fixed during the spike

The first streaming implementation concatenated `stream_event` deltas **and** the
final `assistant` message text, producing `okok`. This is exactly the failure
mode §12.3 warns about. The spike now keeps the two paths separate and asserts
they agree rather than sum — that assertion is now a standing check
(`no text duplication`).

**Implication for the adapter:** message normalization must key off block ids and
treat the complete message as authoritative. Naively appending every text
fragment yields duplicated transcript content that is hard to notice in a chat UI
and impossible to un-append later.

## Findings that constrain the implementation

1. **The platform binary package resolves only relative to the SDK.** It is an
   optional dependency of `@anthropic-ai/claude-agent-sdk`, not of the app. Any
   resolution logic must anchor on the SDK entry path. A Runner that changes
   `cwd` at runtime would otherwise lose the binary. `pathToClaudeCodeExecutable`
   is the escape hatch, but the default path must work.

2. **The binary is 293 MB.** Per-Runner install size and update cost matter; do
   not assume a slim container image. `bun build --compile` is explicitly out of
   scope for MVP (§20.3), which makes this the expected footprint.

3. **Abort surfaces as a generic `Error`, not `AbortError`.** `error.name` was
   `Error` with an abort-shaped message. Cancel detection must not rely on the
   name alone.

4. **Gateway config is only in the `user` tier.** No `project` or `local` source
   contributed. A workspace with its own `.claude/settings.json` could therefore
   *shadow* provider settings — worth an explicit test when workspace registration
   lands, and a reason the diagnostics RPC (§8.3) must show provenance, not just
   effective values.

5. **`settingSources: []` does isolate provider env** in the error probe — the
   dead-endpoint test only produced a connection error because the inherited
   gateway was suppressed. This is consistent with §7.4's warning that
   `settingSources: []` is *not* full isolation, but it does isolate this tier.

## Not yet proven

- Approval / `canUseTool` round-trip (§13)
- Hooks and MCP reachability (§22.1)
- Provider auth under a systemd unit without the operator's shell — the cascade
  read is proven, but not the service environment
- `SDK_AUTH_ERROR` classification against a *real* 401 (only reachability was
  proven; the 401 path needs a deliberately bad token against the live gateway)
- Tool execution and file mutation inside a workspace

These are Phase 1–2 gates, not Phase 0 regressions.

## Reproduce

```sh
bun run scripts/spike/phase0.ts            # free: binary + config cascade
bun run scripts/spike/phase0.ts --model    # spends tokens: adds query, resume, cancel, error classification
```
