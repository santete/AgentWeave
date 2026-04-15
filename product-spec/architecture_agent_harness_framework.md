# AgentWeave — Architecture Document

> Version: 0.1 Draft
> Date: 2026-04-14

---

## Muc luc

1.  [Triet ly thiet ke](#1-triet-ly-thiet-ke)
2.  [Dinh nghia Inner Harness vs Outer Harness](#2-dinh-nghia-inner-harness-vs-outer-harness)
3.  [Layered Architecture Overview](#3-layered-architecture-overview)
4.  [INNER HARNESS — Chi tiet kien truc](#4-inner-harness--chi-tiet-kien-truc)
5.  [OUTER HARNESS — Chi tiet kien truc](#5-outer-harness--chi-tiet-kien-truc)
6.  [CONTROL PLANE — Giao tiep Inner/Outer](#6-control-plane--giao-tiep-innerouter)
7.  [DATA PLANE — Dong du lieu](#7-data-plane--dong-du-lieu)
8.  [Extension Points](#8-extension-points)
9.  [Deployment Topologies](#9-deployment-topologies)
10. [Error Propagation & Fault Isolation](#10-error-propagation--fault-isolation)
11. [Sequence Diagrams](#11-sequence-diagrams)
12. [Component Registry](#12-component-registry)
13. [Design Decisions & Trade-offs](#13-design-decisions--trade-offs)

---

## 1. Triet ly thiet ke

### 1.1 Nguyen tac cot loi

```
P1: SEPARATION OF CONCERNS
    Inner Harness CHI lo thuc thi agent (goi LLM, chay tool, threading messages).
    Outer Harness CHI lo kiem soat, giam sat, quan ly.
    Hai ben giao tiep qua CONTROL PLANE ro rang, khong biet chi tiet noi bo cua nhau.

P2: INNER HARNESS IS REPLACEABLE
    Outer Harness khong phu thuoc vao bat ky inner harness cu the nao.
    Co the swap: Claude Code inner -> Aider inner -> Custom inner.
    Chi can inner implement dung Control Plane interface.

P3: OUTER HARNESS IS OPTIONAL
    Inner Harness co the chay doc lap khong can Outer.
    Outer la "add-on" tang them governance, khong phai dependency.
    Agent van hoat dong binh thuong neu Outer bi tat/crash.

P4: OBSERVE BEFORE CONTROL
    Outer Harness LUON co the observe (doc events, metrics) ma khong can thiep.
    Control (modify, block, inject) la OPT-IN, phai cau hinh tuong minh.
    Mac dinh: passthrough mode (khong can thiep gi).

P5: FAIL-OPEN vs FAIL-CLOSED (configurable)
    Fail-open: neu Outer crash, Inner tiep tuc chay (default cho dev).
    Fail-closed: neu Outer crash, Inner dung lai (cho enterprise/compliance).

P6: STREAM-NATIVE
    Moi thu la stream/async generator.
    Khong bao gio blocking synchronous.
    Observer nhan events real-time, khong phai polling.
```

### 1.2 Ranh gioi trach nhiem

```
Cau hoi                                    | Ai tra loi?
-------------------------------------------|------------------
"Goi LLM model nao, voi params gi?"        | INNER HARNESS
"Tool nay co duoc phep chay khong?"         | OUTER HARNESS
"Message tiep theo gui gi cho LLM?"         | INNER HARNESS
"Output nay co an toan de tra cho user?"    | OUTER HARNESS
"Context window day, nen lam gi?"           | INNER HARNESS
"Da ton bao nhieu tien, con bao nhieu?"     | OUTER HARNESS
"Retry hay chuyen model?"                   | INNER HARNESS
"Agent nay co quyen spawn sub-agent?"       | OUTER HARNESS
"Tool result format nhu the nao?"           | INNER HARNESS
"Tool result co chua PII can redact?"       | OUTER HARNESS
```

---

## 2. Dinh nghia Inner Harness vs Outer Harness

### 2.1 Inner Harness (Execution Engine)

```
INNER HARNESS = Moi thu can thiet de LLM tro thanh Agent co kha nang hanh dong.

Trach nhiem:
  - Goi LLM API (streaming)
  - Parse response (text, tool_use, thinking)
  - Thuc thi tools
  - Thread messages (user -> assistant -> tool_result -> ...)
  - Quan ly context window (compaction, snip)
  - Retry khi LLM loi (429, 529, timeout)
  - Fallback model khi model chinh fail
  - Duy tri agent loop (while true cho den khi terminal)
  - Token counting & cost calculation
  - System prompt construction

KHONG chiu trach nhiem:
  - Permission (ai duoc lam gi)
  - Policy enforcement (rule nao ap dung)
  - Output filtering/validation
  - Monitoring/alerting
  - Session persistence (transcript storage)
  - Multi-agent governance
  - External integrations
  - Dashboard/UI

Tuong duong trong Claude Code:
  - QueryEngine.ts
  - query.ts
  - Tool.ts
  - services/api/claude.ts
  - services/api/withRetry.ts
  - services/compact/
  - utils/model/
  - utils/thinking.ts
```

### 2.2 Outer Harness (Governance & Control Layer)

```
OUTER HARNESS = Moi thu can thiet de KIEM SOAT agent tu ben ngoai.

Trach nhiem:
  - Permission engine (allow/deny/ask tool calls)
  - Hook engine (pre/post tool, pre/post output, lifecycle)
  - Output control pipeline (validate, filter, transform, review)
  - Input gate (validate, transform user input)
  - Monitoring & observability (metrics, traces, alerts)
  - Session management (persist, resume, fork, replay)
  - Multi-agent orchestration (spawn policies, budgets, communication rules)
  - Configuration hierarchy (user > project > policy)
  - External integrations (Slack, CI/CD, Grafana)
  - Dashboard & API (web UI, CLI dashboard, AWOCP protocol)
  - Audit trail (immutable log)
  - Budget management (cost limits, quotas)

KHONG chiu trach nhiem:
  - Goi LLM (de Inner lo)
  - Parse LLM response (de Inner lo)
  - Thuc thi tool logic (de Inner lo — Outer chi GATE truoc/sau)
  - Context window compaction (de Inner lo)
  - Retry/fallback LLM (de Inner lo)

Tuong duong trong Claude Code:
  - hooks/toolPermission/
  - utils/hooks.ts
  - utils/permissions/
  - utils/settings/
  - utils/sessionStorage.ts
  - state/
  - coordinator/
  - services/plugins/
```

### 2.3 Ranh gioi ro rang

```
                    INNER HARNESS                    OUTER HARNESS
                    =============                    =============

                    +-------------+                  +------------------+
User Input ------->| Input       |--- InputEvent --->| Input Gate       |
                    | Parser      |<-- GatedInput ---|                  |
                    +------+------+                  +------------------+
                           |
                    +------v------+                  +------------------+
                    | System      |--- PromptEvent ->| Context          |
                    | Prompt      |<-- Injection ----|  Controller      |
                    | Builder     |                  +------------------+
                    +------+------+
                           |
                    +------v------+
                    | LLM API     |  (Internal - Outer KHONG can thiep)
                    | Caller      |
                    | (streaming) |
                    +------+------+
                           |
                    +------v------+                  +------------------+
                    | Response    |--- ToolRequest ->| Permission       |
                    | Parser      |<-- Decision -----|  Engine          |
                    +------+------+                  +------------------+
                           |
                           |                         +------------------+
                           |-------- PreToolEvent -->| Hook Engine      |
                           |<------- HookResult -----|  (PreToolUse)    |
                           |                         +------------------+
                    +------v------+
                    | Tool        |  (Internal execution)
                    | Executor    |
                    +------+------+
                           |                         +------------------+
                           |-------- PostToolEvent ->| Hook Engine      |
                           |<------- HookResult -----|  (PostToolUse)   |
                           |                         +------------------+
                           |
                    +------v------+
                    | Message     |  (Internal threading)
                    | Threader    |
                    +------+------+
                           |
                    +------v------+                  +------------------+
                    | Terminal    |--- RawOutput ---->| Output Pipeline  |
                    | Detector    |                   | (6 stages)       |
                    +-------------+                  +--------+---------+
                                                              |
                                                     +--------v---------+
                                                     | Delivery         |
                                                     | (to user)        |
                                                     +------------------+

                    ---- SONG SONG ----              ---- SONG SONG ----

                    +-------------+                  +------------------+
                    | Token       |--- MetricEvent ->| Monitor          |
                    | Counter     |                  | Collector        |
                    +-------------+                  +------------------+

                    +-------------+                  +------------------+
                    | Error       |--- ErrorEvent -->| Alert Engine     |
                    | Handler     |                  +------------------+
                    +-------------+
                                                     +------------------+
                                                     | Session Manager  |
                                                     | (persist trace)  |
                                                     +------------------+

                                                     +------------------+
                                                     | Audit Logger     |
                                                     | (immutable log)  |
                                                     +------------------+
```

---

## 3. Layered Architecture Overview

### 3.1 Full Stack Layers

```
+=======================================================================+
|  LAYER 7: PRESENTATION                                                |
|  CLI Dashboard | Web Dashboard | IDE Panel | AWOCP Clients            |
+=======================================================================+
        |                    ^
        v                    |
+=======================================================================+
|  LAYER 6: EXTERNAL INTERFACE                                          |
|  AWOCP Protocol (WebSocket/gRPC/HTTP) | REST API | SDK (TS/Py/Go)    |
+=======================================================================+
        |                    ^
        v                    |
+=======================================================================+
|  LAYER 5: OUTER HARNESS — ORCHESTRATION                      [OUTER] |
|                                                                       |
|  +------------------+  +------------------+  +------------------+     |
|  | Multi-Agent      |  | Session          |  | Configuration    |     |
|  | Orchestrator     |  | Manager          |  | Hierarchy        |     |
|  +------------------+  +------------------+  +------------------+     |
+=======================================================================+
        |                    ^
        v                    |
+=======================================================================+
|  LAYER 4: OUTER HARNESS — GOVERNANCE                         [OUTER] |
|                                                                       |
|  +-------------+  +-------------+  +-------------+  +-------------+  |
|  | Permission  |  | Hook        |  | Output      |  | Input       |  |
|  | Engine      |  | Engine      |  | Pipeline    |  | Gate        |  |
|  +-------------+  +-------------+  +-------------+  +-------------+  |
|                                                                       |
|  +-------------+  +-------------+  +-------------+  +-------------+  |
|  | Budget      |  | Audit       |  | Alert       |  | Monitor     |  |
|  | Manager     |  | Logger      |  | Engine      |  | Collector   |  |
|  +-------------+  +-------------+  +-------------+  +-------------+  |
+=======================================================================+
        |                    ^
        v                    |
+=======================================================================+
|  LAYER 3: CONTROL PLANE (Interface between Inner & Outer)             |
|                                                                       |
|  +--------------------------------------------------------------+    |
|  |  Event Bus  |  Command Bus  |  State Queries  |  Interceptors |    |
|  +--------------------------------------------------------------+    |
|                                                                       |
|  Contracts:                                                           |
|    InnerHarnessProvider  (Inner implements)                            |
|    OuterHarnessConsumer  (Outer implements)                            |
|    ControlPlaneProtocol  (shared interface)                            |
+=======================================================================+
        |                    ^
        v                    |
+=======================================================================+
|  LAYER 2: INNER HARNESS — EXECUTION ENGINE                   [INNER] |
|                                                                       |
|  +-------------+  +-------------+  +-------------+  +-------------+  |
|  | Agent Loop  |  | LLM API     |  | Tool        |  | Context     |  |
|  | (state      |  | Caller      |  | Executor    |  | Window      |  |
|  |  machine)   |  | (streaming) |  | (serial/    |  | Manager     |  |
|  |             |  |             |  |  concurrent)|  | (compact)   |  |
|  +-------------+  +-------------+  +-------------+  +-------------+  |
|                                                                       |
|  +-------------+  +-------------+  +-------------+  +-------------+  |
|  | Message     |  | System      |  | Token       |  | Retry &     |  |
|  | Threader    |  | Prompt      |  | Counter     |  | Fallback    |  |
|  |             |  | Builder     |  |             |  |             |  |
|  +-------------+  +-------------+  +-------------+  +-------------+  |
+=======================================================================+
        |                    ^
        v                    |
+=======================================================================+
|  LAYER 1: INFRASTRUCTURE                                              |
|                                                                       |
|  +-------------+  +-------------+  +-------------+  +-------------+  |
|  | LLM API     |  | File System |  | Shell       |  | Network     |  |
|  | (Anthropic, |  | (read,      |  | (bash,      |  | (HTTP,      |  |
|  |  Bedrock,   |  |  write,     |  |  powershell)|  |  WebSocket, |  |
|  |  Vertex)    |  |  watch)     |  |             |  |  MCP)       |  |
|  +-------------+  +-------------+  +-------------+  +-------------+  |
+=======================================================================+
```

### 3.2 Dependency Direction

```
Quy tac: dependency chi huong XUONG, khong bao gio huong LEN.

Layer 7 (Presentation) --> Layer 6 (External Interface) --> Layer 5 (Orchestration)
                                                               |
                                                               v
                                                          Layer 4 (Governance)
                                                               |
                                                               v
                                                          Layer 3 (Control Plane)
                                                             /    \
                                                            v      v
                                                    Layer 2        Layer 2
                                                    (Inner)        (Inner cua agent khac)
                                                        |
                                                        v
                                                    Layer 1 (Infra)

Ngoai le duy nhat: CONTROL PLANE (Layer 3) la BIDIRECTIONAL by design.
  - Inner PUSH events len Control Plane (observe)
  - Outer SEND commands xuong Control Plane (control)
  - Control Plane route giua hai ben
```

---

## 4. INNER HARNESS — Chi tiet kien truc

### 4.1 Component Diagram

```
+====================================================================+
|                        INNER HARNESS                                |
|                                                                     |
|  +-----------------------+                                          |
|  | AgentLoop             |  (Core state machine)                    |
|  |                       |                                          |
|  |  state: LoopState     |                                          |
|  |  while(true) {        |                                          |
|  |    prepare()          +-------> [SystemPromptBuilder]            |
|  |    callLLM()          +-------> [LLMCaller]                      |
|  |    parseResponse()    |                                          |
|  |    if terminal: break |                                          |
|  |    executeTools()     +-------> [ToolExecutor]                   |
|  |    threadMessages()   +-------> [MessageThreader]                |
|  |    checkRecovery()    +-------> [RecoveryManager]                |
|  |  }                    |                                          |
|  +-----------+-----------+                                          |
|              |                                                      |
|              | emits events via Control Plane                       |
|              |                                                      |
|  +-----------v-----------+                                          |
|  | ControlPlaneAdapter   |  (Bridge to Control Plane)               |
|  |                       |                                          |
|  |  emit(event)          |  --> Event Bus                           |
|  |  waitForDecision()    |  <-- Command Bus (blocking khi can)      |
|  |  queryState()         |  <-- State Queries                       |
|  +-----------------------+                                          |
|                                                                     |
|  +-------------------+  +-------------------+  +------------------+ |
|  | LLMCaller         |  | ToolExecutor      |  | ContextWindow    | |
|  |                   |  |                   |  | Manager          | |
|  | - streaming       |  | - partition       |  |                  | |
|  | - token tracking  |  |   (read/write)    |  | - auto compact   | |
|  | - cache control   |  | - concurrent exec |  | - reactive       | |
|  | - model normalize |  | - streaming exec  |  |   compact        | |
|  +-------------------+  | - timeout         |  | - snip           | |
|                         +-------------------+  | - token tracking | |
|  +-------------------+                         +------------------+ |
|  | MessageThreader   |  +-------------------+                       |
|  |                   |  | RecoveryManager   |                       |
|  | - append messages |  |                   |                       |
|  | - normalize       |  | - PTL retry       |                       |
|  | - tool_result     |  | - max output      |                       |
|  |   pairing         |  |   escalation      |                       |
|  +-------------------+  | - fallback model  |                       |
|                         | - auth refresh     |                       |
|  +-------------------+  +-------------------+                       |
|  | SystemPromptBuild |                                              |
|  |                   |  +-------------------+                       |
|  | - cached sections |  | TokenCounter      |                       |
|  | - volatile sections| |                   |                       |
|  | - tool schemas    |  | - input tokens    |                       |
|  | - agent context   |  | - output tokens   |                       |
|  +-------------------+  | - cache tokens    |                       |
|                         | - cost calc       |                       |
|                         +-------------------+                       |
+====================================================================+
```

### 4.2 Inner Harness Interface (Contract)

Day la interface ma Inner Harness PHAI implement de Outer co the wrap no:

```typescript
/**
 * INNER HARNESS PROVIDER INTERFACE
 *
 * Bat ky Inner Harness nao (Claude Code, Aider, Custom)
 * deu phai implement interface nay de Outer Harness co the wrap.
 */
interface InnerHarnessProvider {

  // === LIFECYCLE ===

  /**
   * Chay agent voi prompt. Tra ve async generator yield events.
   * Day la entry point chinh. Outer Harness goi ham nay.
   */
  run(prompt: string | ContentBlock[], options?: RunOptions): AsyncGenerator<InnerEvent>

  /**
   * Abort agent loop ngay lap tuc.
   */
  abort(reason?: string): void

  // === STATE QUERIES ===

  /**
   * Lay trang thai hien tai cua agent loop.
   */
  getState(): InnerState

  /**
   * Lay conversation messages hien tai.
   */
  getMessages(): ReadonlyArray<Message>

  /**
   * Lay thong tin context window.
   */
  getContextUsage(): ContextUsage

  /**
   * Lay accumulated token usage & cost.
   */
  getUsage(): TokenUsage

  // === TOOL REGISTRY ===

  /**
   * Lay danh sach tools dang dang ky.
   */
  getTools(): ReadonlyArray<ToolDefinition>

  /**
   * Dang ky tool moi tai runtime.
   */
  registerTool(tool: ToolDefinition): void

  /**
   * Go bo tool.
   */
  unregisterTool(name: string): void

  // === INJECTION ===

  /**
   * Inject message vao conversation.
   * Chi co hieu luc o turn TIEP THEO, khong phai turn hien tai.
   */
  injectMessage(message: InjectableMessage): void

  /**
   * Inject/modify system prompt section.
   */
  setSystemPromptSection(name: string, content: string | null): void

  // === CONFIGURATION ===

  /**
   * Doi model tai runtime.
   */
  setModel(model: string): void

  /**
   * Lay config hien tai.
   */
  getConfig(): InnerConfig
}
```

### 4.3 Inner Events (du lieu Inner phat ra cho Control Plane)

```typescript
/**
 * Events ma Inner Harness phat ra.
 * Outer Harness OBSERVE nhung events nay qua Control Plane.
 * Inner khong biet Outer ton tai — no chi emit events.
 */
type InnerEvent =
  // --- Turn lifecycle ---
  | { type: 'turn:start'; turnIndex: number }
  | { type: 'turn:end'; turnIndex: number; stopReason: StopReason }

  // --- LLM streaming ---
  | { type: 'llm:request_start'; model: string; inputTokens: number }
  | { type: 'llm:stream_delta'; delta: string; blockType: 'text' | 'thinking' }
  | { type: 'llm:stream_end'; usage: TokenUsage; stopReason: string }

  // --- Tool lifecycle ---
  | { type: 'tool:requested'; toolName: string; toolInput: unknown; toolUseId: string }
  | { type: 'tool:started'; toolUseId: string }
  | { type: 'tool:progress'; toolUseId: string; progress: unknown }
  | { type: 'tool:completed'; toolUseId: string; result: unknown; duration: number }
  | { type: 'tool:failed'; toolUseId: string; error: string; duration: number }

  // --- Messages ---
  | { type: 'message:assistant'; message: AssistantMessage }
  | { type: 'message:tool_result'; message: ToolResultMessage }

  // --- Context ---
  | { type: 'context:compacting' }
  | { type: 'context:compacted'; freedTokens: number }
  | { type: 'context:usage'; tokens: number; maxTokens: number }

  // --- Recovery ---
  | { type: 'recovery:retry'; reason: string; attempt: number }
  | { type: 'recovery:fallback'; fromModel: string; toModel: string }
  | { type: 'recovery:escalate_tokens'; from: number; to: number }

  // --- Terminal ---
  | { type: 'terminal'; reason: TerminalReason; usage: TokenUsage }

  // --- Error ---
  | { type: 'error'; error: Error; recoverable: boolean }
```

### 4.4 Inner State

```typescript
type InnerState = {
  status: 'idle' | 'running' | 'paused' | 'completed' | 'aborted' | 'error'
  turnIndex: number
  model: string
  usage: TokenUsage
  contextUsage: ContextUsage
  activeTool: { name: string; toolUseId: string } | null
  messageCount: number
  recoveryAttempts: number
}

type TokenUsage = {
  inputTokens: number
  outputTokens: number
  thinkingTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
  totalCost: number         // USD
}

type ContextUsage = {
  usedTokens: number
  maxTokens: number
  pct: number               // 0.0 - 1.0
  compactionCount: number
}

type TerminalReason =
  | 'completed'             // LLM khong goi tool nua
  | 'aborted'               // User/Outer abort
  | 'max_turns'             // Het turns
  | 'budget_exceeded'       // Het tien
  | 'timeout'               // Het thoi gian
  | 'error'                 // Loi khong recovery duoc
```

---

## 5. OUTER HARNESS — Chi tiet kien truc

### 5.1 Component Diagram

```
+====================================================================+
|                        OUTER HARNESS                                |
|                                                                     |
|  +---[GOVERNANCE LAYER]----------------------------------------+   |
|  |                                                              |   |
|  |  +---------------+  +-------------+  +-------------------+  |   |
|  |  | Input Gate    |  | Permission  |  | Output Pipeline   |  |   |
|  |  |               |  | Engine      |  |                   |  |   |
|  |  | - validate    |  |             |  | - intercept       |  |   |
|  |  | - transform   |  | - rules     |  | - validate        |  |   |
|  |  | - sanitize    |  | - roles     |  | - filter          |  |   |
|  |  | - reject      |  | - context   |  | - transform       |  |   |
|  |  +---------------+  | - classify  |  | - review          |  |   |
|  |                      +-------------+  | - deliver         |  |   |
|  |  +---------------+                    +-------------------+  |   |
|  |  | Hook Engine   |  +-------------+                          |   |
|  |  |               |  | Budget      |  +-------------------+  |   |
|  |  | - command     |  | Manager     |  | Tool Governor     |  |   |
|  |  | - prompt      |  |             |  |                   |  |   |
|  |  | - agent       |  | - per-sess  |  | - rate limit      |  |   |
|  |  | - http        |  | - per-day   |  | - timeout         |  |   |
|  |  | - function    |  | - per-user  |  | - sandbox         |  |   |
|  |  | - pipeline    |  | - alerts    |  | - audit           |  |   |
|  |  +---------------+  +-------------+  +-------------------+  |   |
|  |                                                              |   |
|  +--------------------------------------------------------------+   |
|                                                                     |
|  +---[OBSERVABILITY LAYER]--------------------------------------+   |
|  |                                                              |   |
|  |  +---------------+  +-------------+  +-------------------+  |   |
|  |  | Monitor       |  | Alert       |  | Audit Logger     |  |   |
|  |  | Collector     |  | Engine      |  |                   |  |   |
|  |  |               |  |             |  | - immutable log   |  |   |
|  |  | - metrics     |  | - rules     |  | - who/what/when   |  |   |
|  |  | - traces      |  | - channels  |  | - tamper-evident  |  |   |
|  |  | - aggregation |  | - cooldown  |  | - export          |  |   |
|  |  +---------------+  +-------------+  +-------------------+  |   |
|  |                                                              |   |
|  +--------------------------------------------------------------+   |
|                                                                     |
|  +---[ORCHESTRATION LAYER]--------------------------------------+   |
|  |                                                              |   |
|  |  +---------------+  +-------------+  +-------------------+  |   |
|  |  | Session       |  | Multi-Agent |  | Configuration     |  |   |
|  |  | Manager       |  | Orchestrator|  | Hierarchy         |  |   |
|  |  |               |  |             |  |                   |  |   |
|  |  | - persist     |  | - spawn     |  | - 7 levels        |  |   |
|  |  | - resume      |  | - govern    |  | - merge logic     |  |   |
|  |  | - fork        |  | - coordinate|  | - hot reload      |  |   |
|  |  | - replay      |  | - budget    |  | - validation      |  |   |
|  |  +---------------+  +-------------+  +-------------------+  |   |
|  |                                                              |   |
|  +--------------------------------------------------------------+   |
|                                                                     |
|  +---[INTERFACE LAYER]------------------------------------------+   |
|  |                                                              |   |
|  |  +---------------+  +-------------+  +-------------------+  |   |
|  |  | AWOCP Server  |  | REST API    |  | SDK Host          |  |   |
|  |  | (WS/gRPC)     |  |             |  | (TS/Py/Go)        |  |   |
|  |  +---------------+  +-------------+  +-------------------+  |   |
|  |                                                              |   |
|  +--------------------------------------------------------------+   |
+====================================================================+
```

### 5.2 Outer Harness Interface (Contract)

```typescript
/**
 * OUTER HARNESS CONSUMER INTERFACE
 *
 * Interface ma Outer Harness implement de wrap Inner Harness.
 * Nhan events tu Inner qua Control Plane, tra ve decisions.
 */
interface OuterHarnessConsumer {

  // === GATES (blocking decisions) ===

  /**
   * Goi khi Inner muon execute 1 tool.
   * Outer tra ve: allow, deny, hoac ask (doi user).
   * Day la BLOCKING CALL — Inner doi Outer quyet dinh.
   */
  onToolRequested(request: ToolRequest): Promise<ToolDecision>

  /**
   * Goi khi Inner muon tra output cho user.
   * Outer co the: approve, reject, modify.
   * Day la BLOCKING CALL neu output gate mode = sync.
   */
  onOutputReady(output: RawOutput): Promise<OutputDecision>

  /**
   * Goi khi Inner nhan user input.
   * Outer co the: pass, transform, reject.
   */
  onInputReceived(input: UserInput): Promise<InputDecision>

  // === OBSERVERS (non-blocking notifications) ===

  /**
   * Nhan event tu Inner. Khong block Inner.
   * Outer xu ly async (log, metrics, alerts).
   */
  onEvent(event: InnerEvent): void

  // === HOOKS (semi-blocking) ===

  /**
   * Chay hooks cho 1 event. Timeout configurable.
   * Neu timeout: default decision (configurable).
   */
  executeHooks(event: HookEvent): Promise<HookResult>

  // === LIFECYCLE ===

  /**
   * Goi khi Inner bat dau chay. Outer khoi tao resources.
   */
  onSessionStart(session: SessionInfo): Promise<void>

  /**
   * Goi khi Inner ket thuc. Outer cleanup, luu transcript.
   */
  onSessionEnd(session: SessionInfo, result: TerminalResult): Promise<void>
}
```

### 5.3 Tool Decision & Output Decision

```typescript
// === Permission Decision cho tool ===
type ToolDecision = {
  behavior: 'allow' | 'deny' | 'ask'
  modifiedInput?: unknown       // Outer co the modify tool input
  reason: string
  source: string                // Rule nao quyet dinh
  metadata?: Record<string, unknown>
}

// === Output Decision ===
type OutputDecision = {
  action: 'approve' | 'reject' | 'modify' | 'hold' | 'retry'
  modifiedContent?: string      // Neu action = modify
  retryPrompt?: string          // Neu action = retry
  reason?: string
  metadata?: {
    validationPassed: boolean
    filtersApplied: string[]
    transformsApplied: string[]
    reviewDecision?: string
    riskScore?: number
  }
}

// === Input Decision ===
type InputDecision = {
  action: 'pass' | 'transform' | 'reject'
  transformedInput?: string     // Neu action = transform
  injectedContext?: string[]    // Context bo sung
  reason?: string
}
```

---

## 6. CONTROL PLANE — Giao tiep Inner/Outer

### 6.1 Control Plane la gi?

```
Control Plane la LOP TRUNG GIAN giua Inner va Outer.
No KHONG chua business logic — chi route events va commands.

                     CONTROL PLANE
        +------------------------------------+
        |                                    |
Inner --|--> Event Bus ----> Outer (observe) |
        |                                    |
Inner <-|--- Command Bus <-- Outer (control) |
        |                                    |
Inner <-|--- State Queries <- Outer (query)  |
        |                                    |
Inner --|--> Interceptors --> Outer (gate)    |
        +------------------------------------+
```

### 6.2 4 kenh giao tiep

```
CHANNEL 1: EVENT BUS (Inner -> Outer, non-blocking)
  - Inner emit events (turn:start, tool:requested, llm:stream_delta...)
  - Outer subscribe va xu ly async
  - Inner KHONG doi Outer xu ly xong
  - Dung cho: monitoring, logging, metrics, alerts

CHANNEL 2: COMMAND BUS (Outer -> Inner, async)
  - Outer gui commands (pause, resume, abort, inject, switchModel...)
  - Inner xu ly o diem an toan tiep theo (giua cac turns)
  - Khong interrupt giua 1 LLM call
  - Dung cho: lifecycle control, injection

CHANNEL 3: INTERCEPTORS (Bidirectional, BLOCKING)
  - Inner HỎI Outer truoc khi lam 1 viec gi do
  - Outer TRA LOI: allow, deny, modify
  - Inner DOI Outer tra loi (voi timeout)
  - Dung cho: permission, output gate, input gate

CHANNEL 4: STATE QUERIES (Outer -> Inner, sync read)
  - Outer doc state cua Inner (read-only)
  - Khong modify, chi query
  - Dung cho: dashboard, monitoring, debugging
```

### 6.3 Control Plane Interface

```typescript
interface ControlPlane {

  // === EVENT BUS ===

  /**
   * Inner goi de emit event.
   * Non-blocking — return ngay, khong doi subscriber.
   */
  emit(event: InnerEvent): void

  /**
   * Outer goi de subscribe events.
   * Tra ve unsubscribe function.
   */
  subscribe(
    eventType: string | '*',
    handler: (event: InnerEvent) => void
  ): () => void

  // === COMMAND BUS ===

  /**
   * Outer gui command cho Inner.
   * Return Promise resolve khi Inner ACK (khong phai khi Inner XONG).
   */
  sendCommand(command: OuterCommand): Promise<CommandAck>

  /**
   * Inner dang ky command handler.
   */
  onCommand(handler: (command: OuterCommand) => Promise<CommandAck>): void

  // === INTERCEPTORS ===

  /**
   * Inner goi khi can Outer quyet dinh (blocking).
   * Timeout configurable. Default decision khi timeout.
   */
  intercept<T extends InterceptType>(
    type: T,
    request: InterceptRequest[T]
  ): Promise<InterceptResponse[T]>

  /**
   * Outer dang ky interceptor handler.
   */
  registerInterceptor<T extends InterceptType>(
    type: T,
    handler: (request: InterceptRequest[T]) => Promise<InterceptResponse[T]>
  ): void

  // === STATE QUERIES ===

  /**
   * Outer query state cua Inner (read-only snapshot).
   */
  queryState(): InnerState

  /**
   * Outer query messages (read-only).
   */
  queryMessages(): ReadonlyArray<Message>

  /**
   * Outer query tools (read-only).
   */
  queryTools(): ReadonlyArray<ToolDefinition>
}

// Intercept types
type InterceptType = 'tool_request' | 'output_ready' | 'input_received'

type InterceptRequest = {
  tool_request: ToolRequest
  output_ready: RawOutput
  input_received: UserInput
}

type InterceptResponse = {
  tool_request: ToolDecision
  output_ready: OutputDecision
  input_received: InputDecision
}

// Commands from Outer to Inner
type OuterCommand =
  | { type: 'pause' }
  | { type: 'resume' }
  | { type: 'abort'; reason?: string }
  | { type: 'inject'; message: InjectableMessage }
  | { type: 'set_model'; model: string }
  | { type: 'set_max_turns'; maxTurns: number }
  | { type: 'set_budget'; budgetUsd: number }
  | { type: 'set_system_prompt_section'; name: string; content: string | null }
  | { type: 'register_tool'; tool: ToolDefinition }
  | { type: 'unregister_tool'; name: string }
  | { type: 'force_compact' }
  | { type: 'rewind'; toTurn: number }

type CommandAck = {
  accepted: boolean
  reason?: string              // Neu khong accept
}
```

### 6.4 Timeout & Default Decisions

```typescript
// Khi Outer khong tra loi kip:

const INTERCEPTOR_DEFAULTS: Record<InterceptType, {
  timeout: number
  defaultDecision: InterceptResponse[InterceptType]
  failMode: 'open' | 'closed'
}> = {
  tool_request: {
    timeout: 30_000,            // 30s cho permission
    defaultDecision: { behavior: 'deny', reason: 'Timeout' },
    failMode: 'closed',        // Deny khi timeout (an toan)
  },
  output_ready: {
    timeout: 10_000,            // 10s cho output gate
    defaultDecision: { action: 'approve' },
    failMode: 'open',           // Approve khi timeout (UX)
  },
  input_received: {
    timeout: 5_000,             // 5s cho input gate
    defaultDecision: { action: 'pass' },
    failMode: 'open',           // Pass khi timeout (UX)
  },
}

// Configurable:
// fail-open (default cho dev): Inner tiep tuc voi default decision
// fail-closed (cho enterprise): Inner dung lai, bao loi
```

### 6.5 Control Plane Implementations

```
IMPLEMENTATION 1: In-Process (default)
  - Inner va Outer chay trong cung process
  - Control Plane = direct function calls
  - Zero overhead, zero serialization
  - Thich hop cho: CLI wrapping, SDK

IMPLEMENTATION 2: IPC (Inter-Process Communication)
  - Inner va Outer chay trong 2 process khac nhau
  - Control Plane = Unix socket / named pipe
  - JSON-line protocol
  - Thich hop cho: sandboxing, isolation

IMPLEMENTATION 3: Network (Remote)
  - Inner va Outer chay tren 2 may khac nhau
  - Control Plane = WebSocket / gRPC
  - Thich hop cho: centralized governance, cloud deployment
  - AWOCP protocol (defined in product spec)
```

---

## 7. DATA PLANE — Dong du lieu

### 7.1 Tong quan

```
Data Plane mo ta DONG DU LIEU CU THE di qua tung component.
Khac voi Control Plane (dieu khien), Data Plane la DU LIEU THUC TE.
```

### 7.2 Data Flow: Happy Path (tool call thanh cong)

```
[User] "Fix the login bug"
  |
  | UserInput { text: "Fix the login bug", timestamp, sessionId }
  v
[Input Gate]
  | InputDecision { action: 'pass' }
  v
[SystemPromptBuilder]
  | SystemPrompt { sections: [...], tools: [...], context: [...] }
  v
[LLMCaller]
  | LLMRequest { model, messages, system, tools, stream: true }
  | ...streaming...
  | LLMResponse { content: [TextBlock, ToolUseBlock], usage, stopReason }
  v
[ResponseParser]
  | AssistantMessage { content: [text, tool_use(Grep, {pattern: "login"})] }
  | ToolUseBlocks: [{ name: "Grep", input: {pattern: "login"}, id: "tu_1" }]
  v
[Permission Engine]  (via Interceptor)
  | ToolRequest { name: "Grep", input: {pattern: "login"}, id: "tu_1" }
  | ToolDecision { behavior: 'allow', source: 'config:FileRead(*)' }
  v
[Hook Engine: PreToolUse]
  | HookEvent { type: 'PreToolUse', toolName: 'Grep', toolInput: {...} }
  | HookResult { action: 'passthrough' }
  v
[ToolExecutor]
  | ToolExecution { name: "Grep", input: {pattern: "login"} }
  | ToolResult { data: "src/auth.ts:42: function handleLogin()..." }
  v
[Hook Engine: PostToolUse]
  | HookEvent { type: 'PostToolUse', toolName: 'Grep', result: {...} }
  | HookResult { action: 'passthrough' }
  v
[MessageThreader]
  | Append: tool_result message -> messages array
  | Messages: [user, assistant(tool_use), user(tool_result)]
  v
[AgentLoop] --> continue (co tool_use, chua terminal)
  |
  | ...N more turns...
  v
[LLMCaller] --> response voi TEXT ONLY (khong co tool_use)
  v
[Terminal Detector] --> terminal!
  v
[Output Pipeline]
  | Stage 1 INTERCEPT: RawOutput { text: "I found the bug...", tokens: 500 }
  | Stage 2 VALIDATE:  { passed: true }
  | Stage 3 FILTER:    { text: "I found the bug...", redacted: 0 }
  | Stage 4 TRANSFORM: { text: "I found the bug...\n---\nAI Generated" }
  | Stage 5 REVIEW:    { action: 'auto_approve', riskScore: 0.1 }
  | Stage 6 DELIVER:   --> User terminal
  v
[User] sees: "I found the bug in src/auth.ts..."

[Monitor Collector]
  | SessionMetrics { turns: 5, cost: $0.23, tools: 8, duration: 15s }
  v
[Session Manager]
  | Save transcript to ~/.agentweave/sessions/...
```

### 7.3 Data Flow: Permission Denied

```
[LLMCaller] response: tool_use(Bash, { command: "rm -rf tests/" })
  v
[Permission Engine]
  | Match rule: DENY "Bash(rm -rf *)"
  | ToolDecision { behavior: 'deny', reason: 'rm -rf not allowed' }
  v
[MessageThreader]
  | Tao tool_result message: { is_error: true, content: "Permission denied: ..." }
  | Append vao messages
  v
[AgentLoop] --> continue (agent se dieu chinh strategy)
  v
[LLMCaller] --> agent hieu va thu cach khac
```

### 7.4 Data Flow: Output Rejected

```
[Terminal Detector] --> terminal
  v
[Output Pipeline]
  | Stage 1 INTERCEPT: RawOutput { text: "Here's the SQL: DROP TABLE users;" }
  | Stage 2 VALIDATE:  FAIL! { rule: 'no_harmful_code', matched: 'DROP TABLE' }
  |
  | OutputDecision { action: 'retry', retryPrompt: "Do not include raw SQL..." }
  v
[AgentLoop] --> inject retry message, continue
  v
[LLMCaller] --> agent nhan retry prompt, tra lai response moi
  v
[Output Pipeline] --> pass this time
  v
[User] sees safe response
```

---

## 8. Extension Points

### 8.1 Diem mo rong cho Inner Harness

```
EP-I1: Custom Tool
  - Dang ky tool moi implement Tool interface
  - Inner auto-inject vao tool schemas cho LLM

EP-I2: Custom LLM Provider
  - Implement LLMProvider interface
  - Swap Anthropic -> OpenAI -> Local model -> Custom API

EP-I3: Custom System Prompt Section
  - Them section vao system prompt
  - Cached hoac volatile

EP-I4: Custom Compaction Strategy
  - Override cach nen context window
  - E.g. domain-specific summarization

EP-I5: Custom Recovery Strategy
  - Them recovery path moi cho agent loop
  - E.g. domain-specific error handling
```

### 8.2 Diem mo rong cho Outer Harness

```
EP-O1: Custom Permission Rule Layer
  - Them layer moi vao permission engine
  - E.g. database-backed rules, ML classifier

EP-O2: Custom Hook Type
  - Them hook type moi ngoai 6 built-in
  - E.g. Kafka hook, Redis hook

EP-O3: Custom Output Pipeline Stage
  - Them stage moi vao output pipeline
  - E.g. brand-specific formatting, compliance check

EP-O4: Custom Output Filter
  - Dang ky filter regex/function
  - Chay tai stage 3 (Filter)

EP-O5: Custom Output Transformer
  - Dang ky transform function
  - Chay tai stage 4 (Transform)

EP-O6: Custom Alert Channel
  - Ngoai Slack/PagerDuty/terminal
  - E.g. Teams, Discord, custom webhook

EP-O7: Custom Monitor Exporter
  - Export metrics ra Prometheus, Datadog, custom

EP-O8: Custom Control Plane Transport
  - Ngoai in-process/IPC/network
  - E.g. message queue (Kafka, RabbitMQ)

EP-O9: Plugin System
  - Bundle nhieu extensions thanh 1 plugin
  - Install/uninstall tai runtime
```

### 8.3 Extension Registration

```typescript
// Inner extensions
inner.registerTool(myCustomTool)
inner.registerLLMProvider('openai', openaiProvider)
inner.registerCompactionStrategy('domain-aware', myStrategy)

// Outer extensions
outer.permissions.addRuleLayer('database', 5, databaseRules)
outer.hooks.registerType('kafka', kafkaHookExecutor)
outer.output.addStage('compliance', 2.5, complianceChecker)  // Between validate(2) and filter(3)
outer.output.addFilter('custom-pii', customPiiFilter)
outer.output.addTransform('brand', brandFormatter)
outer.alerts.addChannel('teams', teamsNotifier)
outer.monitor.addExporter('datadog', datadogExporter)
```

---

## 9. Deployment Topologies

### 9.1 Topology 1: Embedded (default)

```
+-------------------------------------------+
| Single Process                            |
|                                           |
|  [Outer Harness]                          |
|    |                                      |
|    | Control Plane (in-process, direct)    |
|    |                                      |
|  [Inner Harness]                          |
|    |                                      |
|  [LLM API] -----> Anthropic/Bedrock/...   |
+-------------------------------------------+

Use case: CLI wrapping, local development
Pros: zero overhead, simple
Cons: no isolation
```

### 9.2 Topology 2: Sidecar

```
+-------------------+     +-------------------+
| Process 1         |     | Process 2         |
|                   |     |                   |
| [Inner Harness]   |     | [Outer Harness]   |
|   |               |<--->|   |               |
| [LLM API]        | IPC  | [Dashboard]      |
|                   |     | [Monitoring]      |
+-------------------+     +-------------------+

Use case: sandboxed agent, IDE integration
Pros: process isolation, Outer crash khong anh huong Inner
Cons: IPC overhead, serialization cost
```

### 9.3 Topology 3: Centralized Gateway

```
+------------------+
| Central Outer    |
| Harness Server   |
|                  |
| [Permission]     |
| [Monitoring]     |
| [Dashboard]      |
| [Config Store]   |
+--------+---------+
         |
    AWOCP (gRPC/WS)
    _____|_____
   |     |     |
+--+--+ +-+--+ +-+--+
|Inner| |Inner| |Inner|
|  1  | |  2  | |  3  |
+-----+ +-----+ +-----+

Use case: enterprise, team of developers
Pros: centralized governance, single dashboard
Cons: network dependency, single point of failure
```

### 9.4 Topology 4: Mesh

```
+--------+     +--------+     +--------+
| Agent 1|<--->| Agent 2|<--->| Agent 3|
| +Inner |     | +Inner |     | +Inner |
| +Outer |     | +Outer |     | +Outer |
+---+----+     +---+----+     +---+----+
    |              |              |
    +------+-------+------+------+
           |              |
    +------v------+ +-----v------+
    | Central     | | Monitoring |
    | Config      | | Dashboard  |
    +-------------+ +------------+

Use case: multi-agent system, microservices
Pros: resilient, scalable
Cons: complex, eventually consistent config
```

---

## 10. Error Propagation & Fault Isolation

### 10.1 Nguyen tac

```
RULE 1: Inner errors KHONG crash Outer
  Inner goi LLM fail -> Inner retry -> Inner emit error event -> Outer log
  Inner KHONG throw exception len Outer

RULE 2: Outer errors KHONG crash Inner
  Outer hook fail -> timeout -> default decision -> Inner continues
  Outer dashboard crash -> Inner khong biet, tiep tuc chay

RULE 3: Control Plane timeout = default decision
  Permission timeout -> deny (fail-closed) hoac allow (fail-open)
  Output gate timeout -> approve (fail-open)
  Hook timeout -> passthrough

RULE 4: Errors propagate via events, KHONG via exceptions
  Inner: emit({ type: 'error', error, recoverable })
  Outer: onEvent(error) -> log, alert, maybe send command to abort
```

### 10.2 Fault Isolation Diagram

```
+---------------------------------------------------------------------+
|  FAULT DOMAIN A: Inner Harness                                      |
|                                                                     |
|  LLM API errors    --> RecoveryManager handles (retry, fallback)    |
|  Tool errors       --> ToolExecutor catches, return error result    |
|  Context overflow   --> ContextWindowManager compacts               |
|  Parse errors       --> ResponseParser returns safe default         |
|                                                                     |
|  Unrecoverable     --> emit('error', { recoverable: false })        |
|                     --> set state = 'error'                         |
|                     --> Outer gets event, decides next action        |
+---------------------------------------------------------------------+
        |  (events, NO exceptions)
        v
+---------------------------------------------------------------------+
|  FAULT DOMAIN B: Control Plane                                      |
|                                                                     |
|  Interceptor timeout   --> return default decision                  |
|  Command bus full      --> drop oldest commands, warn               |
|  Event bus overflow    --> drop oldest events (ring buffer)         |
|  Serialization error   --> log, skip event                          |
+---------------------------------------------------------------------+
        |  (events, NO exceptions)
        v
+---------------------------------------------------------------------+
|  FAULT DOMAIN C: Outer Harness                                      |
|                                                                     |
|  Hook crash       --> catch, return passthrough, log error          |
|  Dashboard crash  --> restart, no impact on agent                   |
|  Permission error --> default deny (fail-closed)                    |
|  Output pipeline error --> approve raw output (fail-open)           |
|  Database error   --> use cached config, warn                       |
|  Alert channel fail --> log locally, retry later                    |
+---------------------------------------------------------------------+
```

---

## 11. Sequence Diagrams

### 11.1 Normal Turn (tool call + output)

```
User        Outer:InputGate   Inner:AgentLoop   Inner:LLM   Inner:Tool   Outer:Permission   Outer:Hooks   Outer:OutputPipeline   Outer:Monitor
 |               |                  |               |            |              |                 |                |                    |
 |--input------->|                  |               |            |              |                 |                |                    |
 |               |--InputDecision-->|               |            |              |                 |                |                    |
 |               |  {pass}          |               |            |              |                 |                |                    |
 |               |                  |--request----->|            |              |                 |                |                    |
 |               |                  |               |            |              |                 |                |                    |
 |               |                  |<--stream------|            |              |                 |                |                    |
 |               |                  |  (text+tool_use)           |              |                 |                |                    |
 |               |                  |               |            |              |                 |                |                    |
 |               |                  |              emit('llm:stream_end')       |                 |                |                    |
 |               |                  |               |            |              |                 |                |                    |
 |               |                  |------intercept('tool_request')----------->|                 |                |                    |
 |               |                  |              {name:"Grep", input:{...}}   |                 |                |                    |
 |               |                  |<-----ToolDecision { allow }--------------|                 |                |                    |
 |               |                  |               |            |              |                 |                |                    |
 |               |                  |             emit('tool:requested')--------|-->hooks(Pre)--->|                |                    |
 |               |                  |               |            |              |                 |                |                    |
 |               |                  |               |            |<--HookResult: passthrough------|                |                    |
 |               |                  |               |            |              |                 |                |                    |
 |               |                  |--execute----->|            |              |                 |                |                    |
 |               |                  |               |  (running) |              |                 |                |                    |
 |               |                  |<--result------|            |              |                 |                |                    |
 |               |                  |               |            |              |                 |                |                    |
 |               |                  |             emit('tool:completed')--------|-->hooks(Post)-->|                |                    |
 |               |                  |               |            |              |                 |                |                    |
 |               |                  | (thread messages, loop back, LLM returns text only)        |                |                    |
 |               |                  |               |            |              |                 |                |                    |
 |               |                  |------intercept('output_ready')------------------------------>|                |                    |
 |               |                  |              { text: "I found..." }       |                 |                |                    |
 |               |                  |<-----OutputDecision { approve, transformed }----------------|                |                    |
 |               |                  |               |            |              |                 |                |                    |
 |<----output----|                  |               |            |              |                 |                |                    |
 |  (to user)    |                  |               |            |              |                 |                |                    |
 |               |                  |             emit('terminal')------------------------------------------------>|
 |               |                  |               |            |              |                 |                |  (log metrics, save)|
```

### 11.2 Permission Denied + Agent Adjusts

```
Inner:AgentLoop     Outer:Permission      Outer:Monitor
      |                    |                    |
      |--intercept-------->|                    |
      | tool: Bash         |                    |
      | cmd: "rm -rf /"    |                    |
      |                    |                    |
      |  (match: DENY      |                    |
      |   "Bash(rm -rf *)") |                    |
      |                    |                    |
      |<--ToolDecision-----|                    |
      | { deny, reason }   |----event---------->|
      |                    | (permission:denied) |
      |                    |                    |
      | (create error      |                    |
      |  tool_result,      |                    |
      |  thread messages,  |                    |
      |  continue loop)    |                    |
      |                    |                    |
      |--LLM call--------->                     |
      | (LLM sees denied,  |                    |
      |  tries safe cmd)   |                    |
      |                    |                    |
      |--intercept-------->|                    |
      | tool: Bash         |                    |
      | cmd: "rm test.ts"  |                    |
      |                    |                    |
      |<--ToolDecision-----|                    |
      | { allow }          |                    |
      |                    |                    |
```

### 11.3 Output Pipeline Full Flow

```
Inner:Terminal   Outer:Intercept   Outer:Validate   Outer:Filter   Outer:Transform   Outer:Review   Outer:Deliver
      |                |               |               |               |                |              |
      |--RawOutput---->|               |               |               |                |              |
      |                |               |               |               |                |              |
      |                |--validate---->|               |               |                |              |
      |                |               |               |               |                |              |
      |                |               | check schema  |               |                |              |
      |                |               | check safety  |               |                |              |
      |                |               | check quality |               |                |              |
      |                |               |               |               |                |              |
      |                |<--PASS--------|               |               |                |              |
      |                |               |               |               |                |              |
      |                |--filter---------------------->|               |                |              |
      |                |               |               |               |                |              |
      |                |               |               | PII redact    |                |              |
      |                |               |               | secret redact |                |              |
      |                |               |               |               |                |              |
      |                |<--filtered----|---------------|               |                |              |
      |                |               |               |               |                |              |
      |                |--transform----|---------------|-------------->|                |              |
      |                |               |               |               |                |              |
      |                |               |               |               | add footer     |              |
      |                |               |               |               | format code    |              |
      |                |               |               |               |                |              |
      |                |<--transformed-|---------------|---------------|                |              |
      |                |               |               |               |                |              |
      |                |--review-------|---------------|---------------|--------------->|              |
      |                |               |               |               |                |              |
      |                |               |               |               |                | risk < 0.3   |
      |                |               |               |               |                | auto-approve |
      |                |               |               |               |                |              |
      |                |<--approved----|---------------|---------------|----------------|              |
      |                |               |               |               |                |              |
      |                |--deliver------|---------------|---------------|----------------|------------>|
      |                |               |               |               |                |              |
      |                |               |               |               |                |         [User]
```

---

## 12. Component Registry

### 12.1 Inner Harness Components

| Component | Trach nhiem | Input | Output | Dependencies |
|---|---|---|---|---|
| **AgentLoop** | State machine chinh | UserInput | TerminalResult | All Inner components |
| **LLMCaller** | Goi LLM API, streaming | Messages, Tools, System | Stream of events | Infrastructure Layer |
| **ResponseParser** | Parse LLM response | Raw stream | AssistantMessage, ToolUseBlocks | None |
| **ToolExecutor** | Chay tools (serial/concurrent) | ToolUseBlocks | ToolResults | Tool Registry |
| **MessageThreader** | Quan ly message array | Messages + new msgs | Updated messages | None |
| **SystemPromptBuilder** | Tao system prompt | Config, Tools, Context | SystemPrompt string | None |
| **ContextWindowManager** | Theo doi & nen context | Messages, TokenCount | Compacted messages | LLMCaller (for summary) |
| **TokenCounter** | Dem tokens, tinh cost | Usage events | TokenUsage | None |
| **RecoveryManager** | Xu ly loi, retry, fallback | Errors | Recovery actions | LLMCaller |
| **ControlPlaneAdapter** | Bridge to Control Plane | Inner events | Outer decisions | ControlPlane |

### 12.2 Outer Harness Components

| Component | Trach nhiem | Input | Output | Dependencies |
|---|---|---|---|---|
| **InputGate** | Validate/transform input | UserInput | InputDecision | Config |
| **PermissionEngine** | Quyet dinh tool permissions | ToolRequest | ToolDecision | Config, Classifier |
| **HookEngine** | Chay hooks tai events | HookEvent | HookResult | Config, Shell, LLM |
| **OutputPipeline** | 6-stage output processing | RawOutput | OutputDecision | Config, Filters, Transforms |
| **ToolGovernor** | Wrap tools voi governance | ToolExecution | Governed execution | Config |
| **BudgetManager** | Theo doi & enforce budget | Usage events | Budget alerts | Config |
| **MonitorCollector** | Thu thap metrics | All events | Metrics, Traces | Storage |
| **AlertEngine** | Evaluate alert conditions | Metrics | Alerts | Config, Channels |
| **AuditLogger** | Ghi immutable log | All decisions | Audit entries | Storage |
| **SessionManager** | Persist/resume sessions | Session events | Transcripts | Storage |
| **MultiAgentOrchestrator** | Quan ly sub-agents | Agent events | Orchestration decisions | PermissionEngine, BudgetManager |
| **ConfigHierarchy** | Merge configs tu nhieu source | Config files | Effective config | File system |
| **AWOCPServer** | Expose Control Plane ra network | AWOCP messages | AWOCP responses | ControlPlane |

### 12.3 Control Plane Components

| Component | Trach nhiem | Direction |
|---|---|---|
| **EventBus** | Route events tu Inner den Outer subscribers | Inner -> Outer |
| **CommandBus** | Route commands tu Outer den Inner handler | Outer -> Inner |
| **InterceptorRegistry** | Manage interceptors (tool_request, output, input) | Bidirectional (blocking) |
| **StateQueryProxy** | Read-only view cua Inner state cho Outer | Outer -> Inner (read) |

---

## 13. Design Decisions & Trade-offs

### 13.1 Decision Log

| # | Decision | Alternatives Considered | Rationale |
|---|---|---|---|
| D1 | **Async Generator** cho agent loop | Callback hell, EventEmitter, Observable | Natural fit for streaming + tool loop. Caller controls consumption rate. Backpressure built-in. |
| D2 | **Interceptor pattern** (blocking) cho permission & output gate | Pub/sub (non-blocking), middleware chain | Permission PHAI blocking — agent khong duoc chay tool khi chua co phep. Pub/sub khong dam bao ordering. |
| D3 | **Event bus** (non-blocking) cho monitoring | Interceptor (blocking), polling | Monitoring KHONG duoc lam cham agent. Fire-and-forget la dung. |
| D4 | **Control Plane la separate layer** | Merge vao Inner hoac Outer | Cho phep swap Inner/Outer doc lap. Testable. Clear contract. |
| D5 | **Fail-open default** cho output gate | Fail-closed | Developer UX: agent khong nen dung lai vi outer bug. Enterprise co the switch sang fail-closed. |
| D6 | **Fail-closed default** cho permission | Fail-open | Safety: neu khong biet co duoc phep khong, mac dinh la KHONG. |
| D7 | **JSONL** cho transcript | SQLite, JSON file, Protobuf | Append-only (fast write), streamable (fast read), human-readable, grep-able. |
| D8 | **6-stage output pipeline** | Single validate function, middleware chain | Separation of concerns: moi stage 1 job. Dang ky stage tai runtime. Bypass tung stage duoc. |
| D9 | **In-process default** cho Control Plane | Always IPC/network | Zero overhead cho common case (CLI). Upgrade len IPC/network khi can. |
| D10 | **Inner Harness is replaceable** | Tight coupling voi Claude Code | Framework phai support nhieu agent backends. Vendor lock-in la anti-pattern. |

### 13.2 Trade-offs

```
TRADE-OFF 1: Latency vs Safety
  Problem: Moi interceptor call them latency (permission check, output validation)
  Choice: Configurable — passthrough mode (0 latency) vs sync mode (full safety)
  Mitigation: Parallel hook execution, caching permission decisions

TRADE-OFF 2: Observability vs Privacy
  Problem: Full trace = full data (including secrets, PII)
  Choice: Redaction by default, configurable verbosity
  Mitigation: Audit logger co redact patterns, trace co retention policy

TRADE-OFF 3: Control vs UX
  Problem: Nhieu gates = nhieu lan doi, UX kem
  Choice: Smart defaults — auto-approve low-risk, chi ask high-risk
  Mitigation: ML classifier, contextual rules, per-tool risk scoring

TRADE-OFF 4: Flexibility vs Complexity
  Problem: 5 hook types x 20 events x 6 output stages = rat nhieu config
  Choice: Sensible defaults, progressive disclosure
  Mitigation: Starter templates, wizard, "just works" out of box

TRADE-OFF 5: Inner Independence vs Outer Power
  Problem: Inner co the bypass Outer neu no muon
  Choice: Trust boundary — Inner MUST goi interceptor, enforced by interface
  Mitigation: Compliance testing, audit trail detect bypass
```

### 13.3 Non-Goals (Nhung gi framework KHONG lam)

```
1. KHONG implement LLM model — dung Anthropic/OpenAI/etc. API
2. KHONG implement tool logic — dung existing tools hoac user-defined
3. KHONG implement UI framework — dung React/Ink/web framework
4. KHONG replace CI/CD — integrate voi existing CI/CD
5. KHONG la monitoring platform — export metrics den Grafana/Datadog
6. KHONG la auth system — integrate voi existing SSO/RBAC
7. KHONG enforce 1 agent architecture — support any agent pattern
```

---

## Appendix A: Glossary

| Term | Layer | Dinh nghia |
|---|---|---|
| **Inner Harness** | Layer 2 | Execution engine: LLM + tools + loop |
| **Outer Harness** | Layer 4-5 | Governance: permissions + hooks + output control + monitoring |
| **Control Plane** | Layer 3 | Interface giua Inner va Outer |
| **Data Plane** | All | Dong du lieu thuc te di qua system |
| **Event Bus** | Control Plane | Non-blocking event routing (Inner -> Outer) |
| **Command Bus** | Control Plane | Async command routing (Outer -> Inner) |
| **Interceptor** | Control Plane | Blocking decision point (bidirectional) |
| **Gate** | Outer | Decision point: pass/block/modify (Input Gate, Output Gate, Tool Gate) |
| **Pipeline** | Outer | Multi-stage processing chain (Output Pipeline) |
| **Hook** | Outer | Automation script chay tai event |
| **Trace** | Outer | Full record cua 1 session |
| **Fault Domain** | Architecture | Vung cach ly loi — loi trong 1 domain khong lan sang domain khac |

## Appendix B: File Structure (Proposed)

```
agentweave/
├── packages/
│   ├── core/                          # Shared types, Control Plane interface
│   │   ├── src/
│   │   │   ├── types/                 # InnerEvent, OuterCommand, decisions...
│   │   │   ├── control-plane/         # EventBus, CommandBus, Interceptors
│   │   │   └── index.ts
│   │   └── package.json
│   │
│   ├── inner-harness/                 # Inner Harness (execution engine)
│   │   ├── src/
│   │   │   ├── agent-loop/            # AgentLoop state machine
│   │   │   ├── llm/                   # LLMCaller, streaming, providers
│   │   │   ├── tools/                 # ToolExecutor, registry, partitioning
│   │   │   ├── context/               # ContextWindowManager, compaction
│   │   │   ├── messages/              # MessageThreader, normalization
│   │   │   ├── prompt/                # SystemPromptBuilder, sections
│   │   │   ├── recovery/              # RecoveryManager, retry, fallback
│   │   │   ├── tokens/                # TokenCounter, cost calculation
│   │   │   └── index.ts
│   │   └── package.json
│   │
│   ├── outer-harness/                 # Outer Harness (governance)
│   │   ├── src/
│   │   │   ├── governance/
│   │   │   │   ├── permission/        # PermissionEngine, rules, classifier
│   │   │   │   ├── hooks/             # HookEngine, 5 hook types
│   │   │   │   ├── output-pipeline/   # 6 stages, filters, transforms
│   │   │   │   ├── input-gate/        # Input validation, transformation
│   │   │   │   ├── tool-governor/     # Rate limit, sandbox, audit
│   │   │   │   └── budget/            # BudgetManager
│   │   │   ├── observability/
│   │   │   │   ├── monitor/           # MetricsCollector
│   │   │   │   ├── alerts/            # AlertEngine
│   │   │   │   ├── audit/             # AuditLogger
│   │   │   │   └── traces/            # TraceManager
│   │   │   ├── orchestration/
│   │   │   │   ├── session/           # SessionManager
│   │   │   │   ├── multi-agent/       # MultiAgentOrchestrator
│   │   │   │   └── config/            # ConfigHierarchy
│   │   │   └── index.ts
│   │   └── package.json
│   │
│   ├── protocol/                      # AWOCP protocol definitions
│   │   ├── src/
│   │   │   ├── messages.ts            # Message types
│   │   │   ├── server.ts              # WebSocket/gRPC server
│   │   │   ├── client.ts              # WebSocket/gRPC client
│   │   │   └── transports/            # WS, gRPC, HTTP, stdio, unix
│   │   └── package.json
│   │
│   ├── sdk/                           # Public SDK
│   │   ├── src/
│   │   │   └── index.ts              # createHarness(), AgentWeave class
│   │   └── package.json
│   │
│   ├── cli/                           # CLI interface
│   │   ├── src/
│   │   │   ├── commands/              # run, wrap, monitor, dashboard...
│   │   │   └── dashboard/             # TUI dashboard (Ink)
│   │   └── package.json
│   │
│   └── web-dashboard/                 # Web UI
│       ├── src/
│       └── package.json
│
├── adapters/                          # Inner Harness adapters
│   ├── claude-code/                   # Adapter cho Claude Code
│   ├── aider/                         # Adapter cho Aider
│   ├── codex/                         # Adapter cho Codex
│   └── custom/                        # Template cho custom agent
│
├── plugins/                           # Official plugins
│   ├── plugin-slack/
│   ├── plugin-github/
│   ├── plugin-grafana/
│   └── plugin-pagerduty/
│
└── examples/
    ├── basic/                         # Minimal setup
    ├── enterprise/                    # Full governance
    ├── multi-agent/                   # Coordinator pattern
    └── custom-inner/                  # Custom Inner Harness
```
