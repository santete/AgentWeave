# Scenario B — Implementation Guide

> Custom Inner Harness (built from SDK) + AgentWeave Outer Harness
> Day la tai lieu cuoi cung truoc khi bat tay vao code.
> Ket hop voi: architecture doc (layers), product spec (features), harness engineering (patterns).

---

## Muc luc

1.  [Tech Stack Decision](#1-tech-stack-decision)
2.  [Monorepo Structure](#2-monorepo-structure)
3.  [Dependency Graph](#3-dependency-graph)
4.  [Package 1: @agentweave/types — Shared Contracts](#4-package-1-agentweavetypes)
5.  [Package 2: @agentweave/control-plane — Core Bus](#5-package-2-agentweavecontrol-plane)
6.  [Package 3: @agentweave/inner-harness — Execution Engine](#6-package-3-agentweaveinner-harness)
7.  [Package 4: @agentweave/outer-harness — Governance Layer](#7-package-4-agentweaveouter-harness)
8.  [Package 5: @agentweave/sdk — Public API](#8-package-5-agentweavesdk)
9.  [Package 6: @agentweave/cli — CLI Interface](#9-package-6-agentweavecli)
10. [Data Schemas (Zod)](#10-data-schemas-zod)
11. [Control Plane — Concrete Implementation](#11-control-plane--concrete-implementation)
12. [Inner Harness — Reference Implementation](#12-inner-harness--reference-implementation)
13. [Outer Harness — Module-by-Module Build](#13-outer-harness--module-by-module-build)
14. [Adapter Interface — Plug Any Inner](#14-adapter-interface--plug-any-inner)
15. [Build Order & MVP Scope](#15-build-order--mvp-scope)
16. [Test Strategy](#16-test-strategy)
17. [Configuration Files](#17-configuration-files)
18. [End-to-End Walkthrough](#18-end-to-end-walkthrough)

---

## 1. Tech Stack Decision

### 1.1 Chon gi, tai sao

| Layer | Tech | Ly do |
|---|---|---|
| **Language** | TypeScript (strict, ESM) | Type-safe, shared types giua Inner/Outer, ecosystem lon |
| **Runtime** | Node.js 22+ (hoac Bun) | Stable, enterprise-ready, native ESM |
| **LLM SDK (Inner)** | Vercel AI SDK (`ai`) | Multi-provider, streaming-native, tool-calling built-in, TypeScript-first |
| **LLM Provider** | `@ai-sdk/anthropic` + `@ai-sdk/openai` | Swap model bat ky luc nao |
| **Validation** | Zod v3 | Schema = types = validation = JSON Schema (cho LLM tools) |
| **Monorepo** | pnpm workspaces + turborepo | Fast, reliable, dependency hoisting |
| **Build** | tsup (esbuild) | Fast, zero-config, ESM + CJS |
| **Test** | vitest | Fast, ESM-native, TypeScript-native |
| **CLI UI** | @clack/prompts | Lightweight interactive prompts |
| **Config** | cosmiconfig + YAML | Multi-format, hierarchy-aware |
| **Logging** | pino | Fast structured logging |
| **Metrics** | OpenTelemetry SDK | Vendor-neutral, export anywhere |

### 1.2 Tai sao Vercel AI SDK cho Inner?

```
1. streamText() — native streaming, async iterator
2. tool() — Zod schema -> JSON Schema tu dong
3. Multi-provider — Anthropic, OpenAI, Google, local (Ollama)
4. maxSteps — built-in agent loop (tool call -> result -> continue)
5. onStepFinish — hook vao moi step (= diem de Control Plane intercept)
6. TypeScript-first — shared types voi Outer
7. Lightweight — khong nhu LangChain (heavy, opinionated)
```

### 1.3 Tai sao KHONG dung

| Khong dung | Ly do |
|---|---|
| LangChain/LangGraph | Qua nang, opinionated, Python-centric, abstraction leak |
| Raw Anthropic SDK | Phai tu build agent loop, streaming, tool dispatch |
| CrewAI/AutoGen | Python-only, multi-agent-only, khong phu hop lam core |
| Ink (React terminal) | Qua nang cho CLI; @clack/prompts nhe hon |

---

## 2. Monorepo Structure

```
agentweave/
├── package.json                    # Root: pnpm workspace
├── pnpm-workspace.yaml
├── turbo.json                      # Turborepo pipeline
├── tsconfig.base.json              # Shared TS config
├── biome.json                      # Linter + formatter
│
├── packages/
│   ├── types/                      # @agentweave/types
│   │   ├── src/
│   │   │   ├── inner.ts            # InnerHarnessProvider interface
│   │   │   ├── outer.ts            # OuterHarnessConsumer interface
│   │   │   ├── control-plane.ts    # ControlPlane interface
│   │   │   ├── events.ts           # InnerEvent, OuterCommand types
│   │   │   ├── decisions.ts        # ToolDecision, OutputDecision, InputDecision
│   │   │   ├── messages.ts         # Message, ContentBlock types
│   │   │   ├── tools.ts            # ToolDefinition, ToolResult types
│   │   │   ├── hooks.ts            # HookEvent, HookResult, HookConfig
│   │   │   ├── permissions.ts      # PermissionRule, PermissionMode
│   │   │   ├── sessions.ts         # SessionInfo, SessionState
│   │   │   ├── config.ts           # HarnessConfig, SettingsSchema
│   │   │   ├── metrics.ts          # TokenUsage, SessionMetrics
│   │   │   └── index.ts            # Re-export all
│   │   ├── package.json
│   │   └── tsconfig.json
│   │
│   ├── control-plane/              # @agentweave/control-plane
│   │   ├── src/
│   │   │   ├── event-bus.ts        # EventBus implementation
│   │   │   ├── command-bus.ts      # CommandBus implementation
│   │   │   ├── interceptors.ts     # InterceptorRegistry
│   │   │   ├── state-proxy.ts      # StateQueryProxy
│   │   │   ├── factory.ts          # createControlPlane()
│   │   │   └── index.ts
│   │   ├── package.json
│   │   └── tsconfig.json
│   │
│   ├── inner-harness/              # @agentweave/inner-harness
│   │   ├── src/
│   │   │   ├── agent-loop.ts       # AgentLoop (wraps Vercel AI SDK)
│   │   │   ├── tool-registry.ts    # ToolRegistry
│   │   │   ├── tool-executor.ts    # ToolExecutor (partition, concurrent)
│   │   │   ├── message-store.ts    # MessageStore (threaded history)
│   │   │   ├── context-manager.ts  # ContextWindowManager
│   │   │   ├── token-counter.ts    # TokenCounter + cost
│   │   │   ├── prompt-builder.ts   # SystemPromptBuilder
│   │   │   ├── recovery.ts         # RetryManager, FallbackManager
│   │   │   ├── providers/
│   │   │   │   ├── anthropic.ts    # Anthropic provider config
│   │   │   │   ├── openai.ts       # OpenAI provider config
│   │   │   │   └── index.ts
│   │   │   ├── built-in-tools/
│   │   │   │   ├── bash.ts         # BashTool
│   │   │   │   ├── file-read.ts    # FileReadTool
│   │   │   │   ├── file-write.ts   # FileWriteTool
│   │   │   │   ├── file-edit.ts    # FileEditTool
│   │   │   │   ├── grep.ts         # GrepTool
│   │   │   │   ├── glob.ts         # GlobTool
│   │   │   │   └── index.ts
│   │   │   ├── adapter.ts          # InnerHarnessAdapter (plug into Control Plane)
│   │   │   └── index.ts
│   │   ├── package.json
│   │   └── tsconfig.json
│   │
│   ├── outer-harness/              # @agentweave/outer-harness
│   │   ├── src/
│   │   │   ├── governance/
│   │   │   │   ├── permission-engine.ts
│   │   │   │   ├── permission-rules.ts     # Rule matcher
│   │   │   │   ├── hook-engine.ts
│   │   │   │   ├── hook-executors/
│   │   │   │   │   ├── command-hook.ts
│   │   │   │   │   ├── prompt-hook.ts
│   │   │   │   │   ├── http-hook.ts
│   │   │   │   │   ├── function-hook.ts
│   │   │   │   │   └── index.ts
│   │   │   │   ├── input-gate.ts
│   │   │   │   ├── output-pipeline.ts
│   │   │   │   ├── output-stages/
│   │   │   │   │   ├── intercept.ts
│   │   │   │   │   ├── validate.ts
│   │   │   │   │   ├── filter.ts
│   │   │   │   │   ├── transform.ts
│   │   │   │   │   ├── review.ts
│   │   │   │   │   └── deliver.ts
│   │   │   │   ├── tool-governor.ts
│   │   │   │   └── budget-manager.ts
│   │   │   ├── observability/
│   │   │   │   ├── monitor-collector.ts
│   │   │   │   ├── alert-engine.ts
│   │   │   │   ├── audit-logger.ts
│   │   │   │   └── trace-manager.ts
│   │   │   ├── orchestration/
│   │   │   │   ├── session-manager.ts
│   │   │   │   ├── config-hierarchy.ts
│   │   │   │   └── multi-agent.ts
│   │   │   ├── consumer.ts          # OuterHarnessConsumer implementation
│   │   │   └── index.ts
│   │   ├── package.json
│   │   └── tsconfig.json
│   │
│   ├── sdk/                        # @agentweave/sdk
│   │   ├── src/
│   │   │   ├── agentweave.ts       # Main class: createHarness()
│   │   │   ├── builder.ts          # Fluent builder API
│   │   │   └── index.ts
│   │   ├── package.json
│   │   └── tsconfig.json
│   │
│   └── cli/                        # @agentweave/cli
│       ├── src/
│       │   ├── bin.ts              # Entry point
│       │   ├── commands/
│       │   │   ├── run.ts
│       │   │   ├── monitor.ts
│       │   │   ├── session.ts
│       │   │   └── config.ts
│       │   └── dashboard/
│       │       └── tui.ts          # Terminal dashboard
│       ├── package.json
│       └── tsconfig.json
│
├── tools/                          # Addon tool packages
│   └── mcp/                        # @agentweave/tools-mcp
│       └── ...
│
├── examples/
│   ├── basic/                      # Minimal: Inner + Outer, 1 file
│   ├── with-hooks/                 # Hooks example
│   ├── with-output-control/        # Output pipeline example
│   ├── multi-agent/                # Coordinator pattern
│   └── enterprise/                 # Full governance
│
└── docs/
    ├── knowledge_base_claude_code.md
    ├── harness_engineering.md
    ├── product_spec_agent_harness_framework.md
    ├── architecture_agent_harness_framework.md
    └── scenario_b_implementation_guide.md     # (THIS FILE)
```

---

## 3. Dependency Graph

```
@agentweave/cli
  └── @agentweave/sdk
        └── @agentweave/outer-harness
        │     └── @agentweave/control-plane
        │     │     └── @agentweave/types
        │     └── @agentweave/types
        └── @agentweave/inner-harness
        │     └── @agentweave/control-plane
        │     │     └── @agentweave/types
        │     └── @agentweave/types
        │     └── ai (Vercel AI SDK)
        │     └── @ai-sdk/anthropic
        │     └── @ai-sdk/openai
        └── @agentweave/control-plane
        └── @agentweave/types

Quy tac:
  - types KHONG depend vao bat ky package nao khac (leaf node)
  - control-plane CHI depend vao types
  - inner-harness depend vao control-plane + types + external SDK
  - outer-harness depend vao control-plane + types (KHONG depend inner)
  - sdk depend vao tat ca (assembly point)
  - cli depend vao sdk
```

```
Build order (tu leaf len root):

  [1] @agentweave/types           # Khong dependency noi bo
  [2] @agentweave/control-plane   # Chi depend types
  [3] @agentweave/inner-harness   # Depend types + control-plane
  [3] @agentweave/outer-harness   # Depend types + control-plane (SONG SONG voi inner)
  [4] @agentweave/sdk             # Depend tat ca
  [5] @agentweave/cli             # Depend sdk
```

---

## 4. Package 1: @agentweave/types

### 4.1 Muc dich

Shared type contracts giua Inner va Outer. **Khong co logic, chi co types va Zod schemas.**

### 4.2 Key Files

#### `inner.ts` — Inner Harness Provider Interface

```typescript
import type { ContentBlock, Message } from './messages'
import type { InnerEvent, TerminalResult } from './events'
import type { ToolDefinition } from './tools'
import type { TokenUsage, ContextUsage } from './metrics'
import type { InjectableMessage, InnerConfig, InnerState } from './state'

/**
 * Contract ma BAT KY Inner Harness nao phai implement.
 * Outer Harness chi biet Inner qua interface nay.
 */
export interface InnerHarnessProvider {
  /** Chay agent. Yield events cho Control Plane. */
  run(
    prompt: string | ContentBlock[],
    options?: RunOptions,
  ): AsyncGenerator<InnerEvent, TerminalResult, void>

  /** Abort immediately. */
  abort(reason?: string): void

  /** Read-only state. */
  getState(): InnerState
  getMessages(): ReadonlyArray<Message>
  getContextUsage(): ContextUsage
  getUsage(): TokenUsage
  getTools(): ReadonlyArray<ToolDefinition>

  /** Runtime modifications. */
  registerTool(tool: ToolDefinition): void
  unregisterTool(name: string): void
  injectMessage(message: InjectableMessage): void
  setSystemPromptSection(name: string, content: string | null): void
  setModel(model: string): void
  getConfig(): InnerConfig
}

export interface RunOptions {
  /** Override model cho lan chay nay. */
  model?: string
  /** Max turns truoc khi tu dong dung. */
  maxTurns?: number
  /** Max USD budget. */
  maxBudgetUsd?: number
  /** Max tokens (input + output). */
  maxTokens?: number
  /** Timeout toan bo session (ms). */
  timeoutMs?: number
  /** Pre-loaded messages (resume session). */
  initialMessages?: Message[]
  /** AbortSignal tu caller. */
  signal?: AbortSignal
}
```

#### `outer.ts` — Outer Harness Consumer Interface

```typescript
import type { InnerEvent } from './events'
import type {
  ToolDecision,
  OutputDecision,
  InputDecision,
  ToolRequest,
  RawOutput,
  UserInput,
} from './decisions'
import type { HookEvent, HookResult } from './hooks'
import type { SessionInfo, TerminalResult } from './sessions'

/**
 * Contract ma Outer Harness implement.
 * Inner Harness goi cac method nay QUA Control Plane (khong truc tiep).
 */
export interface OuterHarnessConsumer {
  /**
   * BLOCKING: Quyet dinh co cho tool chay khong.
   *
   * Flow noi bo:
   *   1. PermissionEngine.evaluate() --> PermissionDecision
   *   2. Neu 'allow'/'deny' --> tra ve ToolDecision ngay
   *   3. Neu 'ask' --> UserInteractionGate.waitForResponse(askMessage, timeout)
   *      --> user tra loi --> resolve thanh ToolDecision (allow/deny)
   *      --> timeout --> dung failMode default
   *
   * Inner Harness KHONG biet ve 'ask' — no chi nhan ToolDecision (allow/deny).
   * Outer Harness chiu trach nhiem resolve 'ask' thanh final decision.
   */
  onToolRequested(request: ToolRequest): Promise<ToolDecision>

  /** BLOCKING (configurable): Quyet dinh ve output. */
  onOutputReady(output: RawOutput): Promise<OutputDecision>

  /** BLOCKING: Quyet dinh ve input. */
  onInputReceived(input: UserInput): Promise<InputDecision>

  /** NON-BLOCKING: Nhan event tu Inner. */
  onEvent(event: InnerEvent): void

  /** SEMI-BLOCKING: Chay hooks, co timeout. */
  executeHooks(event: HookEvent): Promise<HookResult>

  /** Lifecycle. */
  onSessionStart(session: SessionInfo): Promise<void>
  onSessionEnd(session: SessionInfo, result: TerminalResult): Promise<void>
}
```

#### `control-plane.ts` — Control Plane Interface

```typescript
import type { InnerEvent, OuterCommand, CommandAck } from './events'

export type InterceptType = 'tool_request' | 'output_ready' | 'input_received'

export interface ControlPlane {
  // Event Bus (Inner -> Outer, non-blocking)
  emit(event: InnerEvent): void
  subscribe(type: string | '*', handler: (event: InnerEvent) => void): () => void

  // Command Bus (Outer -> Inner, async)
  sendCommand(command: OuterCommand): Promise<CommandAck>
  onCommand(handler: (command: OuterCommand) => Promise<CommandAck>): void

  // Interceptors (bidirectional, blocking with timeout)
  intercept<T extends InterceptType>(
    type: T,
    request: InterceptRequest[T],
  ): Promise<InterceptResponse[T]>
  registerInterceptor<T extends InterceptType>(
    type: T,
    handler: (req: InterceptRequest[T]) => Promise<InterceptResponse[T]>,
  ): void

  // Lifecycle
  destroy(): void
}
```

#### `events.ts` — Event & Command Types

```typescript
export type InnerEvent = {
  id: string                // nanoid
  timestamp: number         // Date.now()
  sessionId: string
  agentId: string
} & InnerEventPayload

export type InnerEventPayload =
  // Turn lifecycle
  | { type: 'turn:start'; turnIndex: number }
  | { type: 'turn:end'; turnIndex: number; stopReason: string }
  // LLM streaming
  | { type: 'llm:request_start'; model: string; estimatedInputTokens: number }
  | { type: 'llm:stream_delta'; delta: string; blockType: 'text' | 'thinking' | 'tool_use' }
  | { type: 'llm:stream_end'; usage: TokenUsage; stopReason: string }
  // Tool lifecycle
  | { type: 'tool:requested'; toolName: string; toolInput: unknown; toolUseId: string }
  | { type: 'tool:started'; toolUseId: string }
  | { type: 'tool:completed'; toolUseId: string; result: unknown; durationMs: number }
  | { type: 'tool:failed'; toolUseId: string; error: string; durationMs: number }
  // Permission (phat ra boi Outer, Inner observe de biet tool bi block)
  | { type: 'permission:allowed'; toolName: string; toolUseId: string; source: string }
  | { type: 'permission:denied'; toolName: string; toolUseId: string; reason: string; source: string }
  | { type: 'permission:asking'; toolName: string; toolUseId: string; askMessage: string }
  | { type: 'permission:ask_resolved'; toolName: string; toolUseId: string; behavior: 'allow' | 'deny'; source: string }
  | { type: 'permission:ask_timeout'; toolName: string; toolUseId: string; fallback: 'allow' | 'deny' }
  // Messages
  | { type: 'message:assistant'; content: ContentBlock[] }
  | { type: 'message:tool_result'; toolUseId: string; content: string; isError: boolean }
  // Context
  | { type: 'context:compacted'; freedTokens: number }
  | { type: 'context:usage'; usedTokens: number; maxTokens: number }
  // Recovery
  | { type: 'recovery:retry'; reason: string; attempt: number }
  | { type: 'recovery:fallback'; fromModel: string; toModel: string }
  // Terminal
  | { type: 'terminal'; reason: TerminalReason; usage: TokenUsage }
  | { type: 'error'; error: string; recoverable: boolean }

export type OuterCommand =
  | { type: 'pause' }
  | { type: 'resume' }
  | { type: 'abort'; reason?: string }
  | { type: 'inject'; message: InjectableMessage }
  | { type: 'set_model'; model: string }
  | { type: 'set_max_turns'; maxTurns: number }
  | { type: 'set_budget'; budgetUsd: number }
  | { type: 'force_compact' }

export type CommandAck = {
  accepted: boolean
  reason?: string
}
```

#### `decisions.ts` — Gate Decisions

```typescript
/**
 * PERMISSION DECISION (tu Permission Engine)
 *
 * Co 3 behaviors: allow, deny, ask.
 * 'ask' nghia la Permission Engine khong tu quyet dinh duoc,
 * can hoi user/reviewer.
 */
export type PermissionDecision = {
  behavior: 'allow' | 'deny' | 'ask'
  reason: string
  source: string        // 'rule:policy', 'rule:project', 'hook', 'classifier'
  modifiedInput?: unknown
  riskScore?: number
  /** Chi co khi behavior='ask': message hien thi cho user */
  askMessage?: string
  /** Chi co khi behavior='ask': goi y update rules (e.g. "Always allow git commands") */
  suggestions?: PermissionUpdate[]
}

/**
 * TOOL DECISION (ket qua cuoi cung tra ve cho Inner Harness)
 *
 * Chi co 2 behaviors: allow hoac deny.
 * 'ask' da duoc resolve thanh allow/deny SAU KHI user tra loi.
 *
 * Flow:
 *   PermissionEngine.evaluate() --> PermissionDecision (allow|deny|ask)
 *     |
 *     +-- allow/deny --> ToolDecision (tra ve ngay)
 *     +-- ask --> UserInteractionGate.waitForResponse() --> ToolDecision
 */
export type ToolDecision = {
  behavior: 'allow' | 'deny'
  modifiedInput?: unknown
  reason: string
  source: string        // 'rule:policy', 'rule:project', 'hook', 'classifier', 'user'
  /** True neu decision den tu user tra loi 'ask' prompt */
  resolvedFromAsk?: boolean
  /** Feedback tu user khi chap nhan (e.g. "Always allow this") */
  userFeedback?: string
}

export type PermissionUpdate = {
  pattern: string           // "Bash(git *)"
  behavior: 'allow' | 'deny'
  scope: 'session' | 'project' | 'user'
}

/**
 * ASK FLOW — Sequence Diagram:
 *
 * Inner Harness          Control Plane         Outer Harness              User/UI
 *     |                       |                     |                        |
 *     |-- tool:requested ---->|                     |                        |
 *     |                       |-- intercept ------->|                        |
 *     |                       |                     |                        |
 *     |                       |            PermissionEngine.evaluate()       |
 *     |                       |                     | --> behavior: 'ask'    |
 *     |                       |                     |                        |
 *     |                       |            UserInteractionGate              |
 *     |                       |                     |-- show prompt -------->|
 *     |                       |                     |   "Allow Bash(git     |
 *     |                       |                     |    push origin main)?" |
 *     |                       |                     |   [Allow] [Deny]      |
 *     |                       |                     |   [Always Allow]      |
 *     |                       |                     |   [Edit Input]        |
 *     |                       |                     |                        |
 *     |                       |                     |   (RACE: nhieu nguon   |
 *     |                       |                     |    co the tra loi:     |
 *     |                       |                     |    terminal, IDE,      |
 *     |                       |                     |    webhook, hook)      |
 *     |                       |                     |                        |
 *     |                       |                     |<--- user: "Allow" -----|
 *     |                       |                     |     (+ optional:       |
 *     |                       |                     |      "Always allow     |
 *     |                       |                     |       git commands")   |
 *     |                       |                     |                        |
 *     |                       |            Resolve: ToolDecision {          |
 *     |                       |              behavior: 'allow',             |
 *     |                       |              source: 'user',                |
 *     |                       |              resolvedFromAsk: true,         |
 *     |                       |              userFeedback: "Always allow"   |
 *     |                       |            }                                |
 *     |                       |                     |                        |
 *     |                       |            (optional: persist rule)          |
 *     |                       |            PermissionEngine.addRule({       |
 *     |                       |              pattern: "Bash(git *)",        |
 *     |                       |              behavior: 'allow',             |
 *     |                       |              scope: 'session'               |
 *     |                       |            })                               |
 *     |                       |                     |                        |
 *     |<-- ToolDecision ------|<-- ToolDecision ----|                        |
 *     |                       |                     |                        |
 *     |   (continue tool      |                     |                        |
 *     |    execution)         |                     |                        |
 *
 * TIMEOUT BEHAVIOR:
 *   - Default timeout: 60s (configurable via permissions.askTimeoutMs)
 *   - On timeout: use permissions.failMode ('open' -> allow, 'closed' -> deny)
 *   - EMIT event: 'permission:ask_timeout'
 *
 * ABORT BEHAVIOR:
 *   - Neu user abort agent trong khi ask dialog dang mo:
 *     --> Cancel ask, return deny, abort agent loop
 */

// Output gate decision
export type OutputDecision = {
  action: 'approve' | 'reject' | 'modify' | 'retry'
  modifiedContent?: string
  retryPrompt?: string
  reason?: string
  stages: OutputStageResult[]
}

export type OutputStageResult = {
  stage: 'validate' | 'filter' | 'transform' | 'review'
  passed: boolean
  details?: string
}

// Input gate decision
export type InputDecision = {
  action: 'pass' | 'transform' | 'reject'
  transformedInput?: string
  injectedContext?: string[]
  reason?: string
}

// Tool request (tu Inner gui len Outer)
export type ToolRequest = {
  toolName: string
  toolInput: Record<string, unknown>
  toolUseId: string
  turnIndex: number
  isReadOnly: boolean
  isDestructive: boolean
}

// Raw output (tu Inner gui len Outer)
export type RawOutput = {
  text: string
  contentBlocks: ContentBlock[]
  usage: TokenUsage
  turnIndex: number
  toolCallCount: number
  model: string
}

// User input (tu user gui vao)
export type UserInput = {
  text: string
  attachments?: Attachment[]
  sessionId: string
  timestamp: number
}
```

#### `tools.ts` — Tool Types

```typescript
import { z } from 'zod'

/**
 * Tool definition cho Inner Harness.
 * Tuong thich voi Vercel AI SDK tool() format.
 */
export interface ToolDefinition<TInput = unknown, TOutput = unknown> {
  name: string
  description: string
  parameters: z.ZodType<TInput>     // Zod schema (Vercel AI SDK tuong thich)

  execute(input: TInput, context: ToolContext): Promise<TOutput>

  // Metadata cho Outer Harness (permission, governance)
  metadata: {
    isReadOnly: boolean
    isDestructive: boolean
    isConcurrencySafe: boolean
    category: 'file' | 'shell' | 'search' | 'network' | 'agent' | 'custom'
    maxDurationMs?: number
    maxOutputSize?: number
  }
}

export interface ToolContext {
  sessionId: string
  agentId: string
  cwd: string
  signal: AbortSignal
  onProgress?: (progress: unknown) => void
}
```

#### `hooks.ts` — Hook Types

```typescript
export type HookEventType =
  | 'PreToolUse'
  | 'PostToolUse'
  | 'PostToolUseFailure'
  | 'InputReceived'
  | 'OutputRaw'
  | 'OutputDelivered'
  | 'SessionStart'
  | 'SessionEnd'
  | 'TurnStart'
  | 'TurnEnd'
  | 'BudgetWarning'
  | 'BudgetExceeded'
  | 'ContextCompacted'
  | 'AlertTriggered'

export type HookType = 'command' | 'prompt' | 'agent' | 'http' | 'function'

export interface HookDefinition {
  type: HookType
  event: HookEventType
  matcher?: string               // "Bash", "FileWrite(*.ts)", "*"
  condition?: string             // "Bash(sudo *)", "session.cost > 5"
  timeout?: number               // ms

  // Type-specific
  command?: string               // type=command
  shell?: 'bash' | 'powershell'
  prompt?: string                // type=prompt
  model?: string
  url?: string                   // type=http
  method?: string
  headers?: Record<string, string>
  handler?: string               // type=function (path to module)
  inline?: string                // type=function (inline code)

  // Behavior
  async?: boolean
  once?: boolean
}

export type HookResult = {
  outcome: 'pass' | 'block' | 'modify' | 'error'
  message?: string
  modifiedInput?: unknown        // PreToolUse: modify tool input
  modifiedOutput?: unknown       // PostToolUse: modify tool result
  additionalContext?: string     // Inject context
  permissionDecision?: 'allow' | 'deny'  // PreToolUse: override permission
  preventContinuation?: boolean  // Stop agent loop
  stopReason?: string
}
```

#### `permissions.ts` — Permission Types

```typescript
export type PermissionMode = 'default' | 'strict' | 'permissive' | 'plan'

export interface PermissionRule {
  pattern: string               // "Bash(git *)", "FileWrite(*.env)", "*"
  behavior: 'allow' | 'deny' | 'ask'
  source: 'policy' | 'project' | 'user' | 'runtime'
  priority: number              // Cao hon = uu tien hon
  condition?: string            // Contextual: "git.branch == 'main'"
  message?: string              // Hien thi khi ask/deny
}

export interface PermissionConfig {
  mode: PermissionMode
  rules: PermissionRule[]
  failMode: 'open' | 'closed'  // Khi timeout/error (anh huong ca ask timeout)
  timeoutMs: number             // Timeout cho permission evaluation
  askTimeoutMs: number          // Timeout cho user interaction khi ask (default 60000)
}
```

#### `config.ts` — Configuration Types

```typescript
import type { PermissionConfig } from './permissions'
import type { HookDefinition } from './hooks'

export interface HarnessConfig {
  // Inner
  inner: {
    model: string
    fallbackModel?: string
    maxTurns: number
    thinkingEnabled: boolean
    tools: string[]              // Built-in tool names to enable
  }

  // Outer - Permissions
  permissions: PermissionConfig

  // Outer - Hooks
  hooks: Record<string, HookDefinition[]>

  // Outer - Output pipeline
  output: {
    pipeline: {
      validate: { enabled: boolean; rules: OutputValidationRule[] }
      filter: { enabled: boolean; filters: OutputFilter[] }
      transform: { enabled: boolean; transforms: OutputTransform[] }
      review: { enabled: boolean; autoApproveCondition?: string; timeoutMs?: number }
    }
    /** streaming = per-buffer filter + post-stream validate (default)
     *  batch = full 6-stage pipeline (required for review, schema enforce)
     *  auto = streaming, tu dong chuyen batch khi review enabled hoac
     *         validation co safety/schema rules voi action 'reject' */
    gateMode: 'streaming' | 'batch' | 'auto'
    streaming?: {
      bufferSize?: number           // Tokens per buffer (20-100, default 50)
      contextWindow?: number        // Chars sliding context (default 100)
      postStreamFailure?: 'warn' | 'flag' | 'alert' | 'retract'
    }
  }

  // Outer - Budget
  budget: {
    maxPerSession?: number       // USD
    maxPerDay?: number
    warningThreshold: number     // 0.0 - 1.0
  }

  // Outer - Monitoring
  monitoring: {
    enabled: boolean
    traceEnabled: boolean
    metricsExport?: { type: 'otlp'; endpoint: string }
  }

  // Outer - Session
  session: {
    persistTranscript: boolean
    transcriptDir: string
    autoSave: boolean
  }
}

export interface OutputValidationRule {
  name: string
  type: 'safety' | 'schema' | 'length' | 'custom'
  action: 'reject' | 'retry' | 'flag'
  maxRetries?: number
  retryPrompt?: string
  validator?: string             // Path to custom validator
}

export interface OutputFilter {
  name: string
  type: 'pii' | 'secret' | 'regex' | 'denylist'
  pattern?: string
  patterns?: string[]
  replacement?: string
  entities?: string[]
  words?: string[]
}

export interface OutputTransform {
  name: string
  type: 'template' | 'code_format' | 'summarize' | 'custom'
  position?: 'header' | 'footer'
  content?: string
  transformer?: string           // Path to custom transformer
}
```

---

## 5. Package 2: @agentweave/control-plane

### 5.1 Muc dich

Concrete implementation cua ControlPlane interface. Trong Scenario B, dung **in-process** (direct function calls).

### 5.2 Implementation

#### `event-bus.ts`

```typescript
import { nanoid } from 'nanoid'
import type { InnerEvent } from '@agentweave/types'

type Handler = (event: InnerEvent) => void

export class EventBus {
  private handlers = new Map<string, Set<Handler>>()
  private wildcardHandlers = new Set<Handler>()

  emit(event: InnerEvent): void {
    // Non-blocking: fire-and-forget
    const typeHandlers = this.handlers.get(event.type)
    if (typeHandlers) {
      for (const h of typeHandlers) {
        try { h(event) } catch { /* log, never throw */ }
      }
    }
    for (const h of this.wildcardHandlers) {
      try { h(event) } catch {}
    }
  }

  subscribe(type: string | '*', handler: Handler): () => void {
    if (type === '*') {
      this.wildcardHandlers.add(handler)
      return () => this.wildcardHandlers.delete(handler)
    }
    if (!this.handlers.has(type)) this.handlers.set(type, new Set())
    this.handlers.get(type)!.add(handler)
    return () => this.handlers.get(type)?.delete(handler)
  }

  destroy(): void {
    this.handlers.clear()
    this.wildcardHandlers.clear()
  }
}
```

#### `interceptors.ts`

```typescript
import type { InterceptType, InterceptRequest, InterceptResponse } from '@agentweave/types'

type InterceptHandler<T extends InterceptType> =
  (request: InterceptRequest[T]) => Promise<InterceptResponse[T]>

const DEFAULT_TIMEOUTS: Record<InterceptType, number> = {
  tool_request: 30_000,
  output_ready: 10_000,
  input_received: 5_000,
}

const DEFAULT_DECISIONS: Record<InterceptType, unknown> = {
  tool_request: { behavior: 'deny', reason: 'Interceptor timeout', source: 'timeout' },
  output_ready: { action: 'approve', reason: 'Interceptor timeout', stages: [] },
  input_received: { action: 'pass', reason: 'Interceptor timeout' },
}

export class InterceptorRegistry {
  private handlers = new Map<InterceptType, InterceptHandler<any>>()
  private failMode: 'open' | 'closed' = 'closed'

  registerInterceptor<T extends InterceptType>(
    type: T,
    handler: InterceptHandler<T>,
  ): void {
    this.handlers.set(type, handler)
  }

  async intercept<T extends InterceptType>(
    type: T,
    request: InterceptRequest[T],
  ): Promise<InterceptResponse[T]> {
    const handler = this.handlers.get(type)
    if (!handler) {
      // Khong co handler -> default decision
      return DEFAULT_DECISIONS[type] as InterceptResponse[T]
    }

    const timeout = DEFAULT_TIMEOUTS[type]

    try {
      return await Promise.race([
        handler(request),
        new Promise<InterceptResponse[T]>((_, reject) =>
          setTimeout(() => reject(new Error('Interceptor timeout')), timeout),
        ),
      ])
    } catch {
      // Timeout or error -> default decision
      return DEFAULT_DECISIONS[type] as InterceptResponse[T]
    }
  }

  setFailMode(mode: 'open' | 'closed'): void {
    this.failMode = mode
    // Update default decisions based on fail mode
    if (mode === 'open') {
      (DEFAULT_DECISIONS.tool_request as any).behavior = 'allow'
    } else {
      (DEFAULT_DECISIONS.tool_request as any).behavior = 'deny'
    }
  }
}
```

#### `factory.ts`

```typescript
import type { ControlPlane } from '@agentweave/types'
import { EventBus } from './event-bus'
import { CommandBus } from './command-bus'
import { InterceptorRegistry } from './interceptors'

export function createControlPlane(): ControlPlane {
  const eventBus = new EventBus()
  const commandBus = new CommandBus()
  const interceptors = new InterceptorRegistry()

  return {
    // Event Bus
    emit: (event) => eventBus.emit(event),
    subscribe: (type, handler) => eventBus.subscribe(type, handler),

    // Command Bus
    sendCommand: (cmd) => commandBus.send(cmd),
    onCommand: (handler) => commandBus.setHandler(handler),

    // Interceptors
    intercept: (type, req) => interceptors.intercept(type, req),
    registerInterceptor: (type, handler) => interceptors.registerInterceptor(type, handler),

    // Lifecycle
    destroy: () => {
      eventBus.destroy()
      commandBus.destroy()
    },
  }
}
```

---

## 6. Package 3: @agentweave/inner-harness

### 6.1 Agent Loop (Core)

```typescript
import { streamText, type CoreMessage, type CoreTool } from 'ai'
import { anthropic } from '@ai-sdk/anthropic'
import type {
  InnerHarnessProvider, RunOptions, InnerEvent,
  TerminalResult, ControlPlane, ToolDefinition,
} from '@agentweave/types'

export class AgentLoop implements InnerHarnessProvider {
  private messages: CoreMessage[] = []
  private tools: Map<string, ToolDefinition> = new Map()
  private controlPlane: ControlPlane
  private model: string
  private abortController: AbortController | null = null
  private state: 'idle' | 'running' | 'paused' | 'completed' | 'aborted' = 'idle'
  private turnIndex = 0
  private totalUsage = { inputTokens: 0, outputTokens: 0, totalCost: 0 }

  constructor(config: {
    controlPlane: ControlPlane
    model: string
    tools: ToolDefinition[]
    systemPrompt?: string
  }) {
    this.controlPlane = config.controlPlane
    this.model = config.model
    for (const tool of config.tools) {
      this.tools.set(tool.name, tool)
    }
    this.setupCommandHandler()
  }

  async *run(prompt, options = {}): AsyncGenerator<InnerEvent, TerminalResult> {
    this.state = 'running'
    this.abortController = new AbortController()
    const maxTurns = options.maxTurns ?? 100

    // 1. Input gate (qua Control Plane)
    const inputDecision = await this.controlPlane.intercept('input_received', {
      text: typeof prompt === 'string' ? prompt : JSON.stringify(prompt),
      sessionId: '', // filled by adapter
      timestamp: Date.now(),
    })
    if (inputDecision.action === 'reject') {
      return { reason: 'input_rejected' }
    }
    const effectivePrompt = inputDecision.transformedInput
      ?? (typeof prompt === 'string' ? prompt : JSON.stringify(prompt))

    // 2. Add user message
    this.messages.push({ role: 'user', content: effectivePrompt })

    // 3. Agent loop
    while (this.turnIndex < maxTurns) {
      if (this.abortController.signal.aborted) {
        return { reason: 'aborted', usage: this.totalUsage }
      }

      // Pause support
      while (this.state === 'paused') {
        await new Promise(r => setTimeout(r, 100))
      }

      this.turnIndex++
      yield { type: 'turn:start', turnIndex: this.turnIndex } as any

      // 4. Call LLM via Vercel AI SDK
      const aiTools = this.buildAITools()
      const result = await streamText({
        model: anthropic(this.model),
        messages: this.messages,
        tools: aiTools,
        maxSteps: 1,     // 1 step per loop iteration (WE control the loop)
        abortSignal: this.abortController.signal,
        onStepFinish: async ({ toolCalls, toolResults, text, usage }) => {
          // Track usage
          if (usage) {
            this.totalUsage.inputTokens += usage.promptTokens
            this.totalUsage.outputTokens += usage.completionTokens
          }
        },
      })

      // 5. Consume streaming
      let fullText = ''
      const toolCalls: Array<{ name: string; args: unknown; id: string }> = []

      for await (const part of result.textStream) {
        fullText += part
        yield { type: 'llm:stream_delta', delta: part, blockType: 'text' } as any
      }

      // Collect tool calls from result
      const steps = await result.steps
      for (const step of steps) {
        for (const tc of step.toolCalls) {
          toolCalls.push({ name: tc.toolName, args: tc.args, id: tc.toolCallId })
        }
      }

      // 6. No tool calls -> terminal
      if (toolCalls.length === 0) {
        // Output gate
        const outputDecision = await this.controlPlane.intercept('output_ready', {
          text: fullText,
          contentBlocks: [{ type: 'text', text: fullText }],
          usage: this.totalUsage,
          turnIndex: this.turnIndex,
          toolCallCount: 0,
          model: this.model,
        })

        if (outputDecision.action === 'retry' && outputDecision.retryPrompt) {
          this.messages.push({ role: 'assistant', content: fullText })
          this.messages.push({ role: 'user', content: outputDecision.retryPrompt })
          continue // Retry
        }

        const finalText = outputDecision.action === 'modify'
          ? outputDecision.modifiedContent ?? fullText
          : fullText

        this.state = 'completed'
        yield { type: 'terminal', reason: 'completed', usage: this.totalUsage } as any
        return { reason: 'completed', output: finalText, usage: this.totalUsage }
      }

      // 7. Execute tool calls (with permission gate)
      this.messages.push({ role: 'assistant', content: fullText, toolCalls } as any)

      for (const tc of toolCalls) {
        const tool = this.tools.get(tc.name)

        // 7a. Permission gate
        const decision = await this.controlPlane.intercept('tool_request', {
          toolName: tc.name,
          toolInput: tc.args as Record<string, unknown>,
          toolUseId: tc.id,
          turnIndex: this.turnIndex,
          isReadOnly: tool?.metadata.isReadOnly ?? false,
          isDestructive: tool?.metadata.isDestructive ?? false,
        })

        yield { type: 'tool:requested', toolName: tc.name, toolInput: tc.args, toolUseId: tc.id } as any

        if (decision.behavior === 'deny') {
          // Denied: return error result to LLM
          this.messages.push({
            role: 'tool',
            content: `Permission denied: ${decision.reason}`,
            toolCallId: tc.id,
          } as any)
          yield { type: 'tool:failed', toolUseId: tc.id, error: decision.reason, durationMs: 0 } as any
          continue
        }

        // 7b. Execute tool
        const effectiveInput = decision.modifiedInput ?? tc.args
        yield { type: 'tool:started', toolUseId: tc.id } as any

        const startTime = Date.now()
        try {
          const toolResult = await tool!.execute(effectiveInput as any, {
            sessionId: '',
            agentId: '',
            cwd: process.cwd(),
            signal: this.abortController.signal,
          })

          const duration = Date.now() - startTime
          const resultStr = typeof toolResult === 'string' ? toolResult : JSON.stringify(toolResult)

          this.messages.push({
            role: 'tool',
            content: resultStr,
            toolCallId: tc.id,
          } as any)

          yield { type: 'tool:completed', toolUseId: tc.id, result: toolResult, durationMs: duration } as any
        } catch (err) {
          const duration = Date.now() - startTime
          const errMsg = err instanceof Error ? err.message : String(err)

          this.messages.push({
            role: 'tool',
            content: `Error: ${errMsg}`,
            toolCallId: tc.id,
          } as any)

          yield { type: 'tool:failed', toolUseId: tc.id, error: errMsg, durationMs: duration } as any
        }
      }

      yield { type: 'turn:end', turnIndex: this.turnIndex, stopReason: 'tool_use' } as any
    }

    // Max turns reached
    this.state = 'completed'
    return { reason: 'max_turns', usage: this.totalUsage }
  }

  abort(reason?: string): void {
    this.state = 'aborted'
    this.abortController?.abort(reason)
  }

  // ... getState(), getMessages(), etc. (trivial getters)

  private setupCommandHandler(): void {
    this.controlPlane.onCommand(async (cmd) => {
      switch (cmd.type) {
        case 'pause': this.state = 'paused'; return { accepted: true }
        case 'resume': this.state = 'running'; return { accepted: true }
        case 'abort': this.abort(cmd.reason); return { accepted: true }
        case 'inject': this.injectMessage(cmd.message); return { accepted: true }
        case 'set_model': this.model = cmd.model; return { accepted: true }
        default: return { accepted: false, reason: 'Unknown command' }
      }
    })
  }

  private buildAITools(): Record<string, CoreTool> {
    const aiTools: Record<string, CoreTool> = {}
    for (const [name, def] of this.tools) {
      aiTools[name] = {
        description: def.description,
        parameters: def.parameters,
        // execute is handled by us, not AI SDK
      } as CoreTool
    }
    return aiTools
  }
}
```

---

## 7. Package 4: @agentweave/outer-harness

### 7.1 Consumer Implementation (assembly point)

```typescript
import type {
  OuterHarnessConsumer, InnerEvent, ToolRequest, ToolDecision,
  RawOutput, OutputDecision, UserInput, InputDecision,
  HookEvent, HookResult, SessionInfo, TerminalResult,
} from '@agentweave/types'

import { PermissionEngine } from './governance/permission-engine'
import { HookEngine } from './governance/hook-engine'
import { InputGate } from './governance/input-gate'
import { OutputPipeline } from './governance/output-pipeline'
import { BudgetManager } from './governance/budget-manager'
import { MonitorCollector } from './observability/monitor-collector'
import { AlertEngine } from './observability/alert-engine'
import { AuditLogger } from './observability/audit-logger'
import { SessionManager } from './orchestration/session-manager'

export class OuterHarness implements OuterHarnessConsumer {
  private permissions: PermissionEngine
  private hooks: HookEngine
  private inputGate: InputGate
  private outputPipeline: OutputPipeline
  private budget: BudgetManager
  private monitor: MonitorCollector
  private alerts: AlertEngine
  private audit: AuditLogger
  private sessions: SessionManager
  private userGate: UserInteractionGate

  constructor(config: HarnessConfig) {
    this.permissions = new PermissionEngine(config.permissions)
    this.hooks = new HookEngine(config.hooks)
    this.inputGate = new InputGate(config.input)
    this.outputPipeline = new OutputPipeline(config.output)
    this.budget = new BudgetManager(config.budget)
    this.monitor = new MonitorCollector(config.monitoring)
    this.alerts = new AlertEngine(config.alerts)
    this.audit = new AuditLogger(config.audit)
    this.sessions = new SessionManager(config.session)
    this.userGate = new UserInteractionGate(config.permissions)
  }

  // === GATES ===

  async onToolRequested(request: ToolRequest): Promise<ToolDecision> {
    // 1. Pre-tool hooks (can override permission)
    const preHook = await this.hooks.execute({ type: 'PreToolUse', ...request })
    if (preHook.permissionDecision === 'deny') {
      this.audit.log('tool_denied', { tool: request.toolName, source: 'hook' })
      return { behavior: 'deny', reason: preHook.message ?? 'Blocked by hook', source: 'hook' }
    }
    if (preHook.permissionDecision === 'allow') {
      // Hook explicitly approved — skip Permission Engine
      return { behavior: 'allow', reason: preHook.message ?? 'Approved by hook', source: 'hook' }
    }

    // 2. Permission engine --> PermissionDecision (allow | deny | ask)
    const permDecision = await this.permissions.evaluate(request)
    this.audit.log('permission_decision', { tool: request.toolName, decision: permDecision })

    // 3. Handle 'ask' — resolve to allow/deny via user interaction
    let toolDecision: ToolDecision
    if (permDecision.behavior === 'ask') {
      // Block agent loop, show prompt to user, wait for response
      const userResponse = await this.userGate.waitForResponse({
        toolName: request.toolName,
        toolInput: request.toolInput,
        askMessage: permDecision.askMessage ?? `Allow ${request.toolName}?`,
        suggestions: permDecision.suggestions,
        timeoutMs: this.permissions.config.askTimeoutMs ?? 60_000,
      })

      if (userResponse.timedOut) {
        // Timeout -> use failMode
        const failBehavior = this.permissions.config.failMode === 'open' ? 'allow' : 'deny'
        this.audit.log('permission_ask_timeout', { tool: request.toolName, fallback: failBehavior })
        toolDecision = {
          behavior: failBehavior,
          reason: `Ask timeout (${this.permissions.config.failMode})`,
          source: 'timeout',
        }
      } else {
        toolDecision = {
          behavior: userResponse.approved ? 'allow' : 'deny',
          modifiedInput: userResponse.modifiedInput,
          reason: userResponse.reason ?? (userResponse.approved ? 'User approved' : 'User denied'),
          source: 'user',
          resolvedFromAsk: true,
          userFeedback: userResponse.feedback,
        }

        // Persist rule if user chose "Always allow/deny"
        if (userResponse.persistRule) {
          this.permissions.addRule({
            pattern: userResponse.persistRule.pattern,
            behavior: userResponse.persistRule.behavior,
            source: userResponse.persistRule.scope ?? 'session',
            priority: 50,
          })
        }
      }
    } else {
      // allow or deny — tra ve truc tiep
      toolDecision = {
        behavior: permDecision.behavior as 'allow' | 'deny',
        modifiedInput: permDecision.modifiedInput,
        reason: permDecision.reason,
        source: permDecision.source,
      }
    }

    // 4. Budget check (chi khi allow)
    if (toolDecision.behavior === 'allow') {
      const budgetOk = this.budget.canProceed()
      if (!budgetOk) {
        return { behavior: 'deny', reason: 'Budget exceeded', source: 'budget' }
      }
    }

    return toolDecision
  }

  async onOutputReady(output: RawOutput): Promise<OutputDecision> {
    return this.outputPipeline.process(output)
  }

  async onInputReceived(input: UserInput): Promise<InputDecision> {
    return this.inputGate.process(input)
  }

  // === OBSERVERS ===

  onEvent(event: InnerEvent): void {
    // Non-blocking: fire-and-forget
    this.monitor.collect(event)
    this.alerts.check(event)
    this.audit.logEvent(event)
    this.sessions.appendEvent(event)

    // Post-tool hooks (async, non-blocking)
    if (event.type === 'tool:completed' || event.type === 'tool:failed') {
      void this.hooks.execute({ type: 'PostToolUse', ...event })
    }

    // Budget tracking
    if (event.type === 'llm:stream_end') {
      this.budget.trackUsage(event.usage)
    }
  }

  async executeHooks(event: HookEvent): Promise<HookResult> {
    return this.hooks.execute(event)
  }

  // === LIFECYCLE ===

  async onSessionStart(session: SessionInfo): Promise<void> {
    this.sessions.start(session)
    this.monitor.startSession(session)
    this.audit.log('session_start', session)
    await this.hooks.execute({ type: 'SessionStart', sessionId: session.id })
  }

  async onSessionEnd(session: SessionInfo, result: TerminalResult): Promise<void> {
    await this.hooks.execute({ type: 'SessionEnd', sessionId: session.id, result })
    this.monitor.endSession(session, result)
    this.audit.log('session_end', { ...session, result })
    await this.sessions.save(session.id)
  }
}
```

---

## 8. Package 5: @agentweave/sdk

### 8.1 Public API

```typescript
import { createControlPlane } from '@agentweave/control-plane'
import { AgentLoop } from '@agentweave/inner-harness'
import { OuterHarness } from '@agentweave/outer-harness'
import type { HarnessConfig, InnerEvent } from '@agentweave/types'

export function createHarness(config: HarnessConfig) {
  // 1. Create Control Plane
  const controlPlane = createControlPlane()

  // 2. Create Inner Harness
  const inner = new AgentLoop({
    controlPlane,
    model: config.inner.model,
    tools: loadTools(config.inner.tools),
  })

  // 3. Create Outer Harness
  const outer = new OuterHarness(config)

  // 4. Wire Outer to Control Plane
  controlPlane.registerInterceptor('tool_request', (req) => outer.onToolRequested(req))
  controlPlane.registerInterceptor('output_ready', (req) => outer.onOutputReady(req))
  controlPlane.registerInterceptor('input_received', (req) => outer.onInputReceived(req))
  controlPlane.subscribe('*', (event) => outer.onEvent(event))

  // 5. Return public API
  return {
    async run(prompt: string) {
      await outer.onSessionStart({ id: nanoid(), startTime: Date.now() })
      let finalOutput = ''
      for await (const event of inner.run(prompt, config.inner)) {
        if (event.type === 'terminal') {
          finalOutput = (event as any).output ?? ''
        }
      }
      await outer.onSessionEnd({ id: '' }, { reason: 'completed' })
      return finalOutput
    },

    async *stream(prompt: string): AsyncGenerator<InnerEvent> {
      for await (const event of inner.run(prompt, config.inner)) {
        yield event
      }
    },

    // Control
    pause: () => controlPlane.sendCommand({ type: 'pause' }),
    resume: () => controlPlane.sendCommand({ type: 'resume' }),
    abort: (reason?: string) => controlPlane.sendCommand({ type: 'abort', reason }),
    inject: (msg) => controlPlane.sendCommand({ type: 'inject', message: msg }),

    // Monitor
    getMetrics: () => outer.monitor.getMetrics(),
    getTrace: () => outer.sessions.getTrace(),

    // Cleanup
    destroy: () => controlPlane.destroy(),
  }
}
```

---

## 9. Package 6: @agentweave/cli

```typescript
#!/usr/bin/env node
import { Command } from 'commander'
import { createHarness } from '@agentweave/sdk'
import { loadConfig } from './config-loader'

const program = new Command()
  .name('agentweave')
  .version('0.1.0')

program
  .command('run <prompt>')
  .option('-m, --model <model>', 'LLM model', 'claude-sonnet-4-6')
  .option('-c, --config <path>', 'Config file')
  .option('--budget <usd>', 'Max budget USD')
  .option('--max-turns <n>', 'Max turns')
  .action(async (prompt, opts) => {
    const config = await loadConfig(opts.config)
    if (opts.model) config.inner.model = opts.model
    if (opts.budget) config.budget.maxPerSession = parseFloat(opts.budget)

    const harness = createHarness(config)

    for await (const event of harness.stream(prompt)) {
      if (event.type === 'llm:stream_delta') {
        process.stdout.write(event.delta)
      }
      if (event.type === 'tool:requested') {
        console.log(`\n[Tool] ${event.toolName}`)
      }
      if (event.type === 'tool:completed') {
        console.log(`[Done] ${event.durationMs}ms`)
      }
    }

    harness.destroy()
  })

program.parse()
```

---

## 10. Data Schemas (Zod)

Tat ca types trong `@agentweave/types` deu co Zod schema tuong ung de runtime validation:

```typescript
// packages/types/src/schemas.ts
import { z } from 'zod'

// === Config schema (validate YAML/JSON config files) ===
export const permissionRuleSchema = z.object({
  pattern: z.string(),
  behavior: z.enum(['allow', 'deny', 'ask']),
  source: z.enum(['policy', 'project', 'user', 'runtime']).default('user'),
  priority: z.number().default(0),
  condition: z.string().optional(),
  message: z.string().optional(),
})

export const hookDefinitionSchema = z.object({
  type: z.enum(['command', 'prompt', 'http', 'function']),
  event: z.string(),
  matcher: z.string().optional(),
  condition: z.string().optional(),
  timeout: z.number().default(30_000),
  command: z.string().optional(),
  prompt: z.string().optional(),
  url: z.string().optional(),
  handler: z.string().optional(),
  inline: z.string().optional(),
  async: z.boolean().default(false),
  once: z.boolean().default(false),
})

export const outputFilterSchema = z.object({
  name: z.string(),
  type: z.enum(['pii', 'secret', 'regex', 'denylist']),
  pattern: z.string().optional(),
  patterns: z.array(z.string()).optional(),
  replacement: z.string().default('[REDACTED]'),
})

export const harnessConfigSchema = z.object({
  inner: z.object({
    model: z.string().default('claude-sonnet-4-6'),
    fallbackModel: z.string().optional(),
    maxTurns: z.number().default(100),
    thinkingEnabled: z.boolean().default(true),
    tools: z.array(z.string()).default(['bash', 'file-read', 'file-write', 'file-edit', 'grep', 'glob']),
  }),
  permissions: z.object({
    mode: z.enum(['default', 'strict', 'permissive', 'plan']).default('default'),
    rules: z.array(permissionRuleSchema).default([]),
    failMode: z.enum(['open', 'closed']).default('closed'),
    timeoutMs: z.number().default(30_000),
  }),
  hooks: z.record(z.array(hookDefinitionSchema)).default({}),
  output: z.object({
    pipeline: z.object({
      validate: z.object({ enabled: z.boolean().default(false), rules: z.array(z.any()).default([]) }),
      filter: z.object({ enabled: z.boolean().default(true), filters: z.array(outputFilterSchema).default([]) }),
      transform: z.object({ enabled: z.boolean().default(false), transforms: z.array(z.any()).default([]) }),
      review: z.object({ enabled: z.boolean().default(false) }),
    }),
    gateMode: z.enum(['passthrough', 'async', 'sync']).default('passthrough'),
  }),
  budget: z.object({
    maxPerSession: z.number().optional(),
    maxPerDay: z.number().optional(),
    warningThreshold: z.number().default(0.8),
  }),
  monitoring: z.object({
    enabled: z.boolean().default(true),
    traceEnabled: z.boolean().default(false),
  }),
  session: z.object({
    persistTranscript: z.boolean().default(true),
    transcriptDir: z.string().default('~/.agentweave/sessions'),
    autoSave: z.boolean().default(true),
  }),
})
```

---

## 11. Control Plane — Wiring Diagram

```
createHarness(config)
  |
  |  1. const cp = createControlPlane()
  |
  |  2. const inner = new AgentLoop({ controlPlane: cp, ... })
  |     inner.run() se:
  |       - cp.emit(event)              khi co event
  |       - cp.intercept('tool_request')  khi can permission
  |       - cp.intercept('output_ready')  khi co output
  |       - cp.intercept('input_received') khi co input
  |       - cp.onCommand(handler)        de nhan pause/resume/abort
  |
  |  3. const outer = new OuterHarness(config)
  |
  |  4. WIRING:
  |     cp.registerInterceptor('tool_request',  req => outer.onToolRequested(req))
  |     cp.registerInterceptor('output_ready',  req => outer.onOutputReady(req))
  |     cp.registerInterceptor('input_received', req => outer.onInputReceived(req))
  |     cp.subscribe('*', event => outer.onEvent(event))
  |
  |  5. Return public API (run, stream, pause, resume, abort, ...)
  v

Runtime flow:

  User calls harness.run("Fix the bug")
    |
    v
  inner.run("Fix the bug")
    |
    +--> cp.intercept('input_received', {...})
    |      |
    |      v
    |    outer.onInputReceived({...})  --> InputGate --> { action: 'pass' }
    |      |
    |      v  (decision flows back to inner)
    |
    +--> inner calls LLM (streaming)
    |
    +--> inner receives tool_use
    |      |
    |      v
    |    cp.intercept('tool_request', {...})
    |      |
    |      v
    |    outer.onToolRequested({...})  --> Hooks(Pre) --> PermissionEngine --> { allow }
    |      |
    |      v  (decision flows back to inner)
    |
    +--> inner executes tool
    |      |
    |      v
    |    cp.emit({ type: 'tool:completed', ... })
    |      |
    |      v  (non-blocking, fire-and-forget)
    |    outer.onEvent(...)  --> Monitor, Audit, Hooks(Post), Alert
    |
    +--> inner loop continues...
    |
    +--> inner reaches terminal (no more tool_use)
    |      |
    |      v
    |    cp.intercept('output_ready', {...})
    |      |
    |      v
    |    outer.onOutputReady({...})  --> OutputPipeline(6 stages) --> { approve }
    |      |
    |      v  (decision flows back to inner)
    |
    +--> return final output to user
```

---

## 12. Inner Harness — Built-in Tools

```typescript
// packages/inner-harness/src/built-in-tools/bash.ts
import { z } from 'zod'
import { exec } from 'child_process'
import type { ToolDefinition } from '@agentweave/types'

export const bashTool: ToolDefinition<{ command: string }, string> = {
  name: 'Bash',
  description: 'Execute a bash command and return its output.',
  parameters: z.object({
    command: z.string().describe('The bash command to execute'),
  }),
  metadata: {
    isReadOnly: false,
    isDestructive: true,  // Conservative default
    isConcurrencySafe: false,
    category: 'shell',
    maxDurationMs: 120_000,
  },
  async execute(input, context) {
    return new Promise((resolve, reject) => {
      const child = exec(input.command, {
        cwd: context.cwd,
        timeout: this.metadata.maxDurationMs,
        signal: context.signal,
      }, (error, stdout, stderr) => {
        if (error) {
          resolve(`Exit code ${error.code ?? 1}\nstdout:\n${stdout}\nstderr:\n${stderr}`)
        } else {
          resolve(stdout + (stderr ? `\nstderr:\n${stderr}` : ''))
        }
      })
    })
  },
}

// Tuong tu cho: fileReadTool, fileWriteTool, fileEditTool, grepTool, globTool
```

---

## 13. Outer Harness — Module-by-Module Build

### Build order (moi module la 1 PR rieng):

```
PR 1: PermissionEngine
  - Rule matcher (parse "Bash(git *)" patterns)
  - Rule evaluation (priority, layers)
  - Config loader
  - Tests: rule matching, priority, deny/allow/ask

PR 2: InputGate
  - Input validation (length, content)
  - Input transformation
  - Tests: pass, transform, reject

PR 3: OutputPipeline
  - Stage 1: Intercept (capture raw)
  - Stage 2: Validate (rules)
  - Stage 3: Filter (PII, secret, regex)
  - Stage 4: Transform (template, format)
  - Stage 5: Review (auto-approve logic)
  - Stage 6: Deliver (passthrough)
  - Tests: each stage independently + full pipeline

PR 4: HookEngine
  - CommandHook executor (spawn shell)
  - FunctionHook executor (eval/import)
  - HttpHook executor (fetch)
  - PromptHook executor (call LLM)
  - Event matching + condition filtering
  - Result aggregation
  - Tests: each executor + matching + aggregation

PR 5: BudgetManager
  - Token/cost tracking
  - Threshold alerts
  - Budget enforcement
  - Tests: tracking, warning, exceeded

PR 6: MonitorCollector
  - Metric collection (tokens, cost, latency, tools)
  - Session metrics aggregation
  - Tests: collection, aggregation

PR 7: AuditLogger
  - JSONL append-only log
  - Event serialization (with redaction)
  - Tests: write, read, redaction

PR 8: AlertEngine
  - Condition evaluation
  - Channel dispatch (terminal, webhook)
  - Cooldown logic
  - Tests: conditions, cooldown

PR 9: SessionManager
  - Transcript save/load (JSONL)
  - Session index
  - Fork/resume
  - Tests: save, load, fork

PR 10: ConfigHierarchy
  - YAML loader
  - Multi-source merge (user > project > local)
  - Zod validation
  - Tests: merge priority, validation errors
```

---

## 14. Adapter Interface — Plug Any Inner

### 14.1 Adapter cho 3rd-party Inner (Scenario A fallback)

```typescript
// adapters/claude-code/adapter.ts
import type { InnerHarnessProvider, ControlPlane } from '@agentweave/types'
import { spawn } from 'child_process'

/**
 * Wrap Claude Code CLI process as InnerHarnessProvider.
 * Limited control: chi intercept stdin/stdout.
 */
export class ClaudeCodeAdapter implements InnerHarnessProvider {
  private process: ChildProcess | null = null

  async *run(prompt) {
    this.process = spawn('claude', ['--json', '--output-format', 'stream'], {
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    this.process.stdin.write(prompt + '\n')

    for await (const chunk of this.process.stdout) {
      const event = parseClaudeCodeOutput(chunk)
      yield event
    }
  }

  abort() {
    this.process?.kill('SIGTERM')
  }

  // ... limited implementations of other methods
}
```

### 14.2 Adapter cho OpenAI Agents SDK

```typescript
// adapters/openai-agents/adapter.ts
import { Agent, run as runAgent } from 'openai-agents'
import type { InnerHarnessProvider, ControlPlane } from '@agentweave/types'

export class OpenAIAgentsAdapter implements InnerHarnessProvider {
  async *run(prompt) {
    const agent = new Agent({
      name: 'coder',
      model: 'gpt-4o',
      tools: [...],
    })

    const result = runAgent(agent, prompt)

    for await (const event of result.streamEvents()) {
      yield mapToInnerEvent(event)
    }
  }
  // ...
}
```

---

## 15. Build Order & MVP Scope

### 15.1 MVP (Phase 1): Core Loop + Basic Governance

```
Week 1-2:
  [x] @agentweave/types           (all interfaces + Zod schemas)
  [x] @agentweave/control-plane   (EventBus + InterceptorRegistry + CommandBus)

Week 3-4:
  [x] @agentweave/inner-harness   (AgentLoop + 6 built-in tools)
  [x] Test: inner chay doc lap, khong can outer

Week 5-6:
  [x] PermissionEngine            (rule matching + evaluation)
  [x] OutputPipeline              (6 stages, basic filters)
  [x] BudgetManager               (tracking + enforcement)

Week 7-8:
  [x] @agentweave/sdk             (createHarness + wiring)
  [x] @agentweave/cli             (run command + basic output)
  [x] End-to-end test

MVP deliverable:
  - Agent chay voi 6 tools
  - Permission rules (allow/deny)
  - Output filtering (PII, secrets)
  - Budget limit
  - Cost tracking
  - CLI: agentweave run "prompt"
```

### 15.2 Phase 2: Observability

```
Week 9-10:
  [ ] MonitorCollector
  [ ] AuditLogger
  [ ] AlertEngine
  [ ] SessionManager (persist/resume)
  [ ] CLI: agentweave monitor, agentweave session
```

### 15.3 Phase 3: Advanced Governance

```
Week 11-14:
  [ ] HookEngine (5 hook types: command, prompt, agent, http, function)
  [ ] InputGate
  [ ] Output schema enforcement
  [ ] ConfigHierarchy (multi-source merge)
  [ ] Contextual permission rules
```

### 15.4 Phase 4: Multi-Agent + Ecosystem

```
Week 15+:
  [ ] Multi-agent orchestration
  [ ] AWOCP protocol (WebSocket server)
  [ ] Web dashboard
  [ ] Plugin system
  [ ] Adapters (Claude Code, OpenAI Agents)
```

---

## 16. Test Strategy

### 16.1 Test Layers

```
Unit Tests (vitest):
  - Moi module co test rieng
  - Mock Control Plane cho Inner tests
  - Mock Inner cho Outer tests
  - Zod schema validation tests

Integration Tests:
  - Inner + Control Plane (khong Outer): agent loop chay voi mock LLM
  - Outer + Control Plane (khong Inner): permission + hooks + output pipeline
  - Full stack: Inner + Control Plane + Outer

E2E Tests:
  - CLI run voi real LLM (optional, ci co the skip)
  - Budget enforcement e2e
  - Permission deny e2e
  - Output filtering e2e
```

### 16.2 Mock LLM cho testing

```typescript
// packages/inner-harness/src/__test__/mock-provider.ts
import { createMockProvider } from 'ai/test'

export const mockProvider = createMockProvider({
  responses: [
    // Turn 1: tool call
    { type: 'tool_call', name: 'Bash', args: { command: 'ls' } },
    // Turn 2: text response
    { type: 'text', text: 'Here are the files: ...' },
  ],
})
```

---

## 17. Configuration Files

### 17.1 Default config (zero-config start)

```yaml
# agentweave.yaml (minimum viable)

inner:
  model: claude-sonnet-4-6

permissions:
  mode: default
  rules:
    - pattern: "Bash(git *)"
      behavior: allow
    - pattern: "Bash(rm -rf *)"
      behavior: deny
```

### 17.2 Full config example

```yaml
# agentweave.yaml (full)

inner:
  model: claude-sonnet-4-6
  fallbackModel: claude-haiku-4-5
  maxTurns: 100
  thinkingEnabled: true
  tools: [bash, file-read, file-write, file-edit, grep, glob]

permissions:
  mode: default
  failMode: closed
  timeoutMs: 30000
  rules:
    - { pattern: "Bash(git *)", behavior: allow, source: project }
    - { pattern: "Bash(npm *)", behavior: allow, source: project }
    - { pattern: "Bash(rm -rf *)", behavior: deny, source: policy }
    - { pattern: "Bash(sudo *)", behavior: deny, source: policy }
    - { pattern: "FileWrite(*.env)", behavior: deny, source: policy }
    - { pattern: "FileRead(*)", behavior: allow, source: user }

hooks:
  PostToolUse:
    - type: command
      matcher: "FileWrite"
      condition: "FileWrite(*.ts)"
      command: "npx eslint --fix $FILE_PATH"
      async: true
  SessionEnd:
    - type: command
      command: "npm test"
      timeout: 60000

output:
  gateMode: passthrough
  pipeline:
    validate:
      enabled: false
    filter:
      enabled: true
      filters:
        - { name: secrets, type: secret, patterns: ["sk-[a-zA-Z0-9]{48}", "AKIA[A-Z0-9]{16}"] }
        - { name: pii, type: pii, entities: [email, phone] }
    transform:
      enabled: true
      transforms:
        - { name: footer, type: template, position: footer, content: "\n---\n_AI Generated_" }
    review:
      enabled: false

budget:
  maxPerSession: 10.00
  warningThreshold: 0.8

monitoring:
  enabled: true
  traceEnabled: true

session:
  persistTranscript: true
  transcriptDir: ~/.agentweave/sessions
  autoSave: true
```

---

## 18. End-to-End Walkthrough

### Minimal example (1 file, ~30 dong):

```typescript
// examples/basic/index.ts
import { createHarness } from '@agentweave/sdk'

const harness = createHarness({
  inner: { model: 'claude-sonnet-4-6' },
  permissions: {
    mode: 'default',
    rules: [
      { pattern: 'Bash(git *)', behavior: 'allow' },
      { pattern: 'Bash(rm *)', behavior: 'deny' },
    ],
  },
  output: {
    gateMode: 'passthrough',
    pipeline: {
      filter: {
        enabled: true,
        filters: [{ name: 'secrets', type: 'secret', patterns: ['sk-[a-zA-Z0-9]{48}'] }],
      },
    },
  },
  budget: { maxPerSession: 5.0 },
})

// Stream output
for await (const event of harness.stream('Fix the login bug in src/auth.ts')) {
  switch (event.type) {
    case 'llm:stream_delta':
      process.stdout.write(event.delta)
      break
    case 'tool:requested':
      console.log(`\n> Tool: ${event.toolName}`)
      break
    case 'tool:completed':
      console.log(`> Done (${event.durationMs}ms)`)
      break
    case 'tool:failed':
      console.error(`> Failed: ${event.error}`)
      break
    case 'terminal':
      console.log(`\n\nSession complete. Cost: $${event.usage.totalCost}`)
      break
  }
}

harness.destroy()
```

Chay:
```bash
npx tsx examples/basic/index.ts
```

---

## Appendix: Document Map

Sau khi hoan thanh file nay, toan bo tai lieu can thiet de bat tay code:

```
[1] knowledge_base_claude_code.md        -- Hieu codebase goc (reference only)
     |
[2] harness_engineering.md               -- Patterns ky thuat (agent loop, tools, hooks...)
     |
[3] product_spec_agent_harness_framework.md -- San pham: WHAT to build (features, UX)
     |
[4] architecture_agent_harness_framework.md -- Kien truc: HOW layers connect (Inner/Outer/CP)
     |
[5] scenario_b_implementation_guide.md   -- Implementation: HOW to code (THIS FILE)
     |  - Tech stack decisions
     |  - Monorepo structure
     |  - Package dependencies
     |  - TypeScript interfaces (concrete)
     |  - Zod schemas (concrete)
     |  - Control Plane implementation (concrete)
     |  - Inner Harness reference code (concrete)
     |  - Outer Harness module breakdown (concrete)
     |  - Build order + MVP scope
     |  - Test strategy
     |  - Config file examples
     |  - E2E walkthrough
     |
     v
     READY TO CODE
```
