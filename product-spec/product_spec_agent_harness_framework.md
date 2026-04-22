# AGENTWEAVE — Product Specification

> Ten san pham: **AgentWeave**
> Phien ban: v0.2 — Post-pivot
> Ngay: 2026-04-22
> Muc dich: Governance + QA layer cho AI coding agents (Claude Code, Cursor, MCP-compatible).
>
> **Canonical positioning:** [`product-spec/POSITIONING.md`](./POSITIONING.md). Sections below align with that document; any divergence, POSITIONING.md wins.

---

## Muc luc

1.  [Vision & Problem Statement](#1-vision--problem-statement)
2.  [Product Overview](#2-product-overview)
3.  [Kien truc tong the](#3-kien-truc-tong-the)
4.  [Core Module 1: Agent Loop Controller](#4-core-module-1-agent-loop-controller)
5.  [Core Module 2: Output Control Pipeline](#5-core-module-2-output-control-pipeline)
6.  [Core Module 3: Tool Governance](#6-core-module-3-tool-governance)
7.  [Core Module 4: Permission Engine](#7-core-module-4-permission-engine)
8.  [Core Module 5: Hook Engine](#8-core-module-5-hook-engine)
9.  [Core Module 6: Monitoring & Observability](#9-core-module-6-monitoring--observability)
10. [Core Module 7: Context & Prompt Control](#10-core-module-7-context--prompt-control)
11. [Core Module 8: Session Management](#11-core-module-8-session-management)
12. [Core Module 9: Multi-Agent Orchestration](#12-core-module-9-multi-agent-orchestration)
13. [Core Module 10: Configuration Hierarchy](#13-core-module-10-configuration-hierarchy)
14. [Giao thuc kiem soat du lieu dau ra (Output Control Protocol)](#14-giao-thuc-kiem-soat-du-lieu-dau-ra)
15. [SDK & API Interface](#15-sdk--api-interface)
16. [CLI Interface](#16-cli-interface)
17. [Dashboard & Web UI](#17-dashboard--web-ui)
18. [Integration Patterns](#18-integration-patterns)
19. [Security Model](#19-security-model)
20. [Roadmap](#20-roadmap)

---

## 1. Vision & Problem Statement

### Van de

Cac AI coding agent (Claude Code, Cursor, Aider, Codex...) hien da rat tot o **thuc thi** — agent loop, tool calling, streaming, context management. Nhung cac team su dung chung van gap 6 pain points, **tat ca deu nam o lop governance ben ngoai agent**:

- **Khong kiem soat duoc output**: Agent tra ve gi thi user nhan nay — khong co lop loc secret, PII, transform, validate.
- **Khong giam sat duoc hanh vi**: Agent goi tool gi, bao nhieu lan, ton bao nhieu token — khong ai biet cho den khi xong.
- **Khong audit duoc**: Khong co log co cau truc de review lai agent da lam gi, tai sao.
- **Khong enforce policy duoc**: Enterprise khong ep duoc rule "khong ghi .env", "phai chay test truoc khi commit", "junior chi duoc mode plan".
- **Khong scale duoc governance**: 100 developer dung 100 agent, moi nguoi 1 config, khong co cach quan ly tap trung.
- **Khong do duoc chat luong**: First-pass success? Retry rate? Scope accuracy? Regression? Khong ai biet agent dang tot len hay te di qua tung run.

### Vision

**AgentWeave KHONG xay lai agent loop.** Claude Code, Cursor, Anthropic lam viec do qua tot, va ta khong canh tranh o lop do.

**AgentWeave la Governance + QA layer cho AI coding agents:**

```
AI Agent (Claude Code / Cursor / Aider / ...)
        |
   enforce policy, audit, budget, hooks
        |
   orchestrate SDLC workflow around it
        |
   measure M1-M10 metrics across runs
        |
+========================================+
|  AgentWeave = 3 Pillars                 |
|                                          |
|  1. Governance     (Outer Harness)      |
|  2. QA Pipeline    (SDLC Orchestrator)  |
|  3. Adapters + MCP (Distribution)       |
+========================================+
```

Chi tiet positioning, non-goals, va quyet dinh strategic: **[POSITIONING.md](./POSITIONING.md)** la canonical source.

### Doi tuong su dung

| Persona | Pillar chinh | Nhu cau cu the |
|---|---|---|
| **Developer** | Pillar 2 (QA Pipeline) | First-pass success data, retry count, cost per task |
| **Team Lead** | Pillar 2 + Pillar 1 (Hooks) | Enforce test gates, do team velocity qua M1-M10 |
| **Security Engineer** | Pillar 1 (Governance) | Permission rules, deny lists, audit trail |
| **Platform Engineer** | Pillar 1 + Pillar 3 (Adapters) | Central config cho 100+ agents, adapter cho nhieu CLI |
| **Enterprise Admin** | Pillar 1 (Policy hierarchy) | Compliance, RBAC, immutable rules |
| **AI Researcher** | Pillar 2 (M1-M10 analytics) | Measure agent behavior across runs, compare models |

---

## 2. Product Overview

### AgentWeave la gi?

AgentWeave la **Governance + QA layer** wrap quanh cac AI coding agent co san. Khong thay the agent — wrap va kiem soat chung.

```
AI Coding Agent (Claude Code / Cursor / Aider / MCP-compatible)
        ^
        |  delegates execution via adapter
        |
+=====================================================+
| AGENTWEAVE (3 pillars, each usable alone)           |
|                                                      |
|  ┌────────────────────────────────────────────────┐ |
|  │ Pillar 1: GOVERNANCE (Outer Harness)           │ |
|  │  - Permission Engine (allow/deny/ask, 7-level) │ |
|  │  - Budget Manager (cost caps)                  │ |
|  │  - Hook Engine (5 types, 18+ events)           │ |
|  │  - Input Gate (prompt-side validation)         │ |
|  │  - Audit Logger (tamper-evident JSONL)         │ |
|  │  - Monitor + Alert engine                      │ |
|  └────────────────────────────────────────────────┘ |
|                                                      |
|  ┌────────────────────────────────────────────────┐ |
|  │ Pillar 2: QA PIPELINE (SDLC Orchestrator)      │ |
|  │  8 stages around the agent:                    │ |
|  │    Norm → Ctx → Plan → Exec → Patch → QA →     │ |
|  │    Retry → Out                                 │ |
|  │  Exec stage delegates to agent via adapter.    │ |
|  │  M1-M10 metrics: first-pass success, test      │ |
|  │  pass rate, scope accuracy, retry count,       │ |
|  │  cost, time, regression, plan accuracy,        │ |
|  │  context utilization, code quality delta.      │ |
|  └────────────────────────────────────────────────┘ |
|                                                      |
|  ┌────────────────────────────────────────────────┐ |
|  │ Pillar 3: ADAPTERS + MCP (Distribution)        │ |
|  │  - Claude Code hooks (PreToolUse/PostToolUse)  │ |
|  │  - MCP server (any MCP host can use)           │ |
|  │  - Adapter pattern (Claude Code today;         │ |
|  │    Cursor, Aider roadmap)                      │ |
|  └────────────────────────────────────────────────┘ |
+=====================================================+
```

**Key property:** 3 pillars are independent. Use governance alone (raw Claude Code + hooks). Use QA pipeline alone (wraps any agent, adds metrics). Mix freely.

### Tinh nang chinh (by pillar)

```
Pillar 1 — GOVERNANCE
  ├── Permissions  : rule-based, 7-level hierarchy, contextual conditions
  ├── Budget       : per-session, per-day, per-user caps
  ├── Hooks        : 5 types (command, prompt, agent, http, function)
  ├── Input gate   : prompt validation, injection
  ├── Audit        : append-only JSONL, tool-level decisions logged
  └── Monitor      : real-time metrics + alert engine

Pillar 2 — QA PIPELINE
  ├── 8 SDLC stages around agent execution
  ├── Metrics      : M1-M10 tracked per run, baseline compare
  ├── Retry engine : error classification → strategy → re-invoke agent
  ├── Patch valid. : scope check, file count limit
  └── Quality gate : test/lint/compile via execFile + allowlist

Pillar 3 — ADAPTERS + MCP
  ├── Claude Code hooks : .claude/hooks + `agentweave guard`
  ├── MCP server        : governance + QA exposed as MCP tools
  ├── Adapters          : Claude Code, Cursor (planned), Aider (planned)
  └── Session mgmt      : persist, replay, fork (works across adapters)

What we explicitly do NOT ship (moved to "reference impl only"):
  ├── Agent loop replacement        — Claude Code/Cursor own this.
  ├── Tool-calling runtime          — commodity parity, not our value.
  └── Multi-model provider routing  — use what the agent already supports.
```

Positioning decisions and non-goals: see [POSITIONING.md](./POSITIONING.md).

---

## 3. Kien truc tong the

### 3.1 Component Diagram

```
+------------------------------------------------------------------+
|                     AgentWeave Runtime                             |
|                                                                   |
|  +-----------+  +-------------+  +------------+  +-------------+ |
|  | Input     |  | Agent Loop  |  | Output     |  | Session     | |
|  | Gate      |->| Controller  |->| Pipeline   |->| Manager     | |
|  +-----------+  +------+------+  +-----+------+  +-------------+ |
|                        |               |                          |
|                  +-----v-----+   +-----v------+                   |
|                  | Tool      |   | Monitor    |                   |
|                  | Governor  |   | Collector  |                   |
|                  +-----+-----+   +-----+------+                   |
|                        |               |                          |
|                  +-----v-----+   +-----v------+                   |
|                  | Permission|   | Alert      |                   |
|                  | Engine    |   | Engine     |                   |
|                  +-----------+   +------------+                   |
|                                                                   |
|  +-----------+  +-------------+  +------------+  +-------------+ |
|  | Hook      |  | Context     |  | Config     |  | Plugin      | |
|  | Engine    |  | Manager     |  | Hierarchy  |  | Loader      | |
|  +-----------+  +-------------+  +------------+  +-------------+ |
|                                                                   |
|  +------------------------------------------------------------+  |
|  |              Event Bus (Internal Pub/Sub)                   |  |
|  +------------------------------------------------------------+  |
|                                                                   |
|  +------------------------------------------------------------+  |
|  |              State Store (Immutable, Observable)            |  |
|  +------------------------------------------------------------+  |
+------------------------------------------------------------------+
        |              |              |              |
        v              v              v              v
  +-----------+  +----------+  +-----------+  +----------+
  | Wrapped   |  | CLI      |  | Web       |  | External |
  | AI Agent  |  | Dashboard|  | Dashboard |  | Systems  |
  +-----------+  +----------+  +-----------+  +----------+
```

### 3.2 Data Flow Architecture

```
                    INBOUND FLOW
                    ============
User Input
  |
  v
[1] Input Gate
  |-- Validate input (schema, length, content)
  |-- Transform (sanitize, normalize)
  |-- Inject context (role, project, instructions)
  |-- Log (audit trail)
  |-- EMIT event: 'input:received'
  |
  v
[2] Context Manager
  |-- Build system prompt (cached + volatile sections)
  |-- Load CLAUDE.md / memory files
  |-- Inject policies, rules, constraints
  |-- Manage context window budget
  |-- EMIT event: 'context:built'
  |
  v
[3] Agent Loop Controller
  |-- Forward to wrapped AI Agent
  |-- EMIT event: 'turn:start'
  |
  v
                    AGENT INTERNAL
                    ==============
[4] AI Agent processes (LLM call, streaming)
  |-- INTERCEPT streaming tokens
  |-- EMIT event: 'stream:delta' (per token batch)
  |
  v
[5] Agent wants to call tool(s)
  |-- INTERCEPT tool_use blocks
  |-- EMIT event: 'tool:requested'
  |
  v
                    TOOL GOVERNANCE FLOW
                    ====================
[6] Permission Engine
  |-- Match against rules (allow/deny/ask)
  |-- Check role-based policies
  |-- Run classifier (optional)
  |-- EMIT event: 'permission:decided'
  |-- If DENY --> return denied result to agent, GOTO [4]
  |-- If ASK --> pause, wait for approval
  |
  v
[7] Hook Engine (PreToolUse)
  |-- Execute matched hooks
  |-- Hooks can: block, modify input, add context
  |-- EMIT event: 'hook:pre_tool'
  |
  v
[8] Tool Governor
  |-- Execute tool with governance wrapper
  |-- Track: duration, resource usage, output size
  |-- Enforce: timeout, output size limit, sandboxing
  |-- EMIT event: 'tool:executed'
  |
  v
[9] Hook Engine (PostToolUse)
  |-- Execute matched hooks
  |-- Hooks can: modify output, add context, trigger alerts
  |-- EMIT event: 'hook:post_tool'
  |-- Tool result --> back to Agent, GOTO [4]
  |
  v
                    OUTBOUND FLOW
                    =============
[10] Agent produces final response (no more tool_use)
  |-- INTERCEPT full response
  |-- EMIT event: 'response:raw'
  |
  v
[11] Output Pipeline (THE CORE DIFFERENTIATOR)
  |-- Stage 1: INTERCEPT (capture raw output)
  |-- Stage 2: VALIDATE (schema, safety, quality)
  |-- Stage 3: FILTER (remove sensitive data, PII)
  |-- Stage 4: TRANSFORM (format, restructure, enrich)
  |-- Stage 5: REVIEW (human-in-the-loop gate)
  |-- Stage 6: DELIVER (send to user)
  |-- EMIT event: 'response:delivered'
  |
  v
[12] Monitor Collector
  |-- Aggregate metrics (tokens, cost, latency, tools)
  |-- Store trace (full conversation + decisions)
  |-- Check alert conditions
  |-- EMIT event: 'turn:complete'
  |
  v
User receives controlled, validated, monitored output
```

### 3.3 Event Bus

Moi hanh dong trong harness deu phat ra event. External systems co the subscribe:

```typescript
type HarnessEvent = {
  id: string                    // UUID
  timestamp: string             // ISO 8601
  sessionId: string
  agentId: string
  type: EventType               // 'input:received', 'tool:requested', ...
  data: Record<string, unknown> // Event-specific payload
  metadata: {
    userId?: string
    projectId?: string
    environment?: string
    traceId?: string            // OpenTelemetry trace
  }
}

type EventType =
  // Input
  | 'input:received'
  | 'input:transformed'
  | 'input:rejected'
  // Context
  | 'context:built'
  | 'context:compacted'
  | 'context:injected'
  // Turn
  | 'turn:start'
  | 'turn:complete'
  | 'turn:aborted'
  // Stream
  | 'stream:start'
  | 'stream:delta'
  | 'stream:end'
  // Tool
  | 'tool:requested'
  | 'tool:permitted'
  | 'tool:denied'
  | 'tool:started'
  | 'tool:progress'
  | 'tool:completed'
  | 'tool:failed'
  | 'tool:timeout'
  // Permission
  | 'permission:check'
  | 'permission:allowed'
  | 'permission:denied'
  | 'permission:asked'
  | 'permission:user_response'
  // Hook
  | 'hook:triggered'
  | 'hook:completed'
  | 'hook:failed'
  | 'hook:blocked'
  // Output
  | 'output:raw'
  | 'output:validated'
  | 'output:filtered'
  | 'output:transformed'
  | 'output:reviewed'
  | 'output:delivered'
  | 'output:rejected'
  // Session
  | 'session:start'
  | 'session:end'
  | 'session:paused'
  | 'session:resumed'
  | 'session:forked'
  // Agent
  | 'agent:spawned'
  | 'agent:completed'
  | 'agent:failed'
  // Budget
  | 'budget:warning'
  | 'budget:exceeded'
  // Alert
  | 'alert:triggered'
  | 'alert:resolved'
```

---

## 4. Core Module 1: Agent Loop Controller

### 4.1 Chuc nang

Kiem soat vong doi cua agent loop — tu luc bat dau den luc ket thuc.

### 4.2 Operations

| Operation | Mo ta | Use case |
|---|---|---|
| `start(prompt)` | Bat dau agent voi prompt | Khoi dong binh thuong |
| `pause()` | Tam dung agent (giu state) | Can review truoc khi tiep |
| `resume()` | Tiep tuc tu cho tam dung | Sau khi review xong |
| `abort(reason)` | Dung ngay lap tuc | Emergency stop |
| `inject(message)` | Chen message vao conversation | Them instructions giua chung |
| `stepThrough()` | Chay tung turn mot | Debug agent behavior |
| `setMaxTurns(n)` | Gioi han so turn | Budget control |
| `setBudget(usd)` | Gioi han chi phi | Cost control |
| `setTokenBudget(n)` | Gioi han tokens | Token control |
| `setTimeout(ms)` | Gioi han thoi gian toan bo | Time control |
| `switchModel(model)` | Doi model giua chung | Escalate/downgrade |
| `forkSession()` | Tao nhanh phu tu state hien tai | A/B testing |
| `rewind(turnIndex)` | Quay lai turn cu | Undo/retry |

### 4.3 Agent Loop State Machine

```
                   start()
                     |
                     v
+--------+     +---------+     pause()      +--------+
| IDLE   |---->| RUNNING |----------------->| PAUSED |
+--------+     +----+----+                  +---+----+
                    |    ^                      |
                    |    |      resume()         |
                    |    +----------------------+
                    |
          +---------+---------+
          |                   |
     abort()          no tool_use (terminal)
          |                   |
          v                   v
     +---------+        +-----------+
     | ABORTED |        | COMPLETED |
     +---------+        +-----------+

Transitions emit events:
  IDLE -> RUNNING:    'session:start'
  RUNNING -> PAUSED:  'session:paused'
  PAUSED -> RUNNING:  'session:resumed'
  RUNNING -> ABORTED: 'session:aborted'
  RUNNING -> COMPLETED: 'session:completed'
```

### 4.4 Inject Message Pattern

```typescript
// Inject system instruction giua conversation
controller.inject({
  role: 'system',
  content: 'IMPORTANT: From now on, always run tests before modifying files.',
  position: 'next_turn',   // 'next_turn' | 'immediate' | 'after_current_tool'
})

// Inject user message (gia lap user noi them)
controller.inject({
  role: 'user',
  content: 'Actually, please also update the documentation.',
  position: 'next_turn',
})

// Inject tool result (gia lap tool output)
controller.inject({
  role: 'tool_result',
  tool_use_id: 'current_tool_id',
  content: 'OVERRIDE: File was blocked by policy. Use alternative approach.',
  position: 'immediate',
})
```

### 4.5 Step-Through Mode (Debug)

```
[Turn 1] User: "Fix the login bug"
  |
  [PAUSE] --> Developer reviews system prompt, context
  |           Developer: stepThrough()
  v
[Turn 2] Agent: calls Bash("grep -r 'login' src/")
  |
  [PAUSE] --> Developer reviews tool call
  |           Developer: approve() or modify() or skip()
  v
[Turn 3] Tool result: [list of files]
  |
  [PAUSE] --> Developer reviews what agent will do next
  |           Developer: stepThrough()
  v
[Turn 4] Agent: calls FileEdit("src/auth.ts", ...)
  ...
```

---

## 5. Core Module 2: Output Control Pipeline

> **Day la tinh nang CORE DIFFERENTIATOR — kiem soat du lieu dau ra cua AI Agent.**

### 5.1 Hai che do van hanh: Streaming Mode vs Batch Mode

Pipeline co **2 execution modes** khac nhau, tuy thuoc vao yeu cau governance:

```
                            Output tu Agent
                                 |
                                 v
                      +--------------------+
                      | Mode Selection     |
                      | (config.output     |
                      |  .gateMode)        |
                      +--------+-----------+
                               |
                  +------------+------------+
                  |                         |
                  v                         v
          STREAMING MODE              BATCH MODE
      (mac dinh, low latency)     (full governance)
```

**Khi nao dung mode nao?**

| Tieu chi | Streaming Mode | Batch Mode |
|---|---|---|
| Latency | Thap (~1-5ms/buffer) | Cao (doi het output) |
| Filter (regex, secret) | Co | Co |
| Validate (safety, schema, quality) | **Chi post-stream** | Co (full 6 stages) |
| Transform (summarize, translate) | **Chi post-stream** | Co |
| Review (human gate) | **Khong** (bat buoc chuyen Batch) | Co |
| Use case mac dinh | Interactive CLI, IDE | CI/CD, compliance, review |

**Quy tac tu dong chuyen mode:**
- Neu `review.enabled: true` --> tu dong chuyen sang Batch
- Neu `validation.rules` co type `safety` hoac `schema` voi `action: reject` --> tu dong chuyen sang Batch
- User co the ep mode bang `gateMode: 'streaming' | 'batch' | 'auto'`

### 5.2 Streaming Mode — Chi tiet

```
LLM Streaming tokens
  |
  v (moi N tokens hoac moi regex boundary)
+--[S1: INTERCEPT]---------------------------------------------+
|  Buffer accumulator (configurable: 20-100 tokens, default 50) |
|  - Accumulate tokens cho den khi du buffer hoac gap boundary  |
|  - Metadata tracking (running token count, cost estimate)     |
|  - EMIT event: 'stream:delta'                                |
+---------------------------------------------------------------+
  |
  v
+--[S2: STREAM FILTER]-----------------------------------------+
|  Chi chay STATELESS filters (khong can toan bo output):       |
|  - Regex-based secret redaction (sk-..., AKIA..., ghp_...)   |
|  - Regex-based PII redaction (email, phone, SSN)             |
|  - Path redaction (/home/user/...)                            |
|  - Denylist word replacement                                  |
|  NOTE: Moi filter nhan buffer + sliding context window        |
|        (100 chars truoc + 100 chars sau) de tranh cat token   |
|  - EMIT event: 'stream:filtered'                             |
+---------------------------------------------------------------+
  |
  v
+--[S3: STREAM DELIVER]-----------------------------------------+
|  Forward buffer da filter toi user (real-time)                |
|  - Terminal: stdout.write()                                   |
|  - IDE: bridge message                                        |
|  - EMIT event: 'stream:delivered'                            |
+---------------------------------------------------------------+
  |
  v (khi stream ket thuc)
+--[S4: POST-STREAM PIPELINE]-----------------------------------+
|  Chay tren TOAN BO accumulated output (khong blocking user):  |
|  - Validate (safety, schema, quality) --> flag/warn (da giao) |
|  - Full Transform (template injection, code formatting)       |
|  - Audit log (ghi toan bo output + filter decisions)          |
|  - EMIT event: 'output:post_validated'                       |
|                                                               |
|  Neu Validate FAIL:                                           |
|    - KHONG rollback (user da thay output)                     |
|    - EMIT event: 'output:post_validation_failed'             |
|    - Inject system message: "WARNING: Output failed safety    |
|      check. Review before using."                             |
|    - Tuy config: log alert, notify Slack, flag in dashboard   |
+---------------------------------------------------------------+

Streaming Mode Data Flow (chi tiet buffer):

  tokens: [t1][t2][t3]...[t50] --> buffer full
                                      |
                                      v
                              [sliding context window]
                              prev_100_chars + buffer + lookahead
                                      |
                                      v
                              [regex filters chay tren window]
                                      |
                                      v
                              [chi emit buffer portion, giu context]
                                      |
                                      v
                              [user thay filtered buffer]

  Ranh gioi token: Khi regex match nam tren ranh gioi 2 buffer,
  sliding context window dam bao van bat duoc.
  Vi du: "sk-abc" bi cat thanh buffer1="...sk-" va buffer2="abc..."
         --> context window cua buffer2 chua "sk-" --> regex match.
```

### 5.3 Batch Mode — Full 6-Stage Pipeline

```
Agent Raw Output (doi het moi xu ly)
  |
  v
+--[Stage 1: INTERCEPT]----------------------------------------+
|  Capture toan bo raw output                                   |
|  - Full text capture                                          |
|  - Metadata extraction (model, tokens, cost, stop_reason)     |
|  - EMIT event: 'output:raw'                                  |
+---------------------------------------------------------------+
  |
  v
+--[Stage 2: VALIDATE]-----------------------------------------+
|  Kiem tra output co hop le khong                              |
|  - Schema validation (neu structured output)                  |
|  - Safety check (toxic, harmful, off-topic)                   |
|  - Quality check (hallucination detection, confidence score)  |
|  - Compliance check (enterprise rules, legal requirements)    |
|  - Code quality check (lint, type-check snippets)             |
|  - If FAIL --> reject, retry, or flag                         |
|  - EMIT event: 'output:validated' hoac 'output:rejected'     |
+---------------------------------------------------------------+
  |
  v
+--[Stage 3: FILTER]-------------------------------------------+
|  Loc bo noi dung khong mong muon                             |
|  - PII redaction (ten, email, SDT, CMND...)                  |
|  - Secret redaction (API keys, tokens, passwords)             |
|  - Internal path redaction (/home/user/.ssh/...)              |
|  - Profanity filter                                           |
|  - Regex-based custom filters                                 |
|  - Allowlist/denylist patterns                                |
|  - EMIT event: 'output:filtered'                              |
+---------------------------------------------------------------+
  |
  v
+--[Stage 4: TRANSFORM]----------------------------------------+
|  Bien doi output theo yeu cau                                 |
|  - Format conversion (markdown -> plain, JSON -> table)       |
|  - Language translation                                       |
|  - Tone adjustment (formal, casual, technical)                |
|  - Length control (summarize if too long, expand if too short) |
|  - Template injection (header, footer, disclaimer)            |
|  - Code formatting (prettier, black, gofmt)                   |
|  - Custom transform functions                                 |
|  - EMIT event: 'output:transformed'                           |
+---------------------------------------------------------------+
  |
  v
+--[Stage 5: REVIEW (optional)]--------------------------------+
|  Human-in-the-loop gate                                       |
|  - Show output to reviewer truoc khi deliver                  |
|  - Reviewer can: approve, reject, edit, comment               |
|  - Auto-approve rules (skip review cho low-risk output)       |
|  - Timeout with default action (approve/reject)               |
|  - Multi-reviewer voting (2/3 approve = pass)                 |
|  - EMIT event: 'output:reviewed'                              |
+---------------------------------------------------------------+
  |
  v
+--[Stage 6: DELIVER]------------------------------------------+
|  Giao output cho user (1 lan, toan bo)                        |
|  - Batch delivery                                             |
|  - Channel routing (terminal, IDE, Slack, webhook)            |
|  - Delivery confirmation                                      |
|  - EMIT event: 'output:delivered'                             |
+---------------------------------------------------------------+
```

### 5.4 Stage Compatibility Matrix

```
Stage           | Streaming Mode    | Batch Mode | Notes
----------------|-------------------|------------|-------------------------------
INTERCEPT       | Buffer (per-chunk)| Full text  | Buffer size configurable
VALIDATE:schema | Post-stream only  | Full       | Can toan bo output
VALIDATE:safety | Post-stream only  | Full       | Can toan bo output
VALIDATE:length | Post-stream only  | Full       | Can toan bo output
VALIDATE:custom | Post-stream only  | Full       | Tuy loai validator
FILTER:regex    | Per-buffer + ctx  | Full       | Sliding context window
FILTER:pii      | Per-buffer + ctx  | Full       | Regex-based, stateless
FILTER:secret   | Per-buffer + ctx  | Full       | Regex-based, stateless
FILTER:denylist | Per-buffer        | Full       | Word match, stateless
TRANSFORM:templ | Post-stream only  | Full       | Header/footer can full text
TRANSFORM:format| Post-stream only  | Full       | Prettier can full file
TRANSFORM:summ  | KHONG             | Full       | LLM call, chi Batch
TRANSFORM:transl| KHONG             | Full       | LLM call, chi Batch
REVIEW          | KHONG (force Batch)| Full      | Human gate, incompatible
DELIVER         | Per-buffer        | Full       | stdout.write vs batch send
```

### 5.5 Post-Stream Validation Failure — Handling Strategy

Khi output da duoc stream cho user nhung post-stream validation FAIL:

```
Strategy         | Config key                  | Hanh vi
-----------------|-----------------------------|-------------------------------------------
WARN (default)   | postStreamFailure: 'warn'   | Inject warning message sau output
FLAG             | postStreamFailure: 'flag'   | Log to dashboard, khong notify user
ALERT            | postStreamFailure: 'alert'  | Notify Slack/PagerDuty
INJECT_RETRACT   | postStreamFailure: 'retract'| Append "[OUTPUT RETRACTED - safety check
                 |                             |  failed]" va inject retry prompt cho agent
```

Day la trade-off co y thuc: **Streaming Mode uu tien latency, chap nhan risk**
that post-stream validation co the fail sau khi user da thay output.
Neu can **dam bao 100% output safety**, dung **Batch Mode**.

### 5.6 Output Control Configuration

```yaml
# agentweave.output.yaml

output_pipeline:
  # Mode selection: streaming | batch | auto (default: auto)
  # auto = streaming, tu dong chuyen batch khi review.enabled hoac
  #        validation co safety/schema rules voi action: reject
  gateMode: "auto"

  # Streaming-specific config
  streaming:
    bufferSize: 50               # Tokens per buffer (20-100, default 50)
    contextWindow: 100           # Chars sliding context cho filter (default 100)
    postStreamFailure: "warn"    # warn | flag | alert | retract

  # Stage 2: Validation (Batch mode: full; Streaming: post-stream only)
  validation:
    enabled: true
    rules:
      - name: "no_harmful_code"
        type: "safety"
        action: "reject"          # reject | retry | flag | warn
        retry_prompt: "Your previous response contained potentially harmful code. Please provide a safe alternative."
        max_retries: 2
        # NOTE: action 'reject' voi type 'safety' --> auto forces Batch mode
        #       neu muon giu Streaming, dung action 'flag' hoac 'warn'

      - name: "structured_output"
        type: "schema"
        schema: "$ref:./schemas/response.json"
        action: "retry"

      - name: "code_quality"
        type: "custom"
        validator: "./validators/lint-check.ts"
        action: "flag"            # flag = post-stream compatible

      - name: "max_length"
        type: "length"
        max_chars: 50000
        action: "transform"

  # Stage 3: Filtering (Streaming: per-buffer; Batch: full)
  filtering:
    enabled: true
    filters:
      - name: "pii_redaction"
        type: "pii"
        entities: ["email", "phone", "ssn", "credit_card"]
        replacement: "[REDACTED]"
        streamable: true          # Regex-based, streaming compatible

      - name: "secret_redaction"
        type: "secret"
        patterns:
          - "sk-[a-zA-Z0-9]{48}"
          - "AKIA[A-Z0-9]{16}"
          - "ghp_[a-zA-Z0-9]{36}"
        replacement: "[SECRET_REDACTED]"
        streamable: true

      - name: "path_redaction"
        type: "regex"
        pattern: "/home/[^/]+/"
        replacement: "/home/[USER]/"
        streamable: true

      - name: "custom_denylist"
        type: "denylist"
        words: ["internal-only", "confidential"]
        action: "redact"
        streamable: true

  # Stage 4: Transform (Streaming: post-stream; Batch: full)
  transform:
    enabled: true
    transforms:
      - name: "add_disclaimer"
        type: "template"
        position: "footer"
        content: "\n---\n_Generated by AI Agent. Review before using in production._"
        streamable: false         # Can full output (footer)

      - name: "format_code"
        type: "code_format"
        languages:
          typescript: "prettier"
          python: "black"
          go: "gofmt"
        streamable: false         # Can full file

      - name: "limit_length"
        type: "summarize"
        trigger: "length > 10000"
        model: "claude-haiku-4-5"
        target_length: 5000
        streamable: false         # LLM call, chi Batch mode

  # Stage 5: Review (chi Batch mode; bat review = force Batch)
  review:
    enabled: false
    auto_approve:
      - "output.risk_score < 0.3"
      - "output.tool_count == 0"
    timeout_seconds: 300
    timeout_action: "reject"
    channels: ["terminal", "slack:#code-review"]

  # Stage 6: Delivery
  delivery:
    channels:
      - type: "terminal"
        enabled: true
      - type: "webhook"
        url: "https://api.example.com/agent-output"
        enabled: false
      - type: "file"
        path: "./agent-outputs/{session_id}.md"
        enabled: true
```

### 5.7 Output Interceptor API

```typescript
// === BATCH MODE INTERCEPTORS (chay tren toan bo output) ===

harness.output.intercept('raw', async (output, context) => {
  console.log(`Raw output: ${output.text.length} chars`)
  return output
})

harness.output.intercept('validate', async (output, context) => {
  if (output.text.includes('DROP TABLE')) {
    return {
      action: 'reject',
      reason: 'SQL injection detected in output',
      retry: true,
      retryPrompt: 'Do not include raw SQL in your response.',
    }
  }
  return { action: 'pass' }
})

harness.output.intercept('filter', async (output, context) => {
  return {
    ...output,
    text: output.text.replace(/\b\d{3}-\d{2}-\d{4}\b/g, '[SSN_REDACTED]'),
  }
})

harness.output.intercept('transform', async (output, context) => {
  return {
    ...output,
    text: `## Agent Response\n\n${output.text}\n\n---\nTokens: ${context.usage.output_tokens}`,
  }
})

harness.output.intercept('review', async (output, context) => {
  const riskScore = await assessRisk(output.text)
  if (riskScore > 0.8) {
    return { action: 'hold', reason: 'High risk score, needs human review' }
  }
  return { action: 'approve' }
})

harness.output.intercept('deliver', async (output, context) => {
  await sendToSlack(output.text, '#agent-activity')
  return output
})


// === STREAMING MODE INTERCEPTORS (chay tren tung buffer) ===

// Stream filter: nhan buffer + sliding context, tra ve filtered buffer
harness.output.interceptStream({
  bufferSize: 50,

  // Chay tren moi buffer — chi stateless operations
  onBuffer: async (buffer, context) => {
    if (containsSensitivePattern(buffer.textWithContext)) {
      return {
        action: 'redact',
        replacement: '[REDACTED]',
        // Chi thay the phan match trong buffer, khong thay context
      }
    }
    return { action: 'pass' }
  },

  onStart: async (context) => {
    startStreamMonitor(context.sessionId)
  },

  // Post-stream: chay validation tren toan bo output DA STREAM
  // Luc nay user da thay output — chi co the warn/flag/alert
  onEnd: async (fullOutput, context) => {
    const validation = await validateFullOutput(fullOutput)
    if (!validation.passed) {
      // Khong the rollback — chi flag
      return {
        action: 'flag',
        reason: validation.reason,
        // Tuy config (postStreamFailure): warn user, alert slack, etc.
      }
    }
  },
})
```

### 5.8 Output Schema Enforcement

Ep buoc output theo schema cu the.
**Luu y:** Schema enforcement **bat buoc Batch mode** (can toan bo output de validate).

```typescript
const responseSchema = z.object({
  summary: z.string().max(500),
  changes: z.array(z.object({
    file: z.string(),
    description: z.string(),
    risk: z.enum(['low', 'medium', 'high']),
  })),
  testResults: z.object({
    passed: z.number(),
    failed: z.number(),
    skipped: z.number(),
  }).optional(),
  nextSteps: z.array(z.string()).max(5),
})

harness.output.enforceSchema(responseSchema, {
  onViolation: 'retry',  // retry | reject | coerce
  maxRetries: 3,
  coercionPrompt: 'Please format your response as JSON matching this schema: {schema}',
  // NOTE: enforceSchema() tu dong set gateMode = 'batch'
})
```

---

## 6. Core Module 3: Tool Governance

### 6.1 Tool Lifecycle Control

```
Tool Registration --> Tool Discovery --> Tool Request --> Permission --> Execution --> Result
      |                    |                |               |              |           |
  [register]          [discover]      [intercept]      [decide]      [sandbox]    [validate]
  [unregister]        [hide]          [modify]         [allow]       [timeout]    [transform]
  [override]          [alias]         [block]          [deny]        [resource]   [redact]
                                      [queue]          [ask]         [monitor]    [cache]
```

### 6.2 Tool Wrapper

Moi tool duoc boc trong governance wrapper:

```typescript
type GovernedTool<Input, Output> = {
  // Original tool
  tool: Tool<Input, Output>

  // Governance overrides
  governance: {
    // Enabled/disabled
    enabled: boolean

    // Timeout (override tool default)
    timeout?: number

    // Rate limiting
    rateLimit?: {
      maxCalls: number
      windowMs: number
      perSession?: boolean
    }

    // Resource limits
    resourceLimits?: {
      maxOutputSize?: number      // Bytes
      maxDuration?: number        // Ms
      maxMemory?: number          // Bytes
      maxCpuPercent?: number
    }

    // Sandboxing
    sandbox?: {
      enabled: boolean
      network: boolean            // Cho phep network?
      filesystem: 'read' | 'write' | 'none'
      allowedPaths?: string[]
      deniedPaths?: string[]
    }

    // Input transform (modify truoc khi tool nhan)
    inputTransform?: (input: Input) => Input | Promise<Input>

    // Output transform (modify truoc khi tra ve agent)
    outputTransform?: (output: Output) => Output | Promise<Output>

    // Caching
    cache?: {
      enabled: boolean
      ttlMs: number
      keyFn: (input: Input) => string
    }

    // Audit
    audit: {
      logInput: boolean
      logOutput: boolean
      logDuration: boolean
      redactPatterns?: RegExp[]   // Redact truoc khi log
    }
  }
}
```

### 6.3 Tool Governance Config

```yaml
# agentweave.tools.yaml

tools:
  Bash:
    enabled: true
    timeout: 30000
    rateLimit:
      maxCalls: 50
      windowMs: 60000
    sandbox:
      enabled: true
      network: false
      filesystem: "write"
      allowedPaths:
        - "${PROJECT_ROOT}/**"
      deniedPaths:
        - "**/.env"
        - "**/.ssh/**"
        - "**/node_modules/**"
    audit:
      logInput: true
      logOutput: true
      redactPatterns:
        - "(?i)(password|secret|token)\\s*=\\s*\\S+"

  FileWrite:
    enabled: true
    rateLimit:
      maxCalls: 100
      windowMs: 60000
    governance:
      # Khong cho ghi file ngoai project
      inputTransform: |
        if (!input.path.startsWith(PROJECT_ROOT)) {
          throw new Error('Cannot write files outside project root')
        }
        return input

  WebSearch:
    enabled: true
    rateLimit:
      maxCalls: 10
      windowMs: 60000
    cache:
      enabled: true
      ttlMs: 300000           # Cache 5 phut

  AgentTool:
    enabled: true
    rateLimit:
      maxCalls: 5             # Toi da 5 sub-agents
      windowMs: 300000
    resourceLimits:
      maxDuration: 120000     # Moi sub-agent toi da 2 phut
```

---

## 7. Core Module 4: Permission Engine

### 7.1 Permission Architecture (Mo rong tu Claude Code)

```
Tool Request
  |
  v
[Layer 1: Policy Rules]     -- Enterprise, immutable, highest priority
  |  DENY "Bash(rm -rf *)"
  |  DENY "FileWrite(.env)"
  |
  v
[Layer 2: Project Rules]    -- Team/project level
  |  ALLOW "Bash(npm *)"
  |  ASK "FileWrite(src/security/*)"
  |
  v
[Layer 3: User Rules]       -- Personal preferences
  |  ALLOW "Bash(git *)"
  |  ALLOW "FileRead(*)"
  |
  v
[Layer 4: Role-Based]       -- Theo vai tro nguoi dung
  |  developer: ALLOW "FileEdit(*)"
  |  reviewer: DENY "FileEdit(*)", ALLOW "FileRead(*)"
  |  admin: ALLOW "*"
  |
  v
[Layer 5: Contextual]       -- Dua tren ngu canh
  |  IF branch == "main": DENY "FileWrite(*)"
  |  IF time.hour > 22: ASK "Bash(*)"    -- Ngoai gio lam viec
  |  IF cost > $5: ASK "*"               -- Budget warning
  |
  v
[Layer 6: ML Classifier]    -- Tu dong phan loai (optional)
  |  Risk score > 0.8: DENY
  |  Risk score > 0.5: ASK
  |  Risk score < 0.5: ALLOW
  |
  v
Permission Decision: ALLOW | DENY | ASK
```

### 7.2 Permission Rule DSL

```yaml
# agentweave.permissions.yaml

permissions:
  # Layer 1: Policy (highest priority, immutable)
  policy:
    deny:
      - "Bash(sudo *)"
      - "Bash(rm -rf *)"
      - "Bash(chmod 777 *)"
      - "FileWrite(**/.env*)"
      - "FileWrite(**/.ssh/**)"
      - "WebFetch(*.internal.company.com/*)"

  # Layer 2: Project
  project:
    allow:
      - "Bash(npm *)"
      - "Bash(bun *)"
      - "Bash(git *)"
      - "FileRead(**)"
      - "FileEdit(src/**/*.ts)"
      - "FileEdit(src/**/*.tsx)"
    deny:
      - "FileWrite(dist/**)"           # Khong ghi vao build output
      - "FileEdit(package-lock.json)"   # Khong sua lockfile truc tiep
    ask:
      - "FileWrite(src/security/**)"
      - "Bash(docker *)"

  # Layer 3: User (personal overrides)
  user:
    allow:
      - "Bash(git push)"      # User tin tuong git push

  # Layer 4: Role-based
  roles:
    developer:
      allow: ["FileEdit(**)", "Bash(**)", "AgentTool(**)"]
    reviewer:
      allow: ["FileRead(**)", "Grep(**)", "Glob(**)"]
      deny: ["FileEdit(**)", "FileWrite(**)", "Bash(git push *)"]
    readonly:
      allow: ["FileRead(**)", "Grep(**)", "Glob(**)"]
      deny: ["*"]  # Deny everything else

  # Layer 5: Contextual
  contextual:
    - condition: "git.branch == 'main' || git.branch == 'master'"
      deny: ["FileEdit(**)", "FileWrite(**)", "Bash(git push *)"]
      message: "Direct changes to main branch are not allowed."

    - condition: "session.cost_usd > 10"
      ask: ["*"]
      message: "Session cost exceeded $10. Approve to continue?"

    - condition: "tool.consecutive_errors > 3"
      ask: ["${tool.name}(*)"]
      message: "Tool has failed 3 times in a row. Continue?"

  # Layer 6: Classifier
  classifier:
    enabled: true
    model: "custom-safety-classifier"
    thresholds:
      auto_allow: 0.2
      auto_deny: 0.9
      ask_range: [0.2, 0.9]
```

### 7.3 Permission Decision API

```typescript
interface PermissionEngine {
  // Evaluate permission cho 1 tool call
  evaluate(request: PermissionRequest): Promise<PermissionDecision>

  // Dang ky custom rule layer
  addRuleLayer(name: string, priority: number, rules: PermissionRule[]): void

  // Dang ky contextual evaluator
  addContextualRule(condition: string, rules: PermissionRule[]): void

  // Dang ky classifier
  setClassifier(classifier: PermissionClassifier): void

  // Query: tool nay co duoc phep khong? (dry-run, khong execute)
  canUse(toolName: string, input: unknown): Promise<PermissionDecision>

  // Subscribe permission events
  on(event: 'allowed' | 'denied' | 'asked' | 'user_response', handler): void
}

type PermissionRequest = {
  toolName: string
  toolInput: Record<string, unknown>
  context: {
    sessionId: string
    userId: string
    role: string
    branch?: string
    cost?: number
    turnCount?: number
    consecutiveErrors?: number
  }
}

type PermissionDecision = {
  behavior: 'allow' | 'deny' | 'ask'
  reason: string                       // Ly do quyet dinh
  source: string                       // Rule nao quyet dinh (policy, project, classifier...)
  modifiedInput?: Record<string, unknown>  // Input da bi modify
  suggestions?: PermissionUpdate[]     // Goi y update rules
  riskScore?: number                   // Tu classifier
}
```

---

## 8. Core Module 5: Hook Engine

### 8.1 Hook Events (Mo rong tu Claude Code)

```
AGENT LIFECYCLE
  SessionStart          -- Khi session bat dau
  SessionEnd            -- Khi session ket thuc
  TurnStart             -- Truoc moi turn cua agent loop
  TurnEnd               -- Sau moi turn

INPUT
  InputReceived         -- Khi nhan input tu user
  InputTransformed      -- Sau khi input duoc transform
  InputRejected         -- Khi input bi reject

TOOL
  PreToolUse            -- Truoc khi tool chay
  PostToolUse           -- Sau khi tool chay thanh cong
  PostToolUseFailure    -- Sau khi tool loi
  ToolTimeout           -- Khi tool bi timeout

PERMISSION
  PermissionRequest     -- Khi hoi permission
  PermissionGranted     -- Khi duoc cap phep
  PermissionDenied      -- Khi bi tu choi

OUTPUT
  OutputRaw             -- Khi nhan raw output
  OutputValidated       -- Sau validation
  OutputFiltered        -- Sau filtering
  OutputTransformed     -- Sau transform
  OutputReviewed        -- Sau review
  OutputDelivered       -- Sau khi giao cho user
  OutputRejected        -- Khi output bi reject

CONTEXT
  ContextBuilt          -- Sau khi build system prompt
  ContextCompacted      -- Sau khi nen context
  ContextInjected       -- Khi inject context moi

AGENT (Multi-Agent)
  AgentSpawned          -- Sub-agent duoc tao
  AgentCompleted        -- Sub-agent xong
  AgentFailed           -- Sub-agent loi

BUDGET
  BudgetWarning         -- Gan het budget
  BudgetExceeded        -- Het budget

CUSTOM
  Custom:*              -- Custom events tu plugins
```

### 8.2 Hook Types (5 types)

> **Canonical list:** command, prompt, agent, http, function.
> Moi tai lieu trong project deu phai tham chieu danh sach nay.
> Pipeline (chain nhieu hooks) khong phai hook type rieng — dung array of hooks trong config.

```typescript
// Type 1: Command (shell script)
type CommandHook = {
  type: 'command'
  command: string
  shell?: 'bash' | 'powershell' | 'zsh'
  timeout?: number
  env?: Record<string, string>
  cwd?: string
  async?: boolean
}

// Type 2: Prompt (LLM evaluation — lightweight, fast)
type PromptHook = {
  type: 'prompt'
  prompt: string           // $INPUT, $OUTPUT, $TOOL_NAME, $TOOL_INPUT...
  model?: string           // Default: haiku (fast, cheap)
  temperature?: number
  timeout?: number
}

// Type 3: Agent (spawn full agent de verify — heavyweight)
type AgentHook = {
  type: 'agent'
  prompt: string
  model?: string           // Default: haiku
  tools?: string[]         // Tools agent duoc dung
  maxTurns?: number
  timeout?: number
}

// Type 4: HTTP (webhook/external API)
type HttpHook = {
  type: 'http'
  url: string
  method?: 'GET' | 'POST' | 'PUT'
  headers?: Record<string, string>
  body?: string            // Template voi $VARIABLES
  allowedEnvVars?: string[]
  timeout?: number
}

// Type 5: Function (inline JS/TS — zero-overhead, in-process)
type FunctionHook = {
  type: 'function'
  handler: string          // Path den file handler (export default function)
  // hoac
  inline: string           // Inline function code
  timeout?: number
}

// Luu y: KHONG co type 'pipeline'. De chain nhieu hooks,
// dung array trong config:
//   hooks: [hook1, hook2, hook3]  // chay tuan tu
// Moi hook nhan output cua hook truoc lam input.
```

### 8.3 Hook Config

```yaml
# agentweave.hooks.yaml

hooks:
  PreToolUse:
    - matcher: "Bash"
      hooks:
        - type: "function"
          inline: |
            if (input.command.includes('sudo')) {
              return { decision: 'deny', reason: 'sudo is not allowed' }
            }
            return { decision: 'passthrough' }

        - type: "command"
          command: "echo '$TOOL_INPUT' | jq -r '.command' | shellcheck -"
          if: "Bash(*.sh)"
          timeout: 5

    - matcher: "FileWrite"
      hooks:
        # Chain nhieu hooks = array (chay tuan tu, dung neu 1 hook block)
        - type: "function"
          inline: |
            // Check file khong nam ngoai project
            if (!input.path.startsWith(process.env.PROJECT_ROOT)) {
              return { decision: 'deny', reason: 'Outside project root' }
            }
            return { decision: 'passthrough' }
        - type: "command"
          command: "test -f '$FILE_PATH' && diff <(cat '$FILE_PATH') <(echo '$NEW_CONTENT')"
          async: true

  PostToolUse:
    - matcher: "FileWrite"
      hooks:
        - type: "command"
          command: "npx eslint --fix '$FILE_PATH'"
          if: "FileWrite(*.ts)"
          async: true

    - matcher: "Bash"
      hooks:
        - type: "function"
          inline: |
            if (output.exitCode !== 0) {
              emit('alert:tool_failure', { tool: 'Bash', command: input.command })
            }

  OutputRaw:
    - hooks:
        - type: "prompt"
          prompt: |
            Rate the quality of this AI response on a scale of 1-10.
            If below 5, explain why.
            Response: $OUTPUT
          model: "claude-haiku-4-5"

  BudgetWarning:
    - hooks:
        - type: "http"
          url: "https://slack.webhook.com/budget-alert"
          method: "POST"
          body: '{"text": "Agent budget warning: $COST_USD spent of $BUDGET_USD"}'

  SessionEnd:
    - hooks:
        # Chain: test -> lint -> report (chay tuan tu)
        - type: "command"
          command: "npm test"
          timeout: 60
        - type: "command"
          command: "npm run lint"
          timeout: 30
        - type: "http"
          url: "https://api.example.com/session-report"
          body: '{"session_id": "$SESSION_ID", "cost": $COST_USD, "turns": $TURN_COUNT}'
```

---

## 9. Core Module 6: Monitoring & Observability

### 9.1 Metrics Categories

```
REAL-TIME METRICS (per-second granularity)
├── Token Usage
│   ├── input_tokens (total, per-turn, per-tool)
│   ├── output_tokens (total, per-turn)
│   ├── cache_read_tokens
│   ├── cache_creation_tokens
│   └── thinking_tokens
│
├── Cost
│   ├── total_cost_usd
│   ├── cost_per_turn
│   ├── cost_per_tool_call
│   ├── cost_by_model
│   └── projected_session_cost
│
├── Latency
│   ├── time_to_first_token (TTFT)
│   ├── tokens_per_second (throughput)
│   ├── turn_duration
│   ├── tool_execution_duration
│   ├── permission_wait_duration
│   └── total_session_duration
│
├── Tool Usage
│   ├── tool_calls_count (by tool name)
│   ├── tool_success_rate
│   ├── tool_error_rate
│   ├── tool_timeout_rate
│   ├── concurrent_tool_calls
│   └── tool_result_size_bytes
│
├── Agent Loop
│   ├── turn_count
│   ├── turns_with_tools
│   ├── turns_without_tools
│   ├── recovery_count (by type)
│   ├── context_window_usage_pct
│   └── compaction_count
│
└── Errors
    ├── api_errors (by status code)
    ├── tool_errors (by tool name)
    ├── permission_denials
    ├── output_rejections
    ├── retry_count
    └── fallback_triggers

AGGREGATED METRICS (per-session, per-day, per-project)
├── Sessions
│   ├── total_sessions
│   ├── avg_session_duration
│   ├── avg_turns_per_session
│   ├── avg_cost_per_session
│   └── session_completion_rate
│
├── Tools
│   ├── most_used_tools
│   ├── most_failed_tools
│   ├── avg_tool_latency (by tool)
│   └── tool_usage_trends
│
├── Output Quality
│   ├── validation_pass_rate
│   ├── filter_trigger_rate
│   ├── review_approval_rate
│   └── retry_rate
│
└── Budget
    ├── daily_spend
    ├── weekly_spend
    ├── spend_by_project
    ├── spend_by_user
    └── budget_utilization_pct
```

### 9.2 Trace System

Moi session tao ra **full trace** co the replay:

```typescript
type SessionTrace = {
  sessionId: string
  startTime: string
  endTime: string
  userId: string
  projectId: string
  model: string

  turns: TurnTrace[]
  metrics: SessionMetrics
  events: HarnessEvent[]
}

type TurnTrace = {
  turnIndex: number
  startTime: string
  endTime: string
  duration: number

  // Input
  input: {
    messages: Message[]
    systemPrompt: string          // Hash hoac full (configurable)
    contextWindowTokens: number
  }

  // LLM call
  llmCall: {
    model: string
    requestTokens: number
    responseTokens: number
    thinkingTokens: number
    cost: number
    ttft: number
    duration: number
    stopReason: string
    cacheHit: boolean
  }

  // Tool calls
  toolCalls: ToolCallTrace[]

  // Output
  output: {
    raw: string
    validated: boolean
    filtered: boolean
    transformed: boolean
    reviewed: boolean
    delivered: boolean
    finalText: string
  }

  // Decisions
  decisions: {
    permissionDecisions: PermissionDecision[]
    hookResults: HookResult[]
    recoveryActions: RecoveryAction[]
  }
}

type ToolCallTrace = {
  toolName: string
  toolInput: Record<string, unknown>   // Co the redact
  toolOutput: unknown                   // Co the redact
  duration: number
  permission: PermissionDecision
  preHooks: HookResult[]
  postHooks: HookResult[]
  error?: string
  cached: boolean
}
```

### 9.3 Alert System

```yaml
# agentweave.alerts.yaml

alerts:
  - name: "budget_warning"
    condition: "session.cost_usd > session.budget_usd * 0.8"
    severity: "warning"
    channels: ["terminal", "slack"]
    cooldown: 300                    # Khong alert lai trong 5 phut

  - name: "budget_exceeded"
    condition: "session.cost_usd > session.budget_usd"
    severity: "critical"
    action: "pause"                  # Tu dong pause agent
    channels: ["terminal", "slack", "pagerduty"]

  - name: "high_error_rate"
    condition: "session.tool_error_rate > 0.5 && session.tool_calls > 5"
    severity: "warning"
    action: "inject"
    injectMessage: "You are experiencing a high error rate. Please review your approach."

  - name: "context_window_full"
    condition: "session.context_usage_pct > 0.9"
    severity: "info"
    channels: ["terminal"]

  - name: "long_running_tool"
    condition: "tool.duration > 60000"
    severity: "warning"
    channels: ["terminal"]

  - name: "anomaly_detected"
    condition: "session.cost_per_turn > session.avg_cost_per_turn * 5"
    severity: "warning"
    channels: ["terminal", "slack"]

  - name: "output_rejected"
    condition: "output.validation == 'rejected'"
    severity: "warning"
    channels: ["terminal"]
    action: "log"
```

### 9.4 Dashboard Data Endpoints

```typescript
interface MonitorAPI {
  // Real-time session data
  getSessionStatus(sessionId: string): SessionStatus
  getSessionMetrics(sessionId: string): SessionMetrics
  getSessionTrace(sessionId: string): SessionTrace
  streamSessionEvents(sessionId: string): AsyncGenerator<HarnessEvent>

  // Aggregated data
  getProjectMetrics(projectId: string, timeRange: TimeRange): ProjectMetrics
  getUserMetrics(userId: string, timeRange: TimeRange): UserMetrics
  getToolMetrics(timeRange: TimeRange): ToolMetrics

  // Alerts
  getActiveAlerts(): Alert[]
  getAlertHistory(timeRange: TimeRange): Alert[]
  acknowledgeAlert(alertId: string): void

  // Traces
  searchTraces(query: TraceQuery): SessionTrace[]
  replayTrace(traceId: string): AsyncGenerator<TurnTrace>
}
```

---

## 10. Core Module 7: Context & Prompt Control

### 10.1 System Prompt Management

```typescript
interface ContextManager {
  // System prompt sections (cached + volatile)
  addSection(name: string, content: string, options?: {
    cached: boolean       // true = tinh 1 lan, dung lai
    priority: number      // Thu tu trong prompt
    condition?: string    // Dieu kien hien thi
  }): void

  removeSection(name: string): void
  updateSection(name: string, content: string): void
  listSections(): PromptSection[]

  // Dynamic context injection
  injectContext(content: string, options?: {
    position: 'system' | 'user_prefix' | 'user_suffix'
    persistent: boolean   // Giu lai qua cac turn?
    ttlTurns?: number     // Tu dong xoa sau N turn
  }): void

  // CLAUDE.md / memory management
  addMemory(content: string, scope: 'session' | 'project' | 'user'): void
  removeMemory(id: string): void
  listMemories(): Memory[]

  // Context window
  getContextUsage(): { tokens: number, maxTokens: number, pct: number }
  forceCompact(): Promise<void>
  setCompactionStrategy(strategy: CompactionStrategy): void

  // Prompt template
  setPromptTemplate(template: string): void
  getEffectivePrompt(): string
}
```

### 10.2 Context Injection Patterns

```yaml
# agentweave.context.yaml

context:
  # System prompt sections
  sections:
    - name: "project_rules"
      priority: 1
      cached: true
      content: |
        ## Project Rules
        - Always use TypeScript strict mode
        - All functions must have return types
        - No console.log in production code

    - name: "security_policy"
      priority: 2
      cached: true
      content: |
        ## Security Policy
        - Never commit secrets or credentials
        - Always sanitize user input
        - Use parameterized queries for SQL

    - name: "current_sprint"
      priority: 10
      cached: false           # Re-evaluate moi turn
      condition: "session.turnCount == 1"  # Chi turn dau
      content: |
        ## Current Sprint Context
        Sprint: 2026-Q2-S3
        Focus: Authentication refactor
        Key files: src/auth/, src/middleware/

  # Dynamic injection rules
  injections:
    - trigger: "tool:FileEdit"
      content: "Remember: run `npm test` after editing files."
      position: "user_suffix"
      ttlTurns: 3

    - trigger: "budget:warning"
      content: "IMPORTANT: Budget is running low. Be efficient and concise."
      position: "system"
      persistent: true

    - trigger: "tool:consecutive_errors > 2"
      content: "You've hit multiple errors. Take a step back and reconsider your approach."
      position: "user_suffix"
      ttlTurns: 1
```

---

## 11. Core Module 8: Session Management

### 11.1 Session Lifecycle

```typescript
interface SessionManager {
  // Create & manage
  createSession(options: SessionOptions): Session
  getSession(id: string): Session
  listSessions(filter?: SessionFilter): Session[]

  // Persistence
  saveSession(id: string): Promise<void>       // Luu trang thai hien tai
  loadSession(id: string): Promise<Session>    // Phuc hoi session
  deleteSession(id: string): Promise<void>

  // Operations
  forkSession(id: string, options?: ForkOptions): Session  // Tao nhanh phu
  mergeSession(sourceId: string, targetId: string): Session
  rewindSession(id: string, toTurn: number): Session
  exportSession(id: string, format: 'json' | 'markdown' | 'html'): string

  // Replay
  replaySession(id: string, options?: ReplayOptions): AsyncGenerator<TurnTrace>

  // Comparison
  compareSession(idA: string, idB: string): SessionDiff
}

type SessionOptions = {
  id?: string                     // Auto-generate neu khong co
  name?: string
  projectId?: string
  userId?: string
  model?: string
  maxTurns?: number
  budgetUsd?: number
  tokenBudget?: number
  timeoutMs?: number
  config?: HarnessConfig          // Override config cho session nay
  parentSessionId?: string        // Neu la fork
  initialMessages?: Message[]     // Pre-load messages
  initialContext?: string[]       // Pre-load context
}
```

### 11.2 Session Transcript Format

```
~/.agentweave/sessions/
  ├── {project-hash}/
  │   ├── {session-id}.jsonl        # Main transcript
  │   ├── {session-id}.meta.json    # Session metadata
  │   ├── {session-id}.trace.jsonl  # Full trace
  │   ├── {session-id}.metrics.json # Aggregated metrics
  │   └── {session-id}/
  │       └── agents/
  │           ├── agent-{id}.jsonl  # Sub-agent transcripts
  │           └── agent-{id}.meta.json
  └── index.json                    # Session index
```

### 11.3 Fork & Compare Pattern

```
Session A: "Fix login bug"
  Turn 1: Search code
  Turn 2: Found bug in auth.ts
  Turn 3: [FORK HERE]
     |
     +---> Session B (fork): "Fix with approach 1 (refactor)"
     |       Turn 4B: Refactor auth module
     |       Turn 5B: Add tests
     |       Turn 6B: Done (cost: $2.30)
     |
     +---> Session C (fork): "Fix with approach 2 (patch)"
             Turn 4C: Quick patch
             Turn 5C: Add test
             Turn 6C: Done (cost: $0.80)

Compare:
  compareSession(B, C) --> {
    costDiff: "$1.50 more expensive",
    turnDiff: "same number of turns",
    toolDiff: "B used 12 tools, C used 6",
    codeDiff: "B changed 5 files, C changed 1 file",
  }
```

---

## 12. Core Module 9: Multi-Agent Orchestration

### 12.1 Orchestration Patterns

```
Pattern 1: COORDINATOR (1 leader + N workers)
  Coordinator
    |-- spawn Worker A: "Research auth patterns"
    |-- spawn Worker B: "Research DB schema"
    |-- wait for A, B
    |-- spawn Worker C: "Implement" (based on A, B results)
    +-- synthesize final response

Pattern 2: PIPELINE (sequential chain)
  Agent 1 (Research) --> Agent 2 (Plan) --> Agent 3 (Implement) --> Agent 4 (Review)

Pattern 3: SWARM (peer-to-peer)
  Agent A <--> Agent B <--> Agent C
  (moi agent co mailbox, gui tin nhan cho nhau)

Pattern 4: HIERARCHY (nested teams)
  Lead Agent
    |-- Team 1 Lead
    |     |-- Worker 1A
    |     +-- Worker 1B
    +-- Team 2 Lead
          |-- Worker 2A
          +-- Worker 2B
```

### 12.2 Multi-Agent Governance

```yaml
# agentweave.agents.yaml

multi_agent:
  # Global limits
  maxConcurrentAgents: 10
  maxTotalAgents: 50
  maxNestingDepth: 3
  totalBudgetUsd: 20.00

  # Per-agent limits
  defaults:
    maxTurns: 50
    budgetUsd: 5.00
    timeoutMs: 300000
    model: "claude-sonnet-4-6"

  # Agent type overrides
  types:
    research:
      model: "claude-haiku-4-5"
      tools: ["FileRead", "Grep", "Glob", "WebSearch"]
      maxTurns: 20
      budgetUsd: 1.00

    implementation:
      model: "claude-sonnet-4-6"
      tools: ["*"]
      maxTurns: 100
      budgetUsd: 10.00

    review:
      model: "claude-opus-4-6"
      tools: ["FileRead", "Grep", "Glob", "Bash(npm test)"]
      maxTurns: 10
      budgetUsd: 3.00

  # Communication rules
  communication:
    allowDirectMessages: true
    messageMaxSize: 10000           # chars
    requireCoordinatorApproval: false

  # Monitoring
  monitoring:
    trackPerAgent: true
    alertOnAgentFailure: true
    alertOnBudgetPerAgent: true
```

### 12.3 Agent Monitoring Dashboard

```
┌──────────────────────────────────────────────────────────┐
│  Multi-Agent Monitor          Session: abc123             │
├──────────────────────────────────────────────────────────┤
│                                                          │
│  Coordinator (opus-4-6)          [$4.20 / $20.00]        │
│  ├─ Worker-1 "auth-research"     [COMPLETED] $0.80 45s   │
│  ├─ Worker-2 "db-research"       [COMPLETED] $0.60 38s   │
│  ├─ Worker-3 "implement-auth"    [RUNNING]   $1.50 2m    │
│  │   └─ Turn 8/50  Tools: 12  Tokens: 45K                │
│  ├─ Worker-4 "implement-db"      [PAUSED]    $0.30 30s   │
│  │   └─ Waiting for permission: FileEdit(schema.ts)      │
│  └─ Worker-5 "review"            [PENDING]                │
│                                                          │
│  Total: 5 agents | 2 done | 1 running | 1 paused | 1 pending │
│  Cost: $4.20 | Tokens: 120K in / 35K out                 │
│  Time: 3m 22s elapsed                                    │
│                                                          │
│  [P]ause All  [R]esume  [A]bort  [I]nject  [D]etails    │
└──────────────────────────────────────────────────────────┘
```

---

## 13. Core Module 10: Configuration Hierarchy

### 13.1 Config Sources (Canonical — 7 Levels)

> **Day la bang tham chieu chinh thuc.** Tat ca tai lieu khac phai nhat quan voi bang nay.
> Policy luon co priority cao nhat (immutable). Defaults luon co priority thap nhat.

```
Level  Source            File / Source                              Git?      Priority  Override boi
-----  ----------------  -----------------------------------------  --------  --------  -----------
1      Defaults          Built-in framework defaults                N/A       Thap nhat Moi thu
2      User config       ~/.agentweave/config.yaml                  N/A       |         3-7
3      Project config    <project>/.agentweave/config.yaml          Commit    |         4-7
4      Local config      <project>/.agentweave/config.local.yaml    Gitignore |         5-7
5      CLI flags         --model, --budget, --permissions           N/A       |         6-7
6      Environment vars  AGENTWEAVE_MODEL, AGENTWEAVE_BUDGET        N/A       |         7
7      Policy rules      Enterprise managed (immutable)             Managed   Cao nhat  KHONG
```

**Merge logic:** Level cao override level thap. Policy (7) KHONG the bi override boi bat ky level nao.

**Luu y ve cac nguon khac (KHONG phai level rieng):**
- **Plugin configs** — merge vao level 3 (project scope) hoac level 2 (user scope) tuy plugin scope
- **Runtime overrides** (`harness.config.set(...)`) — ephemeral, chi ton tai trong session hien tai,
  tuong duong level 5 (CLI flags). Khong persist. Khong override Policy.

**Tai sao 7 level thay vi 9?**
- Plugin configs va Runtime overrides KHONG phai level doc lap — chung merge vao level co san.
- Giu 7 level de tranh confuse va giu nhat quan voi tai lieu introduction.

### 13.2 Config File Structure

```yaml
# ~/.agentweave/config.yaml (User config)

# Agent
agent:
  model: "claude-sonnet-4-6"
  fallbackModel: "claude-haiku-4-5"
  maxTurns: 100
  effort: "high"
  thinking: true

# Budget
budget:
  maxPerSession: 10.00       # USD
  maxPerDay: 50.00
  maxPerMonth: 500.00
  warningThreshold: 0.8      # 80%

# Permissions (see section 7)
permissions:
  defaultMode: "default"
  # ...

# Hooks (see section 8)
hooks:
  # ...

# Output pipeline (see section 5)
output_pipeline:
  # ...

# Tools governance (see section 6)
tools:
  # ...

# Monitoring (see section 9)
monitoring:
  enabled: true
  metricsRetention: "30d"
  traceRetention: "7d"
  alertChannels:
    - type: "terminal"
    - type: "slack"
      webhook: "${SLACK_WEBHOOK_URL}"

# Multi-agent (see section 12)
multi_agent:
  # ...

# Context (see section 10)
context:
  # ...

# Integrations
integrations:
  ci:
    provider: "github-actions"
    triggerOnPR: true
  notifications:
    slack:
      webhook: "${SLACK_WEBHOOK_URL}"
      channels: ["#agent-activity"]
  observability:
    otlp:
      endpoint: "https://otel.example.com:4317"
      headers:
        Authorization: "Bearer ${OTEL_TOKEN}"
```

---

## 14. Giao thuc kiem soat du lieu dau ra (Output Control Protocol)

> Day la phan **chi tiet nhat va quan trong nhat** — giao thuc de external systems kiem soat output cua agent.

### 14.1 Protocol Overview

```
AgentWeave dinh nghia 1 giao thuc chuan (AgentWeave Output Control Protocol - AWOCP)
cho phep BẤT KỲ HỆ THỐNG NÀO subscribe, intercept, modify, approve/reject
output cua AI agent qua cac transport: WebSocket, gRPC, HTTP webhook, stdio pipe.
```

### 14.2 Transport Layers

```
Transport 1: WebSocket (real-time, bidirectional)
  - Full-duplex streaming
  - Thich hop cho: dashboard, IDE integration, real-time monitor
  - URL: ws://localhost:9100/awocp

Transport 2: gRPC (high-performance, typed)
  - Streaming RPCs
  - Thich hop cho: microservice integration, high-throughput
  - Port: localhost:9101

Transport 3: HTTP Webhook (fire-and-forget)
  - POST callbacks
  - Thich hop cho: CI/CD, external services, serverless
  - URL: configured per hook

Transport 4: stdio Pipe (local, zero-network)
  - JSON-line protocol qua stdin/stdout
  - Thich hop cho: CLI wrapping, pipe chaining
  - Usage: agent_cli | agentweave | output_handler

Transport 5: Unix Socket / Named Pipe (local IPC)
  - Thich hop cho: IDE extensions, local dashboard
  - Path: /tmp/agentweave-{session-id}.sock
```

### 14.3 Protocol Messages (AWOCP)

```typescript
// === BASE MESSAGE ===
type AWOCPMessage = {
  jsonrpc: '2.0'
  id?: string                    // Cho request/response pairs
  method: string
  params: Record<string, unknown>
}

// === SERVER -> CLIENT (AgentWeave -> External System) ===

// Notification: output da san sang de xu ly
type OutputReadyNotification = {
  method: 'output/ready'
  params: {
    sessionId: string
    turnIndex: number
    stage: OutputStage           // 'raw' | 'validated' | 'filtered' | ...
    output: {
      type: 'text' | 'tool_result' | 'structured'
      content: string
      metadata: {
        model: string
        tokens: number
        cost: number
        toolCalls: number
        thinkingTokens: number
      }
    }
    context: {
      conversationLength: number
      totalCost: number
      turnCount: number
    }
  }
}

// Notification: stream delta
type StreamDeltaNotification = {
  method: 'output/stream_delta'
  params: {
    sessionId: string
    turnIndex: number
    delta: string                // Token(s) moi
    accumulatedLength: number    // Tong so chars da nhan
  }
}

// Notification: tool dang duoc goi
type ToolCallNotification = {
  method: 'tool/call'
  params: {
    sessionId: string
    turnIndex: number
    toolName: string
    toolInput: Record<string, unknown>
    toolUseId: string
  }
}

// Notification: tool da xong
type ToolResultNotification = {
  method: 'tool/result'
  params: {
    sessionId: string
    toolUseId: string
    result: unknown
    duration: number
    error?: string
  }
}

// Notification: can quyet dinh permission
type PermissionRequestNotification = {
  method: 'permission/request'
  params: {
    sessionId: string
    toolName: string
    toolInput: Record<string, unknown>
    toolUseId: string
    suggestions: PermissionUpdate[]
    timeoutMs: number
  }
}

// Notification: metric update
type MetricNotification = {
  method: 'metrics/update'
  params: {
    sessionId: string
    metrics: SessionMetrics
  }
}

// Notification: alert
type AlertNotification = {
  method: 'alert/triggered'
  params: {
    sessionId: string
    alert: Alert
  }
}

// === CLIENT -> SERVER (External System -> AgentWeave) ===

// Request: quyet dinh ve output
type OutputDecisionRequest = {
  method: 'output/decide'
  params: {
    sessionId: string
    turnIndex: number
    decision: 'approve' | 'reject' | 'modify' | 'hold'
    modifiedContent?: string     // Neu decision == 'modify'
    reason?: string
    retryPrompt?: string         // Neu decision == 'reject', prompt de retry
  }
}

// Request: quyet dinh ve permission
type PermissionDecisionRequest = {
  method: 'permission/decide'
  params: {
    sessionId: string
    toolUseId: string
    decision: 'allow' | 'deny'
    modifiedInput?: Record<string, unknown>
    reason?: string
    persistRule?: boolean        // Luu thanh rule vinh vien?
  }
}

// Request: inject message
type InjectRequest = {
  method: 'session/inject'
  params: {
    sessionId: string
    message: {
      role: 'system' | 'user'
      content: string
    }
    position: 'next_turn' | 'immediate'
  }
}

// Request: dieu khien session
type SessionControlRequest = {
  method: 'session/control'
  params: {
    sessionId: string
    action: 'pause' | 'resume' | 'abort' | 'rewind'
    rewindToTurn?: number
    reason?: string
  }
}

// Request: thay doi config runtime
type ConfigUpdateRequest = {
  method: 'config/update'
  params: {
    sessionId: string
    updates: {
      model?: string
      maxTurns?: number
      budgetUsd?: number
      permissions?: PermissionUpdate[]
      hooks?: HookUpdate[]
    }
  }
}

// Request: subscribe events
type SubscribeRequest = {
  method: 'events/subscribe'
  params: {
    sessionId?: string          // Null = tat ca sessions
    eventTypes: EventType[]     // Filter event types
    filter?: string             // JSONPath filter
  }
}
```

### 14.4 Output Gate Pattern

Pattern quan trong nhat: **Output Gate** — tat ca output PHAI di qua gate truoc khi den user:

```
Agent Output
  |
  v
Output Gate (AgentWeave)
  |
  |-- [Mode: PassThrough]  --> Output di thang (khong kiem soat)
  |
  |-- [Mode: Async]        --> Output di ngay, notify external system
  |                            External co the review sau (audit-only)
  |
  |-- [Mode: Sync]         --> Output DUNG LAI, doi external system quyet dinh
  |                            Timeout: approve/reject (configurable)
  |
  |-- [Mode: Stream]       --> Tokens stream qua, nhung co the bi
  |                            intercept/redact real-time
  |
  +-- [Mode: Batch]        --> Gom output, gui 1 lan cho external system
```

```yaml
# Output gate config
output_gate:
  mode: "sync"                    # passthrough | async | sync | stream | batch
  timeout: 30000                  # 30s cho external system quyet dinh
  timeoutAction: "approve"        # approve | reject (khi timeout)

  # Dieu kien bat sync mode (binh thuong passthrough)
  syncConditions:
    - "output.tool_count > 0"     # Co tool calls --> doi review
    - "output.risk_score > 0.7"   # Risk cao --> doi review
    - "session.cost_usd > 5"      # Cost cao --> doi review

  # External system endpoints
  endpoints:
    - transport: "websocket"
      url: "ws://localhost:9100/awocp"
      priority: 1

    - transport: "webhook"
      url: "https://review.example.com/agent-output"
      priority: 2                 # Fallback neu ws disconnect
```

### 14.5 End-to-End Example: Output Control Flow

```
1. User: "Delete all test files and recreate them"

2. AgentWeave Input Gate:
   - EMIT 'input:received'
   - Validate: OK
   - Transform: none

3. Agent processes, wants to call: Bash("rm -rf tests/")

4. AgentWeave Permission Engine:
   - Match rule: DENY "Bash(rm -rf *)"
   - Decision: DENY
   - EMIT 'permission:denied'
   - Return to agent: "Permission denied: rm -rf is not allowed"

5. Agent adjusts, wants to call: Bash("find tests/ -name '*.test.ts' -delete")

6. AgentWeave Permission Engine:
   - No exact deny rule
   - Contextual rule: "destructive command detected"
   - Decision: ASK
   - EMIT 'permission:asked'
   - AWOCP --> PermissionRequestNotification to dashboard
   - Dashboard user: "Deny, but allow removing individual files"
   - AWOCP <-- PermissionDecisionRequest: deny, reason: "use rm per file"

7. Agent adjusts strategy, uses FileRead + individual Bash("rm tests/old.test.ts")

8. PreToolUse hook fires:
   - Command hook: log to audit trail
   - PASS

9. Tools execute successfully

10. Agent produces final response:
    "I've cleaned up the test files and recreated them with the new structure."

11. AgentWeave Output Pipeline:
    Stage 1 (INTERCEPT): Capture raw output
    Stage 2 (VALIDATE): Check quality --> PASS
    Stage 3 (FILTER): Check PII --> none found
    Stage 4 (TRANSFORM): Add disclaimer footer
    Stage 5 (REVIEW): Risk score 0.2 --> auto-approve (below threshold)
    Stage 6 (DELIVER): Stream to terminal

12. User sees:
    "I've cleaned up the test files and recreated them with the new structure.
    ---
    _Generated by AI Agent. Review before using in production._"

13. AgentWeave Monitor:
    - Session cost: $0.45
    - Tools used: 8 (3 FileRead, 4 Bash, 1 FileWrite)
    - Permission: 1 denied, 1 asked, 6 allowed
    - Duration: 45s
    - Trace saved to ~/.agentweave/sessions/...
```

---

## 15. SDK & API Interface

### 15.1 TypeScript SDK

```typescript
import { AgentWeave, createHarness } from '@agentweave/core'

// Tao harness boc quanh agent
const harness = createHarness({
  // Agent configuration
  agent: {
    type: 'claude-code',         // hoac 'custom'
    model: 'claude-sonnet-4-6',
    apiKey: process.env.ANTHROPIC_API_KEY,
  },

  // Hoac custom agent
  agent: {
    type: 'custom',
    loop: myCustomAgentLoop,     // AsyncGenerator
  },

  // Config
  config: './agentweave.yaml',   // Hoac inline object

  // Event handlers
  on: {
    'tool:requested': (event) => console.log(`Tool: ${event.toolName}`),
    'output:raw': (event) => console.log(`Output: ${event.content.length} chars`),
    'budget:warning': (event) => console.warn(`Budget warning!`),
  },
})

// Chay agent
const result = await harness.run('Fix the login bug in auth.ts')

// Hoac streaming
for await (const event of harness.stream('Fix the login bug')) {
  if (event.type === 'text_delta') process.stdout.write(event.text)
  if (event.type === 'tool:requested') console.log(`\nTool: ${event.toolName}`)
}

// Control
harness.pause()
harness.inject({ role: 'user', content: 'Also update the docs' })
harness.resume()

// Monitor
const metrics = harness.getMetrics()
console.log(`Cost: $${metrics.totalCost}, Turns: ${metrics.turnCount}`)

// Session management
const sessionId = harness.getSessionId()
await harness.saveSession()
const restored = await AgentWeave.loadSession(sessionId)
```

### 15.2 Python SDK

```python
from agentweave import AgentWeave, HarnessConfig

harness = AgentWeave(
    agent_type="claude-code",
    model="claude-sonnet-4-6",
    config=HarnessConfig.from_file("./agentweave.yaml"),
)

# Synchronous
result = harness.run("Fix the login bug")

# Streaming
for event in harness.stream("Fix the login bug"):
    if event.type == "text_delta":
        print(event.text, end="")
    elif event.type == "tool:requested":
        print(f"\nTool: {event.tool_name}")

# Output interceptor
@harness.output.intercept("validate")
def check_output(output, context):
    if "DROP TABLE" in output.text:
        return {"action": "reject", "reason": "SQL injection"}
    return {"action": "pass"}

# Hook
@harness.hook("PreToolUse", matcher="Bash")
def before_bash(tool_input, context):
    if "sudo" in tool_input["command"]:
        return {"decision": "deny", "reason": "no sudo"}
    return {"decision": "passthrough"}
```

### 15.3 CLI Wrapper

```bash
# Wrap bat ky agent CLI nao
agentweave wrap -- claude "Fix the login bug"
agentweave wrap -- aider --model sonnet "Fix the login bug"
agentweave wrap -- codex "Fix the login bug"

# Voi config
agentweave wrap --config ./agentweave.yaml -- claude "Fix the login bug"

# Voi budget
agentweave wrap --budget 5.00 -- claude "Fix the login bug"

# Voi permission mode
agentweave wrap --permissions strict -- claude "Fix the login bug"

# Monitor mode (chi giam sat, khong can thiep)
agentweave monitor --session abc123

# Dashboard
agentweave dashboard --port 9100
```

---

## 16. CLI Interface

### 16.1 Command Structure

```
agentweave <command> [options]

COMMANDS:
  run <prompt>          Chay agent voi prompt
  wrap -- <cmd>         Boc CLI agent trong harness
  monitor               Giam sat session dang chay
  dashboard             Mo web dashboard
  session               Quan ly sessions
  config                Quan ly config
  trace                 Xem traces
  alert                 Quan ly alerts
  plugin                Quan ly plugins

OPTIONS:
  --config <path>       Path den config file
  --model <model>       Override model
  --budget <usd>        Max budget
  --max-turns <n>       Max turns
  --permissions <mode>  Permission mode
  --output-mode <mode>  Output control mode
  --verbose             Verbose logging
  --trace               Enable tracing
  --json                JSON output format
```

### 16.2 Interactive CLI Dashboard

```
┌─ AgentWeave Monitor ─────────────────────────── Session: a1b2c3 ─┐
│                                                                   │
│  Model: claude-sonnet-4-6    Status: RUNNING    Turn: 8/100       │
│  Cost: $1.45 / $10.00       Tokens: 45K in / 12K out             │
│  Time: 2m 15s               Context: 62% full                    │
│                                                                   │
├─ Current Activity ────────────────────────────────────────────────┤
│                                                                   │
│  [Turn 8] Agent is executing tool: FileEdit                       │
│  File: src/auth/login.ts                                          │
│  Status: Waiting for permission...                                │
│                                                                   │
│  > Allow this edit? [Y]es [N]o [V]iew diff [E]dit [S]kip         │
│                                                                   │
├─ Recent Tools ────────────────────────────────────────────────────┤
│                                                                   │
│  #5 FileRead  src/auth/login.ts        0.3s  OK                  │
│  #6 Grep      "handleLogin" src/       0.1s  OK                  │
│  #7 Bash      npm test -- auth         4.2s  FAIL (exit 1)       │
│  #8 FileEdit  src/auth/login.ts        ...   PENDING              │
│                                                                   │
├─ Alerts ──────────────────────────────────────────────────────────┤
│                                                                   │
│  [!] Tool Bash failed: test suite has 2 failures                  │
│                                                                   │
├─ Controls ────────────────────────────────────────────────────────┤
│  [P]ause  [R]esume  [A]bort  [I]nject  [S]tep  [T]race  [H]elp  │
└───────────────────────────────────────────────────────────────────┘
```

---

## 17. Dashboard & Web UI

### 17.1 Pages

```
/ (Home)
  - Active sessions overview
  - System health
  - Quick stats (today's cost, sessions, alerts)

/sessions
  - Session list with filters
  - Session detail (trace viewer)
  - Session comparison
  - Session replay

/monitor/{sessionId}
  - Real-time session monitor
  - Live metrics charts
  - Tool call timeline
  - Output preview
  - Control panel (pause/resume/abort/inject)

/traces
  - Searchable trace browser
  - Turn-by-turn trace viewer
  - Tool call inspector
  - Permission decision log
  - Output pipeline stages

/analytics
  - Cost trends (daily/weekly/monthly)
  - Token usage patterns
  - Tool usage heatmap
  - Model performance comparison
  - User activity

/alerts
  - Active alerts
  - Alert history
  - Alert configuration

/config
  - Config editor (YAML)
  - Permission rules editor
  - Hook editor
  - Output pipeline editor
  - Plugin manager

/agents
  - Multi-agent topology view
  - Per-agent metrics
  - Agent communication log
```

---

## 18. Integration Patterns

### 18.1 CI/CD Integration

```yaml
# .github/workflows/agent-review.yaml
name: Agent Code Review
on: [pull_request]
jobs:
  review:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: agentweave/action@v1
        with:
          command: "Review this PR for bugs, security issues, and code quality"
          model: "claude-sonnet-4-6"
          budget: "2.00"
          permissions: "readonly"
          output_gate: "sync"
          config: ".agentweave/ci-review.yaml"
```

### 18.2 Slack Integration

```yaml
integrations:
  slack:
    webhook: "${SLACK_WEBHOOK_URL}"
    events:
      - "alert:*"
      - "session:completed"
      - "output:rejected"
    format: "rich"                # rich | plain
    channel: "#agent-activity"
```

### 18.3 Grafana / Prometheus

```yaml
integrations:
  prometheus:
    enabled: true
    port: 9090
    path: "/metrics"
    labels:
      service: "agentweave"
      environment: "${ENV}"
```

### 18.4 OpenTelemetry

```yaml
integrations:
  otlp:
    enabled: true
    endpoint: "https://otel-collector.example.com:4317"
    protocol: "grpc"
    headers:
      Authorization: "Bearer ${OTEL_TOKEN}"
    resource:
      service.name: "agentweave"
      service.version: "0.1.0"
```

---

## 19. Security Model

### 19.1 Trust Layers

```
Layer 1: Transport Security
  - TLS/mTLS cho moi giao tiep mang
  - Unix socket permissions cho local IPC
  - JWT authentication cho WebSocket/gRPC

Layer 2: Authentication
  - API key authentication
  - OAuth 2.0 cho web dashboard
  - RBAC (Role-Based Access Control)
  - SSO integration (SAML/OIDC)

Layer 3: Authorization
  - Permission engine (see section 7)
  - Policy hierarchy (enterprise > project > user)
  - Immutable policy rules (enterprise khong the bi override)

Layer 4: Data Protection
  - Secret redaction in logs/traces
  - PII filtering in output
  - Encryption at rest (transcripts, configs)
  - Encryption in transit (TLS)

Layer 5: Audit
  - Immutable audit log
  - Who did what, when, why
  - Tamper-evident log chain
  - Export for compliance
```

### 19.2 Trust Dialog

```
Khi chay lan dau trong 1 project, AgentWeave hien:

┌─ Trust Dialog ───────────────────────────────────────────┐
│                                                          │
│  AgentWeave found configuration in this project:         │
│                                                          │
│  .agentweave/config.yaml                                 │
│  - 3 hooks defined (PreToolUse, PostToolUse, SessionEnd) │
│  - 2 output filters (PII redaction, secret redaction)    │
│  - 1 webhook endpoint (https://api.example.com/...)      │
│                                                          │
│  Do you trust this configuration?                        │
│                                                          │
│  [Y]es, trust  [N]o, use defaults  [V]iew config         │
└──────────────────────────────────────────────────────────┘
```

---

## 20. Roadmap

**Post-pivot roadmap (2026-04-22).** Phase numbering kept for continuity; scope re-framed around 3 pillars. Canonical version: [POSITIONING.md § Roadmap Implications](./POSITIONING.md#roadmap-implications).

### Phase 1: Core MVP — COMPLETE (2 months, shipped)

```
[x] Agent Loop Controller            — reference impl, demoted (Pillar 2 stage 4)
[x] Basic Tool Governance            — Pillar 1
[x] Permission Engine (rule-based)   — Pillar 1
[x] Output Pipeline                  — Pillar 1
[x] Session Persistence (JSONL)      — Pillar 1
[x] CLI Interface (agentweave run)   — surface
[x] Basic metrics (tokens, cost)     — Pillar 2 foundation
[x] TypeScript SDK                   — surface
[x] SDLC Pipeline (8 stages, M1-M10) — Pillar 2 USP (bonus, beyond original MVP)
[x] Claude Code adapter              — Pillar 3
[x] MCP server skeleton              — Pillar 3
[x] Guard CLI (`agentweave guard`)   — Pillar 3 distribution
```

### Phase 2: Governance Observability — PRIORITIZED

Focus: close the "we audit but can't view" gap. Enterprise signal.

```
[ ] `agentweave audit view` CLI      — filter/tail/format audit.log
[ ] Prometheus metrics exporter      — Pillar 1 + 2 metrics
[ ] OpenTelemetry integration
[ ] Session replay from audit trail
[ ] Alert engine hardening           — file exists, needs production validation
[ ] Interactive TUI dashboard        — optional, defer if MCP demand higher
```

### Phase 3: MCP Ecosystem + Policy Hierarchy

Focus: Pillar 3 distribution + Pillar 1 enterprise-grade policy.

```
[ ] MCP server public docs + demos   — unlock 100K+ agent users
[ ] Cursor adapter (PoC → prod)      — prove multi-agent-via-adapter
[ ] Aider adapter                    — expand reach
[ ] Contextual permission rules      — branch=main, cost>$5, after-hours
[ ] Policy hierarchy (7 levels)      — immutable enterprise rules
[ ] Hook engine hardening            — 5 types end-to-end validation
```

**De-prioritized from original Phase 3** (do not build unless customer-driven):
```
[-] ML permission classifier          — speculation, no current pull
[-] Streaming output schema enforce   — marginal value vs complexity
[-] Web dashboard as primary surface  — CLI + MCP first
[-] AWOCP WebSocket + gRPC protocol   — defer until gateway demand proven
```

### Phase 4: Multi-Agent via Adapter Fan-Out

Focus: coordinate multiple agents using existing adapters, not custom orchestration.

```
[ ] Parallel agent invocation across adapters
[ ] Per-agent governance (budget, rules, audit)
[ ] Agent communication monitoring (via audit log)
[ ] Coordinator adapter (one agent routes subtasks to others)
[ ] Fork & compare (run same task across 2+ adapters, compare M1-M10)
```

### Phase 5: Enterprise

Focus: compliance, integrations, SDK expansion.

```
[ ] Policy hierarchy (immutable enterprise rules) — rolled in from Phase 3
[ ] RBAC
[ ] SSO / SAML
[ ] Compliance audit trail export (SOC2, HIPAA, GDPR formats)
[ ] Python SDK
[ ] Plugin system (activate existing PluginLoader)
[ ] CI/CD integration (GitHub Actions, GitLab)
[ ] Slack / PagerDuty / webhook integrations
```

### Phase 6: Ecosystem — Ongoing

```
[ ] Plugin marketplace
[ ] Community hooks & filters
[ ] Community-contributed adapters
[ ] Training & documentation
[ ] Certification program
```

### Explicitly NOT on roadmap

Per [POSITIONING.md § Non-Goals](./POSITIONING.md#non-goals):

- Better agent loop than Claude Code / Cursor.
- New LLM model provider.
- IDE plugin as primary surface.
- Lock-in to a single agent vendor.

---

## Appendix: Glossary

| Term | Dinh nghia |
|---|---|
| **Harness** | Lop vo ben ngoai boc quanh AI Agent, kiem soat moi tuong tac |
| **Agent Loop** | Vong lap: user input -> LLM call -> tool execution -> repeat |
| **Tool Governance** | He thong kiem soat tool calls: permission, timeout, sandbox, audit |
| **Output Pipeline** | Chuoi xu ly output: intercept -> validate -> filter -> transform -> review -> deliver |
| **Output Gate** | Diem kiem soat output: cho qua, chan lai, hoac yeu cau review |
| **Hook** | Script tu dong chay tai cac diem noi trong pipeline |
| **Permission Rule** | Rule dinh nghia tool nao duoc phep/cam: `Bash(git *)` |
| **Context Window** | So tokens toi da LLM co the xu ly trong 1 lan goi |
| **Compaction** | Nen conversation khi context window gan day |
| **AWOCP** | AgentWeave Output Control Protocol — giao thuc kiem soat output |
| **Session Trace** | Ban ghi chi tiet moi hanh dong trong 1 session |
| **Fork** | Tao ban sao session de thu huong tiep can khac |
| **Coordinator** | Agent dieu phoi, chi phan viec cho worker agents |
