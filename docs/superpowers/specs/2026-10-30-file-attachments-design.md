# Đặc tả Thiết kế: Đính kèm Tệp & Hình ảnh (File & Image Attachments)

> **Design Document** — 2026-10-30  
> **Status:** Draft for review  
> **Authors:** Antigravity / Claude Code Web Team  

---

## 1. Mục tiêu (Goals) & Bối cảnh (Context)

### 1.1. Bối cảnh
Người dùng điều khiển Claude coding agent qua giao diện web (`cc-web`) thường xuyên cần cung cấp thêm ngữ cảnh ngoài văn bản prompt:
- **Hình ảnh**: Ảnh chụp màn hình lỗi giao diện (UI bugs), ảnh mockup thiết kế, biểu đồ kiến trúc.
- **Tài liệu & Dữ liệu**: File log kiểm thử, tài liệu đặc tả (PDF/Markdown), file cấu hình hoặc đoạn code mẫu từ bên ngoài dự án.

Hiện tại, `Composer.vue` mới chỉ có giao diện giữ chỗ cục bộ (local placeholder) cho các file được chọn và đưa ra thông báo: *"Tệp được chọn nhưng chưa gửi được — runner chưa hỗ trợ đính kèm."* `run.start` chưa truyền danh sách tệp đính kèm, Control Server chưa lưu trữ và Runner chưa có cơ chế tiếp nhận tệp.

### 1.2. Mục tiêu (Goals)
1. **Trải nghiệm đính kèm linh hoạt (Composer UX)**:
   - Cho phép người dùng đính kèm file bằng 3 phương thức: nút Kẹp giấy (`Paperclip`), kéo thả file (`Drag & Drop`), và dán trực tiếp (`Ctrl+V / Paste`) từ clipboard (đặc biệt hữu ích khi chụp màn hình).
   - Hiển thị thanh xem trước (preview bar): thumbnail thu nhỏ đối với ảnh (`image/*`) và badge định danh (icon + tên + dung lượng) đối với các file khác.
   - Có nút xoá (`X`) từng tệp trước khi bấm gửi prompt.
2. **Lưu trữ & Phục vụ tệp tại Control Server**:
   - Control Server nhận file tải lên qua HTTP multipart (`POST /api/sessions/:sessionId/attachments`), lưu trữ trên ổ đĩa cục bộ của server (`./data/attachments/:sessionId/<attachmentId>-<filename>`) và ghi nhận vào database SQLite (`session_attachments`).
   - Cung cấp endpoint bảo mật `GET /api/attachments/:id` có xác thực cookie/token để giao diện web hiển thị thumbnail và cho phép người dùng tải/xem lại ảnh ngay cả khi Runner đang tắt hoặc ngắt kết nối.
3. **Chuyển tiếp và Lưu tạm trên Runner**:
   - Khi run bắt đầu (`run.start`), danh sách tệp đính kèm được gửi từ Control Server sang Runner kèm định danh `id`, `name`, `mimeType`, `size`.
   - Runner tải tệp từ Control Server qua endpoint HTTP nội bộ của runner (`GET /api/runner/attachments/:id` sử dụng bearer token của runner) để tránh làm nghẽn hoặc vượt trần 4MB của WebSocket.
   - Runner lưu tệp vào thư mục tạm của phiên (`~/.cc-web-runner/tmp/sessions/<sessionId>/attachments/<filename>`).
   - Đường dẫn tuyệt đối của các tệp trên Runner được nạp vào lượt chạy của Claude Code. Claude Code có thể trực tiếp dùng tool `Read` (vốn hỗ trợ sẵn cả xem ảnh vision, file PDF, lẫn đọc code/text) hoặc công cụ dòng lệnh để phân tích tệp giống hệt như trên máy cục bộ.
4. **Hiển thị trực quan trong Lịch sử Chat (Chat Transcript)**:
   - Trong bong bóng tin nhắn của người dùng (`UserTurn`), hiển thị danh sách các tệp đính kèm: thumbnail ảnh có thể bấm để phóng to xem chi tiết, badge file có liên kết tải về.
5. **Dọn dẹp tự động khi Xoá Phiên (Automatic Cleanup on Session Deletion)**:
   - Khi một phiên được xoá (đã xác nhận xoá từ `SessionRail`), Control Server tự động xoá toàn bộ thư mục tệp đính kèm của phiên đó trên đĩa server và dọn dẹp các bản ghi trong DB.
   - Control Server đồng thời điều phối yêu cầu dọn dẹp sang Runner (nếu runner đang kết nối) để xoá thư mục tạm tương ứng trên Runner. Thêm vào đó, Runner có cơ chế tự động dọn dẹp các thư mục tạm mồ côi (orphaned tmp dirs) khi khởi động lại.

### 1.3. Ngoài phạm vi (Non-goals)
- Không lưu tệp vĩnh viễn vào trong working tree của git repository trừ khi Claude Code tự chủ động ghi ra file thông qua tool `Write`.
- Không sử dụng thêm dịch vụ lưu trữ đám mây bên thứ ba (S3, GCS, MinIO) ở giai đoạn này; tận dụng lưu trữ cục bộ của Control Server và Runner.
- Không hỗ trợ tải lên file nén rồi tự động giải nén trong phiên làm việc.

---

## 2. Kiến trúc & Thiết kế Chi tiết (Detailed Architecture)

```
[ Browser / Web ]
  │
  ├─ 1. Tải file (multipart/form-data) ──► POST /api/sessions/:sessionId/attachments
  │                                           │ (Lưu vào ./data/attachments/:sessionId/)
  │                                           ▼
  │                                    [ Control Server ]
  │                                           │ (DB: session_attachments)
  │
  ├─ 2. Gửi prompt + attachmentIds ──────► POST /api/sessions/:sessionId/runs
  │                                           │
  │                                           │ (WebSocket command: run.start
  │                                           │  mang danh sách metadata attachments)
  │                                           ▼
  │                                    [ Runner Service ]
  │                                           │
  │     3. Tải file nhị phân qua HTTP ────────┤ (GET /api/runner/attachments/:id)
  │                                           │
  │                                           ├─ Lưu tạm vào ~/.cc-web-runner/tmp/...
  │                                           ▼
  │                                    [ Claude Code SDK ]
  │                                           │
  │                                           ├─ Nhận prompt kèm đường dẫn file tạm
  │                                           └─ Sử dụng Read tool (vision / text)
  │
  └─ 4. Hiển thị Thumbnail / Ảnh ────────► GET /api/attachments/:id
                                         (Phục vụ trực tiếp từ Control Server)
```

### 2.1. Tầng Cơ sở Dữ liệu (`packages/control-db`)

Bổ sung bảng `session_attachments` trong SQLite (`control.sqlite`):

```sql
CREATE TABLE IF NOT EXISTS session_attachments (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  name TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  size INTEGER NOT NULL,
  storage_path TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_session_attachments_session
  ON session_attachments (session_id);
```

Các hàm truy vấn mới trong `@cc-web/control-db`:
- `insertSessionAttachment(db: Database, attachment: SessionAttachmentRecord): void`
- `getSessionAttachment(db: Database, id: string, ownerId: string): SessionAttachmentRecord | undefined`
- `listSessionAttachments(db: Database, sessionId: string, ownerId: string): SessionAttachmentRecord[]`
- `deleteSessionAttachments(db: Database, sessionId: string, ownerId: string): string[]` (trả về danh sách `storage_path` cần xoá trên đĩa).

### 2.2. Tầng Protocol (`packages/protocol`)

1. **Kiểu dữ liệu tệp đính kèm (`AttachmentInfo`)**:
   ```ts
   export type AttachmentInfo = {
     id: string;
     name: string;
     mimeType: string;
     size: number;
   };

   export type RunnerAttachmentItem = {
     id: string;
     name: string;
     mimeType: string;
     size: number;
   };
   ```

2. **Cập nhật `run.start` payload**:
   *Builder's call:* Không nhúng dữ liệu Base64 trực tiếp vào WebSocket để tránh vượt trần `WS_MAX_PAYLOAD_BYTES` (4MB). Chỉ truyền danh sách metadata `RunnerAttachmentItem[]`, Runner sẽ tải file qua HTTP từ Control Server.
   ```ts
   export type RunStartPayload = {
     prompt: string;
     workspaceId?: string;
     permissionMode?: string;
     model?: string;
     effort?: EffortLevel | null;
     ultracode?: boolean;
     branch?: string;
     resumeSessionId?: string;
     attachments?: RunnerAttachmentItem[];
   };
   ```

3. **Cập nhật sự kiện `run.started`**:
   - `run.started` payload mang danh sách `attachments?: AttachmentInfo[]` để giao diện web và lịch sử sự kiện hiển thị lại các file được đính kèm cùng lượt chạy.

4. **Lệnh dọn dẹp phiên trên Runner (`session.cleanup`)**:
   - Thêm RPC request `session.cleanup` với payload `{ sessionId: string }` để dọn dẹp thư mục tạm trên Runner khi phiên bị xoá.

### 2.3. Tầng Control Server (`apps/control-server`)

1. **Endpoint tải lên tệp**: `POST /api/sessions/:sessionId/attachments`
   - Xác thực danh tính chủ sở hữu (owner cookie/token).
   - Kiểm tra `sessionId` hợp lệ và thuộc về owner.
   - Nhận `multipart/form-data` chứa một hoặc nhiều tệp qua `request.formData()`.
   - Giới hạn:
     - Kích thước tối đa mỗi tệp: 20MB.
     - Tổng dung lượng đính kèm mỗi lượt gửi: 50MB.
   - Lưu tệp vào thư mục an toàn: `./data/attachments/:sessionId/<attachmentId>-<filename>`.
   - Ghi vào bảng `session_attachments`.
   - Trả về danh sách `AttachmentInfo[]`.

2. **Endpoint xem/tải tệp đính kèm cho Web**: `GET /api/attachments/:id`
   - Xác thực quyền truy cập của owner đối với attachment qua cookie.
   - Phục vụ tệp với header `Content-Type: <mime_type>`, `Content-Disposition: inline` (đối với ảnh) hoặc `attachment` (đối với file nhị phân khác), và `Cache-Control: private, max-age=86400`.

3. **Endpoint tải tệp cho Runner**: `GET /api/runner/attachments/:id`
   - Xác thực qua header `Authorization: Bearer <runnerToken>`.
   - Kiểm tra runner này được gán với session của attachment.
   - Trả về binary stream của tệp.

4. **Cập nhật Endpoint dispatch run**: `POST /api/sessions/:sessionId/runs`
   - Nhận thêm mảng `attachmentIds?: string[]`.
   - Lấy thông tin các attachments từ database, đưa metadata vào trường `attachments` của `run.start` payload gửi sang Runner.

5. **Dọn dẹp khi xoá phiên**:
   - Khi gọi `deleteSession`:
     - Huỷ active run (nếu có) trước khi xoá.
     - Truy vấn danh sách file đính kèm của phiên và xoá thư mục `./data/attachments/:sessionId/` trên đĩa.
     - Xoá các dòng trong bảng `session_attachments`.
     - Nếu runner của session đang kết nối: gửi RPC `session.cleanup` tới Runner để xoá thư mục tạm trên máy Runner.

### 2.4. Tầng Runner (`apps/runner` & `packages/agent-adapter`)

1. **Tải và lưu tệp tạm trước khi khởi chạy SDK**:
   - Khi nhận command `run.start` có chứa `attachments`:
   - Xác định thư mục tạm: `const uploadDir = path.join(runnerHome, "tmp", "sessions", sessionId, "attachments")`.
   - Tạo thư mục nếu chưa có.
   - Với mỗi attachment: kiểm tra xem file đã có trong `uploadDir` chưa; nếu chưa, gọi `fetch(`${serverUrl}/api/runner/attachments/${att.id}`, { headers: { Authorization: `Bearer ${token}` } })` và lưu thành `uploadDir/<safe-filename>`.
   - Lưu danh sách đường dẫn tuyệt đối: `savedFilePaths: Array<{ name: string; path: string; mimeType: string }>`.

2. **Cung cấp ngữ cảnh tệp cho Claude Code**:
   - Runner format thông tin tệp đính kèm và gắn vào prompt hoặc turn message của Claude Code:
     ```markdown
     [Attached Files]
     - name: screenshot.png, path: /home/anhnt/.cc-web-runner/tmp/sessions/<sessionId>/attachments/screenshot.png (image/png)
     - name: error.log, path: /home/anhnt/.cc-web-runner/tmp/sessions/<sessionId>/attachments/error.log (text/plain)

     User prompt:
     <nội dung prompt của người dùng>
     ```
   - Nhắc nhở Claude Code sử dụng tool `Read` với tham số `file_path` để đọc nội dung text hoặc xem ảnh vision trực tiếp.

3. **Dọn dẹp thư mục tạm (`session.cleanup`) & Dọn dẹp lúc boot**:
   - Tiếp nhận lệnh `session.cleanup` từ Control Server: thực hiện xoá thư mục `path.join(runnerHome, "tmp", "sessions", sessionId)`.
   - Khi Runner khởi động (boot): quét thư mục `tmp/sessions` và dọn dẹp các thư mục tạm cũ hơn 7 ngày.

### 2.5. Tầng Giao diện Web (`apps/web`)

1. **Cải tiến `Composer.vue`**:
   - **Đính kèm linh hoạt**:
     - Bắt sự kiện `@paste` trên ô textarea: nếu `event.clipboardData.files` có tệp (ví dụ ảnh chụp màn hình copy từ clipboard), tự động thêm vào danh sách `attachments`.
     - Bắt sự kiện kéo thả `@dragover`, `@dragleave`, `@drop` trên toàn bộ khung soạn thảo: hiển thị viền nổi bật (drag overlay) và thêm các tệp được thả vào danh sách `attachments`.
     - Nút icon kẹp giấy (`Paperclip`): mở hộp thoại chọn tệp như hiện tại nhưng hỗ trợ chọn nhiều tệp.
   - **Thanh xem trước (Attachment Preview Bar)**:
     - Tạo object URL (`URL.createObjectURL(file)`) ngay khi chọn để hiển thị thumbnail ảnh tức thì.
     - Với file ảnh: hiển thị ảnh thu nhỏ (kích thước ~48x48px, bo góc, `object-cover`), kèm tên và dung lượng tệp.
     - Với file khác: hiển thị badge icon tệp (`FileText`, `FileCode`, `FileArchive`), tên và dung lượng tệp.
     - Nút bấm xoá (`X`) nhỏ gọn ở góc phải mỗi mục đính kèm để gỡ bỏ trước khi gửi.
   - **Luồng gửi prompt (`send`)**:
     - Nếu có `attachments`: gọi `POST /api/sessions/:sessionId/attachments` tải các file lên trước.
     - Sau khi nhận danh sách `attachmentIds`: gọi `startRun` truyền kèm `attachmentIds`.
     - Xoá danh sách attachments cục bộ và thu hồi các object URL (`URL.revokeObjectURL`) để tránh rò rỉ bộ nhớ.

2. **Cập nhật Bong bóng Tin nhắn Chat (`UserTurn` trong `chat-turns.ts` & `SessionView.vue`)**:
   - Mở rộng kiểu dữ liệu `UserTurn`:
     ```ts
     export type UserTurn = {
       type: "user";
       id: string;
       prompt: string;
       timestamp: number;
       attachments?: AttachmentInfo[];
     };
     ```
   - Khi nhận sự kiện `run.started` có trường `attachments`, lưu giữ danh sách này vào `UserTurn`.
   - Render danh sách đính kèm ngay phía trên nội dung văn bản của người dùng:
     - Ảnh thumbnail (chiều cao ~120px - 160px, bo cong, có hiệu ứng hover): bấm vào để xem ảnh kích thước đầy đủ (modal preview hoặc lightbox).
     - File văn bản/tài liệu: chip bo góc có icon file, tên tệp, dung lượng và nút tải về qua URL `/api/attachments/:id`.

---

## 3. An toàn, Bảo mật & Xử lý Ngoại lệ (Safety & Resilience)

1. **Path Traversal & Safe File Naming**:
   - Tên tệp do người dùng tải lên được chuẩn hoá (sanitize): loại bỏ các ký tự điều khiển, dấu phân cách đường dẫn (`/`, `\`, `..`).
   - Đường dẫn lưu trữ trên đĩa luôn được nối bằng `path.join` với thư mục gốc chỉ định, ngăn chặn hoàn toàn tấn công path traversal.
2. **Xác thực & Phân quyền tệp (Authorization)**:
   - Mọi API tải lên hoặc tải về tệp (`/api/sessions/:sessionId/attachments`, `/api/attachments/:id`, `/api/runner/attachments/:id`) đều bắt buộc kiểm tra cookie xác thực của owner hoặc bearer token của runner. Người dùng không thể xem tệp của phiên khác nếu không sở hữu phiên đó.
3. **Giới hạn kích thước & Chống DoS (Size Limits)**:
   - Giới hạn 20MB cho mỗi tệp tải lên và tối đa 50MB cho toàn bộ tệp đính kèm trong một lần gửi.
   - Nếu vượt quá giới hạn, từ chối ngay ở tầng upload với HTTP 413 Payload Too Large và hiển thị thông báo lỗi thân thiện trên web.
4. **Cô lập thư mục tạm trên Runner**:
   - Thư mục tạm nằm trong `~/.cc-web-runner/tmp/sessions/<sessionId>/` với quyền truy cập an toàn (0700/0600), không làm ảnh hưởng đến các thư mục dự án khác.

---

## 4. Kế hoạch Kiểm thử & Tiêu chí Nghiệm thu (Testing & Acceptance Criteria)

### 4.1. Unit & Protocol Tests
- `packages/protocol/src/attachments.test.ts`: Kiểm tra parse và validate `AttachmentInfo`, `RunnerAttachmentItem`, `RunStartPayload` có kèm tệp đính kèm.
- `packages/control-db/src/attachments.test.ts`: Kiểm tra thêm, truy vấn, và xoá file đính kèm theo session; xác nhận xoá phiên dọn dẹp sạch bản ghi.
- `apps/control-server/src/routes/attachments-routes.test.ts`: Kiểm tra upload multipart thành công, từ chối khi không có quyền hoặc vượt quá kích thước, và endpoint phục vụ file.
- `apps/runner/src/execution/attachments.test.ts`: Kiểm tra Runner tải file qua HTTP và lưu đúng file vào thư mục tạm, tạo đúng đường dẫn gửi tới Claude Code.

### 4.2. Acceptance Criteria
1. Người dùng có thể kéo thả, dán từ clipboard hoặc chọn tệp qua nút kẹp giấy trên `Composer.vue`.
2. Ảnh đính kèm hiển thị thumbnail tức thì; file tài liệu hiển thị badge thông tin rõ ràng.
3. Khi bấm gửi, tệp được tải lên Control Server, chuyển tiếp sang Runner và lưu vào thư mục tạm của phiên.
4. Claude Code trong phiên nhận được thông tin tệp và có thể đọc/phân tích tệp (bao gồm cả phân tích ảnh qua `Read`).
5. Tin nhắn người dùng trong khung chat hiển thị đầy đủ danh sách tệp đính kèm và thumbnail ảnh.
6. Khi xoá phiên từ menu `SessionRail`, toàn bộ tệp đính kèm của phiên đó trên Control Server và Runner đều được dọn dẹp sạch sẽ.
