---
status: audit
date: 2026-04-22
scope: packages/outer-harness/src
purpose: Post-pivot (2026-04-22) assessment of Pillar 1 (Governance) module readiness
authoritative: product-spec/POSITIONING.md
---

# Outer-Harness Audit — Skeleton vs Production

Run as part of Phase B of the governance-qa-layer pivot. Goal: identify which Pillar 1 modules are production-grade today and which still read as skeleton, so Phase 2 observability work and Phase 3 advanced-control work can target concrete gaps instead of re-discovering them.

All 5 modules audited here already exist on disk and pass unit tests. The question is depth — not whether they compile.

## Summary Table

| Module | Src LOC | Test cases | Tests LOC | Production-ready? | Main gap |
|---|---:|---:|---:|---|---|
| HookEngine | 513 | 22 | 389 | **Yes, for 3 of 5 hook types** | `prompt` and `agent` types are stubs (TODO comments, return `pass`) |
| InputGate | 96 | 8 | 63 | **Yes — thin but complete** | No gap vs spec; expand scope (PII detection?) is a separate product decision |
| MultiAgentOrchestrator | 304 | 34 | 440 | **Yes, as lifecycle/budget tracker** | Does NOT spawn agents itself — delegated to SDK. Missing adapter fan-out wiring (Phase 4) |
| AlertEngine | 157 | 10 | 154 | **Yes, for in-process rule eval** | No external sinks (Slack/webhook/PagerDuty). Listener API works, no delivery adapters |
| MonitorCollector | 181 | 10 | 142 | **Yes, as in-memory aggregator** | No export surface (Prometheus, OTLP) — snapshot only via `getSnapshot()` |

**Bottom line:** all 5 modules are real, not skeleton. Gaps are distribution/reach (Prometheus, webhook, agent-spawning) rather than missing core logic. The pivot premise stands — governance is our moat — and the moat has real code behind it.

---

## 1. HookEngine (`governance/hook-engine.ts`)

**Role:** Execute automation hooks at lifecycle points. 5 hook types per spec §5.

**Production-grade features observed:**
- `command` hook — `execAsync` with shell selection (cmd.exe / bash / powershell), timeout, env filtering via `ENV_SAFE_KEYS` + `ENV_SECRET_PATTERNS` denylist
- `function` hook — dual path: inline `new Function()` (with `trusted: true` gate), dynamic import handler (with path-traversal + extension validation)
- `http` hook — fetch + `AbortSignal.timeout`, exponential backoff retry on 5xx, custom headers
- Metrics — pass/block/modify/error counts, total + avg duration, per-event breakdown
- Output parsing — JSON-first with fallback to plain-text context
- Aggregation — block stops chain, modify accumulates, additionalContext concatenates

**Gaps (honest):**
- `prompt` hook — stub, returns `{ outcome: "pass", additionalContext: "Prompt hook skipped (no LLM provider in MVP)" }` (line 384). Blocks: needs LLM caller wired.
- `agent` hook — stub, returns same shape (line 392). Blocks: needs agent spawning infrastructure (Phase 4 dependency).
- No per-hook concurrency control — hooks run sequentially. Fine for MVP, re-evaluate at scale.

**Phase 2/3 unlocks:**
- `prompt` hook becomes real once Phase 3 Advanced Control lands an LLM caller inside the harness (not the agent's own LLM).
- `agent` hook lands with Phase 4 Multi-Agent via adapter fan-out.
- HTTP hook + retry is sufficient for Slack/webhook today — no new code needed, just config examples.

**Verdict:** Production-grade for the 3 hook types real users reach for (command/function/http). The 2 stubs have clear dependency chains, not hidden complexity.

---

## 2. InputGate (`governance/input-gate.ts`)

**Role:** Validate, transform, filter user input before it reaches the agent.

**Production-grade features observed:**
- Max length guard (default 100k chars)
- Empty-input rejection
- Whitespace trim
- Deny-pattern list with pre-compiled `RegExp`, case-insensitive, silently drops invalid patterns
- Context injection (`injectContext` prepend list)
- Action enum: `pass | transform | reject` with reason strings

**Gaps:**
- None against current spec. 96 LOC is small because the surface is small — not because it is incomplete.
- Optional scope additions (prompt-injection detection via classifier, PII scrubbing on input) are product decisions, not bugs.

**Phase 2/3 unlocks:**
- None required. Could grow toward `scenario_b` §3.5 "prompt injection detection" as a Phase 3 add-on, but today's `denyPatterns` already serves the 80% use case.

**Verdict:** Production-grade. Ship as-is. Document it better in user-facing docs (currently underweighted).

---

## 3. MultiAgentOrchestrator (`orchestration/multi-agent-orchestrator.ts`)

**Role:** Lifecycle, messaging, budget accounting for multi-agent coordination.

**Production-grade features observed:**
- Lifecycle state machine: `pending → running → (completed | failed | aborted)` with guard checks on transitions
- Hierarchical budget — parent/child budget validation prevents child overspend beyond parent remaining
- Concurrent agent cap (`maxConcurrentAgents`)
- Messaging queue per agent — `send` / `receive` (drain) / `peek`
- Event bus — `onAgentEvent(id | "*", handler)` with error-isolated dispatch
- Lock manager for cross-agent shared resource coordination
- Clean teardown via `destroy()`

**Important boundary (explicit in file header, line 3-5):**
> *"Does NOT create InnerHarness instances (that's the SDK's responsibility via the dependency graph constraint)."*

The orchestrator is a **ledger and mailbox**, not a spawner. Actual execution is the SDK's job.

**Gaps:**
- Post-pivot, "SDK spawns InnerHarness" becomes "SDK spawns an adapter that delegates to Claude Code/Cursor". The orchestrator's contract does not change — only the thing on the other side of `spawn()` does. This is a Phase 4 wiring task in `packages/adapters/`, not an orchestrator rewrite.
- No persistence — all state in-memory. Session crashes drop the graph. Acceptable for current phase.

**Phase 2/3/4 unlocks:**
- Phase 4 multi-agent: use the existing orchestrator, add adapter fan-out in SDK. Orchestrator already supports hierarchical budgets — that's the hard part.
- Add persistence (SQLite / JSONL snapshot) when we reach long-running sessions.

**Verdict:** Production-grade as a ledger. Do not rewrite. Multi-agent story ships via adapter work, not orchestrator work.

---

## 4. AlertEngine (`observability/alert-engine.ts`)

**Role:** Rule-based alerting over `MonitorSnapshot` with cooldowns.

**Production-grade features observed:**
- Rule CRUD (`addRule`, `removeRule`)
- Cooldown-per-rule (prevents alert storms)
- Error-isolated rule evaluation — rule throw does not crash engine
- Listener pattern with error-isolated notify
- Severity enum (`info | warning | critical`)
- 4 built-in rules via `createDefaultAlertRules`: budget_warning (80%), budget_exceeded, high_error_rate (>50% across 5+ calls), long_session (>10min)
- Query API — all alerts, by severity

**Gaps:**
- No external delivery sinks. Listener is in-process only.
- To ship Slack/email/PagerDuty/webhook: either use HookEngine HTTP hooks (ready today), or add a dedicated `AlertSink` interface.

**Phase 2/3 unlocks:**
- Phase 2 observability: add `AlertSink` interface + 2 impl (stdout, webhook). Small scope, ~100 LOC + tests.
- Route alerts to audit log too (re-use `AuditLogger` append-only JSONL) — already feasible via listener, just not documented.

**Verdict:** Production-grade for in-process rule evaluation. Distribution layer is the next logical Phase 2 work.

---

## 5. MonitorCollector (`observability/monitor-collector.ts`)

**Role:** Aggregate `InnerEvent` stream into session/turn/tool metrics.

**Production-grade features observed:**
- Per-turn metrics (duration, tokens, cost delta, tool-call count, model)
- Per-tool metrics (call count, success/error, total/avg duration)
- Session-level aggregates (total usage, turn count, error count, permission-denied count)
- Tool-use-ID to tool-name mapping for cross-event correlation
- `reset()` for session reuse
- Snapshot immutability via object/array copy

**Gaps:**
- No export format. Snapshot is a JS object, not OTLP / Prometheus text / JSONL.
- Not observable from outside the process — need to wire snapshot to a sink.

**Phase 2 unlocks:**
- Add `PrometheusExporter` — iterate snapshot, format as `# HELP / # TYPE / metric_name{label=...} value`. Small, ~150 LOC.
- Add `OTLPExporter` or rely on an OpenTelemetry SDK bridge.
- `agentweave metrics` CLI already reads SDLC metrics JSONL — a parallel `agentweave observe` CLI reading MonitorCollector snapshots would close the Phase 2 "CLI dashboard" deliverable.

**Verdict:** Production-grade as an in-memory aggregator. Needs an export surface to close Phase 2. The collector is already doing the hard work.

---

## Aggregated Gap List (what to build next)

Ordered by impact + effort. These are unlocks, not rewrites — existing code is kept.

### Phase 2 — Observability (highest leverage, lowest risk)

1. **PrometheusExporter** (new, `observability/prometheus-exporter.ts`) — read `MonitorCollector.getSnapshot()` + `AlertEngine.getAlerts()`, emit Prometheus text format. ~150 LOC.
2. **`agentweave audit view`** CLI — JSONL reader over `.agentweave/audit.log` with `--since`, `--tool`, `--tail`. ~200 LOC. **Already deferred to Phase C of this pivot.**
3. **AlertSink interface** (`observability/alert-sinks.ts`) — `StdoutSink`, `WebhookSink`, `FileSink`. Wire to AlertEngine listener. ~100 LOC + tests.
4. Session replay — export InnerEvent stream to `session-{id}.jsonl`, viewer CLI. Already partially done in `session-manager.ts` — add viewer.

### Phase 3 — Advanced Control (requires new dependencies)

5. **HookEngine `prompt` hook** — requires LLM provider wired inside harness (separate from agent's LLM). ~200 LOC + LLM caller reuse from `packages/inner-harness/src/sdlc`.
6. **HookEngine `agent` hook** — blocked until Phase 4 multi-agent wiring.
7. **InputGate prompt-injection classifier** — optional ML hook; low priority, `denyPatterns` covers baseline.

### Phase 4 — Multi-Agent (adapter-first)

8. **Adapter fan-out in SDK** — orchestrator already ready; SDK spawns N adapters in parallel with hierarchical budgets. ~200 LOC in SDK + adapter per-agent governance wiring. No orchestrator changes.

### Non-goals (do NOT build)

- Don't rewrite `MultiAgentOrchestrator` to spawn adapters directly — keeps SDK boundary clean.
- Don't build a bespoke alerting UI — Prometheus + Alertmanager + Grafana is industry standard, free, and outside our moat.
- Don't add `prompt` hook by spinning a new LLM client per hook call — reuse the SDLC pipeline's provider layer.

---

## How This Audit Informs the Roadmap

| Area | Post-audit position |
|---|---|
| Pillar 1 Governance (outer-harness) | 5/5 audited modules are real. Phase 2 focus = **export/reach**, not core logic. |
| Claim "governance is the moat" | Validated — 1251 LOC in 5 modules, 84 test cases, passing. Not a skeleton. |
| Roadmap Phase 2 priority | `agentweave audit view` + Prometheus exporter + AlertSinks. All additive, all high-leverage. |
| Roadmap Phase 4 story | "Multi-agent via adapter fan-out" is feasible today — orchestrator ledger + hierarchical budget already work. Remaining work is in `packages/adapters` + SDK. |

---

## Change Log

| Date | Change | Author |
|---|---|---|
| 2026-04-22 | Initial audit — Phase B of governance-qa-layer pivot | PO (phucdn7) + Claude |
