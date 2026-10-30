# Đặc tả Kế hoạch Triển khai: Đính kèm Tệp & Hình ảnh (File & Image Attachments Implementation Plan)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cung cấp tính năng đính kèm tệp và hình ảnh hoàn chỉnh từ Web Composer (qua nút kẹp giấy, kéo thả, hoặc dán từ clipboard), lưu trữ an toàn tại Control Server, chuyển tiếp tải tạm về Runner để Claude Code tiếp nhận (phân tích ảnh vision, đọc tài liệu), hiển thị thumbnail trong lịch sử chat, và tự động dọn dẹp sạch sẽ khi xoá phiên.

**Architecture:** 
1. `packages/protocol`: Định nghĩa kiểu dữ liệu `AttachmentInfo`, `RunnerAttachmentItem`, mở rộng `RunStartPayload` và RPC `session.cleanup`.
2. `packages/control-db`: Tạo bảng `session_attachments` trong SQLite qua `addColumnIfMissing` / migration, hỗ trợ lưu trữ metadata và cascade dọn dẹp khi xoá phiên.
3. `apps/control-server`: Thêm route multipart upload `POST /api/sessions/:sessionId/attachments`, route xem tệp `GET /api/attachments/:id`, route tải nội bộ cho runner `GET /api/runner/attachments/:id`, truyền `attachmentIds` vào `run.start` và dọn dẹp tệp trên đĩa khi xoá phiên.
4. `apps/runner`: Tải tệp nhị phân từ Control Server về thư mục tạm `~/.cc-web-runner/tmp/sessions/<sessionId>/attachments/`, đưa danh sách đường dẫn tuyệt đối vào ngữ cảnh prompt của Claude Code (hỗ trợ `Read` tool xem ảnh vision / đọc file), tiếp nhận RPC `session.cleanup` và dọn dẹp tệp mồ côi lúc boot.
5. `apps/web`: Nâng cấp `Composer.vue` hỗ trợ kẹp giấy, drag-and-drop, paste ảnh từ clipboard; thanh xem trước tức thì (thumbnail cho ảnh, badge cho tài liệu); hiển thị tệp đính kèm trong bong bóng tin nhắn chat `UserTurn` (click phóng to ảnh).

**Tech Stack:** Bun, TypeScript, SQLite (`bun:sqlite`), Hono, Vue 3, Tailwind CSS, Lucide icons, Claude Agent SDK.

**Spec:** `docs/superpowers/specs/2026-10-30-file-attachments-design.md`

---

## Global Constraints

- Không bao giờ chỉnh sửa trực tiếp các file sinh ra của shadcn-vue (`apps/web/src/components/ui/**`, `apps/web/src/lib/utils.ts`, `apps/web/src/styles/index.css`, `apps/web/components.json`).
- Mọi thay đổi schema database phải tương thích ngược trong `packages/control-db/src/db.ts`.
- WebSocket message size luôn phải nhỏ hơn `WS_MAX_PAYLOAD_BYTES` (4MB) — tuyệt đối không nhúng base64 file lớn vào WebSocket; runner tải file qua HTTP nội bộ.
- Mọi thao tác tải lên/tải về đều phải xác thực `ownerId` hoặc token của runner để đảm bảo tính cô lập tài khoản.
- Tên file tải lên phải được làm sạch (sanitize) chống path traversal (`/`, `\`, `..`).
- Giới hạn tải lên: 20MB / tệp, tối đa 50MB tổng cộng mỗi lượt gửi.
- Chạy toàn bộ test suites (`bun test`), `bun run typecheck`, và `bun run lint` trước khi hoàn tất mỗi task.
- Mã nguồn, comment, tên định danh, commit message viết bằng tiếng Anh; toàn bộ giao diện người dùng (UI text, nhãn, toast, modal) viết bằng tiếng Việt tự nhiên, chuẩn xác.

## Review Focus

1. **Path traversal prevention:** Tên file từ người dùng (`filename`) có thể chứa ký tự độc hại (`../../etc/passwd`). Server và Runner phải sanitize triệt để bằng `path.basename` và regex loại bỏ ký tự lạ.
2. **WebSocket frame size ceiling:** Danh sách tệp đính kèm gửi trong `run.start` chỉ chứa metadata (`id`, `name`, `size`, `mimeType`), không chứa nội dung nhị phân/base64 lớn.
3. **Memory leaks with Object URLs:** Trên frontend, các URL tạm được tạo bởi `URL.createObjectURL(file)` phải được thu hồi bằng `URL.revokeObjectURL()` khi xoá file khỏi danh sách hoặc sau khi gửi thành công.
4. **Offline runner cleanup resilience:** Khi xoá phiên trên server mà runner đang offline, server vẫn hoàn thành xoá phiên cục bộ; khi runner khởi động lại (boot), cơ chế dọn dẹp thư mục tạm mồ côi sẽ dọn dẹp các tệp cũ.
5. **Session isolation on attachments:** Endpoint `GET /api/attachments/:id` và `GET /api/runner/attachments/:id` phải kiểm tra chặt chẽ quyền sở hữu (owner session hoặc runner gán cho session đó), không cho phép truy cập chéo giữa các phiên.

---

### Task 1: Protocol definitions and serialization (`packages/protocol`)

**Files:**
- Create: `packages/protocol/src/attachments.ts`
- Create: `packages/protocol/src/attachments.test.ts`
- Modify: `packages/protocol/src/index.ts:1-70`

**Interfaces:**
- Produces:
  - `AttachmentInfo`: `{ id: string; name: string; mimeType: string; size: number }`
  - `RunnerAttachmentItem`: `{ id: string; name: string; mimeType: string; size: number }`
  - `parseAttachmentInfo(value: unknown): AttachmentInfo | undefined`
  - `parseRunnerAttachmentItems(value: unknown): RunnerAttachmentItem[] | undefined`
  - `SessionCleanupRequest`: `{ sessionId: string }`
  - `SessionCleanupResult`: `{ ok: boolean; error?: string }`
  - `parseSessionCleanupRequest(value: unknown): SessionCleanupRequest | undefined`

- [ ] **Step 1: Write failing tests for attachment protocol parsing and validation**

Thêm các test cases trong `packages/protocol/src/attachments.test.ts`:
- `parseAttachmentInfo`: kiểm tra parse hợp lệ khi đủ `id`, `name`, `mimeType`, `size` (hợp lệ > 0).
- `parseAttachmentInfo`: từ chối nếu thiếu trường, sai kiểu dữ liệu, hoặc kích thước âm.
- `parseRunnerAttachmentItems`: parse mảng các items, từ chối mảng chứa phần tử lỗi, trả về mảng rỗng nếu truyền `undefined`.
- `parseSessionCleanupRequest`: kiểm tra parse `sessionId` hợp lệ (chuỗi không rỗng), từ chối chuỗi rỗng hoặc kiểu khác.

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/protocol/src/attachments.test.ts`  
Expected: FAIL vì file `attachments.ts` chưa tồn tại.

- [ ] **Step 3: Implement protocol models in `packages/protocol/src/attachments.ts` & export in `index.ts`**

1. Tạo file `packages/protocol/src/attachments.ts`:
   - Định nghĩa types `AttachmentInfo`, `RunnerAttachmentItem`, `SessionCleanupRequest`, `SessionCleanupResult`.
   - Viết các hàm parse an toàn: `parseAttachmentInfo`, `parseRunnerAttachmentItems`, `parseSessionCleanupRequest`.
2. Trong `packages/protocol/src/index.ts`:
   - Export toàn bộ types và helper functions từ `attachments.ts`.
   - Bổ sung `session.cleanup` vào `CommandKind` (hoặc RPC request kind).

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/protocol/src/attachments.test.ts`  
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/protocol/src/attachments.ts packages/protocol/src/attachments.test.ts packages/protocol/src/index.ts
git commit -m "feat(protocol): add attachment types, validation, and session cleanup command"
```

---

### Task 2: Database schema and query operations (`packages/control-db`)

**Files:**
- Modify: `packages/control-db/src/db.ts:90-130`
- Create: `packages/control-db/src/attachments.ts`
- Create: `packages/control-db/src/attachments.test.ts`
- Modify: `packages/control-db/src/sessions.ts:40-80`
- Modify: `packages/control-db/src/sessions.test.ts`
- Modify: `packages/control-db/src/index.ts`

**Interfaces:**
- Produces:
  - `SessionAttachmentRecord`: `{ id: string; sessionId: string; ownerId: string; name: string; mimeType: string; size: number; storagePath: string; createdAt: number }`
  - `insertSessionAttachment(db: Database, record: SessionAttachmentRecord): void`
  - `getSessionAttachment(db: Database, id: string, ownerId: string): SessionAttachmentRecord | undefined`
  - `listSessionAttachments(db: Database, sessionId: string, ownerId: string): SessionAttachmentRecord[]`
  - `deleteSessionAttachments(db: Database, sessionId: string, ownerId: string): string[]` (trả về danh sách `storagePath` để server xoá trên đĩa)
  - Cập nhật `deleteSession(db: Database, sessionId: string, ownerId: string): { ok: boolean; attachmentStoragePaths: string[] }`

- [ ] **Step 1: Write failing tests for session attachments DB operations**

Thêm test cases trong `packages/control-db/src/attachments.test.ts` và `packages/control-db/src/sessions.test.ts`:
- `insertSessionAttachment` & `getSessionAttachment`: ghi bản ghi mới và đọc lại chính xác; từ chối khi query sai `ownerId`.
- `listSessionAttachments`: trả về danh sách attachments theo `sessionId` và `ownerId`.
- `deleteSessionAttachments`: xoá toàn bộ bản ghi của session và trả về danh sách `storagePath`.
- `deleteSession`: khi xoá phiên, trả về danh sách các `storagePath` của các attachments thuộc phiên để server xoá tệp trên đĩa.

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/control-db/src/attachments.test.ts`  
Expected: FAIL vì các hàm chưa được định nghĩa.

- [ ] **Step 3: Implement database operations in `packages/control-db`**

1. Trong `packages/control-db/src/db.ts`:
   - Thêm migration tạo bảng `session_attachments` và index `idx_session_attachments_session`.
2. Tạo `packages/control-db/src/attachments.ts`:
   - Viết các hàm `insertSessionAttachment`, `getSessionAttachment`, `listSessionAttachments`, `deleteSessionAttachments`.
3. Trong `packages/control-db/src/sessions.ts`:
   - Cập nhật `deleteSession` để truy vấn danh sách `storage_path` từ `session_attachments`, xoá bảng `session_attachments` trong transaction xoá session, và trả về danh sách đường dẫn này.
4. Export các hàm và types từ `packages/control-db/src/index.ts`.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/control-db/src/attachments.test.ts packages/control-db/src/sessions.test.ts`  
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/control-db/src/db.ts packages/control-db/src/attachments.ts packages/control-db/src/attachments.test.ts packages/control-db/src/sessions.ts packages/control-db/src/sessions.test.ts packages/control-db/src/index.ts
git commit -m "feat(control-db): add session attachments table and queries with cascade cleanup"
```

---

### Task 3: Control Server attachment endpoints and dispatching (`apps/control-server`)

**Files:**
- Create: `apps/control-server/src/routes/attachments-routes.ts`
- Create: `apps/control-server/src/routes/attachments-routes.test.ts`
- Modify: `apps/control-server/src/routes/runs-routes.ts:40-90`
- Modify: `apps/control-server/src/routes/runs-routes.test.ts`
- Modify: `apps/control-server/src/routes/sessions-routes.ts:270-310`
- Modify: `apps/control-server/src/server.ts:180-250`

**Interfaces:**
- Produces:
  - `POST /api/sessions/:sessionId/attachments`: multipart form parser, lưu tệp vào `./data/attachments/:sessionId/<id>-<safeName>`, trả về `AttachmentInfo[]`.
  - `GET /api/attachments/:id`: phục vụ file cho Web (xác thực cookie/session của owner).
  - `GET /api/runner/attachments/:id`: phục vụ file cho Runner (xác thực Bearer token runner).
  - Cập nhật `POST /api/sessions/:sessionId/runs`: nhận `attachmentIds?: string[]`, map sang `RunnerAttachmentItem[]` đưa vào `run.start` payload.
  - Cập nhật `DELETE /api/sessions/:sessionId`: xoá tệp trên đĩa từ `attachmentStoragePaths`, gửi RPC `session.cleanup` tới runner nếu đang kết nối.

- [ ] **Step 1: Write failing tests for attachment routes and run dispatch**

Thêm test cases trong `apps/control-server/src/routes/attachments-routes.test.ts` và `apps/control-server/src/routes/runs-routes.test.ts`:
- Upload multipart thành công: lưu file trên đĩa, trả về 201 với `AttachmentInfo[]`.
- Upload từ chối khi vượt quá 20MB / tệp hoặc quá 50MB tổng dung lượng (trả về 413).
- Upload từ chối khi không có cookie xác thực (trả về 401).
- `GET /api/attachments/:id`: trả về nội dung file với đúng `Content-Type` và `Cache-Control`.
- `GET /api/runner/attachments/:id`: xác thực token của runner, trả về binary stream.
- `POST /api/sessions/:sessionId/runs` nhận `attachmentIds`: payload của `run.start` chứa `attachments: RunnerAttachmentItem[]`.
- `DELETE /api/sessions/:sessionId`: xoá thư mục attachments trên đĩa của session.

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test apps/control-server/src/routes/attachments-routes.test.ts`  
Expected: FAIL vì route chưa được định nghĩa.

- [ ] **Step 3: Implement attachment routes in `apps/control-server`**

1. Tạo `apps/control-server/src/routes/attachments-routes.ts`:
   - Hàm `handleUploadAttachments`: parse `request.formData()`, kiểm tra size, sanitize filename (`path.basename`), lưu tệp vào `options.dataDir/attachments/:sessionId/`, gọi `insertSessionAttachment`.
   - Hàm `handleGetAttachment`: xác thực owner, đọc file và trả về `Response` kèm mime type thích hợp.
   - Hàm `handleGetRunnerAttachment`: xác thực runner token, kiểm tra session pin/active run, trả về file stream.
2. Trong `apps/control-server/src/routes/runs-routes.ts`:
   - Hỗ trợ trường `attachmentIds` trong body. Lấy thông tin từ `getSessionAttachment`, chuyển thành `RunnerAttachmentItem[]` gắn vào payload dispatch.
3. Trong `apps/control-server/src/routes/sessions-routes.ts`:
   - Khi gọi `deleteSession`: xoá thư mục `attachments/:sessionId` trên đĩa. Nếu runner gán với session đang online, gửi RPC `session.cleanup`.
4. Trong `apps/control-server/src/server.ts`:
   - Đăng ký routing các endpoints mới vào fetch handler.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test apps/control-server/src/routes/attachments-routes.test.ts apps/control-server/src/routes/runs-routes.test.ts`  
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/control-server/src/routes/attachments-routes.ts apps/control-server/src/routes/attachments-routes.test.ts apps/control-server/src/routes/runs-routes.ts apps/control-server/src/routes/runs-routes.test.ts apps/control-server/src/routes/sessions-routes.ts apps/control-server/src/server.ts
git commit -m "feat(control-server): add attachment upload, serve, runner download, and dispatch endpoints"
```

---

### Task 4: Runner attachment download, temporary storage, and context injection (`apps/runner`)

**Files:**
- Create: `apps/runner/src/execution/attachments.ts`
- Create: `apps/runner/src/execution/attachments.test.ts`
- Modify: `apps/runner/src/execution/executor.ts:380-410`
- Modify: `apps/runner/src/execution/executor.test.ts`
- Create: `apps/runner/src/cleanup/handler.ts`
- Create: `apps/runner/src/cleanup/handler.test.ts`
- Modify: `apps/runner/src/daemon.ts:50-100`

**Interfaces:**
- Produces:
  - `downloadRunnerAttachments(options: { serverUrl: string; token: string; sessionId: string; runnerHome: string; attachments: RunnerAttachmentItem[] }): Promise<Array<{ name: string; path: string; mimeType: string }>>`
  - `injectAttachmentsContext(prompt: string, files: Array<{ name: string; path: string; mimeType: string }>): string`
  - `cleanSessionTemp(runnerHome: string, sessionId: string): Promise<void>`
  - `cleanOrphanedTemp(runnerHome: string, maxAgeMs?: number): Promise<number>`
  - Tích hợp RPC `session.cleanup` vào `daemon.ts`.

- [ ] **Step 1: Write failing tests for runner attachments and temp cleanup**

Thêm test cases trong `apps/runner/src/execution/attachments.test.ts` và `apps/runner/src/cleanup/handler.test.ts`:
- `downloadRunnerAttachments`: gọi HTTP mock server tải file về thư mục `~/.cc-web-runner/tmp/sessions/<sessionId>/attachments/`, ghi đúng file nhị phân.
- `injectAttachmentsContext`: định dạng danh sách file đính kèm với đường dẫn tuyệt đối, hướng dẫn Claude Code dùng `Read` tool, ghép cùng prompt gốc.
- `cleanSessionTemp`: xoá sạch thư mục tạm của phiên chỉ định.
- `cleanOrphanedTemp`: quét thư mục tạm và xoá các thư mục cũ hơn 7 ngày.

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test apps/runner/src/execution/attachments.test.ts apps/runner/src/cleanup/handler.test.ts`  
Expected: FAIL vì các module chưa tồn tại.

- [ ] **Step 3: Implement runner attachment handling & temp directory cleanup**

1. Tạo `apps/runner/src/execution/attachments.ts`:
   - Hàm `downloadRunnerAttachments`: tạo thư mục `tmp/sessions/:sessionId/attachments`, tải từng tệp chưa có sẵn từ `${serverUrl}/api/runner/attachments/${att.id}`, lưu an toàn trên đĩa.
   - Hàm `injectAttachmentsContext`: sinh block text `[Attached Files]\n- name: <name>, path: <path> (<mimeType>)\n...\nUser prompt:\n<prompt>` nhắc Claude Code sử dụng tool `Read` cho file text/code hoặc ảnh.
2. Trong `apps/runner/src/execution/executor.ts`:
   - Khi `command.payload` chứa `attachments`, gọi `downloadRunnerAttachments`, dùng `injectAttachmentsContext` biến đổi prompt trước khi chuyển cho Claude Code SDK.
   - Đưa `attachments?: AttachmentInfo[]` vào payload sự kiện `run.started`.
3. Tạo `apps/runner/src/cleanup/handler.ts`:
   - Viết các hàm `cleanSessionTemp` và `cleanOrphanedTemp`.
4. Trong `apps/runner/src/daemon.ts`:
   - Định tuyến lệnh RPC `session.cleanup` tới `cleanSessionTemp`.
   - Lúc boot: gọi `cleanOrphanedTemp` chạy background để dọn dẹp các thư mục mồ côi.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test apps/runner/src/execution/attachments.test.ts apps/runner/src/cleanup/handler.test.ts apps/runner/src/execution/executor.test.ts`  
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/runner/src/execution/attachments.ts apps/runner/src/execution/attachments.test.ts apps/runner/src/execution/executor.ts apps/runner/src/execution/executor.test.ts apps/runner/src/cleanup/handler.ts apps/runner/src/cleanup/handler.test.ts apps/runner/src/daemon.ts
git commit -m "feat(runner): add attachment downloading, prompt context injection, and temp directory cleanup"
```

---

### Task 5: Frontend attachments API, Composer UX (pick, drag-drop, paste, preview) (`apps/web`)

**Files:**
- Create: `apps/web/src/services/attachments-api.ts`
- Create: `apps/web/src/services/attachments-api.test.ts`
- Modify: `apps/web/src/features/composer/composer-logic.ts:130-180`
- Modify: `apps/web/src/features/composer/composer-logic.test.ts`
- Modify: `apps/web/src/components/Composer.vue:290-360, 490-540`

**Interfaces:**
- Produces:
  - `uploadSessionAttachments(sessionId: string, files: File[]): Promise<{ ok: true; attachments: AttachmentInfo[] } | { ok: false; message: string }>`
  - `attachmentUrl(id: string): string`
  - Cập nhật `buildRunRequest`: nhận thêm `attachmentIds?: string[]`.
  - Cập nhật `Composer.vue`:
    - Bắt sự kiện `@paste` trên textarea (tự động nhận diện ảnh/file từ clipboard).
    - Hỗ trợ kéo thả file (`@dragover`, `@dragleave`, `@drop`) kèm visual overlay.
    - Thanh xem trước với thumbnail ảnh (object URL), badge tài liệu, và nút xoá (`X`).
    - Gửi file qua API upload trước khi gọi `startRun`.

- [ ] **Step 1: Write failing tests for attachments API and composer logic**

Thêm test cases trong `apps/web/src/services/attachments-api.test.ts` và `apps/web/src/features/composer/composer-logic.test.ts`:
- `uploadSessionAttachments`: gửi `FormData` chứa các tệp tới `/api/sessions/:sessionId/attachments`, xử lý kết quả thành công hoặc lỗi quá dung lượng.
- `buildRunRequest`: bao gồm `attachmentIds` trong request payload khi có tệp được chọn.

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test apps/web/src/services/attachments-api.test.ts`  
Expected: FAIL vì service chưa được tạo.

- [ ] **Step 3: Implement frontend attachment upload and Composer UX**

1. Tạo `apps/web/src/services/attachments-api.ts`:
   - Hàm `uploadSessionAttachments` sử dụng `fetch` và `FormData`.
   - Hàm `attachmentUrl(id)` trả về `/api/attachments/${id}`.
2. Trong `apps/web/src/features/composer/composer-logic.ts`:
   - Bổ sung `attachmentIds?: string[]` vào `RunPayloadInputs` và `StartRunRequest`.
3. Trong `apps/web/src/components/Composer.vue`:
   - Quản lý trạng thái attachments cục bộ kèm object URL cho file ảnh.
   - Viết handler `@paste`: kiểm tra `event.clipboardData?.items`, nếu là ảnh/file thì thêm vào `attachments`.
   - Viết handler kéo thả `@dragover`, `@dragleave`, `@drop` với hiệu ứng viền nổi bật.
   - Nâng cấp giao diện thanh preview tệp: ảnh hiển thị thumbnail thu nhỏ (kèm tỉ lệ ảnh), file khác hiển thị icon + tên + kích thước format (KB, MB).
   - Trong hàm `send()`: upload attachments trước, thu thập `attachmentIds`, truyền vào `startRun`, dọn dẹp các object URL đã tạo.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test apps/web/src/services/attachments-api.test.ts apps/web/src/features/composer/composer-logic.test.ts`  
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/services/attachments-api.ts apps/web/src/services/attachments-api.test.ts apps/web/src/features/composer/composer-logic.ts apps/web/src/features/composer/composer-logic.test.ts apps/web/src/components/Composer.vue
git commit -m "feat(web): add attachments API client and rich Composer UX with paste, drag-drop, and previews"
```

---

### Task 6: Chat transcript attachment rendering and image lightbox (`apps/web`)

**Files:**
- Modify: `apps/web/src/features/journal/chat-turns.ts:1-60`
- Modify: `apps/web/src/features/journal/chat-turns.test.ts`
- Modify: `apps/web/src/components/Composer.vue:80-90`
- Modify: `apps/web/src/views/SessionView.vue:200-280`

**Interfaces:**
- Produces:
  - Mở rộng `UserTurn`: thêm `attachments?: AttachmentInfo[]`.
  - Cập nhật `deriveChatTurns`: trích xuất `attachments` từ sự kiện `run.started` (hoặc pending run) đưa vào `UserTurn`.
  - Cập nhật hiển thị bong bóng chat trong `SessionView.vue`: render hàng đính kèm phía trên prompt của người dùng, bấm vào ảnh để phóng to lightbox modal xem ảnh kích thước đầy đủ.

- [ ] **Step 1: Write failing tests for chat turns attachment derivation**

Thêm test cases trong `apps/web/src/features/journal/chat-turns.test.ts`:
- Sự kiện `run.started` có `attachments: AttachmentInfo[]` sinh ra `UserTurn` chứa đầy đủ danh sách attachments.
- Pending run có `attachments` hiển thị ngay lập tức trong `UserTurn` trước khi sự kiện `run.started` dội về.

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test apps/web/src/features/journal/chat-turns.test.ts`  
Expected: FAIL vì `UserTurn` chưa có trường `attachments`.

- [ ] **Step 3: Implement chat transcript attachment rendering**

1. Trong `apps/web/src/features/journal/chat-turns.ts`:
   - Thêm `attachments?: AttachmentInfo[]` vào `UserTurn` type.
   - Trong `deriveChatTurns`: gán `attachments: event.payload.attachments` khi xử lý `run.started` và pending run.
2. Trong `apps/web/src/components/Composer.vue`:
   - Emit `attachments: AttachmentInfo[]` qua event `started` để SessionView hiển thị pending turn đầy đủ.
3. Trong `apps/web/src/views/SessionView.vue`:
   - Thêm modal/lightbox xem ảnh phóng to (`previewImageSrc`).
   - Trong bong bóng người dùng (`turn.type === 'user'`): render danh sách tệp đính kèm:
     - Với file ảnh: render thẻ `<img>` với `src="/api/attachments/:id"` thu nhỏ bo góc, hover zoom nhẹ, click mở lightbox xem kích thước thực.
     - Với file văn bản/tài liệu: chip bo góc có icon file, tên tệp, dung lượng và link tải về `href="/api/attachments/:id"`.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test apps/web/src/features/journal/chat-turns.test.ts`  
Expected: PASS

- [ ] **Step 5: Verify build & lint**

Run: `bun test && bun run typecheck && bun run lint && cd apps/web && bun run build`  
Expected: Tất cả tests pass, typecheck sạch, lint đạt chuẩn, build production thành công.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/features/journal/chat-turns.ts apps/web/src/features/journal/chat-turns.test.ts apps/web/src/components/Composer.vue apps/web/src/views/SessionView.vue
git commit -m "feat(web): render attachments in user chat turns with image preview and download links"
```

---

## Self-Review Checklist

- [x] **Spec coverage**: Mọi khía cạnh trong spec (Composer paste/drag-drop/kẹp giấy, thumbnail preview, upload API, lưu trữ Control Server, tải HTTP runner, lưu tạm runner, Claude Code context, chat transcript rendering, và tự động dọn dẹp khi xoá phiên) đều đã được phân rã thành các task cụ thể.
- [x] **Step scan**: Mỗi task đều tuân thủ TDD: viết test fail -> verify red -> implement minimal -> verify pass -> commit.
- [x] **Type consistency**: Các interface `AttachmentInfo`, `RunnerAttachmentItem`, `RunStartPayload`, `SessionCleanupRequest` nhất quán giữa `packages/protocol`, `packages/control-db`, `apps/control-server`, `apps/runner`, và `apps/web`.
- [x] **Review Focus**: Các điểm rủi ro (path traversal, trần WebSocket 4MB, thu hồi Object URL tránh rò rỉ bộ nhớ, cô lập tài khoản) đều được thiết kế chốt chặn trong từng task.
- [x] **Proportion**: Kế hoạch súc tích, định rõ file và chữ ký cần thay đổi, không sao chép thừa thãi.
