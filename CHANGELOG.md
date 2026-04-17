# Changelog

All notable changes to AgentWeave will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.5.1-alpha.1] - 2026-04-17

### Added

- **Plugin System** — Extensible plugin architecture for AgentWeave.
  - **Plugin types** — PluginManifest, PluginContext, PluginRegistration, PluginPermissions, PluginConfig in @agentweave/types. HarnessConfig.plugins field.
  - **PluginLoader** — Load plugins from manifests (inline) or file paths (dynamic import). Validate manifest (name, version, activate). Validate permissions (tools/hooks declared vs registered). Activate/deactivate lifecycle with reverse-order cleanup.
  - **SDK integration** — `createHarness({ plugins: [...] })` auto-activates plugins, registers tools with inner ToolRegistry, registers hooks with outer HookEngine. `getPlugins()` returns loaded plugin list.

### Stats

- 8 packages, 27 test files, 270 tests (+16 new), 0 failures

---

## [0.5.0-alpha.1] - 2026-04-17

### Added

- **@agentweave/protocol** — AWOCP (AgentWeave Outer Control Protocol) message types and WebSocket client. AWOCPMessage envelope with 8 message types (auth, intercept, event, health). AWOCPClient: connect + auth handshake, interceptTool/interceptOutput with correlation ID + timeout, sendEvent fire-and-forget, ping/pong health checks, exponential backoff reconnection.
- **@agentweave/gateway** — AWOCP WebSocket server with shared governance. AWOCPServer: client auth (MVP bearer token), message routing, client registry. GatewayServer: wires AWOCPServer + shared OuterHarness (PermissionEngine, OutputPipeline, BudgetManager). Dev Nodes connect via WebSocket and get centralized governance decisions.
- **Auth module** — Bearer token verification (MVP). JWT signing/verification and mTLS deferred to post-MVP.

### Stats

- 8 packages, 25 test files, 251 tests (+10 new), 0 failures
- +2 new packages (protocol, gateway)

---

## [0.4.0-alpha.1] - 2026-04-17

### Added

- **MultiAgentOrchestrator** — Agent registry with lifecycle state machine (pending/running/completed/failed/aborted). Inter-agent message queue (send/receive/peek). Per-agent budget tracking with inheritance constraints (child cannot exceed parent remaining). Concurrent agent limit enforcement. AgentLifecycleEvent listener subscriptions.
- **LockManager** — Sequential file locking for multi-agent conflict resolution. Async acquire with configurable timeout, FIFO wait queue, reentrant locks (no depth tracking), releaseAll for agent cleanup, destroy rejects all waiters.
- **SDK spawnAgent()** — `createHarness({ multiAgent })` enables multi-agent mode. `spawnAgent(config)` returns an `AgentHandle` with `run()`, `stream()`, `abort()`, `send()`, `receive()`, `setLLMCaller()`. Each child gets its own ControlPlane + OuterHarness + AgentLoop. Timeout auto-abort, LLM caller inheritance, terminal-state guards.
- **New types** — AgentState, AgentSpawnConfig, AgentInfo, AgentMessage, MultiAgentConfig, AgentLifecycleEvent, AgentHandle. 5 new InnerEvent types: agent:spawned, agent:completed, agent:failed, agent:aborted, agent:message.
- **CLI agent events** — Terminal output now displays agent:spawned, agent:completed, agent:failed, agent:aborted events.
- **HarnessConfig.multiAgent** — Optional multi-agent config field in framework configuration.

### Stats

- 6 packages, 23 test files, 241 tests (+55 new), 0 failures
- +1,700 lines from Phase 3

---

## [0.3.0-alpha.1] - 2026-04-16

### Added

- **HookEngine** — 5 hook types: command (shell exec with env vars), function (inline JS eval), http (webhook POST), prompt (LLM eval — deferred to real provider), agent (spawn — deferred to Phase 4). Event+matcher filtering, sequential execution with timeout, block-stops-chain semantics, JSON output parsing.
- **ConfigHierarchy** — 7-level config merge: defaults < user < project < local < CLI < env < policy. Permission rules and hooks merge by append (not replace). Cache with invalidation. Policy detection.
- **OuterHarness integration** — `executeHooks()` now delegates to HookEngine. Config accepts `hooks` field.

### Stats

- 6 packages, 21 test files, 184 tests (+20 new), 0 failures
- +855 lines from Phase 2

---

## [0.2.0-alpha.1] - 2026-04-16

### Added

- **MonitorCollector** — Real-time metrics aggregation: per-turn token usage, cost (delta tracking), tool call stats (success/error/avg duration), session duration, permission denial count
- **SessionManager** — JSONL session persistence: auto-save events per-line, load/resume sessions, list all sessions, delete, export as formatted markdown. Path-traversal-safe session IDs.
- **AlertEngine** — Rule-based alerting with configurable severity (info/warning/critical) and cooldown periods. Built-in defaults: budget_warning, budget_exceeded, high_error_rate, long_session. Listener subscription for real-time notifications.
- **New types** — ToolMetrics, TurnMetrics, MonitorSnapshot, AlertRule, AlertEvent, AlertSeverity
- **OuterHarness integration** — All three modules wired into lifecycle (onEvent, onSessionStart, onSessionEnd). Alert checks optimized to state-changing events only.

### Stats

- 6 packages, 19 test files, 164 tests, 0 failures
- +1,114 lines from Phase 1

---

## [0.1.0-alpha.1] - 2026-04-16

### Added

- **@agentweave/types** — Shared type contracts: InnerHarnessProvider, OuterHarnessConsumer, ControlPlane interfaces, InnerEvent/OuterCommand discriminated unions, PermissionDecision (allow/deny/ask), ToolDecision (allow/deny), HookDefinition (5 types as discriminated union), OutputFilter/OutputTransform discriminated unions, HarnessConfig, SessionInfo, TokenUsage
- **@agentweave/control-plane** — EventBus (non-blocking pub/sub), CommandBus (async request/ack), InterceptorRegistry (blocking gates with timeout + fail-open/closed), `createControlPlane()` factory
- **@agentweave/inner-harness** — AgentLoop (AsyncGenerator, pluggable LLM caller, abort/pause/resume, max turns, budget check, single-use guard), ToolRegistry (register/unregister), ToolExecutor (partition read/write, concurrent execution), MessageStore (conversation threading), TokenCounter (usage tracking + Opus/Sonnet/Haiku pricing), MockLLM (deterministic test helper + pre-built scenarios)
- **@agentweave/outer-harness** — PermissionEngine (pre-compiled pattern matching, priority layers, 4 modes: default/strict/permissive/plan, ask flow), OutputPipeline (dual-mode streaming/batch, 7 built-in secret patterns, 4 PII patterns, regex/denylist filters, safe regex compilation), BudgetManager (per-session/daily limits, warning threshold, cost delta tracking), AuditLogger (append-only, category/action queries), OuterHarness (wires all modules, connects to ControlPlane)
- **@agentweave/sdk** — `createHarness()` factory, `run()`/`stream()`/`abort()` API, re-exports key types + testing utilities
- **@agentweave/cli** — `agentweave run "prompt"` with `--model`, `--budget`, `--max-turns`, `--mode` flags, event streaming to terminal
- **Monorepo** — pnpm workspaces + turborepo, tsup build, vitest tests, biome linting, TypeScript strict ESM
- **Documentation** — 13 product spec documents, 8 custom Claude Code commands (/architect, /po, /reviewer, /pm, /implement, /team, /standup, /spec)
- **Git Flow** — Branch strategy (main/develop/feature/release/hotfix), PR template, issue templates (bug/feature/task), CONTRIBUTING.md, conventional commits

### Stats

- 6 packages, 51 TypeScript files, 5,264 lines of code
- 16 test files, 136 tests, 0 failures
- Build: 6/6 packages passing
