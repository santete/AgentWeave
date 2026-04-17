# AgentWeave — Hướng dẫn sử dụng

> Version 1.1.0 | Lớp kiểm soát cho AI Agent

AgentWeave giúp bạn chạy AI agent với quyền kiểm soát: cho phép/chặn tool, giới hạn chi phí, lọc output, giám sát real-time.

---

## Mục lục

**Người dùng (CLI — không cần code):**
1. [Cài đặt](#1-cài-đặt)
2. [Chạy agent đầu tiên](#2-chạy-agent-đầu-tiên)
3. [Kiểm soát quyền (cho phép / chặn)](#3-kiểm-soát-quyền)
4. [Giám sát và quản lý session](#4-giám-sát-và-quản-lý-session)

**Team (nhiều developer dùng chung Gateway):**
5. [Thiết lập Gateway cho team](#5-thiết-lập-gateway-cho-team)
6. [Dashboard và REST API](#6-dashboard-và-rest-api)

**Developer (tích hợp SDK vào ứng dụng):**
7. [SDK cho TypeScript/Node.js](#7-sdk-cho-typescriptnodejs)
8. [Multi-Agent (nhiều agent chạy song song)](#8-multi-agent)
9. [Plugin (mở rộng tính năng)](#9-plugin)
10. [Adapter (bọc Claude Code, OpenAI)](#10-adapter)

**Tham khảo:**
11. [CLI — Danh sách lệnh đầy đủ](#11-cli-reference)
12. [Cấu hình chi tiết](#12-cấu-hình-chi-tiết)
13. [Triển khai (Deploy)](#13-triển-khai)
14. [Xử lý lỗi thường gặp](#14-xử-lý-lỗi)

---

# PHẦN 1: NGƯỜI DÙNG (CLI)

## 1. Cài đặt

### Yêu cầu

- Node.js 22 trở lên
- Một API key LLM (OpenRouter miễn phí, hoặc Anthropic/OpenAI/Google)

### Bước 1: Clone và build

```bash
git clone https://github.com/santete/AgentWeave.git
cd AgentWeave
npm install -g pnpm
pnpm install
pnpm turbo run build
```

### Bước 2: Tạo lệnh `agentweave`

```bash
# Windows PowerShell
cd packages/cli
pnpm link --global

# Hoặc chạy trực tiếp
node packages/cli/dist/bin.js --version
```

### Bước 3: Cấu hình API key

AgentWeave hỗ trợ 4 provider. Chọn 1:

**OpenRouter (khuyên dùng — nhiều model miễn phí):**
```powershell
# Windows PowerShell
$env:OPENROUTER_API_KEY="sk-or-v1-xxx"

# Linux/Mac
export OPENROUTER_API_KEY="sk-or-v1-xxx"
```
Lấy key miễn phí tại: https://openrouter.ai/settings/keys

**Hoặc dùng provider khác:**
```bash
export ANTHROPIC_API_KEY="sk-ant-xxx"      # Anthropic Claude
export OPENAI_API_KEY="sk-xxx"              # OpenAI GPT
export GOOGLE_GENERATIVE_AI_API_KEY="xxx"   # Google Gemini
```

### Xác nhận cài đặt thành công

```bash
agentweave --version
# 1.1.0
```

---

## 2. Chạy agent đầu tiên

### Lệnh cơ bản

```bash
# Chạy agent với prompt
agentweave run "Liệt kê các file trong thư mục hiện tại"

# Chỉ định model (mặc định: claude-sonnet-4-6)
agentweave run "Fix lỗi login" --model nvidia/nemotron-nano-9b-v2:free

# Giới hạn chi phí ($5 max)
agentweave run "Refactor auth module" --budget 5

# Giới hạn số lượt (20 lượt max)
agentweave run "Review code" --max-turns 20
```

### Chế độ quyền (permission mode)

```bash
# Mặc định — chặn tool không rõ nguồn
agentweave run "Fix bug" --mode default

# Nghiêm ngặt — chặn tất cả trừ khi được phép rõ ràng
agentweave run "Deploy" --mode strict

# Thoải mái — cho phép tất cả trừ khi bị cấm
agentweave run "Prototype nhanh" --mode permissive

# Chỉ đọc — agent chỉ xem, không sửa file
agentweave run "Review code quality" --mode plan
```

### Ví dụ chạy thật (đã test thành công)

```bash
# Set API key (PowerShell)
$env:OPENROUTER_API_KEY="sk-or-v1-xxx"

# Chạy agent — nó sẽ gọi Bash tool để liệt kê file
agentweave run "List TypeScript files in current directory" --model nvidia/nemotron-nano-9b-v2:free --budget 0.50
```

**Output mẫu:**
```
  AgentWeave v1.1.0

  Model:  nvidia/nemotron-nano-9b-v2:free
  Budget: $0.50
  Prompt: "List TypeScript files in current directory"

  ── Turn 1 ──
  Tool: Bash({"command":"ls *.ts"})
  ALLOWED: Bash [rule:project]
  Done: tu_1 (45ms)

  ── Turn 2 ──
  Found 3 TypeScript files: index.ts, config.ts, utils.ts

  ── Session Complete ──
  Reason: completed
  Tokens: 2055 in / 687 out
  Cost:   $0.0165
```

### Agent hỏi quyền (Ask flow)

Khi agent muốn chạy tool mà chưa được phép rõ ràng, bạn sẽ thấy prompt:

```
  ASK: Allow Bash?
  Tool: Bash({"command":"npm install express"})
  [y] Allow  [n] Deny  [a] Always Allow
  > y
```

- Gõ `y` → cho phép lần này
- Gõ `n` → chặn lần này
- Gõ `a` → cho phép vĩnh viễn (trong session)

---

## 3. Kiểm soát quyền

AgentWeave có sẵn các rule bảo mật:

| Rule | Hành vi | Mặc định |
|------|---------|----------|
| `Bash(rm -rf *)` | **Chặn** | Có — chặn xóa hàng loạt |
| `Bash(sudo *)` | **Chặn** | Có — chặn sudo |
| `FileWrite(*.env)` | **Chặn** | Có — chặn ghi file .env |
| `FileRead(*)` | **Cho phép** | Có — đọc file thoải mái |
| `Bash(git *)` | **Cho phép** | Không — tùy bạn thêm |

### Sandbox bảo mật

Agent KHÔNG THỂ truy cập:
- `/etc`, `/var`, `/root`, `/sys`, `/proc`
- File `.env`, `.ssh`, `.aws`, `.gnupg`, `credentials`
- Ngoài thư mục dự án (nếu cấu hình `allowedPaths`)

---

## 4. Giám sát và quản lý session

### Xem danh sách session đã chạy

```bash
agentweave session list
```

Output:
```
  Sessions directory: ~/.agentweave/sessions

  Session ID                               Size       Modified
  ──────────────────────────────────────── ────────── ────────────────────
  ses_abc123def456                          12.3KB     2026-04-17 14:30:00
  ses_xyz789ghi012                          8.1KB      2026-04-17 15:45:00

  Total: 2 session(s)
```

### Giám sát Gateway (khi dùng team mode)

```bash
agentweave monitor --gateway http://localhost:9101
```

Output (cập nhật mỗi 2 giây):
```
  Monitoring gateway: http://localhost:9101
  Polling every 2s. Press Ctrl+C to stop.

  [14:30:01] Clients: 3 | Status: ok
  [14:30:03] Clients: 3 | Status: ok
  [14:30:05] Clients: 2 | Status: ok
```

---

# PHẦN 2: TEAM (GATEWAY)

## 5. Thiết lập Gateway cho team

Khi nhiều developer cùng dùng, Gateway giúp:
- **Quy tắc chung**: tất cả agent đều tuân theo cùng permission rules
- **Giám sát tập trung**: xem ai đang chạy agent gì
- **Kiểm soát chi phí**: budget chung cho cả team

### Kiến trúc

```
Developer A ──┐
Developer B ──┤── WebSocket ──► Gateway Server ──► LLM API
Developer C ──┘                 ├── Permission Rules (chung)
                                ├── Budget (chung)
                                ├── REST API (:9101)
                                └── Dashboard (http://localhost:9101/)
```

### Khởi động Gateway

Tạo file `gateway.ts`:

```typescript
import { GatewayServer, issueToken } from "@agentweave/gateway";

const SECRET = "your-secret-key-at-least-32-characters-long";

const gateway = new GatewayServer({
  port: 9100,        // WebSocket cho agent
  restPort: 9101,    // REST API + Dashboard
  auth: { secret: SECRET },
  permissions: {
    mode: "default",
    rules: [
      { pattern: "Bash(rm -rf *)", behavior: "deny", source: "policy", priority: 100 },
      { pattern: "Bash(sudo *)", behavior: "deny", source: "policy", priority: 100 },
      { pattern: "FileRead(*)", behavior: "allow", source: "project", priority: 50 },
    ],
    failMode: "closed",
    timeoutMs: 5000,
    askTimeoutMs: 60000,
  },
});

await gateway.start();

// Tạo token cho từng developer
console.log("Dev token:", issueToken("alice", "developer", SECRET));
console.log("Lead token:", issueToken("bob", "team_lead", SECRET));
console.log("Admin token:", issueToken("carol", "admin", SECRET));
```

Chạy:
```bash
npx tsx gateway.ts
# Gateway running on ws://localhost:9100 + http://localhost:9101
```

### 3 loại quyền (Role)

| Role | Xem | Chạy agent | Sửa rules | Quản lý Gateway |
|------|-----|-----------|-----------|-----------------|
| `developer` | Session mình | Có | Không | Không |
| `team_lead` | Session team | Có | Có | Không |
| `admin` | Tất cả | Có | Có | Có |

---

## 6. Dashboard và REST API

### Dashboard (giao diện web)

Mở trình duyệt: **http://localhost:9101/**

Dashboard hiển thị:
- Số agent đang kết nối
- Danh sách permission rules
- Trạng thái health

Để xem đầy đủ, set JWT token trong console trình duyệt:
```javascript
localStorage.setItem('agentweave_token', 'eyJ...');
```

### REST API

```bash
TOKEN="eyJ..."  # JWT token từ bước tạo token

# Xem rules
curl -H "Authorization: Bearer $TOKEN" http://localhost:9101/api/rules

# Thêm rule (cần team_lead hoặc admin)
curl -X POST -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"pattern":"Bash(npm test)","behavior":"allow","source":"project","priority":60}' \
  http://localhost:9101/api/rules

# Xóa rule theo index
curl -X DELETE -H "Authorization: Bearer $TOKEN" http://localhost:9101/api/rules/0

# Xem agent đang kết nối
curl -H "Authorization: Bearer $TOKEN" http://localhost:9101/api/clients

# Health check (không cần token)
curl http://localhost:9101/api/health
```

---

# PHẦN 3: DEVELOPER (SDK)

## 7. SDK cho TypeScript/Node.js

Dành cho developer muốn **nhúng AgentWeave vào ứng dụng riêng**.

```typescript
import { createHarness } from "@agentweave/sdk";
import { BUILT_IN_TOOLS } from "@agentweave/inner-harness";

const harness = createHarness({
  model: "nvidia/nemotron-nano-9b-v2:free",  // Hoặc claude-sonnet-4-6, gpt-4o, etc.
  tools: BUILT_IN_TOOLS,                      // 6 tool có sẵn
  permissions: {
    mode: "default",
    rules: [
      { pattern: "Bash(git *)", behavior: "allow", source: "user", priority: 50 },
      { pattern: "Bash(rm *)", behavior: "deny", source: "policy", priority: 100 },
    ],
    failMode: "closed",
  },
  budget: { maxPerSession: 5.0 },
});

// Cách 1: Chạy và lấy kết quả
const { result, events } = await harness.run("Fix login bug");
console.log(result.reason);  // "completed"
console.log(harness.getUsage().totalCost);  // $0.02

// Cách 2: Stream events real-time
for await (const event of harness.stream("Refactor auth")) {
  if (event.type === "tool:requested") console.log("Tool:", event.toolName);
  if (event.type === "permission:denied") console.log("BLOCKED:", event.reason);
}
```

---

## 8. Multi-Agent

Chạy nhiều agent song song, mỗi agent có budget và quyền riêng:

```typescript
const harness = createHarness({
  model: "claude-sonnet-4-6",
  multiAgent: { maxConcurrentAgents: 3, totalBudgetUsd: 20 },
});

// Tạo worker research (chỉ đọc, budget $2)
const researcher = harness.spawnAgent({
  name: "researcher",
  prompt: "Tìm pattern authentication trong code",
  budgetUsd: 2,
  permissions: { mode: "plan" },  // Chỉ đọc
});

// Tạo worker implement (full quyền, budget $10)
const coder = harness.spawnAgent({
  name: "coder",
  prompt: "Implement JWT authentication",
  budgetUsd: 10,
});

// Chạy song song
const [r1, r2] = await Promise.all([researcher.run(), coder.run()]);

// Gửi tin nhắn giữa các agent
coder.send(researcher.id, "instruction", { files: ["src/auth.ts"] });
```

---

## 9. Plugin

Thêm tool và hook tùy chỉnh:

```typescript
import { createHarness } from "@agentweave/sdk";

const lintPlugin = {
  name: "lint-plugin",
  version: "1.0.0",
  description: "Tự động lint sau khi sửa file",
  permissions: { hooks: { events: ["PostToolUse"] } },
  activate: async () => ({
    hooks: [{
      event: "PostToolUse",
      matcher: "FileWrite|FileEdit",
      definition: { type: "command", event: "PostToolUse", command: "npx eslint --fix $TOOL_INPUT" },
    }],
  }),
};

const harness = createHarness({
  model: "claude-sonnet-4-6",
  plugins: [lintPlugin],  // Plugin được load tự động
});
```

---

## 10. Adapter

Bọc AI agent bên ngoài (Claude Code CLI, bất kỳ CLI tool):

```typescript
import { createClaudeCodeAdapter } from "@agentweave/adapters";

// Bọc Claude Code CLI
const agent = createClaudeCodeAdapter({ model: "sonnet" });
for await (const event of agent.run("Fix the bug")) {
  console.log(event.type);
}

// Bọc bất kỳ CLI tool
import { ProcessAdapter } from "@agentweave/adapters";
const custom = new ProcessAdapter({
  command: "python",
  args: ["my-agent.py"],
  promptMode: "stdin",
});
```

---

# PHẦN 4: THAM KHẢO

## 11. CLI Reference

```
agentweave run <prompt> [options]     Chạy agent
  --model <tên>                       Model LLM (mặc định: claude-sonnet-4-6)
  --budget <USD>                      Giới hạn chi phí (0-10000)
  --max-turns <số>                    Giới hạn số lượt (1-10000)
  --mode <chế độ>                     default | strict | permissive | plan

agentweave monitor [--gateway <url>]  Giám sát Gateway
agentweave session list [--dir <path>] Xem danh sách session

agentweave --version                  Xem phiên bản
agentweave --help                     Xem trợ giúp
```

## 12. Cấu hình chi tiết

### Provider LLM (tự động detect)

| Env var | Provider | Model ví dụ |
|---------|----------|-------------|
| `OPENROUTER_API_KEY` | OpenRouter (nhiều model free) | `nvidia/nemotron-nano-9b-v2:free` |
| `ANTHROPIC_API_KEY` | Anthropic | `claude-sonnet-4-6` |
| `OPENAI_API_KEY` | OpenAI | `gpt-4o-mini` |
| `GOOGLE_GENERATIVE_AI_API_KEY` | Google | `gemini-2.0-flash` |

**Ưu tiên:** OpenRouter > Google > Anthropic > OpenAI (nếu có nhiều key)

### Permission mode

| Mode | Mô tả | Dùng khi |
|------|-------|----------|
| `default` | Chặn tool không rõ | Phát triển bình thường |
| `strict` | Chặn tất cả trừ whitelist | Production, CI/CD |
| `permissive` | Cho phép tất cả trừ blacklist | Prototype nhanh |
| `plan` | Chỉ đọc, không ghi file | Review code |

### Output filter

| Loại | Chặn gì |
|------|---------|
| `secret` | API key (sk-*), AWS key (AKIA*), GitHub token (ghp_*) |
| `pii` | Email, SSN, số điện thoại, credit card |

### Sandbox (tự động)

Chặn truy cập: `/etc`, `/var`, `.env`, `.ssh`, `.aws`, `.gnupg`, `credentials`

---

## 13. Triển khai

### Cho 1 người (Local)

```bash
git clone https://github.com/santete/AgentWeave.git
cd AgentWeave && pnpm install && pnpm turbo run build
export OPENROUTER_API_KEY="sk-or-v1-xxx"
agentweave run "Hello world"
```

### Cho team (Gateway)

```bash
# Server
npx tsx gateway.ts
# → ws://0.0.0.0:9100 (agent) + http://0.0.0.0:9101 (dashboard)

# Developer máy khác
# Kết nối qua SDK với token từ admin
```

### Cho CI/CD

```yaml
# .github/workflows/review.yaml
- run: |
    export OPENROUTER_API_KEY=${{ secrets.OPENROUTER_API_KEY }}
    agentweave run "Review PR này" --mode plan --budget 1.00
```

---

## 14. Xử lý lỗi

### "Permission denied"
Agent bị chặn tool. Thêm rule cho phép hoặc đổi `--mode permissive`.

### "Budget exceeded"
Hết ngân sách. Tăng `--budget` hoặc dùng model rẻ hơn.

### "LLM call failed: quota exceeded"
API key hết quota. Nạp credit hoặc đổi provider.

### "LLM call failed: User not found"
API key sai hoặc chưa active. Kiểm tra key trên dashboard provider.

### Agent không gọi tool
Model quá yếu hoặc không hỗ trợ tool calling. Thử model mạnh hơn (ví dụ: `nvidia/nemotron-nano-9b-v2:free` hoạt động tốt).

### Lệnh `agentweave` không nhận
Chạy trực tiếp: `node packages/cli/dist/bin.js --version`. Hoặc mở terminal mới sau khi `pnpm link --global`.

---

**GitHub:** https://github.com/santete/AgentWeave
**License:** MIT
