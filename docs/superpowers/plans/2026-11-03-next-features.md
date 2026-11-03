# Next Features — Notifications, Export, Queue, Backup, Migration

**Status:** Planned 2026-11-03, not yet implemented. Owner decisions
recorded below are binding for the builder; anything marked "open"
must be decided before that feature's implementation starts.

**Owner decision 2026-11-03: build complete, no v1/v2 staging.**

**Implementation status 2026-11-03: N1 is implemented (uncommitted).**
Browser + Telegram notifications for `approval.requested`,
`approval.expired` and run-terminal events, with link/unlink/test,
per-channel toggles, event-id dedupe and bounded summaries. See
`apps/control-server/src/notifications/telegram.ts`,
`apps/control-server/src/routes/notifications-routes.ts`,
`apps/web/src/features/notifications/notification-events.ts` and the
Notifications section in `UserProfileDialog.vue`. Telegram approval
actions are also implemented (uncommitted, 2026-11-03, after the owner
decided 2026-11-03 to add them): inline Duyệt/Từ chối buttons on
tool_permission approval messages only, single-use server-side action
tokens verified against the linked chat, executed through the same
decision core as the web UI. user_question approvals stay link-only.
N2–N4 are not yet implemented; N5 remains blocked on owner decisions.
The first draft split several features into a v1 and a follow-up.
That staging is dropped. Everything listed under a feature below
is in scope for that feature, in one implementation, except the
items explicitly marked as needing a separate owner decision
(N5 session migration; Telegram approval actions were decided
2026-11-03 and are implemented).

**Order:** Implement in the order listed. Each feature ships working,
tested software on its own, with the verification gates at the end,
before the next one starts. This follows the master roadmap
(`docs/superpowers/plans/2026-10-26-master-roadmap.md`, M1–M5) and
does not change its milestones.

**Spec references:** `docs/ARCHITECTURE.md` §13 (approvals), §12
(journal/events), §17–§19 (profiles, security, §19.4), §20
(deployment), §21.6 (session migration, blocked).

## At a glance

| # | Feature | Size | Why now |
|---|---------|------|---------|
| N1 | Approval notifications: browser + Telegram bot | Medium | Runs are long and approvals block them; today the operator must watch the UI. Highest daily value. |
| N2 | Export a session to Markdown | Small | The journal already renders markdown; export turns a finished run into something archivable and shareable. |
| N3 | Queue a run when no runner is ready | Medium | Today dispatch with no ready runner answers 503 and the operator must retry by hand. |
| N4 | Backup / restore (1-click) | Medium | All state is local SQLite + attachments; there is no backup feature at all. |
| N5 | Session migration (§21.6) | Large, blocked | Needs owner decisions first (see N5). Do not start it until they are recorded. |

## Global constraints

- Never edit, lint or format generated shadcn-vue files:
  `apps/web/src/components/ui/**`, `apps/web/src/lib/utils.ts`,
  `apps/web/src/styles/index.css`, `apps/web/components.json`.
- VN UI copy with English domain nouns; Tailwind only; no scoped CSS
  for new surfaces unless the existing code already uses it there.
- §19.4 security: no credentials, no API keys, no full tool payloads
  and no file contents in logs, notifications, exports or backups
  metadata. Summaries are bounded and redacted, as the journal is.
- §4.2: no SDK imports outside `packages/agent-adapter`.
- TDD RED→GREEN per task; whole-branch review at each feature's end,
  Critical/Important → one fix pass, Minor → ledger; push straight
  to `main` (master roadmap rules).

## Explicitly NOT in this plan

These were proposed, considered, and dropped by the owner on
2026-11-03. Do not re-add them without a new owner decision:

- **Prompt library / template** — not wanted.
- **Cost per model/profile** — skipped (token usage totals already
  exist via `/api/stats/usage`; no pricing/cost layer is to be built).
- **CodeMirror review UI** — superseded by Monaco Editor (see
  `docs/superpowers/specs/2026-11-01-monaco-review-dialog-design.md`,
  ARCHITECTURE §16, ADR-010). Monaco is the review/file editor;
  CodeMirror is not a future feature.

---

## N1 — Approval notifications: browser + Telegram bot

### Problem

A run can sit suspended on `approval.requested` while the operator
is on another tab, another app, or away from the machine. The
approval row is durable (projected by
`apps/control-server/src/approvals/ingest.ts`) and the run is
suspended until a decision, but nothing outside the browser tab
tells the operator. The same gap applies, to a lesser degree, to a
run finishing while the operator is away.

### Scope — in

- **Browser notifications** for: `approval.requested`,
  approval expired/abandoned, and a run reaching a terminal state.
  Clicking a notification focuses the session / approval in the
  web UI. An in-app toast/badge remains for the case where the
  tab is already in the foreground.
- **Telegram bot notifications for approvals and run-terminal
  events**, alongside the browser channel. Telegram covers
  `approval.requested`, approval expired/abandoned, and a run
  reaching a terminal state, each with its own per-channel
  toggle.
- Per-channel on/off toggles in the web UI (browser, Telegram),
  stored per owner. No channel is on until the operator enables
  it: browser permission must be granted explicitly, and Telegram
  must be linked explicitly (below).
- Deduplication by event id: one approval produces at most one
  notification per enabled channel, even across reconnects and
  browser replay (§12.5). Re-delivery after a restart must not
  re-notify for approvals already notified.

### Scope — out (needs a separate owner decision, not assumed)

- **Approving, rejecting or answering from Telegram is not
  assumed.** The operator asked for Telegram to *receive*
  approval notifications. If Telegram approval actions are
  wanted, that is a separate owner decision: it needs an auth
  design (signed callbacks, chat verification, replay
  protection) before it is added, because anyone who can read
  the linked chat could otherwise decide a tool execution.
  Until that decision is made, the message carries a deep link
  to the session/approval in the web UI, and the decision is
  made there.
- No group chats, no multi-user fan-out. cc-web is single-owner:
  one linked Telegram chat per owner.
- No notification for every journal event — only the events
  listed above. Tool rows, streaming text and routine run
  progress stay in the UI only.

### Browser channel — design notes

- Permission flow: a settings toggle requests
  `Notification.requestPermission()`; if denied, the toggle
  shows the denied state and explains that the browser setting
  must be changed (the app cannot re-prompt).
- Default behaviour (builder to confirm in the task's
  brainstorm): notify for approvals even when the tab is
  visible, but only as a toast/badge when the approval's
  session is already open in the foreground; use a system
  notification when the tab is hidden or another session is
  open. A setting to "always use system notifications" is
  acceptable if it stays a simple toggle.
- Notification content: session title, tool name, a bounded
  input summary (same redaction/cap as the tool timeline),
  never a credential, never a full payload, never file
  contents. Click action: `focus` the existing tab and
  navigate to the session/approval.

### Telegram channel — design notes

- **Setup (owner):** create a bot with BotFather, put its token
  in the control server environment as
  `CC_WEB_TELEGRAM_BOT_TOKEN`. The token is never committed,
  never logged, never returned by any API, and never stored
  in the database — environment only, like
  `CC_WEB_JWT_SECRET`.
- **Linking (owner, single chat):** the web UI (Settings /
  Notifications) generates a single-use link code with a short
  expiry (recommended: 15 minutes). The operator sends
  `/start <code>` to the bot. The server verifies the code,
  stores only the resulting `telegram_chat_id` for the owner,
  and invalidates the code. Unlinking deletes the stored
  chat id. A "send test message" button verifies the link.
- **Transport: polling.** The control server
  polls Telegram `getUpdates` on a short interval for link
  codes. This needs only outbound HTTPS from the control
  server, which already works behind the loopback Caddy proxy
  and the operator's TLS proxy. A webhook
  (`/api/telegram/webhook` with a secret-token header) is the
  lower-latency alternative, but it needs a public HTTPS
  endpoint; polling is the complete transport for this
  feature, webhook is not required.
- **Sending:** outbound Bot API `sendMessage` from the control
  server, with retry + backoff and a per-owner rate cap so a
  burst of approvals cannot spam the chat. Failures to send
  must not block approval projection, run suspension or the
  decision route — notification is best-effort, the durable
  approval row is the authority.
- **Message content:** same bounded summary as the browser
  channel, plus a deep link built from the public origin
  (`CC_WEB_ALLOWED_ORIGINS` first entry) to the session /
  approval. No credentials, no payloads, no file contents.
  Messages from any chat id other than the linked one are
  ignored (no reply, no link, no state change).
- **Security notes for the builder:** the bot token is a
  bearer secret for sending as the bot; treat a leaked token
  like a leaked API key (rotate via BotFather). The link code
  is not an auth token for the web UI and must never mint a
  session. Telegram message delivery is not a substitute for
  the web UI's Origin allowlist + session cookie.

### Acceptance criteria — N1

- [ ] Enabling browser notifications and triggering an
  approval produces exactly one system notification (or
  toast/badge when the session is in the foreground), with a
  click that lands on the approval.
- [ ] Linking Telegram via `/start <code>`, then triggering
  an approval, delivers exactly one Telegram message with a
  bounded summary and a working deep link; unlinking stops
  delivery; a wrong/expired code links nothing.
- [ ] A message from an unlinked chat id changes nothing.
- [ ] A Telegram send failure does not fail or delay the
  approval projection or decision.
- [ ] No credential, full payload or file content appears in
  any notification (browser or Telegram) in tests.
- [ ] Gates: `bun test`, `bun run typecheck`, `bun run lint`,
  `cd apps/web && bun run build`.

### Open decisions — N1 (builder, with recommended defaults)

- Polling interval for `getUpdates` (recommended: 5–10 s;
  link codes are not latency-critical).
- Whether Telegram approval actions are in scope at all
  (owner decision, see Scope — out above; default is no).

---

## N2 — Export a session to Markdown

### Scope

- One button in the session/journal view: "Export Markdown".
  It downloads a single `.md` file for the currently open
  session, named `session-<id>-<date>.md`.
- Contents, in journal order: session title, workspace,
  branch, profile/model, then user prompts, assistant prose
  (through the existing markdown renderer, not raw JSON),
  tool summaries (redacted, size-capped, as on the timeline),
  the list of changed files with +/- counts, approval
  decisions (what was asked, what was decided, when), and
  token usage totals for the session if the stats query
  already provides them.
- Explicitly excluded: raw `message.completed` payloads,
  full tool results, file contents, attachments binaries
  (list attachment names only), credentials, API keys.

### Acceptance criteria — N2

- [ ] Exporting a session with prompts, prose, tool rows,
  file changes and an approval produces a readable Markdown
  file containing all of those sections and none of the
  excluded material.
- [ ] Export works from the journal's already-persisted
  events (no new persistence, no runner round-trip).
- [ ] Gates as in N1.

---

## N3 — Queue a run when no runner is ready

### Problem

Today `POST /api/sessions/:id/runs` with no ready runner
answers 503 ("no ready runner") and nothing is kept: the
operator must retry by hand when a runner comes back.

### Scope

- When no ready runner can take a run, create a durable
  queued run instead of answering 503, and return its
  queued state to the browser. The queue is visible in the
  session view (queued, with a cancel action).
- On runner ready / reconcile, the dispatcher drains queued
  runs in order, respecting the existing rules unchanged:
  workspace/runner placement pinning, dispatch-time
  checkout policy (never discards dirty state without an
  operator decision), permission mode, model and profile
  selection, and the one-active-run-per-session rule.
- Cancelling a queued run removes it without dispatching.
  A queued run that can no longer dispatch (workspace gone,
  runner pin invalid) surfaces as a failed/expired queue
  entry with a reason, not a silent drop.

### Out of scope

- Priority queues, scheduled queueing (schedules already
  exist), and queueing across owners (single-owner product).
- No change to approval flow: a queued run that later
  dispatches still suspends on approvals exactly as a
  direct dispatch does.

### Acceptance criteria — N3

- [ ] Dispatch with no ready runner creates a queued run
  (not 503), and the run dispatches automatically when a
  matching runner becomes ready.
- [ ] Placement pinning and checkout policy are still
  enforced for queued dispatches (tests for a pinned
  runner that does not declare the workspace, and for a
  dirty tree).
- [ ] Cancelling a queued run dispatches nothing.
- [ ] Gates as in N1.

### Open decision — N3

- Queue expiry: configurable TTL, default no expiry
  (operator cancels explicitly). A TTL value is a builder
  setting, not a staged feature.

---

## N4 — Backup / restore (1-click)

### Scope — manual + scheduled

- **Export backup:** one action in the web UI downloads a
  single archive containing the control SQLite database,
  the attachments directory, and a manifest (app version,
  database schema version, created time, counts). The
  archive is sensitive by construction — it contains sealed
  profile keys — and the UI must say so before download.
- **Import restore:** upload a backup archive, validate
  the manifest and database integrity, and restore it.
  The restore path must take a pre-restore backup first
  (or refuse to proceed without one) and must refuse a
  manifest whose app/schema version it cannot handle,
  rather than partially restoring.

### Out of scope

- Cross-version migration of old backups beyond a
  version check + refusal.

Scheduled automatic backups are in scope (reusing the
scheduler): a daily export kept on the server, with a
retention count. Archive encryption with an operator
passphrase is in scope as an option, off by default — the
passphrase is never stored, and a passphrase-protected
backup cannot be restored without it.

### Acceptance criteria — N4

- [ ] Export → fresh database → import restores sessions,
  profiles (keys still openable with the same sealing
  secret), attachments and schedules.
- [ ] A corrupt archive or a mismatched manifest version
  is refused without changing live data.
- [ ] Gates as in N1.

### Open decisions — N4 (builder)

- Archive format (recommended: a single zip/tar with a
  `manifest.json` at the root, so it is inspectable).
- Whether restore requires a server restart / maintenance
  mode (recommended: yes — restore while the server holds
  the database open is the failure mode to avoid).

---

## N5 — Session migration (§21.6)

### Status: BLOCKED on owner decisions

Do not implement N5 until the decisions below are recorded
by the owner in this document (or in ARCHITECTURE §21.6).
This section exists so the decisions are visible in the
plan, not so the builder can start.

### Open decisions — N5

1. **Snapshot policy:** what crosses to the target runner —
   transcript/journal, working-tree files, git branch,
   workspace, profile, model, approval state, scheduled
   state? What explicitly does not cross (secrets in
   plaintext must never cross; sealed keys need a
   re-seal story, not a copy)?
2. **Where snapshots live:** control server, source runner,
   target runner, or object storage? Who owns cleanup?
3. **Target toolchain validation:** what must be verified
   on the target before migration starts (tools, models,
   workspace roots, git state)?
4. **Epoch semantics:** what happens to the source runner's
   run when migration starts (suspend, cancel, keep
   running?), how duplicate execution is prevented, and
   how approval state transfers without double-deciding.
5. **Rollback:** what happens if the target fails
   mid-migration — does the session return to the source,
   and in what state?

### When the decisions land

N5 becomes its own detailed plan (brainstorm first, like
M4 branch select), with its own tasks and gates. It does
not block N1–N4.

---

## Verification gates (every feature)

`bun test`, `bun run typecheck`, `bun run lint`,
`cd apps/web && bun run build`. Plus a live pass on the
vite stack for N1 (browser permission + Telegram link +
approval) and N3 (runner offline → queued → reconnect →
dispatch), because those two cannot be proven by unit
tests alone.
