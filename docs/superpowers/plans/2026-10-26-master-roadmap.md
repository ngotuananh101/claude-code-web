# Master Roadmap — Operator Experience & Fidelity

> Standing authorization (owner, 2026-10-26): build this roadmap and execute
> each milestone in order, one detailed plan per milestone, through the full
> superpowers workflow (brainstorm → writing-plans → TDD → whole-branch
> review → fix pass → push). Each milestone ships working, tested software on
> its own; the order below is the order they run.

**Current base:** `9bce2f0` (Oct 25 night) — 687 tests, all gates green.
Shipped so far: auth, connector model, dispatch, execution + cancel, event
ingestion, browser replay, §13 approvals, dashboard, session pin, run API
placement, §20.3 compiled binary + green CI, live text streaming, tool
timeline.

## Milestones, in execution order

### M1 — Journal readability: markdown + assistant prose

The journal is the product's core surface and still renders assistant text as
raw `pre` blocks and `message.completed` as a JSON blob. Render assistant text
as sanitized markdown (streaming bubble and completed messages both), and
render `message.completed` rows as prose built from their text blocks instead
of `JSON.stringify`. Pure, unit-testable rendering module (bun test cannot
compile SFCs); XSS safety pinned by tests (raw HTML escaped, `javascript:`
links rejected); Tailwind arbitrary variants for prose styling (no scoped CSS,
no typography plugin — styles/index.css is the owner's, never edited).
Dependency: `markdown-it` (caret range), `html: false`.

### M2 — Tool fidelity: input on the timeline, payload hygiene

Review #3 flags: `message.completed` carries full `tool_use` input, and mixed
user frames persist raw `tool_result` content as `run.status`. First half:
surface a redacted, size-capped tool **input summary** on each tool row —
derived browser-side from the `tool_use` blocks of `message.completed`
payloads (same id), no new events, no new persistence. Second half: re-rule
the mixed-frame path (today pinned to land as `run.status`) — likely map its
`tool_result` blocks to `tool.completed` while keeping the frame visible,
removing the last raw tool-result persistence; the ruling happens in M2's
brainstorm and must update the pinned executor test deliberately.

### M3 — Demo prep + chores (small)

`workspaces` field in the fake runner's hello + reconcile (local
`/tmp/cc-web-fake-runner.ts`, never committed — demo stack only); shared
`MODEL_IDS` constant replacing the route/composer drift; ledger minors worth
doing (streaming row `occurredAt` tooltip); a full live demo pass on the
vite stack to eyeball M1+M2 in the real UI.

### M4 — Branch select, real

The composer's branch select is local/advisory. Make it real: runner-side git
integration (list branches, report in declared workspaces or a session
capability), dispatch-time checkout policy that never discards dirty state
without an operator decision. Design-heavy: gets its own brainstorm with
explicit safety rulings before any code.

### M5 — §12.6 backpressure measurement

Instrument the event pump (batch sizes, byte thresholds, browser frame rates)
before changing coalescing. Numbers first, then decide; may close as
"measured, no change needed".

### Explicitly blocked on the owner

- **§21.6 session migration** — snapshot policy (what crosses runners, where
  snapshots live), target toolchain validation and epoch semantics are owner
  decisions, not implementer ones. Proposed when the owner asks.
- Anything touching `styles/index.css`, `--spacing`, or the shadcn preset —
  the owner's knobs.

## Rules carried into every milestone

§19.4 security (no credentials/payload logging, bounded summaries only); §4.2
(no SDK imports outside packages/agent-adapter); TDD RED→GREEN per task; VN
UI copy with English domain nouns; Tailwind only; generated `ui/**` never
hand-edited; `.superpowers/` ledger local-only; whole-branch review at each
milestone end, Critical/Important → one fix pass, Minor → ledger; push
straight to `main`.
