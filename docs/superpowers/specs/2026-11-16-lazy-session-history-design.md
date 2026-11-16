# Lazy Session History Design

## Intent

Opening a long session must load the newest **12 chat bubbles**, in chronological order. Older pages are requested only by upward scrolling or the explicit load-earlier button, without moving the line the reader is viewing.

## Approach

A durable, indexed conversation read model stores complete turn boundaries and coalesced text fragments alongside the unchanged event journal. A cold subscription requests an explicit history bootstrap at a captured watermark; it does not certify omitted content as telemetry replay. Older pages use an exclusive turn cursor and the current reset boundary, independently of live sequence coverage. Existing raw and journal subscriptions remain compatible.

Rejected alternatives: slicing the DOM after full replay still parses and reduces all history; selecting twelve raw events truncates assistant/tool turns and is not twelve messages.

## Invariants

- Page size is 12 chat bubbles, not SDK rows or journal events.
- A page contains complete turn inputs, including tool outcomes and interleaved prose. Consecutive streaming text fragments are coalesced before browser delivery.
- Durable journal rows, event identities, allocation, and runner ACKs are unchanged.
- A bootstrap explicitly establishes a live watermark. Historical pages never advance that watermark.
- Cursors are session-scoped, exclusive, and invalidated by conversation reset. Ownership is checked before every read.
- Cold opens never fan out to child SDK transcripts. Subagent transcript enrichment is deferred until the inspector opens.
- Existing SDK head-relative offset callers remain compatible. SDK-only history is deferred behind journal pages and gated by `workspace.sessions.chat-pages`. The installed SDK has no bounded tail API: first demand builds an immutable redacted snapshot with one full-chain read, never represented as a bounded disk read. Older pages require its opaque session/directory-scoped identity, reuse indexed boundaries without rereading the chain, and cannot move under compaction. Retained cache is capped at 8 snapshots/32 MiB serialized rows with 30-minute expiry; oversized/expired snapshots fail explicitly without silent loss.
- Live rendering caches settled turns and reduces only the current turn, not all loaded history.
- Route changes, resets, duplicate deliveries, and reconnects cannot resurrect old pages.
- Generated shadcn-vue files are never edited, lint-fixed, or formatted.
- No commit, push, deployment, service restart, or billed SDK query is authorized by implementation alone.

## Storage and migration

The control database maintains turn rows, compact event chunks, and reset metadata transactionally with ingestion. Migration backfills existing durable rows in a version-gated IMMEDIATE transaction; the marker commits only with the complete read model, and current-version startup never scans the raw journal. Subsequent page reads query the turn index and selected chunks only. Text merging preserves routing and process/text boundaries. Unknown statuses remain durable and available to legacy replay.

## UI

The feed receives only its loaded pages. Upward loading is single-flight and restores the first visible turn's position after the asynchronous prepend. No mount-time prefetch is allowed. Completed pages remain immutable while live output arrives at the tail. Pending approval cards and question state remain available independently of collapsed process details.

## Verification

Tests must prove twelve-bubble cold bootstraps, twelve-bubble older pages, complete long streaming/tool turns, stable exclusive cursors, reset invalidation, ownership and backpressure behavior, legacy replay compatibility, no initial child transcript fan-out, and async scroll anchoring. Run `bun test`, `bun run typecheck`, `bun run lint`, and `git diff --check` before reporting completion.
