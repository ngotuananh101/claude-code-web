# Đặc tả Thiết kế: Tác vụ theo lịch (Scheduled Tasks) do Control Server sở hữu

> **Design Document** — 2026-10-31
> **Status:** Draft for review
> **Phạm vi:** `packages/protocol`, `apps/runner`, `packages/control-db`, `apps/control-server`, `apps/web`

---

## 1. Bối cảnh & Vấn đề

### 1.1. Hiện tượng

Trên giao diện web, agent gọi tool `CronCreate` để hẹn một task (ví dụ 17:36). Tool trả về thành công:

```
Scheduled one-shot task ada0647d (36 17 31 10 *). Next run: Oct 31 5:36pm.
Session-only (not written to disk, dies when Claude exits).
```

Nhưng đến 17:36 task **không chạy**, không có tin nhắn kết quả nào trong chat — kể cả khi tab web vẫn mở.

### 1.2. Root cause (đã chứng minh bằng probe)

`CronCreate` chỉ đăng ký một **timer in-memory trong tiến trình Claude Code CLI**. cc-web chạy mỗi lượt như một tiến trình CLI riêng (turn-based): khi turn cuối trả `result`, runner kết thúc attempt và tiến trình CLI thoát — timer chết theo.

Bằng chứng từ attempt `47b8d7fa`:

| Thời điểm | Sự kiện |
|---|---|
| 17:33:59 | `CronCreate` tạo task `ada0647d`, hẹn 17:36 |
| 17:34:03 | Bash chạy nền `bg94xyw3e` (15s) giữ process sống |
| 17:34:08 | `result` turn 1 (result_index=0) |
| 17:34:23 | Background task xong → turn 2 |
| 17:34:27 | `result` turn 2 (result_index=1) → CLI thoát |
| 17:36:00 | **Không có gì xảy ra** — timer đã chết cùng process |

Probe tối thiểu xác nhận cơ chế:

| Cách truyền prompt cho SDK | Sau `result` | Cron 17:46 |
|---|---|---|
| `string` (runner hiện tại) | iterator kết thúc sau ~300ms → CLI thoát | ❌ không cháy |
| `AsyncIterable` (stdin giữ mở) | CLI sống tiếp | ✅ cháy đúng giờ, sinh turn mới + `result` thứ 2 |

Tab web **không** giữ process sống: timer nằm trên runner, không nằm trong trình duyệt.

### 1.3. Vì sao không chọn "giữ process sống"

Runner hiện tại có `maxConcurrentRuns = 1` và giữ **workspace lock suốt attempt** (§11.3, §11.4). Nếu park một process chờ cron:

- Runner bị chiếm slot đến giờ hẹn — có thể hàng giờ, hoặc vĩnh viễn với cron lặp.
- Workspace bị khoá theo: mọi phiên khác trong cùng workspace nhận `workspace_busy`.
- Runner restart là mất hết (timer vẫn session-only).

Vì vậy lịch phải thuộc về **Control Server** — nơi đã sở hữu scheduling (§11.3: "Server kiểm tra Runner ready/capacity rồi enqueue") và có DB bền vững.

---

## 2. Goals / Non-goals / Anti-goals

### 2.1. Goals

1. Task do agent tạo bằng `CronCreate` (một lần hoặc lặp) được **mirror sang Control Server** và **bền vững**: sống qua runner restart, server restart, đóng tab.
2. Đến giờ, Control Server **enqueue một run bình thường** cho session (turn-based như mọi run khác) — không cần thay đổi capacity/lock model.
3. Kết quả turn chạy theo lịch hiển thị trong chat như các turn khác, có nhãn rõ đây là **tác vụ theo lịch** (không phải người dùng gõ).
4. Người dùng xem được danh sách lịch đang hoạt động của session và **huỷ** được từ web.
5. Không vi phạm các invariant hiện có: một active run/session (§2.3), một writer/workspace (§11.4), journal là nguồn sự thật (§12), SDK chỉ được import trong `packages/agent-adapter` (§4.2).

### 2.2. Non-goals

- Không giữ process CLI sống để dùng scheduler nội bộ của CLI.
- Không catch-up mọi slot lỡ của cron lặp (chỉ chạy một lần rồi tính slot kế tiếp).
- Không có UI tạo/sửa cron thủ công (chỉ list + cancel); việc tạo vẫn qua hội thoại.
- Không thay đổi `maxConcurrentRuns`, workspace lock, hay state machine của Runner.
- Không hỗ trợ `ScheduleWakeup` / `/loop` ngoài phạm vi `CronCreate`/`CronDelete` (có thể mở rộng sau bằng cùng cơ chế).

### 2.3. Anti-goals

- **Double-fire**: cùng một lịch chạy hai lần (một bởi timer in-process, một bởi server).
- **Mất lịch âm thầm**: lịch biến mất không dấu vết khi runner offline/restart.
- **Chiếm runner/workspace khi đang chờ**: chờ cron không được giữ slot hay lock.
- **Parse text tool output** khi SDK đã cung cấp structured result.

---

## 3. Ràng buộc kiến trúc

| # | Ràng buộc | Nguồn |
|---|---|---|
| C1 | Chỉ `packages/agent-adapter` import SDK; runner là nơi duy nhất hiểu frame SDK | §4.2 |
| C2 | Event runner → server đi qua outbox bền vững, at-least-once, dedupe theo `eventId` | §12.2 |
| C3 | Server chỉ nhận event type trong `EVENT_TYPES`; type lạ làm hỏng cả frame | `runner-gateway.ts` |
| C4 | Một active run/session; capacity 1/runner | §2.3, §11.3 |
| C5 | Session pin (owner, workspace, runner) bất biến, do dispatch đầu tiên ghi (ADR-006 — mô tả ở ARCHITECTURE §24.1; `docs/adr/` hiện chỉ có 0001–0003) | ADR-006 |
| C6 | Migration phải idempotent (chạy lại mỗi boot) | `control-db/db.ts` |

---

## 4. Thiết kế tổng thể

```text
  [CLI subprocess trên Runner]                       [Control Server]
  agent gọi CronCreate
        │ tool_use (assistant frame)
        │ tool_result + tool_use_result {id, humanSchedule, recurring, nextFireAt}
        ▼
  executor: tương quan 2 frame theo tool_use_id
        │ append("schedule.created", payload)
        ▼
  event_outbox ──── WS events frame ────► ingestEvent (journal)
                                              │ projectScheduleEvent (idempotent)
                                              ▼
                                        scheduled_tasks (SQLite)
                                              ▲
                                     tick mỗi 15s (due → dispatch)
                                              │
                                              ▼
                                        Scheduler.dispatch
                                    (run.start y như người dùng gửi)
                                              │
                                              ▼
  CLI subprocess mới (resume session) ◄── outbox → runner inbox
        │ turn chạy prompt của lịch
        ▼
  event thường (run.started ... run.finished) → chat
```

Nguyên tắc: runner chỉ **quan sát và mirror** (`schedule.created` / `schedule.cancelled`); server **sở hữu thời gian** và biến mỗi lần đến hạn thành một run bình thường.

---

## 5. Chi tiết từng tầng

### 5.1. Protocol (`packages/protocol`)

Thêm 2 event type (additive):

```ts
| "schedule.created"
| "schedule.cancelled"
```

và thêm vào `EVENT_TYPES`. Không đổi `PROTOCOL_VERSION` (server + runner ship cùng nhau; xem §10.4 về compatibility).

**Payload `schedule.created`:**

```jsonc
{
  "toolCallId": "call_...",         // tương quan với tool.started/message.completed
  "cliTaskId": "af5c4b05",          // tool_use_result.id; có thể vắng
  "cron": "58 17 31 10 *",          // tool_use_result.humanSchedule ?? input.cron
  "recurring": false,
  "prompt": "Kiểm tra dung lượng...", // input.prompt (CLI đã cap ~1000 ký tự)
  "nextFireAt": 1793444280000,      // tool_use_result.nextFireAt (epoch ms, đồng hồ runner); có thể vắng
  "timezone": "Asia/Ho_Chi_Minh"    // IANA zone của runner
}
```

**Payload `schedule.cancelled`:** `{ "toolCallId": "...", "cliTaskId": "af5c4b05" }`.

Validation: `cron` 1..200 ký tự, `prompt` ≤ 4000, `timezone` là chuỗi ≤ 100; payload vẫn qua `boundEventPayload` (§12.6).

### 5.2. Runner (`apps/runner/src/execution`)

Trong `executor.ts`, thêm một bộ tương quan tool-call nhỏ (module riêng `schedule-events.ts` + test):

1. Khi gặp frame `assistant`, ghi nhớ mọi block `tool_use` theo `id` → `{ name, input }`.
2. Khi gặp frame `user` là tool result, với mỗi block `tool_result`:
   - tra `tool_use_id = block.tool_use_id`;
   - nếu `is_error === true` → bỏ qua;
   - `CronCreate` → dựng `schedule.created` từ **structured `tool_use_result`** của frame (ưu tiên) với fallback về `input`;
   - `CronDelete` → `schedule.cancelled` với `cliTaskId = input.id`.
3. Append bằng `append(...)` của executor (giữ đúng sequence space của attempt).

**Vị trí module (quan trọng):** `toolCompletionsOf` nằm ở `tool-results.ts` và chỉ đọc text content, **bỏ** frame-level `tool_use_result`; nó cũng không giữ state giữa các frame. Bộ tương quan mới là một observer **có state, chạy trên raw SDK frame ngay trong vòng lặp của `executor.ts`, trước mọi nhánh** (`stream_event`, `isToolResultFrame`, `eventTypeOf`) — vì nó cần cả tool_use block của frame `assistant` lẫn `tool_use_result` của frame `user`. `tool-results.ts` không đổi. API gợi ý:

```ts
const schedules = createScheduleObserver();
for await (const message of stream) {
  for (const event of schedules(message)) append(event.type, event.payload);
  // ... existing branches unchanged
}
```

Frame có nhiều block tool_result → bỏ structured result, fallback về input của tool_use (trường hợp thực tế là một block).

Timezone: `Intl.DateTimeFormat().resolvedOptions().timeZone`, memoized; rỗng → `"UTC"`.

Không đổi hành vi với tool khác; không phụ thuộc tên model.

### 5.3. Control DB (`packages/control-db`)

Migration mới trong `migrate()` (idempotent):

```sql
CREATE TABLE IF NOT EXISTS scheduled_tasks (
  schedule_id       TEXT PRIMARY KEY,   -- sched_<uuid>
  session_id        TEXT NOT NULL,
  owner_id          TEXT NOT NULL,
  workspace_id      TEXT NOT NULL,
  runner_id         TEXT NOT NULL,
  origin_attempt_id TEXT NOT NULL,      -- attempt đã tạo lịch (xem §5.4 double-fire)
  cli_task_id       TEXT,
  cron              TEXT NOT NULL,
  timezone          TEXT NOT NULL,
  recurring         INTEGER NOT NULL,
  prompt            TEXT NOT NULL,
  next_fire_at      INTEGER NOT NULL,   -- epoch ms
  state             TEXT NOT NULL DEFAULT 'active', -- active|done|cancelled|orphaned
  created_at        INTEGER NOT NULL,
  last_fired_at     INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS scheduled_tasks_origin_cli
  ON scheduled_tasks (origin_attempt_id, cli_task_id)
  WHERE cli_task_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS scheduled_tasks_due
  ON scheduled_tasks (state, next_fire_at);
```

Module `scheduled-tasks.ts`:

- `projectScheduleCreated(db, event)`: **validate payload trước khi ghi** — hiện chưa có schema-validation layer cho event payload ở server (`runner-gateway` chỉ validate envelope), nên hàm này tự kiểm tra shape và giới hạn (§5.1); sai → log + bỏ qua, không throw. Sau đó `INSERT OR IGNORE` (idempotent theo unique index — projection chạy cả cho event duplicate, §12.2). Lấy `owner_id/workspace_id/runner_id` từ `sessionPin`; không có pin → bỏ qua + log.
  - `next_fire_at`: dùng `nextFireAt` nếu hợp lệ (> 0); nếu vắng → parse cron với `timezone` tại `now`. Cron không parse được → không tạo row (log).
- `projectScheduleCancelled(db, event)`: tìm theo `(origin_attempt_id, cli_task_id)` → `state='cancelled'`. Không thấy → no-op (lịch đã done hoặc từ process cũ).
- `dueSchedules(db, now, limit)`, `advanceSchedule(db, id, {nextFireAt, state?, lastFiredAt})`, `cancelSchedule(db, id)`, `listActiveSchedules(db, sessionId)`.
- `computeNextFire(cron, tz, afterMs)` dùng `cron-parser` (đã xác nhận fetch được `cron-parser@5`, kèm `luxon`). Đây là dependency mới duy nhất của feature.

Projection được gọi trong `onEvents` của `server.ts`, cạnh `projectApprovalEvent` (chạy cho cả duplicate, bỏ qua conflict).

### 5.4. Control Server (`apps/control-server/src/scheduling`)

Tick loop khởi động trong `server.ts` sau khi gateway + scheduler đã wire (`setInterval`, mặc định 15s; clock và khoảng tick injectable để test), có cờ chống chồng tick và `clearInterval` khi server `stop()`:

```text
for row in dueSchedules(now):
  pin = sessionPin(row.session_id)          // không có → state='orphaned'
  active = scheduler.activeRunFor(row.session_id)
  if active?.attemptId === row.origin_attempt_id:
      advance(row)      // process tạo lịch còn sống → timer in-process sẽ tự chạy
      continue
  fireAt  = row.next_fire_at
  runId   = `run_sched_${row.schedule_id}_${fireAt}`   // deterministic (dedupe khi crash)
  if knownRun(runId)        // có row trong command_outbox/run_events/active_runs
      advance(row); continue
  decision = scheduler.dispatch({
      sessionId, runId, attemptId: uuid(), workspaceId: pin.workspaceId,
      prompt: row.prompt, ownerId: pin.ownerId,
      workspacePath: <declared path nếu có>,
      scheduleId: row.schedule_id,
  }, scheduler.capacityFor(pin.runnerId, { runnerId: pin.runnerId, state: "ready",
                                            maxConcurrentRuns: 1, activeRuns: 0 }))
  decision.ok ? advance(row, firedAt=now) : /* để nguyên due, retry tick sau */
```

**Bắt buộc mở rộng `Scheduler.activeRunFor`:** hiện trả `{ runId, runnerId }` và bỏ mất `attempt_id` dù cột có trong `active_runs`. Thêm `attemptId` vào kiểu trả về (không cần migration). Không có nó thì guard double-fire ở trên không viết được.

**Chuỗi `scheduleId` xuyên tầng (đủ 4 điểm nối):** `run.started` do **runner** append (`executor.ts`), không phải server. Đường đi: `DispatchRequest.scheduleId` → payload trong `Scheduler.dispatch` → cột `payload` của `command_outbox` → `Dispatcher` dựng lại frame → runner inbox → `executor` đọc `record["scheduleId"]` → `append("run.started", { ..., scheduleId })` → `chat-turns.ts` đọc payload. Thiếu bất kỳ mắt nào thì web không thấy nhãn.

Capacity dùng đúng như `runs-routes.ts`: `maxConcurrentRuns: 1` (server policy trong `server.ts` quảng cáo 4 nhưng route và handshake clamp về 1 — đừng lấy 4).

`advance(row)`:

- one-shot → `state='done'`, `last_fired_at=now`.
- recurring → `next_fire_at = computeNextFire(cron, tz, max(now, fireAt) + 1)`, `last_fired_at=now`.

**Failure policy:**

| Tình huống | Hành vi |
|---|---|
| Runner offline/not-ready, at capacity, session busy | Giữ nguyên due, retry mỗi tick; one-shot chạy muộn thay vì mất; recurring không catch-up (lần kế tiếp tính từ `now`) |
| Pin mất (session bị xoá) | `state='orphaned'` |
| Cron không parse được (dữ liệu cũ/hỏng) | `state='cancelled'` + log |
| Server restart | Row còn trong SQLite; tick chạy lại; `knownRun` chặn double-fire của fire dở dang |

**Double-fire guard:** timer in-process vẫn tồn tại trong process đã tạo lịch. Chỉ khi **chính attempt đó** còn active tại giờ hẹn thì mới nhường cho nó; process mới (user gửi tin khác) không có timer nên server phải fire. Nhánh `active?.attemptId === row.origin_attempt_id` là toàn bộ guard này.

**Crash window (chấp nhận, ghi nhận):** crash sau `dispatch` nhưng trước `advance` → lần boot sau `knownRun(runId)` phát hiện qua outbox/journal và chỉ advance. Crash sau `advance` trước `dispatch` không xảy ra vì `advance` luôn sau `dispatch`.

**CronDelete / huỷ từ web:** `DELETE /api/schedules/:scheduleId` (owner-scoped) → `state='cancelled'`. Không emit journal event ở MVP.

**List:** `GET /api/sessions/:sessionId/schedules` → các row `active` của session (owner-scoped).

### 5.5. Web (`apps/web`)

1. **Chat rendering** — `chat-turns.ts`: nếu `run.started` payload có `scheduleId` (kèm `cron` nếu có), user turn được đánh dấu `source: "schedule"`; `UserChatBubble.vue` render dạng dòng hệ thống gọn (icon đồng hồ + "Tác vụ theo lịch · `<cron>`" + nội dung prompt) thay vì bubble người dùng. Agent turn phía sau hiển thị bình thường (continuation đã có từ `35ad050`).
2. **Danh sách + huỷ** — thêm tab/mục "Lịch" trong `InspectPanel.vue`: gọi 2 endpoint ở §5.4, hiển thị cron, prompt rút gọn, lần chạy kế tiếp; nút huỷ.
3. Không thêm UI tạo lịch — việc tạo vẫn diễn ra trong hội thoại.

### 5.6. Docs

- `docs/ARCHITECTURE.md`: mục mới "Scheduled tasks" (nguồn sự thật, tick, policy, giới hạn).
- `docs/adr/0016-scheduled-tasks-owned-by-control-server.md`: quyết định + lý do loại bỏ phương án giữ process.

---

## 6. Quyết định thiết kế (calls)

| # | Quyết định | Lý do |
|---|---|---|
| D1 | Mirror từ structured `tool_use_result`, không parse text | `@anthropic-ai/claude-agent-sdk@0.3.309` trả `CronCreateOutput {id, humanSchedule, recurring, durable?, nextFireAt?}` (khớp `sdk-tools.d.ts`) |
| D2 | `nextFireAt` đầu tiên lấy từ CLI; các lần sau server tự tính (`cron-parser` + tz) | Server phải sống độc lập với process tạo lịch |
| D3 | One-shot chạy muộn (retry mỗi tick) nếu runner offline | Mất task âm thầm là anti-goal; chạy muộn còn hơn không |
| D4 | Recurring không catch-up | Tránh "bão" run dồn nếu runner offline lâu |
| D5 | Skip dispatch khi chính `origin_attempt_id` còn active | Timer in-process đang sống — tránh double-fire |
| D6 | `runId` deterministic theo `(schedule, fireAt)` + kiểm tra outbox/journal | Chống double-fire khi server crash giữa dispatch và advance |
| D7 | Không emit journal event khi huỷ từ web (MVP) | Row state + list API đủ; event có thể thêm sau |
| D8 | `scheduleId` đi kèm `run.started` | UI phân biệt turn theo lịch; không cần nhìn event riêng. Chuỗi 4 điểm nối ở §5.4 |
| D9 | Tick 15s, tuần tự, injectable, clear khi stop | Đủ mịn cho cron phút; test tất định |
| D10 | Mở rộng `Scheduler.activeRunFor` trả thêm `attemptId` | Cột đã có trong `active_runs`; guard double-fire cần nó |
| D11 | Observer lịch chạy trên raw frame trong executor, `tool-results.ts` không đổi | Cần cả tool_use input lẫn `tool_use_result` frame-level |
| D12 | Validate payload trong projection | Server chưa có schema-validation cho payload; projection là chốt chặn cuối |

---

## 7. Edge cases & failure modes

| # | Case | Hành vi |
|---|---|---|
| E1 | Cron tạo đúng phút hiện tại, `nextFireAt` đã qua | Fire ngay tick kế tiếp |
| E2 | Runner restart trước giờ hẹn | Lịch trong SQLite vẫn còn; tick fire khi runner ready lại |
| E3 | Server restart trước giờ hẹn | Như E2 |
| E4 | Model gọi `CronDelete` trong process mới (khác process tạo) | `cliTaskId` không khớp → no-op; UI cancel là đường huỷ bền vững (limitation §10.2) |
| E5 | Model gọi `CronList` trong process mới | Trả "No scheduled jobs" (limitation §10.2) |
| E6 | Session bị xoá khi lịch còn pending | `state='orphaned'` ở tick kế tiếp |
| E7 | Prompt của lịch chứa secret | Đã qua redaction hiện có khi vào journal; prompt đã nằm trong `message.completed` từ trước |
| E8 | Hai lịch cùng session cùng đến hạn | Một cái dispatch, cái kia `session_busy` → bị đẩy sang tick sau (chạy muộn) |
| E9 | Lịch tạo trong một run bị `run.failed` sau đó | Event `schedule.created` đã commit trước khi fail → lịch vẫn sống (đúng: tool đã chạy thành công) |
| E10 | Runner cũ chưa biết event type mới | Chỉ ảnh hưởng khi server mới + runner cũ: frame bị từ chối; ship cùng nhau, ghi chú compatibility |

---

## 8. Testing

- **protocol**: `event-types.test.ts` — 2 type mới được chấp nhận; completeness check biên dịch.
- **runner**: `schedule-events.test.ts` — tương quan tool_use/tool_result; structured result; fallback input; `is_error` → không emit; CronDelete; timezone; frame nhiều block.
- **control-db**: projection idempotent (duplicate delivery), payload validation (shape/limits), cancel theo cli id, due query, advance, `computeNextFire` (one-shot/recurring/tz), `activeRunFor` trả `attemptId`.
- **control-server**: tick fire đúng một lần; skip khi origin attempt active; retry khi offline/busy; `knownRun` dedupe; list/cancel API owner-scoped; gateway validate event type mới; `scheduleId` đi trọn chuỗi tới `run.started`.
- **web**: `chat-turns.test.ts` — run có `scheduleId` render turn "theo lịch"; bubble; list/cancel component test.
- **manual end-to-end probe** (bắt buộc trước khi coi là xong): tạo one-shot ~2 phút, kết thúc run ngay, verify fire đúng phút + chat hiển thị đúng nhãn; tạo recurring 1 phút × 3 lần.

Gate: `bun test`, `bun run typecheck`, `bun run lint`, `cd apps/web && bun run build`.

---

## 9. Thứ tự triển khai (sẽ chốt trong plan)

1. P0 — Protocol + runner mirror events (+ tests).
2. P1 — Control DB: migration, projection, helpers (+ tests).
3. P2 — Control server: ingest wiring, tick loop, list/cancel API (+ tests).
4. P3 — Web: render turn theo lịch, panel Lịch (+ tests).
5. P4 — Docs (ARCHITECTURE.md, ADR), manual probe, dọn dẹp.

---

## 10. Giới hạn đã biết

1. **CronList/CronDelete trong process mới không thấy lịch server-side.** Lịch sống ở server; process CLI mới không có session cron in-memory. Hệ quả: model có thể tạo trùng nếu không được nhắc; `CronDelete` chỉ hoạt động trong chính process đã tạo. Giảm thiểu MVP: UI list/cancel; ghi rõ trong docs. Hướng sau: inject danh sách lịch đang hoạt động vào ngữ cảnh run (system note) hoặc deny `CronList` và cung cấp tool riêng.
2. **`durable: false` của CLI** vẫn đúng với process; tính bền vững là của cc-web, không phải của CLI.
3. **Crash window** giữa dispatch và advance: đã xử lý bằng `knownRun`; trường hợp command đã enqueue nhưng chưa có event nào và chưa có trong outbox-read thì có thể retry — cực hiếm, chấp nhận (at-least-once phía task).
4. **Compatibility**: 2 event type mới là additive; server hiện tại từ chối frame chứa type lạ, nên server và runner phải được nâng cấp cùng nhau.
5. **DST/timezone**: cron được diễn giải theo IANA tz của runner qua `cron-parser`; khác biệt DST trivial hiếm, chấp nhận.

---

## 11. Câu hỏi mở

Không còn câu hỏi chặn triển khai. Các điểm có thể đổi ý (ghi nhận, không chặn):

- Có cần UI tạo/sửa lịch thủ công ngoài hội thoại không (hiện là non-goal)?
- Có cần thông báo khi một lịch bị bỏ lỡ hẳn (runner offline quá lâu) không (hiện chỉ retry)?
