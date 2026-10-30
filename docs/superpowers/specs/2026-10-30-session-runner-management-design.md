# Quản lý Phiên, Runner và Bản địa hoá Tiếng Việt (Session & Runner Management with Vietnamese Localization)

> **Design Document** — 2026-10-30  
> **Status:** Draft for review  

## 1. Mục tiêu (Goals) & Phạm vi (Scope)

### Bối cảnh & Vấn đề
- Hiện tại, các phiên làm việc (sessions) và runner chỉ được hiển thị bằng chuỗi ID kỹ thuật dài (UUID / hash), khó nhớ và khó phân biệt khi có nhiều phiên hoặc runner.
- Người dùng chưa thể đổi tên phiên/runner, chưa thể xoá phiên cũ hoặc xoá runner đã thu hồi/không dùng nữa trực tiếp từ giao diện web.
- Một số thành phần trên giao diện người dùng (`apps/web`) vẫn còn hiển thị tiếng Anh (như tiêu đề "Connectors.", "Runners", nhãn trạng thái, v.v.), chưa đồng bộ trải nghiệm tiếng Việt.

### Mục tiêu cần đạt (Goals)
1. **Đổi tên gợi nhớ phiên (Session Renaming)**:
   - Cho phép đặt/đổi tên gợi nhớ cho phiên qua hộp thoại modal.
   - Tên gợi nhớ được lưu bền vững vào database `control.sqlite`, thay thế chuỗi ID trên danh sách phiên (`SessionRail`) và các màn hình liên quan.
2. **Xoá phiên (Session Deletion)**:
   - Thêm nút menu hành động 3 chấm (`...`) xuất hiện ở góc phải khi hover vào từng phiên trên `SessionRail`.
   - Menu hành động có 2 chức năng: "Đổi tên" và "Xoá phiên".
   - Thao tác xoá phiên yêu cầu xác nhận qua modal; khi xoá sẽ dọn dẹp sạch toàn bộ dữ liệu phiên trong database (`sessions`, `run_events`, `active_runs`, `approvals`, `approval_decisions`, `command_outbox`).
3. **Quản lý Runner (Runner Renaming & Deletion)**:
   - Cho phép đặt/đổi tên gợi nhớ cho runner trong trang quản lý Runners (`/runners`).
   - Hỗ trợ nút xoá runner:
     - Nếu runner đã thu hồi (`revoked_at != null`): Xoá ngay bản ghi runner trong DB.
     - Nếu runner chưa thu hồi: Tự động thu hồi (ngắt kết nối WebSocket) rồi xoá trong DB.
     - Cascade delete: Tự động xoá tất cả các phiên thuộc về runner này (cùng toàn bộ lịch sử sự kiện của các phiên đó).
4. **Bản địa hoá toàn bộ giao diện sang tiếng Việt (100% Vietnamese Localization)**:
   - Rà soát và chuyển toàn bộ các chuỗi giao diện người dùng tiếng Anh còn sót lại trong `apps/web/src` sang tiếng Việt chuẩn, tự nhiên.

### Ngoài phạm vi (Non-goals)
- Không can thiệp sửa đổi các file hoặc thư mục trên máy trạm của runner.
- Không hỗ trợ khôi phục phiên/runner sau khi đã xác nhận xoá (xoá vĩnh viễn).

---

## 2. Kiến trúc & Thiết kế Chi tiết (Detailed Design)

### 2.1. Cập nhật Cơ sở dữ liệu (`packages/control-db`)

1. **Bảng `sessions`**:
   - Schema hiện tại: `id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, workspace_id TEXT NOT NULL, runner_id TEXT NOT NULL, created_at INTEGER NOT NULL`.
   - Thêm cột `title TEXT` (nullable) lưu tên gợi nhớ của phiên.
   - Sử dụng `addColumnIfMissing(db, "sessions", "title", "TEXT")` để đảm bảo tương thích ngược không mất dữ liệu.
   - Các hàm truy vấn:
     - `updateSessionTitle(db: Database, sessionId: string, ownerId: string, title: string): boolean`
     - `deleteSession(db: Database, sessionId: string, ownerId: string): boolean`
       - Xoá trong transaction: `sessions` (theo `id = sessionId`), `run_events` (theo `session_id = sessionId`), `active_runs` (theo `session_id = sessionId`), `approvals` (theo `session_id = sessionId`), `command_outbox` (theo `session_id = sessionId`).
     - Cập nhật `listSessions` trả về trường `title?: string`.

2. **Bảng `runners`**:
   - Schema hiện tại: `id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, created_at INTEGER NOT NULL, revoked_at INTEGER`.
   - Thêm cột `name TEXT` (nullable) lưu tên gợi nhớ của runner.
   - Sử dụng `addColumnIfMissing(db, "runners", "name", "TEXT")`.
   - Các hàm truy vấn:
     - `updateRunnerName(db: Database, runnerId: string, ownerId: string, name: string): boolean`
     - `deleteRunner(db: Database, runnerId: string, ownerId: string): { ok: boolean; deletedSessions: string[] }`
       - Thu hồi runner nếu chưa thu hồi (`revoked_at = Date.now()`).
       - Tìm tất cả các phiên (`sessions WHERE runner_id = ? AND owner_id = ?`), xoá sạch dữ liệu các phiên đó qua logic dọn dẹp phiên.
       - Xoá các bản ghi liên quan đến runner: `workspaces`, `runner_credentials`, `command_outbox`, và `runners`.
     - Cập nhật `listRunners` trả về trường `name?: string`.

---

### 2.2. API Routes & WebSocket Gateway (`apps/control-server`)

1. **Quản lý Phiên**:
   - `PATCH /api/sessions/:id`:
     - `:id` là `sessionId` đầy đủ.
     - Body: `{ title: string }`.
     - Xác thực cookie và kiểm tra `ownerId`.
     - Cập nhật tên và trả về `{ ok: true, sessionId, title }`.
   - `DELETE /api/sessions/:id`:
     - `:id` là `sessionId` đầy đủ.
     - Xác thực cookie và kiểm tra `ownerId`.
     - Nếu có active run đang chạy trong phiên này, huỷ run qua `scheduler.release(runId)`.
     - Dọn dẹp toàn bộ dữ liệu phiên trong DB qua `deleteSession`.
     - Trả về `{ ok: true, sessionId }`.

2. **Quản lý Runner**:
   - `PATCH /api/runners/:id`:
     - `:id` là `runnerId` đầy đủ.
     - Body: `{ name: string }`.
     - Xác thực cookie và kiểm tra `ownerId`.
     - Cập nhật tên và trả về `{ ok: true, runnerId, name }`.
   - `DELETE /api/runners/:id`:
     - `:id` là `runnerId` đầy đủ.
     - Xác thực cookie và kiểm tra `ownerId`.
     - Đóng kết nối live WebSocket socket của runner qua `runnerGateway.revoke(runnerId)` (đã có sẵn trong gateway).
     - Thu hồi token và cascade xoá toàn bộ phiên cùng dữ liệu runner trong DB qua `deleteRunner`.
     - Trả về `{ ok: true, runnerId, deletedSessions: string[] }`.

---

### 2.3. Giao diện Người dùng (`apps/web`)

1. **`SessionRail.vue` (Thanh danh sách phiên)**:
   - Mỗi mục phiên (`li`) khi hover sẽ hiển thị icon ba chấm `MoreHorizontal` ở góc phải (`opacity-0 group-hover:opacity-100 transition-opacity`).
   - Khi click vào nút menu:
     - Ngăn sự kiện click lan truyền (`@click.stop`) để không kích hoạt điều hướng vào phiên.
     - Mở Dropdown Menu (shadcn-vue `DropdownMenu`, `DropdownMenuItem`):
       - "Đổi tên phiên" (`Pencil` icon): Mở modal đổi tên.
       - "Xoá phiên" (`Trash2` icon, màu text đỏ `text-destructive`): Mở modal xác nhận xoá.
   - Nhãn hiển thị phiên: Ưu tiên hiển thị `session.title` nếu có, nếu không thì hiển thị tên thư mục / ID ngắn như hiện tại.
   - Khi phiên đang xem bị xoá: Tự động điều hướng về `/sessions` (màn hình tạo phiên mới).

2. **Modal Dialogs**:
   - `RenameDialog.vue`: Dialog chung hoặc riêng cho việc đổi tên (có tiêu đề rõ ràng, input autofocus, nút "Lưu" và "Huỷ").
   - `ConfirmDeleteDialog.vue`: Dialog xác nhận xoá với cảnh báo rõ ràng (đặc biệt khi xoá runner sẽ cảnh báo kèm số lượng phiên bị xoá).

3. **`RunnersView.vue` (Trang quản lý Runners)**:
   - Hiển thị tên gợi nhớ nổi bật cho mỗi runner (nếu chưa đặt, hiển thị mặc định hoặc gợi ý đặt tên).
   - Thêm nút hành động:
     - Nút "Đổi tên" (`Pencil` icon hoặc nút bấm).
     - Nút "Thu hồi" (giữ nguyên logic hiện tại).
     - Nút "Xoá runner" (`Trash2` icon): Nếu chưa thu hồi, hiển thị cảnh báo "Runner sẽ được thu hồi và toàn bộ các phiên liên quan sẽ bị xoá".

4. **Bản địa hoá Tiếng Việt toàn diện (Localization Sweep)**:
   - Rà soát toàn bộ các text tiếng Anh còn sót lại:
     - `RunnersView.vue`: "Connectors." -> "Trình kết nối (Runners)", "runner id" -> "mã runner", "copy" -> "sao chép", các hướng dẫn cài đặt.
     - `SessionRail.vue`: "Runners" -> "Trình kết nối" (hoặc "Runners"), tiêu đề và tooltip.
     - `ConsoleLayout.vue`, `DashboardView.vue`, `Composer.vue`: Các nút, thông báo trạng thái, placeholder.
     - Thông báo toast: Thống nhất hoàn toàn bằng tiếng Việt.

---

## 3. Rủi ro & Giải pháp (Risks & Mitigations)

| Rủi ro | Giải pháp |
|---|---|
| Xoá nhầm phiên hoặc runner | Luôn yêu cầu xác nhận qua modal dialog trước khi gọi API xoá. |
| Runner đang chạy tác vụ dở dang khi bị xoá | Tự động gọi `runnerGateway.revoke()` để ngắt socket và giải phóng scheduler run trước khi xoá DB. |
| Người dùng khác can thiệp xoá phiên của nhau | Toàn bộ các thao tác `PATCH` và `DELETE` đều kiểm tra `owner_id` trong truy vấn SQL. |
| DB cũ thiếu cột `title` hoặc `name` | Dùng `addColumnIfMissing` khi khởi chạy DB, không làm hỏng dữ liệu hiện tại. |
