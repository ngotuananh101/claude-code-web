# Scheduled Tasks do Control Server sở hữu (Scheduled Tasks Owned by the Control Server) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Task do agent tạo bằng `CronCreate` được mirror bền vững sang Control Server; đến giờ Control Server enqueue một run bình thường vào đúng session, kết quả hiện trong chat với nhãn "tác vụ theo lịch", và người dùng xem/huỷ được lịch từ web.

**Architecture:** Runner chỉ quan sát frame SDK và mirror hai event mới (`schedule.created` / `schedule.cancelled`) qua outbox như mọi event khác. Control Server project event vào bảng `scheduled_tasks` trong SQLite, chạy một tick tuần tự mỗi 15 giây, và biến mỗi lần đến hạn thành một `Scheduler.dispatch` y như người dùng gửi tin — không giữ process CLI sống, không đổi capacity/lock model.

**Tech Stack:** Bun + TypeScript, `bun:sqlite`, `cron-parser@^5.10.2` (dependency mới duy nhất, kéo theo `luxon`), `@anthropic-ai/claude-agent-sdk@0.3.309` (chỉ trong `packages/agent-adapter`), Vue 3 + Tailwind + Lucide.

**Spec:** `docs/superpowers/specs/2026-10-31-scheduled-tasks-design.md`

## Global Constraints

- Không sửa/lint/format file sinh bởi shadcn-vue: `apps/web/src/components/ui/**`, `apps/web/src/lib/utils.ts`, `apps/web/src/styles/index.css`, `apps/web/components.json`.
- Event type mới là additive: thêm vào **cả** union `EventType` và list `EVENT_TYPES` của `packages/protocol/src/index.ts` (compile-time completeness check sẽ bắt nếu thiếu một bên). Không đổi `PROTOCOL_VERSION`.
- Chỉ `packages/agent-adapter` được import SDK. Runner làm việc trên raw frame `Record<string, unknown>`; không import SDK.
- Journal là nguồn sự thật (§12). Projection chạy cho cả event duplicate, bỏ qua conflict, **không bao giờ throw** — lỗi chỉ log và bỏ qua.
- Migration phải idempotent (`CREATE TABLE IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`) vì `migrate()` chạy mỗi boot.
- Invariant giữ nguyên: một active run/session (§2.3), capacity/runner là 1 khi dispatch (`maxConcurrentRuns: 1` — không lấy 4 từ policy), workspace lock không bị chiếm khi chờ lịch.
- Dependency mới duy nhất: `cron-parser@^5.10.2` trong `packages/control-db`. Không thêm `luxon` trực tiếp (nó là transitive dependency của `cron-parser`).
- `exactOptionalPropertyTypes: true`: field optional phải được **bỏ qua** bằng conditional spread, không được gán `undefined`.
- Mã nguồn, comment, tên định danh, commit message bằng tiếng Anh. UI text (nhãn, thông báo, toast) bằng tiếng Việt. Docs repo: `ARCHITECTURE.md` tiếng Việt, ADR tiếng Anh (theo `docs/adr/README.md`).
- Trước mọi lệnh bun: `export PATH="$HOME/.ponta/bin:$PATH"`. Gates đầy đủ: `bun test`, `bun run typecheck`, `bun run lint`; riêng task web thêm `cd apps/web && bun run build`.
- Kiểm tra `git status` trước mỗi commit; chỉ `git add` đúng các file của task.

## Review Focus

- `nextFireAt` đã ở quá khứ khi lịch vừa được tạo (cron trỏ đúng phút hiện tại): tick kế tiếp phải fire, không được bỏ qua — test "a one-shot already due fires on the next tick" (Task 6).
- Event `schedule.created` được giao **hai lần** (at-least-once, projection chạy cả cho duplicate): chỉ được tạo đúng một row, không nhân đôi lịch — test "projecting the same event twice creates one row" (Task 4).
- Cron không parse được hoặc timezone rác (dữ liệu cũ, model gửi 6-field lạ): projection bỏ qua row; lịch lặp có cron hỏng khi advance phải chuyển `cancelled` + log, không crash tick — tests "an unparseable cron with no nextFireAt creates no row" (Task 4) và "a repeating row whose cron stopped parsing is cancelled" (Task 6).
- Hai lịch của cùng một session đến hạn trong cùng một tick: chỉ một run được dispatch, lịch còn lại nằm nguyên `due` và chạy ở tick sau khi slot freed — test "two due schedules for one session dispatch one and retry the other" (Task 6).
- Frame `tool_result` có nhiều block, hoặc `CronCreate` trả `is_error`: không được sinh `schedule.created` sai — tests "a multi-block result frame ignores the frame-level structured result" và "an error result mirrors nothing" (Task 2).

---

## Chuẩn bị (trước Task 1)

- [ ] **Commit tài liệu đã duyệt**

```bash
export PATH="$HOME/.ponta/bin:$PATH"
git status --short
git add docs/superpowers/specs/2026-10-31-scheduled-tasks-design.md docs/superpowers/plans/2026-10-31-scheduled-tasks.md
git commit -m "docs: add scheduled tasks design and implementation plan"
```

---

### Task 1: Protocol — event types và payload contracts

**Files:**
- Modify: `packages/protocol/src/index.ts:89-141` (union + `EVENT_TYPES`)
- Create: `packages/protocol/src/schedules.ts`
- Modify: `packages/protocol/src/index.ts` (export block — thêm export của `schedules.ts`)
- Test: `packages/protocol/src/event-types.test.ts`
- Test: `packages/protocol/src/schedules.test.ts`

**Interfaces:**
- Consumes: không.
- Produces:
  - `EventType` thêm `"schedule.created" | "schedule.cancelled"`; `EVENT_TYPES` thêm đúng hai chuỗi đó.
  - `type ScheduleState = "active" | "done" | "cancelled" | "orphaned"`
  - `type ScheduleCreatedPayload = { toolCallId: string; cliTaskId?: string; cron: string; recurring: boolean; prompt: string; nextFireAt?: number; timezone: string }`
  - `type ScheduleCancelledPayload = { toolCallId: string; cliTaskId: string }`
  - `type ScheduledTask = { scheduleId: string; sessionId: string; cron: string; timezone: string; recurring: boolean; prompt: string; nextFireAt: number; state: ScheduleState; createdAt: number; lastFiredAt?: number }`
  - `parseScheduleCreatedPayload(value: unknown): ScheduleCreatedPayload | undefined`
  - `parseScheduleCancelledPayload(value: unknown): ScheduleCancelledPayload | undefined`

Giới hạn validation (spec §5.1): `toolCallId` chuỗi khác rỗng ≤ 200; `cliTaskId` tuỳ chọn, chuỗi khác rỗng ≤ 200; `cron` chuỗi 1..200; `recurring` boolean; `prompt` chuỗi khác rỗng ≤ 4000; `nextFireAt` tuỳ chọn, số hữu hạn > 0; `timezone` chuỗi khác rỗng ≤ 100.

- [ ] **Step 1: Viết test fail cho event types**

Thêm vào `packages/protocol/src/event-types.test.ts`:

```ts
test("schedule.created and schedule.cancelled are known event types", () => {
  expect(EVENT_TYPES).toContain("schedule.created" as EventType);
  expect(EVENT_TYPES).toContain("schedule.cancelled" as EventType);
});
```

- [ ] **Step 2: Chạy test để chắc nó fail**

Run: `export PATH="$HOME/.ponta/bin:$PATH" && bun test packages/protocol/src/event-types.test.ts`
Expected: FAIL — `EVENT_TYPES` không chứa `"schedule.created"`.

- [ ] **Step 3: Thêm hai type vào union và `EVENT_TYPES`**

Thêm `| "schedule.created"` và `| "schedule.cancelled"` vào cuối union `EventType` (sau `"session.updated"`), và hai chuỗi tương ứng vào cuối mảng `EVENT_TYPES`. Compile-time check `_EventTypesAreComplete` sẽ tự xác nhận hai bên khớp.

- [ ] **Step 4: Chạy test để chắc nó pass**

Run: `export PATH="$HOME/.ponta/bin:$PATH" && bun test packages/protocol/src/event-types.test.ts`
Expected: PASS.

- [ ] **Step 5: Viết test fail cho payload parsers**

Tạo `packages/protocol/src/schedules.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { parseScheduleCancelledPayload, parseScheduleCreatedPayload } from "./schedules.ts";

const valid = {
  toolCallId: "toolu_01abc",
  cliTaskId: "af5c4b05",
  cron: "58 17 31 10 *",
  recurring: false,
  prompt: "Kiểm tra dung lượng ổ đĩa",
  nextFireAt: 1793444280000,
  timezone: "Asia/Ho_Chi_Minh",
};

describe("parseScheduleCreatedPayload", () => {
  test("accepts the runner's full payload", () => {
    expect(parseScheduleCreatedPayload(valid)).toEqual(valid);
  });

  test("omits absent optional fields instead of inventing them", () => {
    const { cliTaskId, nextFireAt, ...minimal } = valid;
    expect(parseScheduleCreatedPayload(minimal)).toEqual(minimal);
  });

  test("rejects a cron longer than 200 characters", () => {
    expect(parseScheduleCreatedPayload({ ...valid, cron: "x".repeat(201) })).toBeUndefined();
  });

  test("rejects an empty prompt", () => {
    expect(parseScheduleCreatedPayload({ ...valid, prompt: "" })).toBeUndefined();
  });

  test("rejects a non-boolean recurring", () => {
    expect(parseScheduleCreatedPayload({ ...valid, recurring: "false" })).toBeUndefined();
  });

  test("rejects a non-positive nextFireAt", () => {
    expect(parseScheduleCreatedPayload({ ...valid, nextFireAt: -5 })).toBeUndefined();
  });

  test("rejects a missing toolCallId and a missing timezone", () => {
    const { toolCallId, ...noToolCall } = valid;
    const { timezone, ...noTimezone } = valid;
    expect(parseScheduleCreatedPayload(noToolCall)).toBeUndefined();
    expect(parseScheduleCreatedPayload(noTimezone)).toBeUndefined();
  });

  test("rejects non-objects and arrays", () => {
    expect(parseScheduleCreatedPayload(null)).toBeUndefined();
    expect(parseScheduleCreatedPayload(["cron"])).toBeUndefined();
  });
});

describe("parseScheduleCancelledPayload", () => {
  test("accepts toolCallId and cliTaskId", () => {
    expect(parseScheduleCancelledPayload({ toolCallId: "toolu_1", cliTaskId: "af5c4b05" })).toEqual({
      toolCallId: "toolu_1",
      cliTaskId: "af5c4b05",
    });
  });

  test("rejects a missing cliTaskId", () => {
    expect(parseScheduleCancelledPayload({ toolCallId: "toolu_1" })).toBeUndefined();
  });
});
```

- [ ] **Step 6: Chạy test để chắc nó fail**

Run: `export PATH="$HOME/.ponta/bin:$PATH" && bun test packages/protocol/src/schedules.test.ts`
Expected: FAIL — không resolve được `./schedules.ts`.

- [ ] **Step 7: Viết `packages/protocol/src/schedules.ts`**

Cài đặt hai parser với đúng giới hạn ở Interfaces, trả object đã chuẩn hoá chỉ gồm các field hợp lệ (optional vắng thì không có key). Xuất type `ScheduledTask`, `ScheduleState`, `ScheduleCreatedPayload`, `ScheduleCancelledPayload`. Dùng `typeof value === "object" && value !== null && !Array.isArray(value)` làm cổng đầu tiên.

- [ ] **Step 8: Export module mới từ `packages/protocol/src/index.ts`**

Thêm `export { ... } from "./schedules.ts";` theo đúng phong cách các export hiện có (named exports, không `export *`).

- [ ] **Step 9: Chạy test + gate**

Run: `export PATH="$HOME/.ponta/bin:$PATH" && bun test packages/protocol && bun run typecheck && bun run lint`
Expected: PASS toàn bộ.

- [ ] **Step 10: Commit**

```bash
git add packages/protocol/src/index.ts packages/protocol/src/schedules.ts packages/protocol/src/schedules.test.ts packages/protocol/src/event-types.test.ts
git commit -m "feat(protocol): add scheduled-task events and payload contracts"
```

---

### Task 2: Runner — schedule observer trên raw frame + nối vào executor

**Files:**
- Create: `apps/runner/src/execution/schedule-events.ts`
- Create: `apps/runner/src/execution/schedule-events.test.ts`
- Modify: `apps/runner/src/execution/executor.ts:475-519` (vòng lặp `for await`)
- Test: `apps/runner/src/execution/executor.test.ts` (thêm một test)

**Interfaces:**
- Consumes: `ScheduleCreatedPayload`, `ScheduleCancelledPayload` từ `@cc-web/protocol` (Task 1).
- Produces:
  - `type ScheduleEvent = { type: "schedule.created"; payload: ScheduleCreatedPayload } | { type: "schedule.cancelled"; payload: ScheduleCancelledPayload }`
  - `createScheduleObserver(options?: { timezone?: string }): (message: Record<string, unknown>) => ScheduleEvent[]`

Hành vi (spec §5.2): ghi nhớ block `tool_use` của frame `assistant` theo `id` (chỉ giữ `CronCreate`/`CronDelete`); khi gặp frame `user` chứa `tool_result`, tra theo `tool_use_id`, bỏ qua nếu `is_error === true`; `CronCreate` dựng `schedule.created` từ frame-level `tool_use_result` (ưu tiên) với fallback về `input`, `CronDelete` dựng `schedule.cancelled` từ `input.id`. Frame có nhiều hơn một block `tool_result` → bỏ qua `tool_use_result` của frame và dùng fallback `input` cho từng block.

- [ ] **Step 1: Viết test fail cho observer**

Tạo `apps/runner/src/execution/schedule-events.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { createScheduleObserver } from "./schedule-events.ts";

function assistant(...content: unknown[]): Record<string, unknown> {
  return { type: "assistant", message: { role: "assistant", content } };
}

function result(toolUseResult: unknown, ...content: unknown[]): Record<string, unknown> {
  return {
    type: "user",
    message: { role: "user", content },
    ...(toolUseResult === undefined ? {} : { tool_use_result: toolUseResult }),
  };
}

const cronCreateUse = {
  type: "tool_use",
  id: "toolu_1",
  name: "CronCreate",
  input: {
    cron: "58 17 31 10 *",
    recurring: false,
    prompt: "Kiểm tra dung lượng ổ đĩa",
  },
};

const structured = {
  id: "af5c4b05",
  humanSchedule: "58 17 31 10 *",
  recurring: false,
  durable: false,
  nextFireAt: 1793444280000,
};

describe("createScheduleObserver", () => {
  test("a successful CronCreate mirrors the structured result", () => {
    const observe = createScheduleObserver({ timezone: "Asia/Ho_Chi_Minh" });
    expect(observe(assistant(cronCreateUse))).toEqual([]);
    const events = observe(
      result(structured, { type: "tool_result", tool_use_id: "toolu_1", content: "Scheduled" }),
    );
    expect(events).toEqual([
      {
        type: "schedule.created",
        payload: {
          toolCallId: "toolu_1",
          cliTaskId: "af5c4b05",
          cron: "58 17 31 10 *",
          recurring: false,
          prompt: "Kiểm tra dung lượng ổ đĩa",
          nextFireAt: 1793444280000,
          timezone: "Asia/Ho_Chi_Minh",
        },
      },
    ]);
  });

  test("without a structured result the tool input is the fallback", () => {
    const observe = createScheduleObserver({ timezone: "UTC" });
    observe(assistant(cronCreateUse));
    const events = observe(
      result(undefined, { type: "tool_result", tool_use_id: "toolu_1", content: "ok" }),
    );
    expect(events).toEqual([
      {
        type: "schedule.created",
        payload: {
          toolCallId: "toolu_1",
          cron: "58 17 31 10 *",
          recurring: false,
          prompt: "Kiểm tra dung lượng ổ đĩa",
          timezone: "UTC",
        },
      },
    ]);
  });

  test("an error result mirrors nothing", () => {
    const observe = createScheduleObserver({ timezone: "UTC" });
    observe(assistant(cronCreateUse));
    expect(
      observe(
        result(undefined, {
          type: "tool_result",
          tool_use_id: "toolu_1",
          is_error: true,
          content: "invalid cron",
        }),
      ),
    ).toEqual([]);
  });

  test("CronDelete mirrors a cancellation", () => {
    const observe = createScheduleObserver({ timezone: "UTC" });
    observe(
      assistant({
        type: "tool_use",
        id: "toolu_2",
        name: "CronDelete",
        input: { id: "af5c4b05" },
      }),
    );
    expect(
      observe(result(undefined, { type: "tool_result", tool_use_id: "toolu_2", content: "deleted" })),
    ).toEqual([
      { type: "schedule.cancelled", payload: { toolCallId: "toolu_2", cliTaskId: "af5c4b05" } },
    ]);
  });

  test("a multi-block result frame ignores the frame-level structured result", () => {
    const observe = createScheduleObserver({ timezone: "UTC" });
    observe(assistant(cronCreateUse));
    observe(
      assistant({
        type: "tool_use",
        id: "toolu_9",
        name: "CronDelete",
        input: { id: "other-task" },
      }),
    );
    const events = observe(
      result(structured, { type: "tool_result", tool_use_id: "toolu_1", content: "ok" }, {
        type: "tool_result",
        tool_use_id: "toolu_9",
        content: "deleted",
      }),
    );
    expect(events).toEqual([
      {
        type: "schedule.created",
        payload: {
          toolCallId: "toolu_1",
          cron: "58 17 31 10 *",
          recurring: false,
          prompt: "Kiểm tra dung lượng ổ đĩa",
          timezone: "UTC",
        },
      },
      { type: "schedule.cancelled", payload: { toolCallId: "toolu_9", cliTaskId: "other-task" } },
    ]);
  });

  test("non-cron tools are ignored", () => {
    const observe = createScheduleObserver({ timezone: "UTC" });
    observe(assistant({ type: "tool_use", id: "toolu_3", name: "Bash", input: { command: "ls" } }));
    expect(
      observe(result(undefined, { type: "tool_result", tool_use_id: "toolu_3", content: "a" })),
    ).toEqual([]);
  });

  test("a tool_result without a remembered tool_use is ignored", () => {
    const observe = createScheduleObserver({ timezone: "UTC" });
    expect(
      observe(result(structured, { type: "tool_result", tool_use_id: "toolu_x", content: "ok" })),
    ).toEqual([]);
  });

  test("the default timezone is a non-empty IANA name", () => {
    const observe = createScheduleObserver();
    observe(assistant(cronCreateUse));
    const events = observe(
      result(undefined, { type: "tool_result", tool_use_id: "toolu_1", content: "ok" }),
    );
    const payload = events[0]?.payload as { timezone?: unknown };
    expect(typeof payload.timezone).toBe("string");
    expect(String(payload.timezone).length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Chạy test để chắc nó fail**

Run: `export PATH="$HOME/.ponta/bin:$PATH" && bun test apps/runner/src/execution/schedule-events.test.ts`
Expected: FAIL — không resolve được `./schedule-events.ts`.

- [ ] **Step 3: Cài đặt `createScheduleObserver`**

Cấu trúc cốt lõi (phần tương quan giữa hai frame là thứ test không tự suy ra được):

```ts
const pending = new Map<string, { name: string; input: Record<string, unknown> }>();

return (message) => {
  const events: ScheduleEvent[] = [];
  if (message["type"] === "assistant") {
    // ghi nhớ tool_use CronCreate/CronDelete theo id
    return events; // assistant frame không bao giờ emit
  }
  if (message["type"] !== "user") return events;
  const content = (message["message"] as { content?: unknown[] } | undefined)?.content;
  if (!Array.isArray(content)) return events;
  const blocks = content.filter(isToolResultBlock); // type === "tool_result" và tool_use_id khác rỗng
  const structured = blocks.length === 1 ? asRecord(message["tool_use_result"]) : null;
  for (const block of blocks) {
    const use = pending.get(block.tool_use_id as string);
    pending.delete(block.tool_use_id as string);
    if (use === undefined || block["is_error"] === true) continue;
    // CronCreate: cron = structured.humanSchedule ?? use.input.cron; recurring = structured.recurring ?? use.input.recurring ?? false
    //   prompt = use.input.prompt (bắt buộc non-empty); cliTaskId = structured.id (nếu string khác rỗng)
    //   nextFireAt = structured.nextFireAt (chỉ khi number hữu hạn > 0)
    // CronDelete: cliTaskId = use.input.id (bắt buộc string khác rỗng)
    // Thiếu field bắt buộc → không emit event nào cho block đó
  }
  return events;
};
```

Timezone: `const zone = options.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone; const timezone = typeof zone === "string" && zone !== "" ? zone : "UTC";` tính một lần khi tạo observer.

- [ ] **Step 4: Chạy test để chắc nó pass**

Run: `export PATH="$HOME/.ponta/bin:$PATH" && bun test apps/runner/src/execution/schedule-events.test.ts`
Expected: PASS.

- [ ] **Step 5: Viết test fail cho việc nối vào executor**

Thêm vào `apps/runner/src/execution/executor.test.ts` (dùng `setup()`, `COMMAND`, `events(db)` sẵn có):

```ts
test("CronCreate is mirrored as schedule.created in the attempt's own sequence", async () => {
  const { db } = setup();
  beginAttempt(db, {
    attemptId: "attempt-1",
    sessionId: "session-1",
    runId: "run-1",
    workspacePath: "/home/runner/project",
  });
  const sdk: SdkStream = () => ({
    async *[Symbol.asyncIterator]() {
      yield {
        type: "assistant",
        message: {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "toolu_1",
              name: "CronCreate",
              input: { cron: "58 17 31 10 *", recurring: false, prompt: "Kiểm tra dung lượng" },
            },
          ],
        },
      };
      yield {
        type: "user",
        message: {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "Scheduled" }],
        },
        tool_use_result: {
          id: "af5c4b05",
          humanSchedule: "58 17 31 10 *",
          recurring: false,
          nextFireAt: 1793444280000,
        },
      };
      yield { type: "result", subtype: "success", is_error: false };
    },
  });

  await executeRun(db, COMMAND, { workspacePath: "/home/runner/project", sdk });

  const rows = events(db);
  const mirrored = rows.find((row) => row.type === "schedule.created");
  expect(mirrored).toBeDefined();
  expect(JSON.parse(mirrored!.payload)).toMatchObject({
    toolCallId: "toolu_1",
    cliTaskId: "af5c4b05",
    cron: "58 17 31 10 *",
    recurring: false,
    prompt: "Kiểm tra dung lượng",
    nextFireAt: 1793444280000,
  });
  // The mirror sits between run.started and the terminal event.
  const types = rows.map((row) => row.type);
  expect(types.indexOf("schedule.created")).toBeGreaterThan(types.indexOf("run.started"));
  expect(types.indexOf("schedule.created")).toBeLessThan(types.lastIndexOf("run.finished"));
});
```

- [ ] **Step 6: Chạy test để chắc nó fail**

Run: `export PATH="$HOME/.ponta/bin:$PATH" && bun test apps/runner/src/execution/executor.test.ts`
Expected: FAIL — `schedule.created` không có trong outbox.

- [ ] **Step 7: Nối observer vào vòng lặp executor**

Trong `executor.ts`, ngay trước `for await (const message of stream)`, tạo `const schedules = createScheduleObserver();`. Trong vòng lặp, sau bước parse `sdkMessage` và **trước mọi nhánh** (`system init`, `stream_event`, `isToolResultFrame`), thêm:

```ts
for (const event of schedules(sdkMessage)) append(event.type, event.payload);
```

Không đổi `tool-results.ts`, không đổi các nhánh hiện có.

- [ ] **Step 8: Chạy test + gate**

Run: `export PATH="$HOME/.ponta/bin:$PATH" && bun test apps/runner && bun run typecheck && bun run lint`
Expected: PASS toàn bộ.

- [ ] **Step 9: Commit**

```bash
git add apps/runner/src/execution/schedule-events.ts apps/runner/src/execution/schedule-events.test.ts apps/runner/src/execution/executor.ts apps/runner/src/execution/executor.test.ts
git commit -m "feat(runner): mirror CronCreate/CronDelete tool results as schedule events"
```

---

### Task 3: Control DB — schema `scheduled_tasks`, `cron-parser`, `activeRunFor` trả `attemptId`

**Files:**
- Modify: `packages/control-db/package.json` (dependency `cron-parser`)
- Modify: `packages/control-db/src/db.ts:282-286` (thêm DDL trước dấu `}` đóng `migrate`)
- Modify: `packages/control-db/src/scheduler.ts:107` (`ActiveRow`) và `:261-266` (`activeRunFor`)
- Test: `packages/control-db/src/db.test.ts`
- Test: `packages/control-db/src/scheduler.test.ts`

**Interfaces:**
- Consumes: không.
- Produces:
  - Bảng `scheduled_tasks` + 2 index (schema ở spec §5.3).
  - `Scheduler.activeRunFor(sessionId: string): { runId: string; runnerId: string; attemptId: string } | undefined` — thêm `attemptId` (D10; cột đã có trong `active_runs`, không cần migration).

- [ ] **Step 1: Thêm dependency**

Run: `export PATH="$HOME/.ponta/bin:$PATH" && bun add cron-parser@^5.10.2 --cwd packages/control-db`
Expected: `package.json` của `packages/control-db` có `"cron-parser": "^5.10.2"`; `bun.lock` cập nhật; `luxon` xuất hiện như transitive dependency.

- [ ] **Step 2: Viết test fail cho migration**

Thêm vào `packages/control-db/src/db.test.ts`:

```ts
test("scheduled_tasks and its indexes exist after two migrations", () => {
  const db = new Database(":memory:");
  migrate(db);
  migrate(db); // idempotent: the server calls migrate() on every boot

  const tables = db
    .query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'scheduled_tasks'")
    .all();
  expect(tables).toHaveLength(1);

  const indexes = db
    .query(
      "SELECT name FROM sqlite_master WHERE type = 'index' AND name IN ('scheduled_tasks_origin_cli', 'scheduled_tasks_due')",
    )
    .all() as Array<{ name: string }>;
  expect(indexes.map((row) => row.name).sort()).toEqual([
    "scheduled_tasks_due",
    "scheduled_tasks_origin_cli",
  ]);
});
```

- [ ] **Step 3: Chạy test để chắc nó fail**

Run: `export PATH="$HOME/.ponta/bin:$PATH" && bun test packages/control-db/src/db.test.ts`
Expected: FAIL — bảng chưa tồn tại.

- [ ] **Step 4: Thêm DDL vào `migrate()`**

Chép nguyên văn schema ở spec §5.3 (bảng + unique partial index `scheduled_tasks_origin_cli` + index `scheduled_tasks_due`), đặt cạnh các bảng hiện có trong `migrate()`, kèm comment ngắn giải thích nguồn (projection từ `schedule.created`, tick đọc theo `(state, next_fire_at)`).

- [ ] **Step 5: Viết test fail cho `activeRunFor`**

Thêm vào `packages/control-db/src/scheduler.test.ts`:

```ts
test("activeRunFor answers the attempt id the double-fire guard needs", async () => {
  const { scheduler } = setup();
  await scheduler.dispatch(request, capacity());

  expect(scheduler.activeRunFor("session-1")).toEqual({
    runId: "run-1",
    runnerId: "runner-a",
    attemptId: "attempt-1",
  });
});
```

- [ ] **Step 6: Chạy test để chắc nó fail**

Run: `export PATH="$HOME/.ponta/bin:$PATH" && bun test packages/control-db/src/scheduler.test.ts`
Expected: FAIL — object trả về không có `attemptId`.

- [ ] **Step 7: Mở rộng `ActiveRow` và `activeRunFor`**

`ActiveRow` thêm `attempt_id: string`; câu query `SELECT run_id, runner_id, attempt_id FROM active_runs WHERE session_id = ?`; kiểu trả về và object trả về thêm `attemptId: row.attempt_id`. Không đổi `release`, `capacityFor`, `dispatch`.

- [ ] **Step 8: Chạy test + gate**

Run: `export PATH="$HOME/.ponta/bin:$PATH" && bun test packages/control-db && bun run typecheck && bun run lint`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add packages/control-db/package.json bun.lock packages/control-db/src/db.ts packages/control-db/src/db.test.ts packages/control-db/src/scheduler.ts packages/control-db/src/scheduler.test.ts
git commit -m "feat(control-db): add scheduled_tasks schema and expose attemptId on active runs"
```

---

### Task 4: Control DB — module `scheduled-tasks` (projection, computeNextFire, due/advance/cancel/list/runKnown)

**Files:**
- Create: `packages/control-db/src/scheduled-tasks.ts`
- Create: `packages/control-db/src/scheduled-tasks.test.ts`
- Modify: `packages/control-db/src/index.ts` (export block)

**Interfaces:**
- Consumes: `parseScheduleCreatedPayload`, `parseScheduleCancelledPayload`, `ScheduleState`, `ScheduledTask` (Task 1); bảng `scheduled_tasks` và `activeRunFor` (Task 3); `sessionPin` (đã có).
- Produces (tất cả từ `@cc-web/control-db`):
  - `type ScheduleRecord = { scheduleId: string; sessionId: string; ownerId: string; workspaceId: string; runnerId: string; originAttemptId: string; cliTaskId?: string; cron: string; timezone: string; recurring: boolean; prompt: string; nextFireAt: number; state: ScheduleState; createdAt: number; lastFiredAt?: number }`
  - `computeNextFire(cron: string, timezone: string, afterMs: number): number | undefined`
  - `projectScheduleEvent(db: Database, event: { type: string; sessionId: string; attemptId: string; payload: unknown }): void`
  - `dueSchedules(db: Database, now: number, limit?: number): ScheduleRecord[]` (mặc định `limit = 20`)
  - `advanceSchedule(db: Database, scheduleId: string, input: { state: ScheduleState; nextFireAt?: number; lastFiredAt?: number }): void`
  - `cancelScheduleForOwner(db: Database, scheduleId: string, ownerId: string): boolean`
  - `listActiveSchedules(db: Database, sessionId: string): ScheduledTask[]`
  - `runKnown(db: Database, runId: string): boolean`

Hành vi (spec §5.3):
- `computeNextFire` dùng `CronExpressionParser.parse(cron, { tz: timezone, currentDate: new Date(afterMs) })` rồi `.next().getTime()`; mọi lỗi parse (cron sai, timezone sai) → `undefined`; kết quả không hữu hạn → `undefined`.
- `projectScheduleEvent` dispatch theo `type`: `schedule.created` / `schedule.cancelled`; type khác no-op. Bọc toàn bộ trong try/catch, lỗi → `console.warn` và return (không throw).
- `projectScheduleCreated`: parse payload; thiếu → log + return. Lấy pin qua `sessionPin(db, event.sessionId)`; không có pin → log + return. `next_fire_at = payload.nextFireAt ?? computeNextFire(payload.cron, payload.timezone, Date.now())`; `undefined` → log + return. `schedule_id = \`sched_${event.attemptId}_${payload.toolCallId}\`` (deterministic — idempotent tuyệt đối kể cả khi `cliTaskId` vắng; unique index theo `(origin_attempt_id, cli_task_id)` vẫn giữ theo spec). `INSERT OR IGNORE`, `state = 'active'`, `created_at = Date.now()`.
- `projectScheduleCancelled`: parse; `UPDATE scheduled_tasks SET state = 'cancelled' WHERE origin_attempt_id = ? AND cli_task_id = ? AND state = 'active'`.
- `dueSchedules`: `WHERE state = 'active' AND next_fire_at <= ? ORDER BY next_fire_at, created_at LIMIT ?`; map snake_case → `ScheduleRecord` (optional vắng thì không có key).
- `advanceSchedule`: cập nhật `state`, `next_fire_at` và/hoặc `last_fired_at` theo các field được truyền.
- `cancelScheduleForOwner`: `UPDATE ... SET state = 'cancelled' WHERE schedule_id = ? AND owner_id = ? AND state = 'active'`; trả `changes > 0`.
- `listActiveSchedules`: row `state = 'active'` của session, map sang `ScheduledTask`.
- `runKnown`: `EXISTS` trên `active_runs`, `command_outbox`, `run_events` theo `run_id`.

**Khác spec có chủ đích:** spec §5.3 ghi `schedule_id = sched_<uuid>`, plan chốt `sched_${attemptId}_${toolCallId}`. Lý do: projection chạy cả cho event duplicate (§12.2) và `cliTaskId` có thể vắng, nên unique index `(origin_attempt_id, cli_task_id)` một mình không đủ chống nhân đôi; id deterministic làm `INSERT OR IGNORE` idempotent tuyệt đối. Unique index vẫn giữ nguyên theo spec.

- [ ] **Step 1: Viết test fail cho `computeNextFire` và projection**

Tạo `packages/control-db/src/scheduled-tasks.test.ts`:

```ts
import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { migrate } from "./db.ts";
import {
  advanceSchedule,
  cancelScheduleForOwner,
  computeNextFire,
  dueSchedules,
  listActiveSchedules,
  projectScheduleEvent,
  runKnown,
} from "./scheduled-tasks.ts";
import { ensureSessionPin } from "./sessions.ts";

function setup() {
  const db = new Database(":memory:");
  migrate(db);
  ensureSessionPin(db, {
    sessionId: "session-1",
    ownerId: "user-1",
    workspaceId: "workspace-1",
    runnerId: "runner-a",
  });
  return db;
}

const created = {
  type: "schedule.created",
  sessionId: "session-1",
  attemptId: "attempt-1",
  payload: {
    toolCallId: "toolu_1",
    cliTaskId: "af5c4b05",
    cron: "58 17 31 10 *",
    recurring: false,
    prompt: "Kiểm tra dung lượng ổ đĩa",
    nextFireAt: 1793444280000,
    timezone: "Asia/Ho_Chi_Minh",
  },
};

function rows(db: Database) {
  return db.query("SELECT * FROM scheduled_tasks ORDER BY created_at").all() as Array<
    Record<string, unknown>
  >;
}

describe("computeNextFire", () => {
  test("a five-field cron resolves in the schedule's timezone", () => {
    // 2026-10-31T10:00:00Z is 17:00 in Asia/Ho_Chi_Minh, so 17:58 is 10:58Z.
    expect(computeNextFire("58 17 31 10 *", "Asia/Ho_Chi_Minh", Date.UTC(2026, 9, 31, 10, 0, 0))).toBe(
      Date.UTC(2026, 9, 31, 10, 58, 0),
    );
  });

  test("a recurring cron moves to the next slot", () => {
    expect(computeNextFire("*/5 * * * *", "UTC", Date.UTC(2026, 9, 31, 10, 1, 0))).toBe(
      Date.UTC(2026, 9, 31, 10, 5, 0),
    );
  });

  test("predefined expressions are accepted", () => {
    expect(computeNextFire("@daily", "UTC", Date.UTC(2026, 9, 31, 10, 1, 0))).toBe(
      Date.UTC(2026, 10, 1, 0, 0, 0),
    );
  });

  test("an unparseable cron answers undefined instead of throwing", () => {
    expect(computeNextFire("99 99 99 99 *", "UTC", Date.now())).toBeUndefined();
  });

  test("an unknown timezone answers undefined instead of throwing", () => {
    expect(computeNextFire("58 17 * * *", "Not/AZone", Date.now())).toBeUndefined();
  });
});

describe("projectScheduleEvent", () => {
  test("a valid schedule.created creates one row from the session pin", () => {
    const db = setup();
    projectScheduleEvent(db, created);

    expect(rows(db)).toHaveLength(1);
    expect(rows(db)[0]).toMatchObject({
      schedule_id: "sched_attempt-1_toolu_1",
      session_id: "session-1",
      owner_id: "user-1",
      workspace_id: "workspace-1",
      runner_id: "runner-a",
      origin_attempt_id: "attempt-1",
      cli_task_id: "af5c4b05",
      cron: "58 17 31 10 *",
      timezone: "Asia/Ho_Chi_Minh",
      recurring: 0,
      prompt: "Kiểm tra dung lượng ổ đĩa",
      next_fire_at: 1793444280000,
      state: "active",
    });
  });

  test("projecting the same event twice creates one row", () => {
    const db = setup();
    projectScheduleEvent(db, created);
    projectScheduleEvent(db, created);
    expect(rows(db)).toHaveLength(1);
  });

  test("a session with no pin creates no row", () => {
    const db = setup();
    projectScheduleEvent(db, { ...created, sessionId: "session-unknown" });
    expect(rows(db)).toHaveLength(0);
  });

  test("an invalid payload creates no row and does not throw", () => {
    const db = setup();
    projectScheduleEvent(db, {
      ...created,
      payload: { cron: "x".repeat(201) },
    });
    expect(rows(db)).toHaveLength(0);
  });

  test("a missing nextFireAt is computed from the cron", () => {
    const db = setup();
    const { nextFireAt, ...payload } = created.payload;
    projectScheduleEvent(db, { ...created, payload: { ...payload, cron: "*/5 * * * *" } });
    const row = rows(db)[0]!;
    expect(Number(row["next_fire_at"])).toBeGreaterThan(Date.now());
  });

  test("an unparseable cron with no nextFireAt creates no row", () => {
    const db = setup();
    const { nextFireAt, ...payload } = created.payload;
    projectScheduleEvent(db, { ...created, payload: { ...payload, cron: "99 99 99 99 *" } });
    expect(rows(db)).toHaveLength(0);
  });

  test("schedule.cancelled closes the row created by the same attempt", () => {
    const db = setup();
    projectScheduleEvent(db, created);
    projectScheduleEvent(db, {
      type: "schedule.cancelled",
      sessionId: "session-1",
      attemptId: "attempt-1",
      payload: { toolCallId: "toolu_2", cliTaskId: "af5c4b05" },
    });
    expect(rows(db)[0]!["state"]).toBe("cancelled");
  });

  test("a cancellation for an unknown cli task is a no-op", () => {
    const db = setup();
    projectScheduleEvent(db, created);
    projectScheduleEvent(db, {
      type: "schedule.cancelled",
      sessionId: "session-1",
      attemptId: "attempt-1",
      payload: { toolCallId: "toolu_2", cliTaskId: "never-seen" },
    });
    expect(rows(db)[0]!["state"]).toBe("active");
  });

  test("other event types are ignored", () => {
    const db = setup();
    projectScheduleEvent(db, { ...created, type: "run.started" });
    expect(rows(db)).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Chạy test để chắc nó fail**

Run: `export PATH="$HOME/.ponta/bin:$PATH" && bun test packages/control-db/src/scheduled-tasks.test.ts`
Expected: FAIL — không resolve được `./scheduled-tasks.ts`.

- [ ] **Step 3: Cài đặt `scheduled-tasks.ts` — types, `computeNextFire`, projection**

Theo đúng Interfaces ở trên. `import { CronExpressionParser } from "cron-parser";` và parse/validation dùng hai parser của Task 1.

- [ ] **Step 4: Chạy test để chắc phần projection pass**

Run: `export PATH="$HOME/.ponta/bin:$PATH" && bun test packages/control-db/src/scheduled-tasks.test.ts`
Expected: PASS.

- [ ] **Step 5: Viết test fail cho due/advance/cancel/list/runKnown**

Thêm vào cùng file:

```ts
describe("schedule queries", () => {
  test("dueSchedules returns active rows at or before the given time, oldest first", () => {
    const db = setup();
    projectScheduleEvent(db, created); // next_fire_at 1793444280000
    projectScheduleEvent(db, { ...created, attemptId: "attempt-2", payload: { ...created.payload, toolCallId: "toolu_2", nextFireAt: 1793444000000 } });
    expect(dueSchedules(db, 1793444279999).map((row) => row.scheduleId)).toEqual([
      "sched_attempt-2_toolu_2",
    ]);
    expect(dueSchedules(db, 1793444280000).map((row) => row.scheduleId)).toEqual([
      "sched_attempt-2_toolu_2",
      "sched_attempt-1_toolu_1",
    ]);
  });

  test("advanceSchedule sets state, next fire and last fired", () => {
    const db = setup();
    projectScheduleEvent(db, created);
    advanceSchedule(db, "sched_attempt-1_toolu_1", {
      state: "active",
      nextFireAt: 1793444340000,
      lastFiredAt: 1793444280000,
    });
    expect(rows(db)[0]).toMatchObject({
      state: "active",
      next_fire_at: 1793444340000,
      last_fired_at: 1793444280000,
    });
    advanceSchedule(db, "sched_attempt-1_toolu_1", { state: "done", lastFiredAt: 1793444340000 });
    expect(rows(db)[0]).toMatchObject({ state: "done", last_fired_at: 1793444340000 });
  });

  test("cancelScheduleForOwner is owner-scoped and only cancels active rows", () => {
    const db = setup();
    projectScheduleEvent(db, created);
    expect(cancelScheduleForOwner(db, "sched_attempt-1_toolu_1", "someone-else")).toBe(false);
    expect(cancelScheduleForOwner(db, "sched_attempt-1_toolu_1", "user-1")).toBe(true);
    expect(rows(db)[0]!["state"]).toBe("cancelled");
    expect(cancelScheduleForOwner(db, "sched_attempt-1_toolu_1", "user-1")).toBe(false);
  });

  test("listActiveSchedules answers camelCase tasks for one session only", () => {
    const db = setup();
    projectScheduleEvent(db, created);
    ensureSessionPin(db, {
      sessionId: "session-2",
      ownerId: "user-1",
      workspaceId: "workspace-1",
      runnerId: "runner-a",
    });
    projectScheduleEvent(db, { ...created, sessionId: "session-2", attemptId: "attempt-9", payload: { ...created.payload, toolCallId: "toolu_9" } });
    cancelScheduleForOwner(db, "sched_attempt-9_toolu_9", "user-1");

    expect(listActiveSchedules(db, "session-1")).toEqual([
      {
        scheduleId: "sched_attempt-1_toolu_1",
        sessionId: "session-1",
        cron: "58 17 31 10 *",
        timezone: "Asia/Ho_Chi_Minh",
        recurring: false,
        prompt: "Kiểm tra dung lượng ổ đĩa",
        nextFireAt: 1793444280000,
        state: "active",
        createdAt: expect.any(Number),
      },
    ]);
    expect(listActiveSchedules(db, "session-2")).toEqual([]);
  });

  test("runKnown sees the outbox, the journal and active_runs", () => {
    const db = setup();
    expect(runKnown(db, "run_unknown")).toBe(false);

    db.query(
      "INSERT INTO active_runs (run_id, session_id, runner_id, attempt_id, dispatched_at) VALUES (?, ?, ?, ?, ?)",
    ).run("run_active", "session-1", "runner-a", "attempt-1", Date.now());
    expect(runKnown(db, "run_active")).toBe(true);

    db.query(
      "INSERT INTO command_outbox (command_id, runner_id, kind, payload, fingerprint, issued_at, run_id, delivery_state, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run("cmd-1", "runner-a", "run.start", "{}", "fp", "2026-10-31T00:00:00Z", "run_queued", "pending", Date.now());
    expect(runKnown(db, "run_queued")).toBe(true);

    db.query(
      "INSERT INTO run_events (event_id, runner_id, boot_id, session_id, run_id, attempt_id, local_sequence, session_sequence, type, payload, occurred_at, ingested_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run("evt-1", "runner-a", "boot-1", "session-1", "run_journaled", "attempt-1", 1, 1, "run.started", "{}", "2026-10-31T00:00:00Z", Date.now());
    expect(runKnown(db, "run_journaled")).toBe(true);
  });
});
```

- [ ] **Step 6: Chạy test để chắc nó fail**

Run: `export PATH="$HOME/.ponta/bin:$PATH" && bun test packages/control-db/src/scheduled-tasks.test.ts`
Expected: FAIL — các function chưa tồn tại.

- [ ] **Step 7: Cài đặt các truy vấn còn lại**

`dueSchedules`, `advanceSchedule`, `cancelScheduleForOwner`, `listActiveSchedules`, `runKnown` đúng như Interfaces. Map row → record trong một helper nội bộ duy nhất để hai hàm list không lệch nhau.

- [ ] **Step 8: Export từ `packages/control-db/src/index.ts`**

Thêm block export cho module mới (types + functions), giữ thứ tự alphabet như các block hiện có.

- [ ] **Step 9: Chạy test + gate**

Run: `export PATH="$HOME/.ponta/bin:$PATH" && bun test packages/control-db && bun run typecheck && bun run lint`
Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add packages/control-db/src/scheduled-tasks.ts packages/control-db/src/scheduled-tasks.test.ts packages/control-db/src/index.ts
git commit -m "feat(control-db): project schedule events and query scheduled tasks"
```

---

### Task 5: `scheduleId` xuyên tầng — `DispatchRequest` → outbox payload → `run.started`

**Files:**
- Modify: `packages/control-db/src/scheduler.ts:34-93` (`DispatchRequest`) và `:162-178` (payload)
- Modify: `apps/runner/src/execution/executor.ts:196-216` (đọc record) và `:384-393` (`run.started` payload)
- Test: `packages/control-db/src/scheduler.test.ts`
- Test: `apps/runner/src/execution/executor.test.ts`

**Interfaces:**
- Consumes: `activeRunFor` (Task 3); executor hiện có.
- Produces:
  - `DispatchRequest` thêm `scheduleId?: string` và `scheduleCron?: string`.
  - `Scheduler.dispatch` chép hai field đó vào payload của `command_outbox` bằng conditional spread (theo đúng kiểu `model`/`effort`/`ultracode`).
  - `run.started` payload có thêm `scheduleId` / `scheduleCron` khi run.start payload mang chúng (D8; web dựa vào đây để render nhãn).

Chuỗi đầy đủ (spec §5.4): `DispatchRequest.scheduleId` → payload trong `Scheduler.dispatch` → cột `payload` của `command_outbox` → `Dispatcher` dựng lại frame → runner inbox → `executor` đọc `record["scheduleId"]` → `append("run.started", { ..., scheduleId })` → `chat-turns.ts` đọc payload.

- [ ] **Step 1: Viết test fail ở scheduler**

Thêm vào `packages/control-db/src/scheduler.test.ts`:

```ts
test("schedule ids ride the run.start payload", async () => {
  const { db, scheduler } = setup();
  await scheduler.dispatch(
    { ...request, runId: "run_sched_1", scheduleId: "sched_1", scheduleCron: "58 17 31 10 *" },
    capacity(),
  );

  const row = db.query("SELECT payload FROM command_outbox WHERE run_id = ?").get("run_sched_1") as {
    payload: string;
  };
  expect(JSON.parse(row.payload)).toMatchObject({
    scheduleId: "sched_1",
    scheduleCron: "58 17 31 10 *",
  });
});
```

- [ ] **Step 2: Chạy test để chắc nó fail**

Run: `export PATH="$HOME/.ponta/bin:$PATH" && bun test packages/control-db/src/scheduler.test.ts`
Expected: FAIL — payload không có `scheduleId`.

- [ ] **Step 3: Thêm hai field vào `DispatchRequest` và payload**

Khai báo optional với comment ngắn (giống `model`/`branch`), thêm vào object payload trong `dispatch`:

```ts
...(request.scheduleId === undefined ? {} : { scheduleId: request.scheduleId }),
...(request.scheduleCron === undefined ? {} : { scheduleCron: request.scheduleCron }),
```

- [ ] **Step 4: Chạy test để chắc nó pass**

Run: `export PATH="$HOME/.ponta/bin:$PATH" && bun test packages/control-db/src/scheduler.test.ts`
Expected: PASS.

- [ ] **Step 5: Viết test fail ở executor**

Thêm vào `apps/runner/src/execution/executor.test.ts`:

```ts
test("run.started carries the schedule ids from the run.start payload", async () => {
  const { db } = setup();
  beginAttempt(db, {
    attemptId: "attempt-1",
    sessionId: "session-1",
    runId: "run_sched_1",
    workspacePath: "/home/runner/project",
  });
  const sdk: SdkStream = () => ({
    async *[Symbol.asyncIterator]() {
      yield { type: "result", subtype: "success", is_error: false };
    },
  });

  await executeRun(
    db,
    {
      ...COMMAND,
      runId: "run_sched_1",
      payload: { prompt: "Kiểm tra dung lượng", scheduleId: "sched_1", scheduleCron: "58 17 31 10 *" },
    },
    { workspacePath: "/home/runner/project", sdk },
  );

  const started = events(db).find((row) => row.type === "run.started");
  expect(JSON.parse(started!.payload)).toMatchObject({
    prompt: "Kiểm tra dung lượng",
    scheduleId: "sched_1",
    scheduleCron: "58 17 31 10 *",
  });
});
```

Kèm một test đối chứng (cùng file), để nhánh conditional spread có cả hai phía:

```ts
test("an ordinary run carries no schedule keys on run.started", async () => {
  const { db } = setup();
  beginAttempt(db, {
    attemptId: "attempt-1",
    sessionId: "session-1",
    runId: "run-1",
    workspacePath: "/home/runner/project",
  });
  const sdk: SdkStream = () => ({
    async *[Symbol.asyncIterator]() {
      yield { type: "result", subtype: "success", is_error: false };
    },
  });

  await executeRun(db, COMMAND, { workspacePath: "/home/runner/project", sdk });

  const started = events(db).find((row) => row.type === "run.started");
  expect(JSON.parse(started!.payload)).not.toHaveProperty("scheduleId");
  expect(JSON.parse(started!.payload)).not.toHaveProperty("scheduleCron");
});
```

- [ ] **Step 6: Chạy test để chắc nó fail**

Run: `export PATH="$HOME/.ponta/bin:$PATH" && bun test apps/runner/src/execution/executor.test.ts`
Expected: FAIL — `run.started` thiếu `scheduleId`.

- [ ] **Step 7: Đọc và chép hai field trong executor**

Cạnh các biến `branch`/`model`:

```ts
const scheduleId =
  typeof record?.["scheduleId"] === "string" && record["scheduleId"] !== ""
    ? record["scheduleId"]
    : undefined;
const scheduleCron =
  typeof record?.["scheduleCron"] === "string" && record["scheduleCron"] !== ""
    ? record["scheduleCron"]
    : undefined;
```

Trong payload `run.started`, thêm conditional spread cho hai field này. Không thêm vào `effectivePrompt` hay prompt journal.

- [ ] **Step 8: Chạy test + gate**

Run: `export PATH="$HOME/.ponta/bin:$PATH" && bun test apps/runner packages/control-db && bun run typecheck && bun run lint`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add packages/control-db/src/scheduler.ts packages/control-db/src/scheduler.test.ts apps/runner/src/execution/executor.ts apps/runner/src/execution/executor.test.ts
git commit -m "feat: carry schedule ids from dispatch to run.started"
```

---

### Task 6: Control Server — tick loop sở hữu thời gian

**Files:**
- Create: `apps/control-server/src/scheduling/schedule-loop.ts`
- Create: `apps/control-server/src/scheduling/schedule-loop.test.ts`

**Interfaces:**
- Consumes: `dueSchedules`, `advanceSchedule`, `computeNextFire`, `runKnown`, `sessionPin` (Tasks 3–4); `Scheduler.dispatch`/`capacityFor`/`activeRunFor` (Task 3, 5); `RunnerState` và `workspacesForOwner` từ `@cc-web/control-db`.
- Produces:
  - `type ScheduleTickOptions = { db: Database; scheduler: Scheduler; runnerGateway: { stateOf(runnerId: string): RunnerState }; now?: () => number; log?: (message: string) => void }` — `RunnerGateway.stateOf` trả `GatewayState` (`"offline" | "connected" | "ready" | "revoked"`), là tập con của `RunnerState` nên gán thẳng được.
  - `type ScheduleLoopOptions = ScheduleTickOptions & { intervalMs?: number }` (mặc định `15_000`)
  - `async function runScheduleTick(options: ScheduleTickOptions): Promise<void>`
  - `function startScheduleLoop(options: ScheduleLoopOptions): { stop(): void }`

Thuật toán tick (spec §5.4) — thứ tự dưới đây là quyết định, không phải gợi ý:

```text
for row in dueSchedules(db, now()):
  try:
    pin = sessionPin(db, row.sessionId)
    if pin is undefined:
        advanceSchedule(db, row.scheduleId, { state: "orphaned" }); continue

    active = scheduler.activeRunFor(row.sessionId)
    if active?.attemptId === row.originAttemptId:
        advance(row, firedAt = now); continue        // timer in-process của chính attempt đó sẽ chạy

    fireAt = row.nextFireAt
    runId  = `run_sched_${row.scheduleId}_${fireAt}`
    if runKnown(db, runId):
        advance(row, firedAt = now); continue

    workspacePath = workspacesForOwner(db, pin.ownerId)
                      .find((w) => w.workspaceId === pin.workspaceId && w.runnerId === pin.runnerId)?.path
    state = runnerGateway.stateOf(pin.runnerId)
    decision = await scheduler.dispatch(
      { sessionId: row.sessionId, runId, attemptId: crypto.randomUUID(),
        workspaceId: pin.workspaceId, prompt: row.prompt, ownerId: pin.ownerId,
        scheduleId: row.scheduleId, scheduleCron: row.cron,
        ...(workspacePath === undefined ? {} : { workspacePath }) },
      scheduler.capacityFor(pin.runnerId, { runnerId: pin.runnerId, state, maxConcurrentRuns: 1, activeRuns: 0 }),
    )
    if decision.ok: advance(row, firedAt = now)
    else: leave row due (retry next tick)
  catch (error):
    log(`schedule tick failed for ${row.scheduleId}: ...`); continue
```

`advance(row, firedAt)`:
- one-shot: `advanceSchedule(db, row.scheduleId, { state: "done", lastFiredAt: firedAt })`.
- recurring: `next = computeNextFire(row.cron, row.timezone, Math.max(firedAt, row.nextFireAt) + 1)`; `next === undefined` → log + `{ state: "cancelled" }`; ngược lại `{ state: "active", nextFireAt: next, lastFiredAt: firedAt }`.

`startScheduleLoop`: `setInterval` với cờ chống chồng tick (`let running = false`), tick đầu tiên chạy ngay (fire-and-forget, lỗi đã được log trong tick), `stop()` gọi `clearInterval`. `log` mặc định `console.warn`.

- [ ] **Step 1: Viết test fail cho tick**

Tạo `apps/control-server/src/scheduling/schedule-loop.test.ts`. Dùng DB in-memory + `Scheduler` thật + gateway giả:

```ts
import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import {
  ensureSessionPin,
  migrate,
  projectScheduleEvent,
  Scheduler,
} from "@cc-web/control-db";
import { runScheduleTick } from "./schedule-loop.ts";
```

Các case (mỗi case tạo `setup()` riêng: DB, pin `session-1`, schedule qua `projectScheduleEvent`, `Scheduler(db)`; gateway giả `{ stateOf: () => "ready" }` hoặc `"offline"`):

1. `"a due one-shot is dispatched, marked done and leaves a run.start in the outbox"`: now = `nextFireAt`; sau tick: outbox có đúng một `run.start` với `run_id = "run_sched_sched_attempt-1_toolu_1_1793444280000"`, payload chứa `scheduleId`/`scheduleCron`; row `state = "done"`, `last_fired_at = now`.
2. `"a one-shot already due fires on the next tick"`: đặt `now = nextFireAt + 90_000` → vẫn dispatch.
3. `"the origin attempt still running owns the fire"`: `await scheduler.dispatch({ ... }, capacity)` với `attemptId: "attempt-1"` (trùng origin); tick → outbox chỉ có command của lần dispatch thủ công, row `done`.
4. `"an offline runner leaves the row due for a later tick"`: gateway `"offline"`; tick → row vẫn `active` với `next_fire_at` cũ; không thêm command; tick lần hai với gateway `"ready"` → dispatch.
5. `"a busy session retries the schedule on a later tick"`: dispatch một run khác cho `session-1` (attempt khác) rồi tick → không thêm command cho schedule; `scheduler.release("run-other")` rồi tick → dispatch.
6. `"two due schedules for one session dispatch one and retry the other"`: hai row cùng `next_fire_at`; tick một lần → đúng một command mới; row thứ hai vẫn `active` due; release run đầu, tick lại → command thứ hai xuất hiện.
7. `"a known run id is advanced instead of dispatched twice"`: chèn trước một row `command_outbox` với `run_id` deterministic của lần fire; tick → không thêm command; row `done`.
8. `"a recurring row advances to its next fire instead of finishing"`: cron `*/5 * * * *`, `nextFireAt` quá khứ; tick → row `state = "active"`, `next_fire_at > now`, `last_fired_at = now`.
9. `"a repeating row whose cron stopped parsing is cancelled"`: row recurring với cron `"99 99 99 99 *"` (chèn trực tiếp bằng SQL vì projection sẽ từ chối) → tick → `state = "cancelled"`, không throw.
10. `"a schedule whose session pin vanished is orphaned"`: xoá pin (`DELETE FROM sessions WHERE id = 'session-1'`) → tick → `state = "orphaned"`, không dispatch.

- [ ] **Step 2: Chạy test để chắc nó fail**

Run: `export PATH="$HOME/.ponta/bin:$PATH" && bun test apps/control-server/src/scheduling/schedule-loop.test.ts`
Expected: FAIL — không resolve được `./schedule-loop.ts`.

- [ ] **Step 3: Cài đặt `schedule-loop.ts`**

Đúng thuật toán trên. Chú ý: `capacity.activeRuns` lấy từ `scheduler.capacityFor`; `state` là `RunnerState` nên gateway giả trả `"offline" | "ready"` là đủ. `advance` là helper nội bộ nhận `row` + `firedAt` + `next` tính sẵn.

- [ ] **Step 4: Chạy test + gate**

Run: `export PATH="$HOME/.ponta/bin:$PATH" && bun test apps/control-server/src/scheduling && bun run typecheck && bun run lint`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/control-server/src/scheduling/schedule-loop.ts apps/control-server/src/scheduling/schedule-loop.test.ts
git commit -m "feat(control-server): add the scheduled-task tick loop"
```

---

### Task 7: Control Server — wiring ingest + vòng đời loop

**Files:**
- Modify: `apps/control-server/src/server.ts` (imports; `ServerOptions`; `onEvents`; khởi động loop sau `Scheduler`; `stop`)
- Test: `apps/control-server/src/scheduling/schedule-ingest.test.ts` (harness `start()` + `connectRunner` chép từ `runs-routes.test.ts`)

**Interfaces:**
- Consumes: `projectScheduleEvent` (Task 4); `startScheduleLoop` (Task 6); `ensureSessionPin`, `listActiveSchedules` (Tasks 3–4).
- Produces:
  - `ServerOptions` thêm `scheduleTickMs?: number` (chỉ dùng cho test; mặc định của loop là 15s).
  - Trong `onEvents`: sau `projectApprovalEvent`, gọi `projectScheduleEvent(options.db, event)` cho mọi event không conflict.
  - `createServer` khởi động `startScheduleLoop({ db, scheduler, runnerGateway, intervalMs })`; `stop()` dừng loop trước khi `server.stop(true)`.

- [ ] **Step 1: Viết test fail cho projection wiring**

Tạo `schedule-ingest.test.ts`, chép `start()` và `connectRunner` từ `runs-routes.test.ts` (giữ `afterEach` đóng link + `handle.stop()`). Test này chứng minh cùng lúc: gateway chấp nhận event type mới (C3), `onEvents` project đúng, và `stop()` dừng loop gọn:

```ts
test("a schedule.created event sent by a runner is accepted and projected", async () => {
  const { db, url, credential } = await start();
  ensureSessionPin(db, {
    sessionId: "session-1",
    ownerId: "user-1",
    workspaceId: "workspace-1",
    runnerId: "runner-a",
  });
  const inbox = new Database(":memory:");
  migrateRunnerDb(inbox);
  const runner = await connectRunner(url, credential, inbox);

  runner.send(
    JSON.stringify({
      type: "events",
      events: [
        {
          eventId: "evt-sched-1",
          runnerId: "runner-a",
          bootId: "boot-1",
          sessionId: "session-1",
          runId: "run-1",
          attemptId: "attempt-1",
          localSequence: 1,
          occurredAt: "2026-10-31T10:00:00.000Z",
          type: "schedule.created",
          payload: {
            toolCallId: "toolu_1",
            cliTaskId: "af5c4b05",
            cron: "58 17 31 10 *",
            recurring: false,
            prompt: "Kiểm tra dung lượng ổ đĩa",
            nextFireAt: 1793444280000,
            timezone: "Asia/Ho_Chi_Minh",
          },
        },
      ],
    }),
  );

  // An unknown event type refuses the whole frame, so the ACK is the proof
  // that the new type was accepted.
  await runner.waitForAck();
  expect(listActiveSchedules(db, "session-1")).toHaveLength(1);
});
```

`connectRunner` hiện chưa expose Promise ack — thêm vào bản chép trong file test này (`acked` resolve khi `frame.type === "events.ack"`, trả `{ send, waitForAck }`), không sửa `runs-routes.test.ts`.

- [ ] **Step 2: Chạy test để chắc nó fail**

Run: `export PATH="$HOME/.ponta/bin:$PATH" && bun test apps/control-server/src/scheduling/schedule-ingest.test.ts`
Expected: FAIL — `schedule.created` chưa nằm trong `EVENT_TYPES` sẽ bị gateway từ chối (nếu Task 1 xong thì fail ở `listActiveSchedules` rỗng vì chưa có projection).

- [ ] **Step 3: Nối projection vào `onEvents`**

Trong `server.ts`, import `projectScheduleEvent` từ `@cc-web/control-db`. Trong `onEvents`, cạnh `projectApprovalEvent`:

```ts
if (result.status !== "conflict") {
  projectApprovalEvent(options.db, runs, event);
  projectScheduleEvent(options.db, event);
}
```

- [ ] **Step 4: Khởi động và dừng loop**

Thêm `scheduleTickMs?: number` vào `ServerOptions` với comment "injectable tick interval for tests; production uses the loop default". Sau khi tạo `scheduler`:

```ts
const scheduleLoop = startScheduleLoop({
  db: options.db,
  scheduler,
  runnerGateway,
  ...(options.scheduleTickMs === undefined ? {} : { intervalMs: options.scheduleTickMs }),
});
```

Đổi `stop` ở object trả về thành:

```ts
stop: () => {
  scheduleLoop.stop();
  server.stop(true);
},
```

- [ ] **Step 5: Chạy test + gate**

Run: `export PATH="$HOME/.ponta/bin:$PATH" && bun test apps/control-server && bun run typecheck && bun run lint`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/control-server/src/server.ts apps/control-server/src/scheduling/schedule-ingest.test.ts
git commit -m "feat(control-server): project schedule events and run the scheduling tick"
```

---

### Task 8: Control Server — API list/cancel (owner-scoped)

**Files:**
- Create: `apps/control-server/src/routes/schedules-routes.ts`
- Modify: `apps/control-server/src/server.ts` (đăng ký 2 route trong `fetch`)
- Test: `apps/control-server/src/routes/schedules-routes.test.ts` (mới)

**Interfaces:**
- Consumes: `listActiveSchedules`, `cancelScheduleForOwner`, `sessionPin` (Tasks 3–4).
- Produces:
  - `handleListSchedules(request, options: ServerOptions, allowedOrigins: ReadonlySet<string>, browserGateway: BrowserGateway, sessionId: string): Promise<Response>` — `GET /api/sessions/:sessionId/schedules`.
  - `handleCancelSchedule(request, options, allowedOrigins, browserGateway, scheduleId: string): Promise<Response>` — `DELETE /api/schedules/:scheduleId`.
- Hợp đồng: auth giống mọi browser route (Origin trước, cookie sau — chép `handleListSessions`); list trả `{ "schedules": ScheduledTask[] }` với `Cache-Control: no-store`; session không thuộc owner → 404 (không lộ tồn tại); cancel trả `{ "ok": true }` 200, không có/thuộc owner khác → 404.

- [ ] **Step 1: Viết test fail cho hai route**

Trong `apps/control-server/src/routes/schedules-routes.test.ts`, dùng harness `start()` giống `runs-routes.test.ts` (DB in-memory, `createServer`, cookie `cc_session=${auth.issueAccessToken("user-1")}`). Seed lịch bằng `projectScheduleEvent` với pin `session-1` của `user-1`.

Các test:
1. `"GET lists the owner's active schedules for a session"` → 200, `schedules` có đúng row active.
2. `"GET answers 404 for a session the caller does not own"` → tạo pin owner `user-2`; cookie `user-1` → 404.
3. `"GET answers 401 without a cookie and 403 for a foreign Origin"`.
4. `"GET excludes cancelled and done rows"` → cancel một row rồi list → không có nó.
5. `"DELETE cancels an active schedule"` → 200 `{ ok: true }`, DB row `state = "cancelled"`.
6. `"DELETE answers 404 for an unknown or foreign schedule"` → row vẫn `active`.

- [ ] **Step 2: Chạy test để chắc nó fail**

Run: `export PATH="$HOME/.ponta/bin:$PATH" && bun test apps/control-server/src/routes/schedules-routes.test.ts`
Expected: FAIL — 404 cho mọi route (chưa đăng ký).

- [ ] **Step 3: Viết `schedules-routes.ts`**

Chép khung auth của `handleListSessions`; list: resolve pin, so `pin.ownerId !== authorized.userId` → `new Response("not found", { status: 404 })`; trả JSON. Cancel: `cancelScheduleForOwner(options.db, scheduleId, authorized.userId)`; `false` → 404.

- [ ] **Step 4: Đăng ký route trong `server.ts`**

Đặt cạnh các route session hiện có:

```ts
const sessionSchedulesMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/schedules$/);
if (sessionSchedulesMatch && request.method === "GET") {
  return handleListSchedules(
    request, options, allowed, browserGateway,
    decodeURIComponent(sessionSchedulesMatch[1] ?? ""),
  );
}

const scheduleMatch = url.pathname.match(/^\/api\/schedules\/([^/]+)$/);
if (scheduleMatch && request.method === "DELETE") {
  return handleCancelSchedule(
    request, options, allowed, browserGateway,
    decodeURIComponent(scheduleMatch[1] ?? ""),
  );
}
```

- [ ] **Step 5: Chạy test + gate**

Run: `export PATH="$HOME/.ponta/bin:$PATH" && bun test apps/control-server && bun run typecheck && bun run lint`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/control-server/src/routes/schedules-routes.ts apps/control-server/src/routes/schedules-routes.test.ts apps/control-server/src/server.ts
git commit -m "feat(control-server): list and cancel scheduled tasks over HTTP"
```

---

### Task 9: Web — chat render nhãn "tác vụ theo lịch"

**Files:**
- Modify: `apps/web/src/features/journal/chat-turns.ts:23-30` (`UserTurn`) và `:803-841` (run.started live)
- Modify: `apps/web/src/components/chat/UserChatBubble.vue`
- Test: `apps/web/src/features/journal/chat-turns.test.ts`

**Interfaces:**
- Consumes: `run.started` payload có `scheduleId` / `scheduleCron` (Task 5).
- Produces:
  - `UserTurn` thêm `source?: "schedule"` và `scheduleCron?: string`.
  - Live `run.started` có `scheduleId` khác rỗng → user turn mang `source: "schedule"`; `scheduleCron` (nếu có) được chép sang.
  - `UserChatBubble.vue`: khi `turn.source === "schedule"`, render dòng hệ thống gọn (icon `Clock` của `@lucide/vue`, nhãn "Tác vụ theo lịch", badge cron nếu có, nội dung prompt) thay cho bubble người dùng; các nút copy/raw giữ nguyên chức năng.

- [ ] **Step 1: Viết test fail trong `chat-turns.test.ts`**

```ts
test("a run started by a schedule is marked as a scheduled task", () => {
  resetSeq();
  const turns = deriveChatTurns(
    [],
    [
      liveEvent("run.started", {
        prompt: "Kiểm tra dung lượng",
        scheduleId: "sched_1",
        scheduleCron: "58 17 31 10 *",
      }),
    ],
  );
  const user = turns.find((turn) => turn.kind === "user");
  expect(user).toMatchObject({
    text: "Kiểm tra dung lượng",
    source: "schedule",
    scheduleCron: "58 17 31 10 *",
  });
});

test("a normal run carries no schedule source", () => {
  resetSeq();
  const turns = deriveChatTurns([], [liveEvent("run.started", { prompt: "hello" })]);
  const user = turns.find((turn) => turn.kind === "user");
  expect(user?.kind === "user" ? user.source : undefined).toBeUndefined();
});
```

- [ ] **Step 2: Chạy test để chắc nó fail**

Run: `export PATH="$HOME/.ponta/bin:$PATH" && bun test apps/web/src/features/journal/chat-turns.test.ts`
Expected: FAIL — `source` không tồn tại trên turn.

- [ ] **Step 3: Cập nhật `chat-turns.ts`**

Thêm hai field optional vào `UserTurn` với comment ngắn. Trong nhánh `event.type === "run.started"` của live phase, đọc `const scheduleId = asString(payload["scheduleId"]); const scheduleCron = asString(payload["scheduleCron"]);` rồi conditional spread vào object user turn (cả hai đều bỏ key khi vắng). Không đổi logic dedupe/historical.

- [ ] **Step 4: Chạy test để chắc nó pass**

Run: `export PATH="$HOME/.ponta/bin:$PATH" && bun test apps/web/src/features/journal/chat-turns.test.ts`
Expected: PASS.

- [ ] **Step 5: Cập nhật `UserChatBubble.vue`**

Thêm nhánh template `v-if="turn.source === 'schedule'"` **trước** bubble hiện tại: container `flex items-start gap-2 rounded-lg border border-border/60 bg-muted/40 px-3 py-2 max-w-[85%]`; icon `<Clock :size="14" class="mt-0.5 shrink-0 text-muted-foreground" />`; dòng header `text-xs text-muted-foreground` chứa "Tác vụ theo lịch" và (nếu có) `<code class="rounded bg-muted px-1 py-0.5 font-mono text-[10px]">{{ turn.scheduleCron }}</code>`; nội dung prompt qua `renderMarkdown(turn.text)` + `proseClasses`. Bubble người dùng hiện tại chỉ render khi `turn.source !== "schedule"`. Giữ nguyên actions row và raw viewer cho cả hai nhánh. Import `Clock` từ `@lucide/vue`.

- [ ] **Step 6: Chạy test + gate web**

Run: `export PATH="$HOME/.ponta/bin:$PATH" && bun test apps/web && bun run typecheck && bun run lint && cd apps/web && bun run build`
Expected: PASS toàn bộ.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/features/journal/chat-turns.ts apps/web/src/features/journal/chat-turns.test.ts apps/web/src/components/chat/UserChatBubble.vue
git commit -m "feat(web): render schedule-fired turns as scheduled tasks"
```

---

### Task 10: Web — API client + tab "Lịch" trong InspectPanel

**Files:**
- Create: `apps/web/src/services/schedules-api.ts`
- Create: `apps/web/src/services/schedules-api.test.ts`
- Create: `apps/web/src/features/schedules/schedule-rows.ts`
- Create: `apps/web/src/features/schedules/schedule-rows.test.ts`
- Modify: `apps/web/src/components/InspectPanel.vue`

**Interfaces:**
- Consumes: `ScheduledTask` từ `@cc-web/protocol` (Task 1); hai endpoint của Task 8.
- Produces:
  - `listSchedules(sessionId: string): Promise<{ ok: true; schedules: ScheduledTask[] } | { ok: false; code: string; message: string }>`
  - `cancelSchedule(scheduleId: string): Promise<"cancelled" | "not_found" | "unauthorized" | "error">`
  - `type ScheduleRow = { scheduleId: string; promptPreview: string; cadence: string; nextFireText: string }`
  - `toScheduleRow(task: ScheduledTask, now: number): ScheduleRow`
  - `formatNextFire(nextFireAt: number, now: number): string`

Quy ước (chép `runs-api.ts`): URL encode id; GET `/api/sessions/<id>/schedules`, DELETE `/api/schedules/<id>`; không bao giờ throw; 401 → `unauthorized`, 404 → `not_found`, còn lại → `error`.

`formatNextFire` (dùng trong ScheduleRow, test theo từng nhánh):
- `diff = nextFireAt - now`; `diff <= 0` → `"đang đến hạn"`.
- `< 60_000` → `"trong dưới 1 phút"`.
- `< 3_600_000` → `` `trong ${Math.ceil(diff / 60_000)} phút` ``.
- `< 86_400_000` → `` `trong ${Math.ceil(diff / 3_600_000)} giờ` ``.
- còn lại → `` `lúc ${new Date(nextFireAt).toLocaleString("vi-VN")}` ``.

`toScheduleRow`: `promptPreview` = prompt đã trim, cắt 80 ký tự + `"…"` nếu dài hơn; `cadence` = `recurring ? "Lặp lại" : "Một lần"`; `nextFireText = formatNextFire(task.nextFireAt, now)`.

- [ ] **Step 1: Viết test fail cho `schedule-rows.ts`**

```ts
import { describe, expect, test } from "bun:test";
import type { ScheduledTask } from "@cc-web/protocol";
import { formatNextFire, toScheduleRow } from "./schedule-rows.ts";

const task: ScheduledTask = {
  scheduleId: "sched_1",
  sessionId: "session-1",
  cron: "58 17 31 10 *",
  timezone: "Asia/Ho_Chi_Minh",
  recurring: false,
  prompt: "Kiểm tra dung lượng ổ đĩa",
  nextFireAt: 1_000_000,
  state: "active",
  createdAt: 0,
};

describe("formatNextFire", () => {
  test("a due or past fire reads as due now", () => {
    expect(formatNextFire(1_000_000, 1_000_000)).toBe("đang đến hạn");
    expect(formatNextFire(999_000, 1_000_000)).toBe("đang đến hạn");
  });
  test("under a minute", () => {
    expect(formatNextFire(1_030_000, 1_000_000)).toBe("trong dưới 1 phút");
  });
  test("minutes and hours round up", () => {
    expect(formatNextFire(1_120_000, 1_000_000)).toBe("trong 2 phút");
    expect(formatNextFire(1_000_000 + 3 * 3_600_000, 1_000_000)).toBe("trong 3 giờ");
  });
  test("more than a day uses the calendar form", () => {
    expect(formatNextFire(1_000_000 + 2 * 86_400_000, 1_000_000)).toContain("lúc");
  });
});

describe("toScheduleRow", () => {
  test("builds the panel's display strings", () => {
    expect(toScheduleRow(task, 1_000_000)).toEqual({
      scheduleId: "sched_1",
      promptPreview: "Kiểm tra dung lượng ổ đĩa",
      cadence: "Một lần",
      nextFireText: "đang đến hạn",
    });
  });
  test("a long prompt is cut at 80 characters with an ellipsis", () => {
    const row = toScheduleRow({ ...task, prompt: "x".repeat(100) }, 0);
    expect(row.promptPreview).toBe(`${"x".repeat(80)}…`);
  });
  test("a recurring task reads as repeating", () => {
    expect(toScheduleRow({ ...task, recurring: true }, 0).cadence).toBe("Lặp lại");
  });
});
```

- [ ] **Step 2: Chạy test để chắc nó fail**

Run: `export PATH="$HOME/.ponta/bin:$PATH" && bun test apps/web/src/features/schedules/schedule-rows.test.ts`
Expected: FAIL — module chưa tồn tại.

- [ ] **Step 3: Cài đặt `schedule-rows.ts`**

- [ ] **Step 4: Viết test fail cho `schedules-api.ts`**

Dùng capture-fetch như `runs-api.test.ts`:
- GET 200 `{ schedules: [task] }` → `{ ok: true, schedules: [...] }`, URL `"/api/sessions/session-1/schedules"`, method GET.
- GET 401 → `{ ok: false, code: "unauthorized", ... }`.
- DELETE 200 → `"cancelled"`, URL `/api/schedules/sched_1`, method DELETE.
- DELETE 404 → `"not_found"`; 403/500 → `"error"`.
- Session id được URL-encode (`session /ß` → `session%20%2F%C3%9F`).

- [ ] **Step 5: Chạy test để chắc nó fail**

Run: `export PATH="$HOME/.ponta/bin:$PATH" && bun test apps/web/src/services/schedules-api.test.ts`
Expected: FAIL.

- [ ] **Step 6: Cài đặt `schedules-api.ts`**

- [ ] **Step 7: Thêm tab "Lịch" vào `InspectPanel.vue`**

- `Tab` thêm `"schedules"`; `TAB_LABELS` thêm `schedules: "Lịch"` (giữ thứ tự files / changes / diagnostics / schedules để tab bar không xáo).
- State mới: `schedules`, `schedulesError`, `schedulesLoading`, `cancellingScheduleId`; `loadSchedules()` gọi `listSchedules(props.sessionId)` và gán kết quả/lỗi.
- Watch `tab`: `if (next === "schedules" && schedules.value === null) void loadSchedules();`.
- Watch đổi session hiện có: reset toàn bộ state schedules (đặt cạnh các reset khác).
- Template (trong nhánh `v-else`, sau khối diagnostics): loading → "Đang tải…"; lỗi → text lỗi; rỗng → "Chưa có lịch nào."; danh sách mỗi row dùng `toScheduleRow(schedule, Date.now())`: prompt preview, `cadence`, `nextFireText`, `<code>{{ schedule.cron }}</code>`, nút "Huỷ" gọi `cancelSchedule(row.scheduleId)` rồi `loadSchedules()` lại (set `cancellingScheduleId` để disable nút trong lúc chờ).
- Không thêm UI tạo lịch (non-goal).

- [ ] **Step 8: Chạy test + gate web**

Run: `export PATH="$HOME/.ponta/bin:$PATH" && bun test apps/web && bun run typecheck && bun run lint && cd apps/web && bun run build`
Expected: PASS; lưu ý Biome không được chạm vào `apps/web/src/components/ui/**`.

- [ ] **Step 9: Commit**

```bash
git add apps/web/src/services/schedules-api.ts apps/web/src/services/schedules-api.test.ts apps/web/src/features/schedules/schedule-rows.ts apps/web/src/features/schedules/schedule-rows.test.ts apps/web/src/components/InspectPanel.vue
git commit -m "feat(web): list and cancel scheduled tasks from the inspect panel"
```

---

### Task 11: Docs — ARCHITECTURE §11.5 + ADR-016

**Files:**
- Modify: `docs/ARCHITECTURE.md` (thêm `### 11.5. Scheduled tasks (server-owned)` trước `## 12`; thêm row ADR-016 vào bảng §24.1)
- Create: `docs/adr/0016-scheduled-tasks-owned-by-control-server.md`

**Interfaces:**
- Consumes: thiết kế đã duyệt (`docs/superpowers/specs/2026-10-31-scheduled-tasks-design.md`).
- Produces: tài liệu chuẩn cho vận hành và người đọc sau.

- [ ] **Step 1: Viết §11.5**

Nội dung tối thiểu: vì sao lịch thuộc server (tóm tắt root cause: timer in-process của CLI chết cùng process); nguồn sự thật `scheduled_tasks`; mirror event `schedule.created`/`schedule.cancelled`; tick 15s tuần tự; chính sách lỗi (bảng ngắn: offline → retry, pin mất → orphaned, cron hỏng → cancelled, crash → `knownRun`); double-fire guard theo `origin_attempt_id`; giới hạn đã biết (CronList/CronDelete trong process mới không thấy lịch server-side; `durable:false` của CLI; server+runner phải nâng cấp cùng nhau). Viết tiếng Việt theo văn phong các mục §11 hiện có.

- [ ] **Step 2: Thêm row vào bảng §24.1**

```md
| ADR-016 | Scheduled tasks thuộc Control Server (2026-10-31) | Lịch sống qua restart, chạy đúng giờ mà không giữ process; CronList/CronDelete của CLI chỉ thấy trong process tạo lịch |
```

- [ ] **Step 3: Viết ADR-016 (tiếng Anh, theo template `docs/adr/README.md`)**

`# ADR-0016 — Scheduled tasks owned by the Control Server`, `- Status: accepted`, `- Date: 2026-10-31`, `- Refines: ARCHITECTURE.md §11.5`. Context: `CronCreate` là timer in-memory trong CLI subprocess, chết khi turn kết thúc; probe A/B (string prompt vs streaming input) chứng minh. Decision: server sở hữu lịch, mirror qua event, tick dispatch như run bình thường. Consequences: lịch bền vững, không chiếm capacity/lock; `CronList`/`CronDelete` divergence; event type additive buộc server+runner ship cùng nhau; `cron-parser` là dependency mới.

- [ ] **Step 4: Kiểm tra định dạng**

Run: `export PATH="$HOME/.ponta/bin:$PATH" && bun run lint`
Expected: PASS (docs không bị Biome phàn nàn).

- [ ] **Step 5: Commit**

```bash
git add docs/ARCHITECTURE.md docs/adr/0016-scheduled-tasks-owned-by-control-server.md
git commit -m "docs: document server-owned scheduled tasks (ADR-016)"
```

---

### Task 12: Manual end-to-end probe (bắt buộc trước khi coi là xong)

**Files:** không tạo file trong repo; scratch dưới `/tmp/schedule-probe/`.

**Interfaces:**
- Consumes: toàn bộ Tasks 1–11.

- [ ] **Step 1: Build runner + khởi động server sạch**

```bash
export PATH="$HOME/.ponta/bin:$PATH"
bun run build:runner
mkdir -p /tmp/schedule-probe/data
CC_WEB_JWT_SECRET="$(openssl rand -hex 32)" \
CC_WEB_ALLOWED_ORIGINS="http://localhost:8899" \
CC_WEB_PORT=8899 \
CC_WEB_DATA_DIR=/tmp/schedule-probe/data \
bun apps/control-server/src/index.ts > /tmp/schedule-probe/server.log 2>&1 &
echo $! > /tmp/schedule-probe/server.pid
```

- [ ] **Step 2: Seed owner, login, mint runner token**

```bash
echo -n "probe-pass" | bun scripts/seed-user.ts probe
curl -s -c /tmp/schedule-probe/cookies -H 'Origin: http://localhost:8899' \
  -H 'Content-Type: application/json' \
  -d '{"username":"probe","password":"probe-pass"}' \
  http://localhost:8899/auth/login
RUNNER_JSON=$(curl -s -b /tmp/schedule-probe/cookies -H 'Origin: http://localhost:8899' \
  -X POST http://localhost:8899/api/runners)
RUNNER_ID=$(echo "$RUNNER_JSON" | sed -E 's/.*"runnerId":"([^"]+)".*/\1/')
RUNNER_TOKEN=$(echo "$RUNNER_JSON" | sed -E 's/.*"token":"([^"]+)".*/\1/')
```

- [ ] **Step 3: Kết nối runner thật (identity riêng, không đụng runner đang dùng)**

```bash
export CC_WEB_RUNNER_HOME=/tmp/schedule-probe/runner-home
CC_WEB_RUNNER_TOKEN="$RUNNER_TOKEN" ./dist/cc-web-runner setup \
  --server http://localhost:8899 --runner-id "$RUNNER_ID"
./dist/cc-web-runner connect > /tmp/schedule-probe/runner.log 2>&1 &
echo $! > /tmp/schedule-probe/runner.pid
# Chờ /api/runners báo runner "ready" trước khi gửi run.
```

- [ ] **Step 4: Probe one-shot — tạo lịch +2 phút rồi kết thúc run ngay**

```bash
SID="probe-oneshot-$(date +%s)"
CRON="$(date -d '+2 minutes' '+%M %H %d %m *')"
curl -s -b /tmp/schedule-probe/cookies -H 'Origin: http://localhost:8899' \
  -H 'Content-Type: application/json' \
  -d "{\"prompt\":\"Gọi tool CronCreate đúng một lần với cron: \\\"$CRON\\\", recurring: false, prompt: \\\"Trả lời đúng một từ: SCHEDULED-FIRED\\\". Sau đó kết thúc lượt ngay, không chờ.\"}" \
  http://localhost:8899/api/sessions/$SID/runs
```

Chờ qua mốc phút đã hẹn + ~90s, rồi kiểm:

```bash
curl -s -b /tmp/schedule-probe/cookies -H 'Origin: http://localhost:8899' \
  http://localhost:8899/api/sessions/$SID/schedules
# Kỳ vọng: một row state "done", lastFiredAt đã set.

bun -e '
import { Database } from "bun:sqlite";
const db = new Database("/tmp/schedule-probe/data/control.sqlite", { readonly: true });
const rows = db.query("SELECT type, payload FROM run_events WHERE session_id = ? ORDER BY session_sequence").all(process.argv[1]);
const starts = rows.filter((r) => r.type === "run.started").map((r) => JSON.parse(r.payload));
console.log(JSON.stringify(starts, null, 2));
process.exit(starts.some((p) => typeof p.scheduleId === "string") ? 0 : 1);
' "$SID"
# Kỳ vọng: exit 0 — run thứ hai có scheduleId + scheduleCron trong run.started.
```

- [ ] **Step 5: Probe recurring — mỗi phút một lần, huỷ giữa chừng**

```bash
SID="probe-recurring-$(date +%s)"
curl -s -b /tmp/schedule-probe/cookies -H 'Origin: http://localhost:8899' \
  -H 'Content-Type: application/json' \
  -d '{"prompt":"Gọi tool CronCreate đúng một lần với cron: \"* * * * *\", recurring: true, prompt: \"Trả lời đúng một từ: TICK\". Sau đó kết thúc lượt ngay, không chờ."}' \
  http://localhost:8899/api/sessions/$SID/runs
```

Chờ ~3 phút, đếm số lần fire (kỳ vọng ≥ 3) và xác nhận row vẫn `active`:

```bash
bun -e '
import { Database } from "bun:sqlite";
const db = new Database("/tmp/schedule-probe/data/control.sqlite", { readonly: true });
const rows = db.query("SELECT payload FROM run_events WHERE session_id = ? AND type = ?").all(process.argv[1], "run.started");
const fired = rows.map((r) => JSON.parse(r.payload)).filter((p) => typeof p.scheduleId === "string");
console.log(`scheduled fires: ${fired.length}`);
' "$SID"

curl -s -b /tmp/schedule-probe/cookies -H 'Origin: http://localhost:8899' \
  http://localhost:8899/api/sessions/$SID/schedules
# Kỳ vọng: row state "active", lastFiredAt đã set, nextFireAt ở tương lai.
```

Huỷ giữa chừng rồi xác nhận không còn fire:

```bash
SCHED_ID=$(curl -s -b /tmp/schedule-probe/cookies -H 'Origin: http://localhost:8899' \
  http://localhost:8899/api/sessions/$SID/schedules \
  | sed -E 's/.*"scheduleId":"([^"]+)".*/\1/')
curl -s -b /tmp/schedule-probe/cookies -H 'Origin: http://localhost:8899' -X DELETE \
  http://localhost:8899/api/schedules/$SCHED_ID
# Ghi lại số "scheduled fires" ngay lúc này; chờ 2 phút rồi chạy lại đúng script đếm ở trên.
# Kỳ vọng: con số không tăng.
```

- [ ] **Step 6: Dọn dẹp**

```bash
kill "$(cat /tmp/schedule-probe/runner.pid)" "$(cat /tmp/schedule-probe/server.pid)" 2>/dev/null || true
rm -rf /tmp/schedule-probe
```

- [ ] **Step 7: Ghi kết quả**

Ghi lại trong báo cáo cuối: thời điểm hẹn, thời điểm fire thực tế, số lần fire recurring, payload `run.started` có `scheduleId`. Nếu một kỳ vọng không đạt: **không** tuyên bố hoàn thành; quay lại debugging có hệ thống.

---

## Ghi chú thực thi

- Mỗi task là một commit độc lập; không gộp nhiều task vào một commit.
- Thứ tự bắt buộc: 1 → 2, 3 → 4, 4 → 5, 4 → 6, 6 → 7, 7 → 8, 5 → 9, 8 → 10, 9+10 → 11 → 12.
- Khi một test ngoài phạm vi task fail vì interface đổi (ví dụ `activeRunFor` trả thêm field), sửa call site trong cùng task — không để lại compile break giữa các commit.
