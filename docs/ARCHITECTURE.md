# ARCHITECTURE — Web Control Plane cho Claude Coding Agents

> Phiên bản tài liệu: 2.0 — kiến trúc đã thống nhất để triển khai.
> Ngày đối chiếu tài liệu kỹ thuật: 2026-10-23.
> Trạng thái: blueprint thiết kế; chưa có prototype hoặc benchmark chứng minh implementation.
> Kiến trúc chính: **Web → Control Server → nhiều Runner**.
> Thay thế bản single-host/embedded Runner trước đây. Có thể deploy cùng máy, nhưng Runner luôn là service độc lập về lifecycle.

## Mục lục

1. [Mục tiêu và quyết định nền tảng](#1-mục-tiêu-và-quyết-định-nền-tảng)
2. [Phạm vi và nguyên tắc an toàn](#2-phạm-vi-và-nguyên-tắc-an-toàn)
3. [Kiến trúc tổng thể](#3-kiến-trúc-tổng-thể)
4. [Stack và cấu trúc repository](#4-stack-và-cấu-trúc-repository)
5. [Domain model và quyền sở hữu](#5-domain-model-và-quyền-sở-hữu)
6. [Runner connector và authentication](#6-runner-connector-và-authentication)
7. [Kế thừa cấu hình Claude Code](#7-kế-thừa-cấu-hình-claude-code)
8. [Overrides và configuration diagnostics](#8-overrides-và-configuration-diagnostics)
9. [Durable command delivery](#9-durable-command-delivery)
10. [Runner execution và process supervision](#10-runner-execution-và-process-supervision)
11. [State machines, scheduling và concurrency](#11-state-machines-scheduling-và-concurrency)
12. [Event journal, streaming và replay](#12-event-journal-streaming-và-replay)
13. [Approvals và user questions](#13-approvals-và-user-questions)
14. [Cancel, disconnect, restart và reconciliation](#14-cancel-disconnect-restart-và-reconciliation)
15. [Workspace, file API và Git](#15-workspace-file-api-và-git)
16. [Frontend Vue và CodeMirror](#16-frontend-vue-và-codemirror)
17. [HTTP API và wire protocol](#17-http-api-và-wire-protocol)
18. [Persistence và database schema](#18-persistence-và-database-schema)
19. [Security và trust boundaries](#19-security-và-trust-boundaries)
20. [Deployment và vận hành](#20-deployment-và-vận-hành)
21. [Mở rộng và nâng cấp hạ tầng](#21-mở-rộng-và-nâng-cấp-hạ-tầng)
22. [Testing và acceptance criteria](#22-testing-và-acceptance-criteria)
23. [Roadmap triển khai](#23-roadmap-triển-khai)
24. [Decision log và các điểm còn cần xác nhận](#24-decision-log-và-các-điểm-còn-cần-xác-nhận)
25. [Nguồn tham khảo](#25-nguồn-tham-khảo)

## 1. Mục tiêu và quyết định nền tảng

Xây một ứng dụng web chat-centric để điều khiển Claude coding agents từ xa: hội thoại, sử dụng tools, duyệt thao tác, xem thay đổi và chỉnh sửa code. Trải nghiệm lấy cảm hứng từ ứng dụng desktop có agent, không phải mục tiêu sao chép đầy đủ Claude Desktop hoặc VS Code.

### 1.1. Các quyết định đã chốt

| Hạng mục | Quyết định |
| --- | --- |
| Kiến trúc | Một Web, một Control Server ở MVP, nhiều Runner |
| Vị trí chạy | Cùng máy hoặc khác máy; protocol không phụ thuộc topology |
| Frontend | Vue 3 + TypeScript + Vite + Tailwind CSS + shadcn-vue |
| Editor / diff | CodeMirror 6 + `@codemirror/merge` |
| Backend | Bun + Hono |
| Runner | Bun, service riêng, dùng Claude Agent SDK TypeScript |
| Claude executable | Binary đi kèm SDK; không bắt buộc CLI global |
| Config | Kế thừa config có sẵn trên từng Runner |
| Overrides | Tường minh, theo session/profile, không sửa file gốc mặc định |
| Kết nối | Runner chủ động mở outbound WSS đến Control Server |
| Độ bền | Server outbox, Runner inbox, Runner event outbox, Server event journal |
| Session routing | Pin session vào Runner + workspace; resume bằng SDK session ID cụ thể |
| Failover | Không tự chuyển coding run chưa rõ trạng thái sang Runner khác |
| Broker / workflow engine | Không bắt buộc NATS, Redis hoặc Temporal ở MVP |

### 1.2. Tuyên bố về bảo đảm

Hệ thống hướng đến durable, at-least-once delivery và idempotent processing ở tầng ứng dụng. **Không hứa exactly-once cho shell command, ghi file, push Git hoặc request đến dịch vụ ngoài.**

Không suy diễn rằng heartbeat timeout chứng minh tiến trình đã chết. Không suy diễn rằng resume hội thoại phục hồi workspace. Không coi ACK command là kết quả thực thi.

### 1.3. Tính năng MVP

- Đăng nhập owner; đăng ký, thu hồi và theo dõi nhiều Runner.
- Đăng ký workspace trên Runner; chọn workspace để tạo session.
- Chat nhiều lượt, streaming, tool timeline và usage khi SDK cung cấp.
- Tool permissions và user questions từ SDK.
- Reconnect, event replay, cancel và phục hồi sau restart.
- Kế thừa config, diagnostics và overrides không phá config gốc.
- File tree, code viewer/editor, unified/split diff với revision checks.
- Audit, backup/restore và smoke tests trên hai Runner.

## 2. Phạm vi và nguyên tắc an toàn

### 2.1. Trust model MVP

Một owner hoặc nhóm vận hành cùng trust domain quản lý Control Server và các Runner. Không mở đăng ký public. Runner được xem là có quyền thực thi code với OS permissions của nó.

Repo, model output, tool output và preview application vẫn có thể không đáng tin. Runner bị compromise có thể gửi events giả hoặc lộ dữ liệu của chính môi trường đó; protocol chỉ xác định nguồn credential, không chứng minh tool thực sự đã làm gì.

### 2.2. Ngoài phạm vi MVP

- Public SaaS multi-tenant với người dùng không tin cậy lẫn nhau.
- Computer use điều khiển màn hình/chuột/bàn phím toàn desktop.
- Nền tảng cloud IDE đầy đủ, terminal toàn quyền và debug adapter.
- Transparent session migration hoặc automatic failover giữa máy.
- Shared checkout có nhiều Runner cùng ghi.
- Tự động push/deploy/merge/reset repository.
- Plugin compatibility 1:1 với mọi tính năng CLI/Claude Desktop.

### 2.3. Các invariant bắt buộc

1. Một session có tối đa một active run.
2. Một workspace có tối đa một writer do hệ thống quản lý.
3. Session thuộc đúng Runner và workspace đã đăng ký.
4. Start command chỉ thực thi khi authority/assignment còn hợp lệ.
5. Command gửi lại cùng ID không khởi chạy lại một run đã xử lý.
6. Event được ACK chỉ sau khi Server commit bền vững.
7. Cancel chỉ hoàn tất khi Runner xác nhận hoặc trạng thái thực thi đã được xác minh.
8. Không nhận approval stale cho tool input mới.
9. Lost connection không tạo quyền failover cho workspace.
10. Không xóa config/transcript/workspace chỉ vì xóa lịch sử trên Web.

## 3. Kiến trúc tổng thể

```text
Browser / điện thoại
Vue + shadcn-vue + CodeMirror
        │ HTTPS commands / WSS events
        ▼
Control Server — Bun + Hono
├── Web authentication / authorization
├── Runner registry / connector tokens
├── Workspace / session / run services
├── Scheduler / assignment authority
├── Command outbox / dispatcher
├── Event ingestion / journal / projections
├── Approval service / audit
└── Control database
        ▲
        │ Runner-initiated outbound WSS
        │
    ┌───┴──────────────────────┐
    │                          │
Runner A                    Runner B ... N
├── Connection agent        ├── Connection agent
├── SQLite inbox/outbox     ├── SQLite inbox/outbox
├── Local scheduler         ├── Local scheduler
├── Workspace locks         ├── Workspace locks
├── Process supervisor      ├── Process supervisor
└── Run worker processes    └── Run worker processes
    └── Claude Agent SDK        └── Claude Agent SDK
        └── Bundled CLI             └── Bundled CLI
            ├── Config A                ├── Config B
            ├── Transcripts             ├── Transcripts
            └── Workspace A             └── Workspace B
```

SDK khởi chạy Claude Code subprocess và làm việc với local filesystem/state. Hosting không tương đương một stateless API wrapper. Vì vậy SDK và artifacts thuộc Runner, không đặt vào lifecycle HTTP/WebSocket handler. [^https://code.claude.com/docs/en/agent-sdk/hosting]

### 3.1. Control Server sở hữu gì?

- Web users, role và resource authorization.
- Danh tính Runner và trạng thái kết nối quan sát được.
- Desired state, assignment, command history, UI history.
- Profiles, approval decisions, audit logs và metadata.
- Scheduling theo capacity nhưng không trực tiếp tạo SDK process.

### 3.2. Runner sở hữu gì?

- Workspace registration và canonical paths.
- Local execution truth: command receipts, process/run state, locks.
- Config discovery, provider authentication và SDK invocation.
- File/Git operations trong scope được operator cho phép.
- Transcripts, working files, snapshots và unsent events.

Control Server không trực tiếp đọc filesystem của Runner. Mọi file/config inspection phải đi qua Runner RPC đã authorization và redaction.

### 3.3. Run worker process

Runner daemon điều phối; mỗi active run có thể chạy trong một Bun worker **process** riêng, không phải browser Web Worker. Worker process sở hữu SDK query và chuyển message về daemon qua IPC protocol nội bộ.

Lợi ích: lỗi một SDK invocation không trực tiếp phá connection loop; process ownership/cancellation rõ hơn. Đây không phải sandbox: cùng OS user vẫn có thể đọc nhiều tài nguyên chung.

Một implementation đầu có thể dùng adapter trong daemon cho compatibility spike, nhưng bản nghiệm thu phải bảo đảm supervisor và connection không phụ thuộc vòng lặp streaming của một run.

## 4. Stack và cấu trúc repository

### 4.1. Stack

| Layer | Công nghệ |
| --- | --- |
| Web | Vue 3, TypeScript, Vue Router, Pinia |
| UI/build | shadcn-vue, Tailwind CSS, Vite |
| Code/diff | CodeMirror 6, `@codemirror/merge`, language packages lazy-loaded |
| API/gateway | Bun, Hono, native WebSocket |
| Runner runtime | Bun, Claude Agent SDK, Git |
| Validation | Zod; schemas chia sẻ cho protocol/DTO |
| Control DB | SQLite + Drizzle cho single-instance MVP; PostgreSQL khi mở rộng |
| Runner DB | SQLite local + Drizzle hoặc SQL có migrations |
| TLS/proxy | Caddy |
| Service manager | Linux/systemd trước; Docker có thể dùng khi phù hợp |

Pin toolchain, SDK và lockfile. Không điền một version number chưa kiểm chứng; Phase 0 chọn phiên bản cụ thể rồi commit compatibility matrix.

### 4.2. Repository

```text
apps/
  web/src/
    components/ui/
    components/editor/
    features/{auth,runners,workspaces,sessions,chat,approvals,changes,settings}/
    composables/
    stores/
    router/
  control-server/src/
    auth/
    http/routes/
    websocket/{browser,runner}/
    runners/
    scheduling/
    commands/
    events/
    approvals/
    projections/
    persistence/
    observability/
  runner/src/
    bootstrap/
    identity/
    connection/
    inbox/
    outbox/
    supervisor/
    workers/
    workspaces/
    filesystem/
    git/
    diagnostics/
packages/
  protocol/                 # wire envelopes, command/event schemas
  agent-adapter/            # SDK-specific implementation, Runner only
  control-db/
  runner-db/
  shared/                   # pure helpers, no secrets or SDK import into web
infra/
  caddy/
  systemd/
  docker/
scripts/
  doctor.ts
  backup-control.sh
  backup-runner.sh
  restore-check.sh
ARCHITECTURE.md
```

## 5. Domain model và quyền sở hữu

### 5.1. Các thực thể

| Entity | Ý nghĩa |
| --- | --- |
| Runner | Một installation identity ổn định của daemon |
| Runner connection | Một kết nối WSS; có generation riêng |
| Boot | Một lifetime của daemon, có `bootId` mới khi restart |
| Workspace | Project directory được Runner đăng ký và cho phép thao tác |
| App session | Hội thoại do Control Server quản lý |
| SDK session | Native conversation/transcript, định danh bằng SDK session ID |
| Run | Một lần xử lý user prompt; có thể gồm nhiều model turns/tool calls |
| Execution attempt | Một lần launch có chủ đích, định danh riêng để không nhầm retry |
| Command | Một yêu cầu vận chuyển đến Runner |
| Event | Một quan sát được journal và chuyển lên Server |
| Approval | Một yêu cầu quyền/câu hỏi gắn với callback cụ thể |

### 5.2. Mapping

```text
Owner / Organization scope
  └── Runner
       └── Workspace
            └── App Session
                 ├── sdkSessionId
                 └── Runs
                      └── Execution attempt
```

Workspace ID không phải absolute path. Browser gửi ID; Runner tự resolve path đã đăng ký. Hai Runner cùng trỏ một shared directory không được đăng ký như hai workspace độc lập để lách writer lock.

### 5.3. Desired state và observed state

Server lưu cả:

- `desiredState`: muốn chạy, muốn cancel, muốn revoke assignment.
- `observedExecutionState`: Runner báo đang chạy, hoàn tất hoặc interrupted.
- `observationFreshness`: thời điểm/sequence/connection của quan sát.

UI có thể hiển thị “Running — Runner mất kết nối, quan sát cuối 2 phút trước”. Không đổi `running` thành `failed` chỉ vì socket đóng.

## 6. Runner connector và authentication

### 6.1. Connector model

Runner là connector kiểu cloudflared: một file thực thi, dials ra Server, không cần inbound port.

1. Owner mint token trên web (`POST /api/runners`): `runnerId` là UUID, token hiển thị đúng một lần; database chỉ giữ SHA-256 của token.
2. Operator chạy `cc-web-runner setup --server <origin> --runner-id <id>` trên máy Runner; token đọc từ `CC_WEB_RUNNER_TOKEN`, TTY prompt hoặc stdin — không bao giờ qua argv (shell history/`ps`).
3. `setup` ghi `identity.json` (mode 0600, atomic qua temp + rename) vào `CC_WEB_RUNNER_HOME` (mặc định `~/.cc-web-runner`): `runnerId`, `controlUrl`, credential.
4. `cc-web-runner connect` mở outbound WSS bằng credential trong identity; `cc-web-runner service install` cài systemd unit — unit không chứa secret, chỉ trỏ `ExecStart` về binary với subcommand `connect` và `CC_WEB_RUNNER_HOME`.
5. Credential trong identity là credential dài hạn; mint token chỉ là cơ chế cấp credential đầu tiên. Không reconnect bằng credential đã revoke.
6. Rotate = mint token mới cho runner đang có và chạy lại `setup` (ghi đè identity, revoke credential cũ trong cùng transaction).

### 6.2. Handshake

```ts
type RunnerHello = {
  protocolVersion: 1;
  runnerId: string;
  bootId: string;
  runnerVersion: string;
  sdkVersion: string;
  platform: string;
  maxConcurrentRuns: number;
  activeRuns: RunInventoryItem[];
  eventOffsets: RunEventOffset[];
};
```

Authentication credential truyền qua cơ chế header được hỗ trợ, không trong URL. Payload hello không chứa provider keys, raw environment hoặc toàn bộ config.

Server trả negotiated protocol version, connection generation và policy bounds. Runner chỉ chuyển sang `ready` sau reconciliation; connected chưa có nghĩa có thể dispatch ngay.

### 6.3. Identity lifecycle

- Mỗi installation có credential riêng; không copy runner identity/data directory sang nhiều máy để tạo clone.
- Duplicate connections: chỉ một generation là current trên Server.
- Generation check chặn traffic từ socket cũ; không tự kill được process đã chạy ở một clone khác.
- Revoke đóng kết nối và ngừng cấp việc. Không hứa revoke sẽ dừng một Runner đang offline.
- Rotation có overlap có kiểm soát; log các lần đăng ký, rotate, revoke và duplicate identity.
- mTLS là tùy chọn hardening sau; TLS + scoped credentials đủ cho trusted-owner MVP nếu triển khai đúng.

### 6.4. Capabilities và capacity

Runner quảng bá khả năng thực tế: platform, SDK version, Git/file support, capacity. Server không giao feature vượt capability. Runner vẫn phải kiểm tra local limits khi nhận command; server-side capacity có thể đã cũ.

## 7. Kế thừa cấu hình Claude Code

### 7.1. Quyết định cốt lõi

Mỗi Runner dùng bundled Claude Code của SDK và kế thừa config trong môi trường của chính Runner đó. Không cần cài CLI global và không buộc đồng bộ config giữa các Runner.

```ts
{
  cwd: registeredWorkspace.absolutePath,
  settingSources: ["user", "project", "local"],
  systemPrompt: { type: "preset", preset: "claude_code" }
}
```

`pathToClaudeCodeExecutable` không đặt mặc định; SDK tự resolve packaged binary. Binary và configuration là hai vấn đề độc lập. [^https://platform.claude.com/docs/en/agent-sdk/typescript]

### 7.2. Config sources

| Source | Settings chính |
| --- | --- |
| `user` | `~/.claude/settings.json` |
| `project` | `<cwd>/.claude/settings.json` |
| `local` | `<cwd>/.claude/settings.local.json` |

Các sources còn ảnh hưởng instructions/rules/skills/hooks theo cơ chế SDK. Project settings/hooks nằm trực tiếp dưới `.claude` của `cwd`, trong khi instructions và một số resources có quy tắc tìm lên thư mục cha. Chọn root đúng; không giả định mọi resource dùng cùng discovery algorithm. [^https://platform.claude.com/docs/en/agent-sdk/claude-code-features]

### 7.3. Môi trường service

- Runner chạy đúng OS user có config cần dùng.
- `HOME`, `PATH`, `CLAUDE_CONFIG_DIR` nếu có được thiết lập tường minh khi cần.
- Service manager không mặc định nạp shell rc files của terminal.
- Hook/MCP binaries và dependencies phải tồn tại trong môi trường service.
- Local transcripts/memory cần persistent/writable storage phù hợp.
- Hai Runner cùng OS user/config directory dùng chung user config; không quảng bá chúng là config-isolated.

### 7.4. Không có cam kết “kế thừa mọi thứ 1:1”

Managed policy, global config, auto memory và một số MCP sources có hành vi riêng ngoài `settingSources`. Không coi `settingSources: []` là isolation hoàn toàn. MCP discovery, enablement, approval và auth cần compatibility test. Không tự đặt `mcpServers: {}` hoặc strict config để giả lập trạng thái kế thừa. [^https://platform.claude.com/docs/en/agent-sdk/claude-code-features]

### 7.5. System prompt và auth

Dùng `claude_code` preset để có base prompt coding-agent thay vì minimal SDK prompt; `CLAUDE.md` loading do sources quyết định riêng. [^https://platform.claude.com/docs/en/agent-sdk/modifying-system-prompts]

Config inheritance không chứng minh provider auth hợp lệ và không cam kết tái sử dụng subscription Pro/Max. Khi phân phối sản phẩm phải dùng phương thức auth được phép; tài liệu Anthropic hiện giới hạn việc bên thứ ba cung cấp claude.ai login/rate limits nếu chưa được phê duyệt. [^https://code.claude.com/docs/en/agent-sdk/quickstart]

## 8. Overrides và configuration diagnostics

### 8.1. Chính sách override

```text
Explicit session override
        ↓ nếu không có
Explicit selected profile override
        ↓ nếu không có
Runner's inherited Claude configuration

Managed policy vẫn có ưu tiên theo SDK.
```

Không có global web defaults vô tình che cấu hình host. Không truyền model/permission/tool list rỗng chỉ vì frontend chưa chọn giá trị.

```ts
type Override<T> =
  | { mode: "inherit" }
  | { mode: "set"; value: T };

type RunOverrides = {
  model: Override<string>;
  maxTurns: Override<number>;
  maxBudgetUsd: Override<number>;
  instructionAppend: Override<string>;
};
```

“Inherit” nghĩa là omit corresponding SDK option. `null`, `0` và empty string không làm sentinel. Instructions bổ sung dùng preset `append`, không thay toàn bộ prompt mặc định.

### 8.2. Scope và thời điểm

- Server validate schema; Runner validate lại theo SDK/capabilities.
- Snapshot overrides trước run; thay đổi trong lúc chạy áp dụng run tiếp theo.
- Profiles có thể scope theo Runner/workspace; không assume model/provider capability giống nhau trên mọi Runner.
- Không merge arbitrary settings JSON từ browser ở MVP.
- `settings` có thể được SDK dùng cho inline/file overrides, nhưng mapping phải theo trường được hỗ trợ và managed policy; không mô phỏng precedence bằng object spread tùy tiện. [^https://platform.claude.com/docs/en/agent-sdk/typescript]
- Runtime fingerprint chỉ lưu phần đã redacted. Không lưu secrets để cố tái tạo config.

### 8.3. Diagnostics RPC

Web yêu cầu diagnostic → Server authorize → Runner resolve local sources → Runner redacts → Server/UI nhận kết quả.

Hiển thị SDK/Runner version, sources, config existence/readability, workspace root, missing helper binaries, provider auth status và warnings. `resolveSettings()` nếu SDK version hỗ trợ có thể giải thích effective settings/provenance; không dùng nó làm bằng chứng đầy đủ về runtime auth/policy. [^https://platform.claude.com/docs/en/agent-sdk/typescript]

Không truyền toàn bộ env/raw config lên Server. Static doctor không gọi model; live smoke test là action riêng có chi phí và consent rõ ràng.

### 8.4. Sửa file config gốc

Phase sau. Cần xem diff, backup, expected hash, atomic write, audit và xác nhận scope. Thay đổi ở một Runner không tự thay config các Runner khác. Không mở editor credential files tùy ý trên Web.

## 9. Durable command delivery

### 9.1. Envelope

```ts
type RunnerCommand = {
  protocolVersion: 1;
  commandId: string;
  runnerId: string;
  workspaceId?: string;
  sessionId?: string;
  runId?: string;
  attemptId?: string;
  assignmentEpoch?: number;
  kind: string;
  issuedAt: string;
  expiresAt?: string;
  payload: unknown;
};
```

Payload là discriminated union đã validate; examples không phải SDK API. Request fingerprint dùng canonical serialization có định nghĩa version, không hash JSON với ordering không ổn định.

### 9.2. Server outbox

Trong một transaction:

1. Kiểm tra owner, session lock và target Runner/workspace.
2. Tạo run/attempt ở trạng thái queued.
3. Tạo start command/outbox record.
4. Ghi audit/domain event cần thiết.

Dispatcher gửi committed outbox records. Socket send success không phải durable receipt. Retry transport dùng cùng `commandId`.

Outbox giải quyết dual-write giữa database và message delivery; consumer vẫn cần idempotency vì message có thể được gửi lại. [^https://docs.aws.amazon.com/prescriptive-guidance/latest/cloud-design-patterns/transactional-outbox.html]

### 9.3. Runner inbox

Khi nhận command:

1. Xác thực target/current connection authority và schema.
2. Check expiry, assignment, workspace, local policy và capacity phù hợp loại command.
3. Transaction insert inbox + request fingerprint + receipt.
4. Commit rồi mới ACK `accepted`.
5. Local dispatcher thực thi command theo semantics.

Nếu command đã tồn tại: trả receipt/state cũ; không gọi SDK lần hai. Cùng ID khác payload phải bị reject và audit.

### 9.4. Ba loại acknowledgement

| ACK / event | Ý nghĩa |
| --- | --- |
| `command.accepted` | Đã persist inbox; chưa chứng minh thực thi |
| `run.started` / operation started | Bắt đầu invocation/process được quan sát |
| `run.finished` / command result | Có observed outcome |

Start command sau durable acceptance không còn cần gửi vô hạn từ Server. Reconciliation và run state theo dõi completion, không coi timeout delivery là permission tạo execution attempt mới.

### 9.5. Start authorization

Runner chỉ bắt đầu **run mới** khi đã reconcile và có authority hiện hành. Command accepted nhưng chờ capacity không được tự khởi chạy sau nhiều giờ offline chỉ vì còn trong inbox.

Trước launch phải xác nhận còn assignment hợp lệ qua online handshake/authorization được Server persist. Start authorization có identity và thời hạn; Runner kiểm tra bằng local monotonic deadline tương ứng, không chỉ so đồng hồ tường tùy ý.

Mất kết nối ngay sau authorization không tạo giao dịch nguyên tử với OS spawn. Vì vậy Server không reassignment chỉ vì hết TTL; đây là cơ chế giảm stale launch, không phải exactly-once proof.

### 9.6. Command classes và ordering

- `run.start`: queued scheduling, một active execution trên session/workspace.
- `run.cancel`: control lane ưu tiên, không nằm sau start handler đang chờ run kết thúc.
- `approval.respond`: kiểm tra callback identity và lifecycle.
- `workspace.file.write/revert`: workspace mutation lane có lock/revision check.
- `workspace.inspect/config.inspect`: bounded RPC, không vào queue coding dài.

Cancel đến trước start phải được persist như desired-state/tombstone và làm start cùng attempt không chạy. Không bỏ cancel chỉ vì chưa thấy process.

### 9.7. Ambiguous launch window

Database transaction không nguyên tử với OS process spawn hoặc side effect bên ngoài. Nếu Runner chết trong cửa sổ launch:

- Dùng process supervisor metadata/OS ownership kiểm tra process còn sống.
- Không dựa vào PID đơn lẻ vì PID tái sử dụng.
- Nếu không xác minh được, đánh dấu attempt `interrupted/unknown`.
- Không auto-respawn cùng attempt hoặc tự tạo attempt khác.
- User xem workspace/state và chủ động resume/retry bằng operation mới có audit.

Inbox deduplication chống transport duplicates, không biến mọi side effect thành exactly-once.

## 10. Runner execution và process supervision

### 10.1. Lifecycle của một run

```text
persist command → validate authorization → acquire local workspace lock
 → snapshot metadata/baseline → launch worker → SDK query
 → persist events → persist terminal outcome → release lock
```

Process supervisor giữ mapping `attemptId → process ownership`, callbacks và cancellation channels. SDK/worker exit bất thường không được làm daemon mất toàn bộ registry.

### 10.2. Adapter pseudocode

```ts
import { query } from "@anthropic-ai/claude-agent-sdk";

async function execute(ctx: ExecutionContext) {
  const overrides = compileAllowedOverrides(ctx.overrides);
  const append = overrides.instructionAppend;

  const stream = query({
    prompt: ctx.prompt,
    options: {
      cwd: ctx.workspacePath,
      settingSources: ["user", "project", "local"],
      systemPrompt: {
        type: "preset",
        preset: "claude_code",
        ...(append ? { append } : {}),
      },
      includePartialMessages: true,
      ...(ctx.sdkSessionId ? { resume: ctx.sdkSessionId } : {}),
      ...(overrides.model !== undefined ? { model: overrides.model } : {}),
      ...(overrides.maxTurns !== undefined
        ? { maxTurns: overrides.maxTurns } : {}),
      ...(overrides.maxBudgetUsd !== undefined
        ? { maxBudgetUsd: overrides.maxBudgetUsd } : {}),
      canUseTool: ctx.handleToolPermission,
    },
  });

  try {
    for await (const sdkMessage of stream) {
      await ctx.persistAndForwardSdkMessage(sdkMessage);
    }
  } catch (error) {
    await ctx.recordTerminalErrorOnce(error);
  } finally {
    await ctx.cleanup();
  }
}
```

Các `ExecutionContext` helpers là code ứng dụng cần xây. Cancellation, hooks, worker IPC và runtime options phải type-check theo SDK đã pin. Error result có thể được yield trước iterator throw; terminal transition phải idempotent. [^https://code.claude.com/docs/en/agent-sdk/sessions]

### 10.3. Environment và credentials

Environment provider/config của Runner được kế thừa có chủ đích. Nếu truyền SDK `env`, đó là replacement, không tự merge; giữ những giá trị cần thiết như PATH/HOME và provider variables. [^https://platform.claude.com/docs/en/agent-sdk/typescript]

Không truyền Control Server secrets vào Runner. Không truyền Runner connector credential vào run worker environment nếu worker không cần. Cùng OS user vẫn không có secret isolation hoàn toàn; env filtering chỉ giảm exposure.

### 10.4. Session resume

Capture SDK session ID từ init/result và lưu local + Server. Mỗi run tiếp theo dùng ID cụ thể, không `continue: true` chọn hội thoại mới nhất. Transcript missing phải báo rõ, không silent fallback sang session mới. [^https://code.claude.com/docs/en/agent-sdk/sessions]

## 11. State machines, scheduling và concurrency

### 11.1. Runner

```text
registered → connecting → reconciling → ready
                                    ↔ draining
ready → suspect → offline
any authenticated state → revoked
```

Connection health và capacity là hai khái niệm riêng. Connected Runner có capacity 0 không nhận run mới.

### 11.2. Run

```text
queued → accepted → starting → running ↔ waiting_for_approval
                                  │
                                  ├── succeeded
                                  ├── failed
                                  └── cancelling → cancelled

Execution không xác minh được sau crash → interrupted / unknown observation
```

`cancel_requested` là desired-state flag, có thể tồn tại khi observed run vẫn running/offline. Late event sau disconnect có thể làm rõ outcome; không overwrite kết quả thực bằng suy đoán timeout.

### 11.3. Scheduling MVP

User chọn workspace đã gắn Runner; Server kiểm tra Runner ready/capacity rồi enqueue. Không cần scheduler thông minh hoặc worker pool tùy ý.

Runner có local queue và tự kiểm tra limits. Mặc định `maxConcurrentRuns = 1` mỗi Runner; tăng sau khi đo RAM/CPU/workload.

### 11.4. Locks và assignment epochs

- Server có unique active execution/assignment constraints.
- Runner có atomic local lock cho canonical workspace.
- Epoch tăng khi ownership được chuyển có chủ đích.
- Server/Runner RPC reject stale epoch.
- Local lock áp dụng cả editor save và Git mutation do ứng dụng thực hiện.

Epoch không bảo vệ mọi Bash file write. Fencing chỉ an toàn khi tài nguyên đích kiểm tra token; ordinary filesystem không biết epoch của Server. [^https://martin.kleppmann.com/2016/02/08/how-to-do-distributed-locking.html]

Vì vậy không share writable checkout giữa Runner, không automatic takeover khi chỉ mất heartbeat. Nếu sau này cần takeover phải cách ly/stop môi trường cũ hoặc dùng resource layer thực sự enforce fencing.

External editor/CLI ngoài hệ thống không chịu locks. Luôn cần hash checks và conflict handling.

## 12. Event journal, streaming và replay

### 12.1. Runner event

```ts
type RunnerEvent = {
  protocolVersion: 1;
  eventId: string;
  runnerId: string;
  bootId: string;
  sessionId: string;
  runId: string;
  attemptId: string;
  localSequence: number; // tăng trong attempt; không reset khi reconnect
  occurredAt: string;
  type: string;
  payload: unknown;
};
```

Server gán thêm `sessionSequence` để Web replay. Không trộn sequence scope hoặc dùng timestamp làm thứ tự duy nhất. Event ID và `(attemptId, localSequence)` có unique constraints; conflicting duplicate phải được audit.

### 12.2. Persist → send → ACK

```text
SDK message
 → Runner local journal transaction
 → Send batch
 → Server validate + deduplicate + journal transaction
 → Update projections / allocate session sequence
 → Commit
 → ACK highest contiguous localSequence
 → Runner mark acknowledged / compact theo retention
```

ACK không được vượt qua gap. Nếu nhận seq 1,2,4 thì chỉ ACK contiguous 2 và yêu cầu 3; buffer bounded hoặc reject out-of-order theo protocol. Không delete event chưa được ACK.

Server mất ACK sau commit: Runner resend, Server deduplicate. Server broadcast fail sau commit: Web replay từ journal. At-least-once + deduplication là guarantee ở đây, không phải global exactly-once.

### 12.3. Message normalization

SDK partial stream cung cấp deltas và cũng có complete messages. Adapter correlate message/block IDs, accumulate text/tool JSON rồi finalize; không append final text lần nữa. Tool input chỉ parse khi hoàn chỉnh; tool status dựa evidence từ SDK/hooks, không suy từ một câu model nói đang chạy. [^https://code.claude.com/docs/en/agent-sdk/streaming-output]

Giữ semantic message IDs và structured blocks, không chỉ một string transcript. Không công khai private/internal reasoning nếu có trong raw provider/SDK payload; chỉ expose content được API thiết kế để hiển thị và đã qua redaction policy.

### 12.4. Event families của ứng dụng

```text
command.accepted / command.rejected
run.started / run.status / run.finished / run.failed / run.interrupted
message.started / message.delta / message.completed
tool.started / tool.completed
approval.requested / approval.resolved / approval.expired
question.requested / question.answered
workspace.changed / usage.updated / session.updated
```

Tên trên là app protocol, không phải SDK event names. Version schema và adapter độc lập với raw SDK types.

`run.interrupted` là outcome terminal cho attempt dừng mà không quan sát được kết quả SDK thật — abort do cancel/shutdown (§14.2, §20.4) hoặc ambiguous launch window (§9.7). Nó không phải failure: server phân biệt `interrupted`/`cancelled` theo cancel audit, không theo event này.

### 12.5. Web replay

Client subscribe session với `afterSessionSequence`. Server kiểm tra ownership, lấy high-watermark, replay và buffer live tail để tránh race. Client deduplicate, phát hiện gap rồi fetch lại. Retention đã xóa range thì trả `resync_required` kèm snapshot checkpoint.

Không tự resubmit prompt sau reconnect. Multiple browser tabs chỉ là nhiều observers, không phải nhiều run owners.

### 12.6. Backpressure và spool limits

- Batch nhỏ theo byte/time thresholds được đo sau.
- Bun send return/drain dùng để kiểm soát slow connections.
- Bounded payloads, bounded in-memory queues, local disk quotas.
- Slow browser có thể bị ngắt và replay; không giữ unlimited buffer.
- Runner offline spool tăng đến warning threshold rồi critical threshold.
- Critical policy phải tường minh: yêu cầu dừng run và ghi minimal failure record bằng reserved budget; không âm thầm drop mandatory events rồi báo success.

Bun pub/sub/backpressure là transport features, không thay durable journal và không tự chia sẻ giữa nhiều processes. [^https://bun.com/docs/runtime/http/websockets]

## 13. Approvals và user questions

SDK có `canUseTool` để xử lý tool permissions và `AskUserQuestion`; callback có thể chờ user. Tool đã được auto-approve ở bước trước có thể không đi qua callback. Logic bắt buộc trên mọi tool cần hook phù hợp; permissions không thay OS sandbox. [^https://code.claude.com/docs/en/agent-sdk/user-input]

### 13.1. Lifecycle

1. Worker nhận callback và gửi request về Runner daemon.
2. Runner persist pending approval cùng callback generation/tool input hash.
3. Event chuyển lên Server, Web hiển thị.
4. User quyết định qua HTTP; Server authorize và lưu decision + outbox command atomically.
5. Runner kiểm tra exact approval ID, run/attempt, tool call, request hash, expiry và callback còn sống.
6. Runner resolve đúng callback một lần, emit outcome.

Payload gồm `approvalId`, `runId`, `attemptId`, `toolCallId`, `inputHash`, `callbackGeneration`, `expiresAt` và kind `tool_permission | user_question`.

### 13.2. Giới hạn

- MVP: approve once/reject và trả lời question.
- Always allow có thể ghi permission rules ra config; không bật mặc định.
- Kế thừa permissive config có thể làm tool tự chạy; UI phải nói rõ, không hứa mọi lệnh đều hiện popup.
- Timeout/cancel không ngầm approve.
- Worker crash làm callback mất: approval cũ abandoned; không apply decision cũ cho callback mới sau resume.
- Server đã lưu decision nhưng chưa đến Runner: UI “đang chuyển quyết định”, không “tool đã chạy”.

## 14. Cancel, disconnect, restart và reconciliation

### 14.1. Chính sách disconnect mặc định

Run đã bắt đầu tiếp tục trên Runner, lưu event local. Không start run mới khi offline. Pending approval chờ có timeout, không tự duyệt. Server không reassignment hoặc retry coding task chưa rõ trạng thái.

Heartbeat là failure suspicion, không proof of death. Có thể bắt đầu thử với heartbeat khoảng 10 giây và suspect sau nhiều nhịp mất; đây là cấu hình đề xuất cần đo, không phải SLO hay thời gian kết luận task chết.

### 14.2. Cancel

```text
Web request → Server desired cancel + durable command
 → Runner persists cancel → SDK cancellation / process cleanup
 → Runner observes actual terminal outcome → Server/Web
```

- Cancel lane ưu tiên, không chờ run start handler kết thúc.
- Runner offline: UI “đã yêu cầu dừng, chưa xác nhận”.
- Kết thúc thực tế có thể đã success trước khi cancel đến; lưu outcome thực, audit cancel too late.
- Graceful SDK cancellation trước; escalation chỉ nhắm process tree/cgroup thuộc attempt.
- Không `killall claude`; không dùng PID cũ đơn lẻ.
- Cancel không rollback code hoặc external side effects.

### 14.3. Reconciliation protocol

Sau reconnect, Runner chưa ready ngay:

1. Authenticate và establish current connection generation.
2. Trao đổi active/terminal run inventory, local command receipts, approvals và event offsets.
3. Resend events chưa được Server commit.
4. Server resend pending idempotent commands/cancel decisions còn hợp lệ.
5. Resolve conflicts theo assignment/attempt identity và local process evidence.
6. Mark ready rồi mới dispatch việc mới.

Nếu inventory lớn phải pagination/chunking, không nhét toàn bộ history vào hello.

### 14.4. Conflict matrix

| Server biết | Runner báo | Xử lý |
| --- | --- | --- |
| Queued | Accepted cùng command | Cập nhật receipt, không gửi execution mới |
| Running | Completed cùng attempt | Replay terminal events, cập nhật outcome |
| Running | Process còn sống | Tiếp tục observe/replay |
| Running | Không process, không terminal | Interrupted; không auto-retry |
| Không có assignment | Có process cũ | Quarantine điều tra; không attach sang session khác |
| Cancel requested | Running | Chuyển cancel lại bằng ID cũ |
| Approval pending | Callback mất | Abandon approval, báo run interruption nếu phù hợp |
| Assignment cũ | Event late có dữ liệu | Giữ evidence/audit; không cho chiếm quyền current assignment |

### 14.5. Các failure modes chính

| Sự cố | Cơ chế phục hồi |
| --- | --- |
| Web đóng tab | Run không đổi, replay khi quay lại |
| Server crash sau tạo run | Outbox tiếp tục dispatch |
| Runner nhận command nhưng ACK mất | Resend cùng ID, inbox trả receipt cũ |
| Server commit event nhưng ACK mất | Resend event, unique constraints deduplicate |
| Runner daemon/worker crash | Supervisor reconcile, ambiguous attempt không auto-launch |
| Server offline | Runner tiếp tục accepted active work và spool events |
| Runner disk full | Không accept start mới; critical spool policy và alert |
| Provider auth lỗi | Failed có mã lỗi/redaction; không silent đổi provider |
| Transcript bị xóa | Resume unavailable; user chọn session mới có chủ đích |
| Identity clone | Reject duplicate generation và operator intervention |

## 15. Workspace, file API và Git

### 15.1. Registration và trust

Operator cấu hình allowed roots trên Runner. Web có thể yêu cầu đăng ký path trong roots; Runner canonicalize và xác nhận. Không gửi arbitrary `cwd` vào start command.

Repo có thể chứa hooks/MCP/instructions thực thi code. Registration cần trust acknowledgement rõ ràng; không tự mở bất kỳ repo do người chưa xác thực gửi lên.

### 15.2. File RPC

Browser → Control Server authorization → targeted Runner RPC → bounded result. Runner luôn kiểm tra local workspace registration/policy; không tin path chỉ vì Server gửi.

- Relative paths, realpath/containment checks, symlink handling và TOCTOU mitigation.
- Chặn device/socket, path ngoài scope, file quá lớn hoặc binary không hỗ trợ.
- Không expose app data, auth keys hay credential files qua file browser.
- Save với expected content hash; conflict → HTTP 409/domain error, không overwrite.
- Atomic write phù hợp với permissions và loại file; không xuyên symlink bất ngờ.
- Dùng argv arrays khi chạy Git/helpers; không interpolate user input vào shell.
- Workspace offline thì báo unavailable/stale cache rõ ràng, không trả nội dung cũ như live data.

`cwd` và API containment không phải sandbox cho Bash; shell vẫn có quyền của OS user. [^https://code.claude.com/docs/en/agent-sdk/secure-deployment]

### 15.3. Existing workspace mặc định

MVP dùng thư mục hiện có để giữ dependencies/local config/path references. Một Runner sở hữu directory; không share writable checkout giữa Runner.

Worktree mode ở phase sau phải xử lý ignored files, `settings.local.json`, dependencies, hook/MCP relative paths và secrets. Không copy toàn bộ config/credentials mặc định.

### 15.4. Snapshot và attribution

Phân biệt ba baseline:

1. HEAD → working tree: bao gồm thay đổi trước agent.
2. Run-start snapshot → current: thay đổi trong khoảng run, có thể gồm external edits.
3. Editor-open hash → save: optimistic concurrency.

Git diff không tự chứng minh “mọi thay đổi do agent”. Untracked/deleted/renamed/binary files và non-Git project có handling riêng. File snapshots có size/retention limits, chứa dữ liệu nhạy cảm như source code.

### 15.5. Revert và commit

- Không dùng `git reset --hard` / `git clean` làm nút revert mặc định.
- Revert chỉ khi baseline và current revision khớp; external change thì review conflict.
- User pre-existing edits không bị xóa.
- Commit là action độc lập có explicit confirmation và scope file rõ.
- Không auto-push hoặc auto-deploy từ việc bấm Reviewed.

## 16. Frontend Vue và CodeMirror

### 16.1. UX

```text
Sidebar                  Main                       Secondary panel
Runners / Workspaces     Conversation               Files / Changes
Sessions                 Tool timeline              Code / Diff
Connection health        Approval cards             Run configuration
                         Prompt composer
```

User không cần hiểu topology để dùng: chọn workspace, UI tự hiển thị Runner và trạng thái. Khi cần chẩn đoán mới mở runner details.

Mobile dùng tabs Chat / Changes / Workspaces, unified diff mặc định. Không ép desktop IDE layout lên điện thoại.

### 16.2. State

- Pinia: active resources, run projections, message state, approvals, connection freshness.
- Composable socket singleton hoặc service cấp app, không tạo socket mỗi component.
- Local component state cho tabs, selection và editor instance.
- Backend là persisted source of truth; local drafts có revision metadata.
- Batch streaming updates; không rerender full chat theo từng delta.
- Sanitize markdown/links/tool outputs; không chạy raw HTML từ model.

### 16.3. CodeMirror components

```text
CodeEditor.vue       — text editor/viewer
SplitDiff.vue        — MergeView
UnifiedDiff.vue      — unifiedMergeView
ReviewToolbar.vue    — shadcn-vue controls
```

CodeMirror có mobile-oriented editing và extension model; merge package hỗ trợ split/unified, collapse unchanged và chunk controls. Không chốt bundle/performance tốt hơn lựa chọn khác khi chưa benchmark. [^https://codemirror.net/][^https://codemirror.net/docs/ref/]

- `onMounted` tạo view, unmount gọi `destroy()`.
- `shallowRef`/non-reactive instance, không deep proxy editor state.
- Update document bằng transaction, không recreate theo từng change.
- Lazy-load editor và language packages; theme dùng CSS tokens phù hợp shadcn-vue.
- Read-only baseline bằng editor extensions, không chỉ disable nút.
- Agent/external file update khi có local draft → conflict UI, không ghi đè draft.

### 16.4. Review semantics

Agent đã sửa workspace trước khi user xem diff. Default accept/reject của merge chỉ thay state/documents trong editor; không tự ghi file lên Runner hay tạo commit. [^https://codemirror.net/docs/ref/]

MVP tắt controls gây hiểu nhầm hoặc wrap thành app actions:

| Action | Ý nghĩa |
| --- | --- |
| Reviewed | User đã duyệt; không áp code lần hai |
| Save | Ghi editor document qua revision-checked RPC |
| Revert | Explicit Runner mutation có baseline/conflict check |
| Commit | Git operation riêng |

Không lấy mutable “original” của merge editor làm audit baseline duy nhất.

## 17. HTTP API và wire protocol

### 17.1. Web API

HTTP là command entrypoint từ browser; WSS chủ yếu phục vụ subscribe/events. Không triển khai hai mutation paths khác nhau khi chưa cần.

| Method | Endpoint | Trách nhiệm |
| --- | --- | --- |
| GET | `/healthz` | Liveness không lộ nội bộ |
| `POST` | `/auth/login` | Username/password (argon2id), set cookie `cc_session`; một đáp án duy nhất cho mọi credential failure (no oracle); Origin bắt buộc thuộc allowlist |
| `POST` | `/auth/logout` | Bump `token_version` + revoke socket subscriptions + clear cookie; Origin tùy chọn (same-origin) |
| GET | `/api/runners` | Danh sách runner của owner (id + lifecycle, không secret) |
| POST | `/api/runners` | Mint one-time connector token (hiển thị một lần, chỉ lưu hash) |
| POST | `/api/runners/:id/revoke` | Revoke credential/dispatch |
| GET | `/api/workspaces` | Workspace có quyền truy cập |
| POST | `/api/runners/:id/workspaces` | Request registration có local validation |
| POST | `/api/workspaces/:id/sessions` | Tạo app session pin location |
| GET | `/api/sessions/:id` | Metadata/messages/checkpoint |
| POST | `/api/sessions/:id/runs` | Submit prompt, trả 202/run ID |
| GET | `/api/runs/:id` | Desired + observed state và freshness |
| POST | `/api/runs/:id/cancel` | Durable cancel request |
| GET | `/api/sessions/:id/events?after=N` | Replay phân trang |
| POST | `/api/approvals/:id/decision` | Persist decision + delivery |
| GET | `/api/workspaces/:id/files?path=...` | Authorized Runner read RPC |
| GET/PUT | `/api/workspaces/:id/file?path=...` | Read/save có expected hash |
| GET | `/api/workspaces/:id/changes` | Git/snapshot status |
| GET | `/api/workspaces/:id/diff?path=...` | Before/after + revisions |
| GET | `/api/workspaces/:id/config/diagnostics` | Redacted diagnostics |
| GET/POST/PATCH/DELETE | `/api/config/profiles[/:id]` | Overrides profiles |

Async registration/inspection có thể trả operation ID khi không đáp ứng trong bounded timeout. Không giữ HTTP request vô hạn khi Runner offline.

### 17.2. WSS endpoints

- `/ws/browser`: cookie/session auth, Origin allowlist, resource-scoped subscriptions.
- `/ws/runner`: Runner credential auth, protocol negotiation, command/event channel.

Browser và Runner không dùng chung auth semantics. Bun WebSocket hỗ trợ native transport/backpressure nhưng ứng dụng vẫn tự xây persistence/replay. [^https://bun.com/docs/runtime/http/websockets]

### 17.3. Idempotency và error model

Mutation có `Idempotency-Key`, scope theo owner/operation. Same key khác payload → reject. TTL và dedup retention không được ngắn hơn retry window đã công bố.

```ts
type ApiError = {
  error: {
    code: string;
    message: string;
    retryable: boolean;
    details?: unknown;
  };
  requestId: string;
};
```

Mã lỗi: `RUNNER_UNAVAILABLE`, `RUNNER_NOT_RECONCILED`, `SESSION_BUSY`, `WORKSPACE_BUSY`, `COMMAND_EXPIRED`, `STALE_ASSIGNMENT`, `FILE_CONFLICT`, `APPROVAL_STALE`, `TRANSCRIPT_MISSING`, `SDK_AUTH_ERROR`, `CONFIG_INVALID`, `JOURNAL_FULL`.

Không trả raw stack traces, credentials hoặc environment. Retryable transport error không có nghĩa được tạo execution attempt mới.

### 17.4. Protocol evolution

- Version envelope và payload schema.
- Negotiate compatible protocol ranges/capabilities.
- Unsupported critical command phải reject, không bỏ qua rồi ACK.
- Rolling upgrade hỗ trợ tối thiểu version overlap đã kiểm thử.
- Không expose raw SDK types như public wire contract.

## 18. Persistence và database schema

### 18.1. Control database

| Bảng | Trách nhiệm |
| --- | --- |
| `users` | Owner identity: username unique, argon2id `password_hash`, `token_version` cho stateful revocation (ADR-0001) |
| `runners` | Stable identity, owner, lifecycle (created/revoked) |
| `runner_credentials` | SHA-256 của connector token; plaintext chỉ tồn tại trong response mint |
| `runner_connections` | Boot/generation, heartbeat, gateway ownership |
| `workspaces` | Runner ownership, display metadata, trust status |
| `sessions` | Workspace/Runner pin, SDK ID, title, visibility |
| `runs`, `execution_attempts` | Desired/observed state, assignment epoch, usage, errors |
| `commands`, `command_outbox` | Payload, fingerprint, delivery/receipt lifecycle |
| `events` | Ingested source events, dedup keys, session sequence |
| `messages` | UI projection từ events |
| `approvals`, `approval_decisions` | Request identity, callback generation, decision/delivery |
| `config_profiles` | Validated overrides; không credential thô |
| `idempotency_receipts` | HTTP dedup và stored responses |
| `audit_logs` | Actor/resource/operation/redacted metadata |

### 18.2. Runner local database

| Bảng | Trách nhiệm |
| --- | --- |
| `local_identity_metadata` | Runner ID/boot metadata; credential storage có quyền riêng |
| `registered_workspaces` | Canonical paths, local allowed policy |
| `command_inbox` | Command ID, fingerprint, accepted/result state |
| `local_attempts` | SDK ID, process ownership metadata, execution state |
| `workspace_locks` | Local writer ownership |
| `event_outbox` | Durable ordered events và ACK offsets |
| `pending_approvals` | Callback identity, expiry; không tự phục hồi callback từ DB |
| `file_snapshots` | Hash/content references và retention |

### 18.3. Constraints

- Unique command ID và immutable request fingerprint.
- Unique `(attemptId, localSequence)` và event ID.
- Unique `(sessionId, sessionSequence)` trên Server.
- Một active execution cho session; workspace mutation locks atomically acquired.
- Approval transition compare-and-set; terminal state idempotent.
- Allocate sequence trong transaction, không `MAX()+1` ngoài lock.
- ACK offsets chỉ advance qua contiguous committed range.

### 18.4. SQLite / PostgreSQL

MVP một Control Server dùng local SQLite với WAL, foreign keys, busy timeout, migrations và consistent backups. Runner dùng SQLite trên local disk, không NFS/shared network database file.

PostgreSQL là bước nâng cấp khi cần nhiều Control Server instances, concurrent dispatchers hoặc operational requirements cao hơn. Thiết kế repository interface tách DB logic, nhưng không giả vờ Drizzle tự làm migration dialect/data conversion không cần kiểm thử.

### 18.5. Retention

- Events có TTL/compaction sau snapshot checkpoint.
- Command receipts giữ đủ lâu để late redelivery không bị hiểu là command mới; khi xóa payload vẫn cần tombstone/dedup policy phù hợp.
- SDK transcripts cleanup là policy riêng và phải cảnh báo ảnh hưởng resume.
- File snapshots/logs/tool output có quotas và đều có thể chứa secrets.
- Chưa có usage/cost thì nullable/unknown, không ghi 0 giả.

## 19. Security và trust boundaries

### 19.1. Web auth

Dùng Better Auth hoặc auth library đã xác minh tương thích Bun/version pin. Không tự viết password/session crypto. Bootstrap owner operator-local; public signup tắt.

Cookies `HttpOnly`, `Secure`, SameSite phù hợp; CSRF cho mutations; Origin allowlist trước browser WebSocket upgrade. Cookie-authenticated WebSocket không được bảo vệ chỉ nhờ same-origin policy. [^https://bun.com/docs/runtime/http/websockets]

Authorization theo resource ở mọi API/subscription/RPC. Revoke login ngắt hoặc vô hiệu hóa socket subscriptions tương ứng.

### 19.2. Runner boundary

- Scoped credential theo Runner; không dùng web cookie.
- Server kiểm tra message.runnerId với authenticated identity.
- Runner không có quyền subscribe events/secrets của Runner khác.
- Local operator policy là giới hạn tối đa cho command từ Server.
- Connector/auth secrets không đi vào tool output hoặc worker env không cần thiết.
- Compromised Control Server vẫn là rủi ro lớn: nó có quyền gửi tác vụ đến Runner; local allowlists và OS isolation giới hạn blast radius.

### 19.3. Agent boundary

Run process separation không phải sandbox; cùng UID có thể đọc tài nguyên của user. Permission prompts không thay thế filesystem/network/container/VM controls. Chạy code không tin cậy cần isolation thực, không chỉ rule regex trên Bash. [^https://code.claude.com/docs/en/agent-sdk/secure-deployment]

MVP không chạy root, không mount Docker socket và không truyền toàn bộ home/secrets chỉ để config hoạt động. Nếu nâng lên untrusted tenants, phải tách storage, identities, config, auth và runtime boundary; không đơn thuần thêm `tenantId` vào database.

### 19.4. Secrets và telemetry

Không gửi API keys/raw env/config lên Control Server. Redaction là best-effort, không thể bảo đảm tool output không bao giờ chứa secret. Prompts, source, transcripts và snapshots phải được bảo vệ như dữ liệu nhạy cảm.

Nếu dùng credential-injecting proxy sau này, đặt ngoài agent security boundary và enforce network routes thực sự; không assume mọi tool tôn trọng proxy env.

### 19.5. Preview

Phase sau dùng authorized preview routing gắn Runner/process/port allowlist. Origin tách biệt, không chia sẻ auth cookie control app. Không tạo generic URL proxy; chống SSRF và không expose toàn bộ Runner ports. HTML/JS do agent tạo không được cùng origin với control UI.

## 20. Deployment và vận hành

### 20.1. Topology A — một máy

```text
Caddy + Web + Control Server + Control SQLite
                         │ loopback / authenticated connection
                         ├── Runner A + local SQLite + config A
                         └── Runner B + local SQLite + config B
```

Vẫn dùng protocol thật và Runner services độc lập. Nếu dùng cùng user/config thì chủ đích shared config, không tự gọi đó là isolation.

### 20.2. Topology B — nhiều máy

```text
Public server: Caddy + Web + Control Server + DB
                   ▲
                   │ outbound WSS
              ┌────┴──────────────┐
              │                   │
         PC / laptop          Linux VPS / server
         Runner A             Runner B
```

Không cần inbound port trên máy Runner cho control protocol. Model/provider traffic và tools vẫn cần egress theo cấu hình local.

### 20.3. Service management

- Control Server bind loopback sau Caddy.
- Runner host-native dưới OS user có config cần kế thừa.
- systemd quản lý restart, graceful shutdown và process containment trên Linux.
- Không dùng hardening flags làm mất HOME/project quyền truy cập mà không doctor test.
- Caddy/proxy WebSocket timeouts và idle behavior phải kiểm thử.
- Docker tùy chọn: mount đúng config/data, UID/GID và paths; host helpers không tự có trong image.

Connector runner được compile thành single executable (`bun run build:runner`, smoke bởi `scripts/integration/runner-binary.ts`): `setup`/`connect`/`service` chạy trên binary compiled. Chạy agent thật từ binary compiled chưa được verify — SDK native binary cần xử lý asset extraction riêng khi compile single executable; phải verify theo tài liệu SDK và platform matrix trước khi tin binary cho run thật. [^https://platform.claude.com/docs/en/agent-sdk/typescript]

### 20.4. Graceful shutdown

Control Server: ngừng nhận start mới, flush committed work, thông báo reconnect; không cần dừng mọi Runner đang chạy chỉ vì Server deploy.

Runner: draining, ngừng accept/start mới; chọn chờ run đến grace period hoặc cancel có chủ đích; persist final state, flush events khi có thể. Không để service manager kill daemon nhưng bỏ lại unmanaged agent children ngoài ownership.

### 20.5. Backup/restore

Backup ba nhóm riêng:

1. Control DB và auth/profile metadata.
2. Runner DB + SDK config/transcripts/memory cần giữ.
3. Workspace source/artifacts theo chính sách operator.

SQLite dùng consistent backup API/snapshot, không copy main DB file rồi bỏ WAL. Ưu tiên draining/maintenance khi snapshot nhiều nhóm dữ liệu. Mã hóa backups, không commit secrets vào Git.

Restore Runner phải không tạo identity clone đang cùng hoạt động. Thay máy/restore cần quy trình revoke rồi mint token mới + chạy lại `setup`, hoặc giữ identity chỉ khi instance cũ đã được dừng chắc chắn.

### 20.6. Observability

Structured logs: request/command/event/run/attempt/runner IDs. Không log raw prompt/tool output mặc định.

Metrics: online/ready Runner, reconnect count, reconciliation duration, command accepted latency, outbox age, event ACK lag, spool bytes, active runs, approval wait, cancellation confirmation latency, RSS/disk, cost khi SDK báo.

Alert ưu tiên: stuck accepted command, event gaps, stale running observations, journal full, duplicate identity, config/auth failure và revoked Runner vẫn có reported active tasks.

## 21. Mở rộng và nâng cấp hạ tầng

### 21.1. Giai đoạn mở rộng

| Stage | Topology | Điều kiện / thay đổi |
| --- | --- | --- |
| A | Một Server, nhiều trusted Runners | SQLite central + durable WSS protocol |
| B | Một Server, nhiều users trong cùng trust domain | RBAC, ownership/quota, PostgreSQL khi cần |
| C | Nhiều Control Server instances | PostgreSQL, connection routing, durable dispatch coordination |
| D | Runner pools / ephemeral workspaces | Workspace provisioning, storage lifecycle, config/auth isolation |
| E | Workflow nghiệp vụ nhiều bước | Có thể bổ sung Temporal sau spike |
| F | Untrusted multi-tenant service | Thiết kế security boundary riêng, không nâng cấp thuần bằng config |

Số Runner không phải trigger duy nhất. Đo database contention, outbox lag, connection memory, availability requirements và chi phí vận hành trước khi nâng cấp.

### 21.2. Nhiều Control Server instances

Vấn đề mới: socket Runner nằm ở gateway X nhưng API request vào instance Y.

Cần:

- Shared PostgreSQL và dispatcher claims/leases có transaction.
- Connection directory `runnerId → gatewayInstance + generation`.
- Internal routing/broker để command đến đúng gateway.
- Gateway reject stale ownership, reconcile sau rebalance.
- Browser event fanout xuyên instances.
- Shared hoặc centralized auth session revocation.

Không dựa vào Bun native pub/sub cho cross-process delivery. Không dùng sticky load balancer như giải pháp duy nhất cho durable scheduling.

### 21.3. NATS JetStream tùy chọn

Dùng khi cần durable transport, nhiều gateway/dispatchers hoặc giảm tự quản delivery ở lớp broker. Giữ public application protocol và inbox/idempotency nguyên tắc.

- Route theo Runner/ownership, không để stateful session rơi vào bất kỳ worker nào.
- ACK broker sau durable inbox acceptance nếu command semantics là “đã bàn giao”; run completion theo event lifecycle riêng.
- Không giữ message unacked suốt nhiều giờ để timeout vô tình tạo lần chạy khác.
- Dedup windows và double ACK không thay side-effect idempotency.
- Broker retention không thay UI history hoặc SDK transcripts.

JetStream ACK timeout có thể gây redelivery; đây là at-least-once mechanism, không bảo đảm shell chạy một lần. [^https://docs.nats.io/learn/jetstream/delivery-and-acknowledgment]

### 21.4. Temporal tùy chọn

Phù hợp khi có workflow dài nhiều bước, timers, approvals nhiều ngày hoặc compensation có định nghĩa. Không cần ở MVP chat agent.

Không bọc nguyên coding run thành Activity có retry vô điều kiện. Temporal Activity timeout/retry có thể tạo attempt khác; cancellation là cooperative và workers có thể chưa dừng. [^https://docs.temporal.io/activity-execution]

Nếu chọn: workflow điều phối run IDs/commands và chờ observed outcomes; side-effecting execution giữ semantics hiện có. Bun compatibility của Temporal SDK chưa được kiểm chứng trong tài liệu này; có thể cần service Node riêng sau spike.

### 21.5. Runner pools và scheduling nâng cao

Tách hai loại workload:

- Stateful interactive coding: pin Runner/workspace, không tự migrate.
- Ephemeral/stateless tasks: có thể pool scheduling nếu workspace/artifacts/auth được provision rõ ràng.

Sau này thêm labels, resource requirements, provider capabilities, affinity và quota. Local Runner admission vẫn là quyết định cuối về capacity/policy. Không share một working tree để tăng parallelism; tạo isolated workspaces.

### 21.6. Session migration

Explicit migration, không failover ngầm:

1. Drain/stop source run, xác minh không còn writer.
2. Snapshot workspace gồm untracked changes theo policy, transcript và required metadata.
3. Kiểm tra target toolchain, provider auth, config và secrets access.
4. Restore, validate paths/dependencies, cấu hình target có chủ đích.
5. Tạo assignment epoch/location mới, audit mapping.
6. User xác nhận resume trên target.

SessionStore nếu dùng giúp transcript portability, không tự lưu workspace/memory artifacts. Fork history không fork filesystem. [^https://code.claude.com/docs/en/agent-sdk/hosting][^https://code.claude.com/docs/en/agent-sdk/sessions]

### 21.7. Storage mở rộng

Object storage cho snapshots/artifacts lớn; DB lưu metadata/hash/access policy. Signed downloads scope/TTL ngắn, không public buckets. Không upload entire workspace/config mặc định.

Data retention và backup phải thống nhất giữa DB/object store/Runner local storage. Garbage collection cần reference tracking, không xóa artifacts run đang cần replay/review.

### 21.8. Untrusted multi-tenancy

Cần per-tenant OS/container/VM boundary phù hợp, credentials ngoài agent boundary khi khả thi, egress control, storage/config separation và tenant-aware auth. Kế thừa “host user config” chuyển thành kế thừa **tenant environment đã được provision**, không dùng một config chung cho mọi khách hàng.

Đây là thay đổi trust model lớn, phải threat-model và test riêng. Không nằm trong cam kết an toàn của MVP.

## 22. Testing và acceptance criteria

### 22.1. Compatibility spike bắt buộc

Pin Bun/SDK và test trên OS target:

- Bundled CLI resolve/launch không cần global CLI.
- User/project/local config inheritance.
- Preset + CLAUDE.md, hooks và MCP thực tế cần dùng.
- Provider auth trong service environment.
- Streaming, resume explicit ID, approvals, cancellation và process cleanup.
- SDK update chạy lại matrix; không chỉ test một prompt hello-world.

### 22.2. Unit/integration

- Override inherit sinh omission, không default giả.
- Session/profile resolution, schema validation, managed-policy không bị mô phỏng sai.
- Outbox transaction rollback không phát command.
- Duplicate inbox command không spawn lại.
- Same ID khác payload bị reject.
- Cancel trước start chặn launch.
- ACK không vượt sequence gap.
- Partial/final SDK messages không nhân đôi text.
- Approval expiry/generation/hash/ownership validation.
- File traversal/symlink/expected hash và XSS sanitization.
- Terminal error result + throw chỉ sinh một terminal transition.

### 22.3. Fault injection

Dùng ít nhất hai Runner và kiểm soát điểm crash:

| Fault | Điều phải chứng minh |
| --- | --- |
| Server chết sau DB commit trước send | Outbox giao tiếp sau restart |
| Runner chết sau inbox commit trước ACK | Command resend không tạo run trùng |
| Runner chết quanh OS spawn | Không auto-launch khi state mơ hồ |
| Event ACK mất | Replay không nhân đôi messages |
| Mạng đứt trong active run | Run tiếp tục/spool đúng policy, không failover |
| Cancel khi offline | UI không báo stopped trước confirmation |
| Worker chết khi chờ approval | Decision cũ không áp vào callback mới |
| Runner reconnect khi replay | Không mất live tail, không sequence gap im lặng |
| Local disk đầy | Không accept/start tiếp rồi bỏ events |
| Duplicate runner credential | Generation conflict được phát hiện |
| External file edit | Save/revert conflict, không overwrite |
| Hai session cùng workspace | Writer admission chặn đúng |

Không cần khẳng định mọi fault recovery tự động. Trạng thái unknown rõ ràng và không lặp side effect là kết quả chấp nhận được cho ambiguous failures.

### 22.4. End-to-end và vận hành

- Hai Runner có config khác nhau, Web kế thừa đúng target.
- Web disconnect không dừng agent.
- Restart Control Server không reset Runner active run.
- Resume đúng SDK session, không chọn session mới nhất vô tình.
- Backup restore giữ mapping và không clone active Runner identity.
- Mobile chat/approval/unified diff, tiếng Việt IME, keyboard navigation.
- Config gốc không bị web thay đổi trong default flows.

### 22.5. Performance

Đo time-to-first-event, command receipt latency, replay throughput, UI render time, Runner RSS, DB contention và spool growth. Test long sessions, large outputs và large diffs. SLO đặt sau benchmark đại diện; không lấy WebSocket benchmark chung của Bun làm bằng chứng agent chạy nhanh hơn.

## 23. Roadmap triển khai

### Phase 0 — Prove runtime/config

Script Runner nhỏ chứng minh bundled CLI, Bun compatibility, config inheritance, auth, hooks/MCP, streaming, resume và cancel. Chọn/pin versions và OS support matrix.

### Phase 1 — Control/Runner protocol

Connector token/auth, two-Runner connectivity, registry/capabilities, local SQLite inbox/outbox, central outbox, commands/events ACK, boot identity và reconciliation. Test mất mạng/crash trước khi xây UI đầy đủ.

### Phase 2 — Chat product MVP

Vue shell, owner auth, workspaces/sessions, streaming projections, approvals/questions, cancel, reconnect/replay và errors. One concurrent run/Runner mặc định.

### Phase 3 — Config và code review

Diagnostics RPC, profiles/overrides, CodeMirror, file/Git RPC, revision checks, snapshots, explicit revert và retention.

### Phase 4 — Hardening/release

Security checks, fault injection, backup/restore, quotas, observability, graceful upgrade, install/service docs và mobile QA.

### Phase 5 — Mở rộng theo evidence

PostgreSQL/multiple gateways nếu cần; broker nếu routing/durable transport trở thành bottleneck; preview/worktree/pools hoặc workflow engine theo nhu cầu thực tế. Không thêm tất cả chỉ để dự phòng.

Không ước lượng thời gian hoàn thành khi chưa có Phase 0 và scope implementation cụ thể.

## 24. Decision log và các điểm còn cần xác nhận

### 24.1. ADR tóm tắt

| ID | Quyết định | Hệ quả |
| --- | --- | --- |
| ADR-001 | Web/Control/Runner tách biệt | Deploy cùng hoặc khác máy không đổi protocol |
| ADR-002 | Runner là service độc lập | Server deploy không buộc agent chết |
| ADR-003 | Bundled Claude Code | Không phụ thuộc CLI global; pin SDK/native binary |
| ADR-004 | Config kế thừa tại Runner | Không centralize raw config/credentials |
| ADR-005 | Explicit overrides | Inherit không bị web defaults che |
| ADR-006 | Stateful session pin | Không load-balance resume tùy ý |
| ADR-007 | Durable outbox/inbox/journals | Reconnect/crash recovery có state bền vững |
| ADR-008 | At-least-once + dedup | Không hứa exactly-once side effects |
| ADR-009 | No automatic ambiguous failover | Ưu tiên safety hơn availability khi không xác minh |
| ADR-010 | Vue + CodeMirror review-first | Không xây IDE đầy đủ ở MVP |
| ADR-011 | SQLite MVP, PostgreSQL scale-out | Không chạy SQLite shared trên nhiều servers |
| ADR-012 | No mandatory broker/Temporal | Giữ vận hành gọn, có điểm mở rộng rõ |
| ADR-013 | One Runner owner/workspace | Tránh shared-filesystem split-brain |
| ADR-014 | Host-native Runner ưu tiên | Tái sử dụng user config và toolchain ít sai khác |
| ADR-015 | Runner là connector với token mint từ web (2026-10-24); phần owner auth (better-auth) đã đảo ngược 2026-10-25 — quay lại ADR-0001 | Token hiển thị một lần, DB chỉ giữ hash; systemd unit không chứa secret |

### 24.2. Cần chốt khi bắt đầu implementation

- OS/platform cho Runner đầu tiên; ưu tiên Linux để chốt supervisor semantics.
- SDK/Bun versions cụ thể và minimum supported versions.
- Provider/auth được dùng thực tế, không suy ra từ subscription.
- MCP/hook/plugin nào bắt buộc tương thích.
- Allowed workspace roots và policy source-of-truth.
- Retention, output/file size limits, spool budget và critical disk behavior.
- Auth library và bootstrap/recovery flow cho owner.
- SQLite hay PostgreSQL ngay từ đầu theo deployment/availability needs thực tế.

Các điểm trên không thay đổi kiến trúc chính. Chúng là parameters/compatibility gates cần xác nhận, không phải tính năng đã triển khai.

## 25. Nguồn tham khảo

Tuyên bố về SDK, Bun và editor dựa trên nguồn bên dưới. Schema, endpoints, protocol, process layout, limits và roadmap là thiết kế đề xuất cho ứng dụng, không phải API chính thức của nhà cung cấp.

- [Claude Agent SDK overview](https://code.claude.com/docs/en/agent-sdk/overview)
- [TypeScript SDK reference](https://platform.claude.com/docs/en/agent-sdk/typescript)
- [Use Claude Code features in the SDK](https://platform.claude.com/docs/en/agent-sdk/claude-code-features)
- [System prompts và CLAUDE.md](https://platform.claude.com/docs/en/agent-sdk/modifying-system-prompts)
- [Hosting và local state](https://code.claude.com/docs/en/agent-sdk/hosting)
- [Sessions, resume và fork](https://code.claude.com/docs/en/agent-sdk/sessions)
- [Streaming output](https://code.claude.com/docs/en/agent-sdk/streaming-output)
- [Approvals và user input](https://code.claude.com/docs/en/agent-sdk/user-input)
- [Secure deployment](https://code.claude.com/docs/en/agent-sdk/secure-deployment)
- [Quickstart và authentication](https://code.claude.com/docs/en/agent-sdk/quickstart)
- [Bun WebSockets](https://bun.com/docs/runtime/http/websockets)
- [CodeMirror](https://codemirror.net/)
- [CodeMirror reference / merge](https://codemirror.net/docs/ref/)
- [AWS transactional outbox](https://docs.aws.amazon.com/prescriptive-guidance/latest/cloud-design-patterns/transactional-outbox.html)
- [NATS delivery và acknowledgement](https://docs.nats.io/learn/jetstream/delivery-and-acknowledgment)
- [Temporal Activity execution và cancellation](https://docs.temporal.io/activity-execution)
- [Distributed locking và fencing — Martin Kleppmann](https://martin.kleppmann.com/2016/02/08/how-to-do-distributed-locking.html)
