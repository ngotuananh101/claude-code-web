# Quản lý Phiên, Runner và Bản địa hoá Tiếng Việt (Session & Runner Management with Vietnamese Localization) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cung cấp tính năng đổi tên và xoá phiên (qua menu hover 3 chấm), đổi tên và xoá runner (tự động thu hồi và cascade xoá các phiên liên quan), cùng bản địa hoá 100% giao diện sang tiếng Việt.

**Architecture:** Mở rộng SQLite schema trong `control-db` với các cột `title` (sessions) và `name` (runners) qua `addColumnIfMissing`. Xây dựng các hàm cascade delete an toàn trong database transaction, bổ sung API REST `PATCH`/`DELETE` trong `control-server`. Ở frontend Vue 3, xây dựng các modal `RenameDialog` và `ConfirmDeleteDialog`, tích hợp menu hover 3 chấm trên `SessionRail`, nâng cấp `RunnersView` và rà soát dịch toàn bộ chuỗi tiếng Anh sang tiếng Việt.

**Tech Stack:** Bun, TypeScript, SQLite (`bun:sqlite`), Vue 3, Tailwind CSS, Lucide icons, Radix Vue / shadcn-vue primitives.

**Spec:** `docs/superpowers/specs/2026-10-30-session-runner-management-design.md`

## Global Constraints

- Không bao giờ chỉnh sửa trực tiếp các file sinh ra của shadcn-vue (`apps/web/src/components/ui/**`, `apps/web/src/lib/utils.ts`, `apps/web/src/styles/index.css`, `apps/web/components.json`).
- Mọi thay đổi schema database phải tương thích ngược: dùng `addColumnIfMissing` trong `packages/control-db/src/db.ts`, không làm mất dữ liệu SQLite hiện có.
- Mọi thao tác xoá phiên/runner đều phải xác thực `owner_id` trong câu lệnh SQL để đảm bảo tính cô lập tài khoản.
- Chạy toàn bộ test suites (`bun test`), `bun run typecheck`, và `bun run lint` trước khi hoàn tất mỗi task.
- Mã nguồn, comment, tên định danh, commit message viết bằng tiếng Anh; toàn bộ giao diện người dùng (UI text, nhãn, toast, modal) viết bằng tiếng Việt tự nhiên, chuẩn xác.

## Review Focus

- Xoá runner đang kết nối trực tiếp: socket WebSocket phải được đóng ngay lập tức (`runnerGateway.revoke`), tránh runner tiếp tục nhận lệnh sau khi đã bị xoá khỏi DB.
- Cascade delete phiên khi xoá runner: toàn bộ lịch sử `run_events`, `active_runs`, `approvals`, `command_outbox` của các phiên đó phải được dọn dẹp sạch sẽ, không để lại rác trong DB.
- Xoá phiên đang được mở trên trình duyệt: frontend phải tự động điều hướng về `/sessions` và xoá state trong store để không bị lỗi 404/trắng trang.
- Click vào nút menu 3 chấm trên dòng phiên: phải dùng `@click.stop` để không kích hoạt router push chuyển trang vào phiên.
- Tên gợi nhớ quá dài: UI phải có class `truncate` và `title` thuộc tính để không làm vỡ layout của sidebar hoặc bảng danh sách.

---

### Task 1: Database schema and query operations (`packages/control-db`)

**Files:**
- Modify: `packages/control-db/src/db.ts:100-120`
- Modify: `packages/control-db/src/sessions.ts:1-60`
- Modify: `packages/control-db/src/runner-tokens.ts:60-85`
- Modify: `packages/control-db/src/replay.ts:134-210`
- Modify: `packages/control-db/src/index.ts:35-55`
- Test: `packages/control-db/src/sessions.test.ts`
- Test: `packages/control-db/src/runner-tokens.test.ts`
- Test: `packages/control-db/src/replay.test.ts`

**Interfaces:**
- Produces:
  - `updateSessionTitle(db: Database, sessionId: string, ownerId: string, title: string): boolean`
  - `deleteSession(db: Database, sessionId: string, ownerId: string): boolean`
  - `updateRunnerName(db: Database, runnerId: string, ownerId: string, name: string): boolean`
  - `deleteRunner(db: Database, runnerId: string, ownerId: string): { ok: boolean; deletedSessions: string[] }`
  - `SessionSummary.title?: string | null`
  - `ListedRunner.name?: string | null`

- [ ] **Step 1: Write failing tests for session title update, session delete, runner name update, and runner cascade delete**

Thêm các test cases trong `packages/control-db/src/sessions.test.ts` và `packages/control-db/src/runner-tokens.test.ts`:
- `updateSessionTitle`: cập nhật tên phiên thành công khi đúng `ownerId`, từ chối khi sai `ownerId`.
- `deleteSession`: xoá phiên và xoá sạch `run_events`, `active_runs`, `approvals` liên quan.
- `updateRunnerName`: cập nhật tên runner thành công khi đúng `ownerId`.
- `deleteRunner`: thu hồi runner nếu chưa thu hồi, cascade xoá toàn bộ sessions thuộc runner và các dữ liệu liên quan.
- `listSessions`: trả về `title` khi phiên đã được đặt tên gợi nhớ.
- `listRunners`: trả về `name` khi runner đã được đặt tên gợi nhớ.

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/control-db/src/sessions.test.ts packages/control-db/src/runner-tokens.test.ts`
Expected: FAIL vì các hàm và cột mới chưa tồn tại.

- [ ] **Step 3: Implement database migrations & operations in `packages/control-db`**

1. Trong `packages/control-db/src/db.ts`:
   - Thêm `addColumnIfMissing(db, "sessions", "title", "TEXT");`
   - Thêm `addColumnIfMissing(db, "runners", "name", "TEXT");`
2. Trong `packages/control-db/src/sessions.ts`:
   - Cài đặt `updateSessionTitle(db, sessionId, ownerId, title)`
   - Cài đặt `deleteSession(db, sessionId, ownerId)` (dùng transaction xoá `sessions`, `run_events`, `active_runs`, `approvals`, `command_outbox`)
3. Trong `packages/control-db/src/runner-tokens.ts`:
   - Cài đặt `updateRunnerName(db, runnerId, ownerId, name)`
   - Cài đặt `deleteRunner(db, runnerId, ownerId)` (thu hồi runner, tìm sessions thuộc runner, gọi xoá từng session, xoá `workspaces`, `runner_credentials`, `command_outbox`, `runners`)
   - Cập nhật `listRunners` để SELECT cột `name`
4. Trong `packages/control-db/src/replay.ts`:
   - Cập nhật `SessionSummary` có `title: string | null`
   - Cập nhật query `listSessions` để SELECT `s.title AS title` từ bảng `sessions`
5. Xuất các hàm mới trong `packages/control-db/src/index.ts`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test packages/control-db/src/sessions.test.ts packages/control-db/src/runner-tokens.test.ts packages/control-db/src/replay.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/control-db/
git commit -m "feat(control-db): add title/name columns and delete operations for sessions and runners"
```

---

### Task 2: Control server REST API routes (`apps/control-server`)

**Files:**
- Modify: `apps/control-server/src/routes/sessions-routes.ts`
- Modify: `apps/control-server/src/routes/runners-routes.ts`
- Modify: `apps/control-server/src/server.ts`
- Test: `apps/control-server/src/routes/sessions-routes.test.ts`
- Test: `apps/control-server/src/routes/runners-routes.test.ts`

**Interfaces:**
- Consumes: `updateSessionTitle`, `deleteSession`, `updateRunnerName`, `deleteRunner`, `listSessions`, `listRunners` từ `@cc-web/control-db`
- Produces:
  - `PATCH /api/sessions/:id`
  - `DELETE /api/sessions/:id`
  - `PATCH /api/runners/:id`
  - `DELETE /api/runners/:id`

- [ ] **Step 1: Write failing tests for session and runner HTTP routes**

Trong `sessions-routes.test.ts` và `runners-routes.test.ts`:
- Test `PATCH /api/sessions/:id`: đổi tên phiên, kiểm tra xác thực cookie, trả về 200 và json `{ ok: true, sessionId, title }`.
- Test `DELETE /api/sessions/:id`: xoá phiên, giải phóng active run nếu có, trả về 200 và `{ ok: true, sessionId }`.
- Test `PATCH /api/runners/:id`: đổi tên runner, trả về 200 và `{ ok: true, runnerId, name }`.
- Test `DELETE /api/runners/:id`: thu hồi socket live, xoá runner + cascade sessions, trả về 200 và `{ ok: true, runnerId, deletedSessions }`.

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test apps/control-server/src/routes/sessions-routes.test.ts apps/control-server/src/routes/runners-routes.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement handlers and route matching in `control-server`**

1. Trong `apps/control-server/src/routes/sessions-routes.ts`:
   - Viết `handleUpdateSessionTitle(request, options, allowedOrigins, browserGateway, sessionId)`
   - Viết `handleDeleteSession(request, options, allowedOrigins, browserGateway, scheduler, sessionId)`
2. Trong `apps/control-server/src/routes/runners-routes.ts`:
   - Viết `handleUpdateRunnerName(request, options, allowedOrigins, browserGateway, runnerId)`
   - Viết `handleDeleteRunner(request, options, allowedOrigins, browserGateway, runnerGateway, scheduler, runnerId)`
3. Trong `apps/control-server/src/server.ts`:
   - Match `PATCH /api/sessions/:id`
   - Match `DELETE /api/sessions/:id`
   - Match `PATCH /api/runners/:id`
   - Match `DELETE /api/runners/:id`

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test apps/control-server/src/routes/sessions-routes.test.ts apps/control-server/src/routes/runners-routes.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/control-server/
git commit -m "feat(control-server): add endpoints for renaming and deleting sessions and runners"
```

---

### Task 3: Frontend API services and stores (`apps/web`)

**Files:**
- Modify: `apps/web/src/services/sessions-api.ts`
- Modify: `apps/web/src/services/runners-api.ts`
- Modify: `apps/web/src/stores/sessions.ts`
- Test: `apps/web/src/services/sessions-api.test.ts`
- Test: `apps/web/src/stores/sessions.test.ts`

**Interfaces:**
- Produces:
  - `renameSession(sessionId: string, title: string): Promise<boolean>`
  - `deleteSession(sessionId: string): Promise<boolean>`
  - `renameRunner(runnerId: string, name: string): Promise<boolean>`
  - `deleteRunner(runnerId: string): Promise<{ ok: boolean; deletedSessions: string[] }>`

- [ ] **Step 1: Write failing tests for frontend session/runner services and store methods**

Trong `sessions-api.test.ts` và `sessions.test.ts`:
- Kiểm tra `renameSession` gọi `PATCH /api/sessions/:id` với body JSON.
- Kiểm tra `deleteSession` gọi `DELETE /api/sessions/:id`.
- Kiểm tra store cập nhật danh sách phiên sau khi đổi tên hoặc xoá.

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test apps/web/src/services/sessions-api.test.ts apps/web/src/stores/sessions.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement client API calls and store actions**

1. Trong `apps/web/src/services/sessions-api.ts`:
   - Thêm `renameSession(sessionId, title)`
   - Thêm `deleteSession(sessionId)`
2. Trong `apps/web/src/services/runners-api.ts`:
   - Thêm `renameRunner(runnerId, name)`
   - Thêm `deleteRunner(runnerId)`
3. Trong `apps/web/src/stores/sessions.ts`:
   - Thêm action/helper để cập nhật title phiên locally hoặc gọi reload sessions.
   - Thêm helper dọn dẹp khi session bị xoá.

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test apps/web/src/services/sessions-api.test.ts apps/web/src/stores/sessions.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/services/ apps/web/src/stores/
git commit -m "feat(web): add API services and store actions for session and runner operations"
```

---

### Task 4: Modal dialog components (`apps/web`)

**Files:**
- Create: `apps/web/src/components/RenameDialog.vue`
- Create: `apps/web/src/components/ConfirmDeleteDialog.vue`
- Test: `apps/web/src/components/RenameDialog.test.ts`
- Test: `apps/web/src/components/ConfirmDeleteDialog.test.ts`

**Interfaces:**
- `RenameDialog`:
  - Props: `open: boolean`, `title: string`, `description?: string`, `initialValue: string`, `placeholder?: string`
  - Emits: `update:open`, `confirm(name: string)`
- `ConfirmDeleteDialog`:
  - Props: `open: boolean`, `title: string`, `description: string`, `warning?: string`, `busy?: boolean`
  - Emits: `update:open`, `confirm()`

- [ ] **Step 1: Write failing tests for Dialog components**

Kiểm tra:
- `RenameDialog` mở ra với giá trị khởi tạo, autofocus, phím Enter để xác nhận, Escape/Huỷ để đóng.
- `ConfirmDeleteDialog` hiển thị đúng lời cảnh báo, nút xác nhận xoá hiển thị trạng thái disabled khi `busy`.

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test apps/web/src/components/RenameDialog.test.ts apps/web/src/components/ConfirmDeleteDialog.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement `RenameDialog.vue` and `ConfirmDeleteDialog.vue`**

Sử dụng shadcn-vue primitives (`Dialog`, `DialogContent`, `DialogHeader`, `DialogTitle`, `DialogDescription`, `DialogFooter`, `Button`, `Input`) đã có sẵn:
- Giao diện tiếng Việt 100%: "Đổi tên", "Huỷ", "Lưu", "Xác nhận xoá", "Hành động này không thể hoàn tác".
- Thiết kế đẹp mắt, hỗ trợ dark/light theme với Tailwind CSS.

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test apps/web/src/components/RenameDialog.test.ts apps/web/src/components/ConfirmDeleteDialog.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/RenameDialog.* apps/web/src/components/ConfirmDeleteDialog.*
git commit -m "feat(web): add RenameDialog and ConfirmDeleteDialog components"
```

---

### Task 5: SessionRail hover menu & session actions (`apps/web`)

**Files:**
- Modify: `apps/web/src/components/SessionRail.vue`
- Test: `apps/web/src/components/SessionRail.test.ts`

**Interfaces:**
- Consumes: `RenameDialog`, `ConfirmDeleteDialog`, `renameSession`, `deleteSession`, `sessionsStore`

- [ ] **Step 1: Write test for SessionRail actions**

Kiểm tra:
- Session row hiển thị `title` khi có.
- Menu 3 chấm xuất hiện và mở dropdown chứa "Đổi tên" và "Xoá phiên".
- Khi xoá session đang active, chuyển route về `/sessions`.

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test apps/web/src/components/SessionRail.test.ts`
Expected: FAIL

- [ ] **Step 3: Update `SessionRail.vue`**

1. Thêm import icon `MoreHorizontal`, `Pencil`, `Trash2`.
2. Trên mỗi mục session trong `v-for`:
   - Bọc nút và menu con trong `group relative`.
   - Hiển thị tên `row.session.title || row.label || row.session.sessionId`.
   - Thêm nút menu góc phải:
     ```html
     <button class="opacity-0 group-hover:opacity-100 transition-opacity p-1 rounded hover:bg-muted" @click.stop="openMenu(row.session)">
       <MoreHorizontal :size="14" />
     </button>
     ```
   - Tích hợp `DropdownMenu` với các action "Đổi tên" và "Xoá phiên".
3. Kết nối với `RenameDialog` và `ConfirmDeleteDialog`.
4. Gọi `renameSession` và `deleteSession`, cập nhật store và hiển thị toast tiếng Việt ("Đã đổi tên phiên", "Đã xoá phiên").

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test apps/web/src/components/SessionRail.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/SessionRail.vue apps/web/src/components/SessionRail.test.ts
git commit -m "feat(web): add hover action menu to SessionRail for renaming and deleting sessions"
```

---

### Task 6: RunnersView UI enhancements (`apps/web`)

**Files:**
- Modify: `apps/web/src/views/RunnersView.vue`
- Test: `apps/web/src/views/RunnersView.test.ts`

**Interfaces:**
- Consumes: `RenameDialog`, `ConfirmDeleteDialog`, `renameRunner`, `deleteRunner`

- [ ] **Step 1: Write test for RunnersView**

Kiểm tra:
- Hiển thị tên runner (`name`) nổi bật bên cạnh ID.
- Nút "Đổi tên" mở dialog và cập nhật tên runner.
- Nút "Xoá runner" hiển thị cảnh báo thu hồi + xoá cascade session, thực thi gọi API xoá thành công.

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test apps/web/src/views/RunnersView.test.ts`
Expected: FAIL

- [ ] **Step 3: Update `RunnersView.vue`**

1. Thêm `name` vào `RunnerRow`.
2. Hiển thị tên gợi nhớ (nếu có) trên từng hàng runner với kích thước lớn và rõ ràng hơn mã ID kỹ thuật.
3. Thêm các nút hành động:
   - Nút icon `Pencil` để mở `RenameDialog`.
   - Nút "Thu hồi" (giữ nguyên nếu chưa thu hồi).
   - Nút icon `Trash2` "Xoá" để mở `ConfirmDeleteDialog`:
     - Nếu runner chưa thu hồi: cảnh báo "Runner sẽ bị ngắt kết nối/thu hồi ngay lập tức và toàn bộ các phiên làm việc thuộc runner này sẽ bị xoá vĩnh viễn!".
4. Tích hợp gọi `renameRunner` và `deleteRunner`, hiển thị toast tiếng Việt ("Đã đổi tên runner", "Đã xoá runner và các phiên liên quan").

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test apps/web/src/views/RunnersView.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/views/RunnersView.vue apps/web/src/views/RunnersView.test.ts
git commit -m "feat(web): add rename and cascade delete actions to RunnersView"
```

---

### Task 7: Comprehensive Vietnamese localization sweep (`apps/web`)

**Files:**
- Modify: `apps/web/src/views/RunnersView.vue`
- Modify: `apps/web/src/components/SessionRail.vue`
- Modify: `apps/web/src/views/ConsoleLayout.vue`
- Modify: `apps/web/src/views/DashboardView.vue`
- Modify: `apps/web/src/views/SessionView.vue`
- Modify: `apps/web/src/components/Composer.vue`
- Modify: `apps/web/src/components/InspectPanel.vue`

- [ ] **Step 1: Scan for remaining English text in UI views and components**

Tìm các chuỗi tiếng Anh như:
- "Connectors." -> "Trình kết nối (Runners)"
- "Runners" trong rail -> "Trình kết nối"
- "copy" -> "Sao chép"
- "New session" -> "Phiên mới"
- "Sign out" -> "Đăng xuất"
- "All changes reverted" -> "Đã hoàn tác toàn bộ thay đổi"
- Các placeholder, aria-label, tooltip còn tiếng Anh.

- [ ] **Step 2: Update all components to Vietnamese**

Thay thế bằng văn phong tiếng Việt chuẩn kỹ thuật, ngắn gọn, tự nhiên và nhất quán với các phần đã dịch trước đó.

- [ ] **Step 3: Run full checks (tests, typecheck, lint)**

Run: `bun test && bun run typecheck && bun run lint`
Expected: PASS 100%

- [ ] **Step 4: Commit**

```bash
git add apps/web/
git commit -m "feat(web): complete Vietnamese localization across web UI"
```

---

### Task 8: End-to-end verification and build verification

- [ ] **Step 1: Run full monorepo tests, typecheck and lint**

Run: `bun test && bun run typecheck && bun run lint`
Expected: Tất cả bài test đều pass, không có lỗi typecheck hoặc lint.

- [ ] **Step 2: Build runner and web application**

Run: `bun run build:runner && cd apps/web && bun run build`
Expected: Build thành công không có lỗi bundle.

- [ ] **Step 3: Verification commit & push**

```bash
git push origin main
```
