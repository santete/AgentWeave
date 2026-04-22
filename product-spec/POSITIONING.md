# AgentWeave Positioning

> **Canonical source of truth for product positioning.** Last updated: 2026-04-22.
> All other product-spec documents (`product_spec_agent_harness_framework.md`, `agentweave_product_introduction.md`, `README.md`) must align with this file.

---

## Tagline

**Governance + QA layer for AI coding agents — enforce policy on Claude Code, Cursor, and any MCP-compatible agent, with measurable SDLC metrics.**

---

## What AgentWeave Is (and Is Not)

| AgentWeave IS | AgentWeave is NOT |
|---|---|
| A governance + QA wrapper around existing AI coding agents | A replacement for Claude Code, Cursor, Aider, or any agent CLI |
| A policy engine, audit trail, and budget enforcer | A new agent loop or tool-calling runtime competing with Anthropic/Cursor |
| An SDLC workflow orchestrator that delegates execution to agents via adapters | A model provider or LLM host |
| A distribution target via Claude Code hooks + MCP server | A DIY framework where you rebuild agent-loop plumbing from scratch |

---

## Why This Positioning (The Strategic Pivot)

**2026-04-22 decision:** stop competing with Claude Code / Cursor on agent-loop implementation. Reasons:

1. **Agent loop = commodity parity.** Anthropic and Cursor ship polished agent loops with model-specific tuning, IDE integrations, and streaming UX we cannot match on their turf.
2. **Customer pain is in governance, not execution.** Every pain point in the original vision — output control, audit, policy enforcement, real-time intervention, multi-user governance — lives outside the agent loop.
3. **Distribution leverage.** Claude Code hooks + MCP ecosystem provide instant access to 100K+ existing agent users. Rebuilding the loop has zero distribution.
4. **Engineering compounds outside the loop.** Hours spent on governance, adapters, and QA pipelines build a moat. Hours spent on agent-loop polish catch up to a moving target.

---

## Three Pillars

```
┌───────────────────────────────────────────────────────────┐
│  Pillar 1: GOVERNANCE    (Outer Harness)                  │
│  Permission · Budget · Audit · Hooks · Input Gate         │
└───────────────────────────────────────────────────────────┘
┌───────────────────────────────────────────────────────────┐
│  Pillar 2: QA PIPELINE   (SDLC Orchestrator)              │
│  Norm → Ctx → Plan → Exec → Patch → QA → Retry → Out      │
│  M1–M10 metrics · delegates Exec to agents via adapter    │
└───────────────────────────────────────────────────────────┘
┌───────────────────────────────────────────────────────────┐
│  Pillar 3: ADAPTERS + MCP   (Distribution)                │
│  Claude Code hooks · Cursor adapter · MCP server · …      │
└───────────────────────────────────────────────────────────┘
```

Each pillar stands alone. Use governance without pipeline. Use pipeline without MCP. Mix freely.

### Pillar 1 — Governance (Outer Harness)

Primary value. Enforces policy on every tool call an agent makes — via Claude Code `PreToolUse` / `PostToolUse` hooks or the MCP tool surface. Produces tamper-evident audit trail.

**Core modules (`packages/outer-harness/`):**
- `PermissionEngine` — rule-based allow/deny/ask with 7-level hierarchy
- `BudgetManager` — per-session, per-day, per-user cost caps
- `HookEngine` — 5 hook types (command, prompt, agent, http, function)
- `InputGate` — prompt-side validation and injection
- `AuditLogger` — append-only JSONL audit trail
- `MonitorCollector` + `AlertEngine` — live telemetry

### Pillar 2 — QA Pipeline (SDLC Orchestrator)

Meta-workflow **above** agents. Delegates the actual code generation (Pillar 2 stage 4 — `Exec`) to whatever agent the user has (Claude Code, Cursor, direct API). Adds deterministic stages around it: task normalization, context assembly, planning, patch validation, quality gates, retry classification, output standardization.

**Differentiator:** M1–M10 metrics — first-pass success, test pass rate, scope accuracy, retry count, cost, time, regression, plan accuracy, context utilization, code quality delta — measured across runs. Claude Code does not expose these.

**Core modules (`packages/inner-harness/src/sdlc/`):** 8 stage modules, metrics collector, pipeline orchestrator, config loader.

### Pillar 3 — Adapters + MCP (Distribution)

How AgentWeave reaches agents in the wild.

**Channels:**
- **Claude Code hooks** — `.claude/hooks/pre-tool-use.cjs` → `agentweave guard` → governance enforcement
- **MCP server** (`packages/mcp-server/`) — exposes governance + QA tools to any MCP host (Claude Code, Cursor, Windsurf, custom agents)
- **Adapter pattern** (`packages/adapters/`) — bridges SDLC pipeline's `Exec` stage to target agents (Claude Code today; Cursor, Aider roadmap)

---

## What We Keep, What We Demote

The existing codebase built more than this pivot covers. Nothing is deleted, but roles change.

| Module | Old role | New role |
|---|---|---|
| `inner-harness/src/agent-loop.ts`, `tool-executor.ts`, built-in-tools | "Production inner execution" | **Reference implementation + teaching only.** Not promoted in marketing. Kept for offline/local use cases. |
| `inner-harness/src/message-store.ts`, `token-counter.ts`, `mock-llm.ts` | Production support | **Test infrastructure.** Enables governance unit tests without real API calls. |
| `inner-harness/src/sdlc/` (8 stages, M1–M10) | Inner harness feature | **Promoted → Pillar 2, USP.** Re-framed as orchestrator-above-agents, not agent-loop replacement. |
| `adapters/claude-code-adapter.ts` | Bridge component | **Promoted → Pillar 3 core.** Template for future Cursor, Aider, custom adapters. |
| `outer-harness/*` | Secondary governance layer | **Promoted → Pillar 1, primary value.** |
| `mcp-server/` | Optional feature | **Promoted → Pillar 3 distribution channel.** |

**Rule:** no new features for agent-loop replacement. Bug fixes only when tests break. Don't mention `agent-loop` in marketing copy, docs, or persona mapping.

---

## Persona Mapping

| Persona | Primary Pillar | Why |
|---|---|---|
| **Developer** | Pillar 2 (QA Pipeline) | Wants first-pass-success data, retry count, cost per task |
| **Team Lead** | Pillar 2 + Pillar 1 (Hooks) | Enforce test gates, measure team velocity via M1–M10 |
| **Security Engineer** | Pillar 1 (Governance) | Permission rules, deny lists, audit trail |
| **Platform Engineer** | Pillar 1 + Pillar 3 (Adapters) | Central config for 100+ agents across heterogeneous tools |
| **Enterprise Admin** | Pillar 1 (Policy hierarchy) | Compliance, RBAC, immutable rules |
| **AI Researcher** | Pillar 2 (M1–M10 analytics) | Measure agent behavior across runs, compare models |

---

## Competitive Framing

| Category | Examples | AgentWeave relationship |
|---|---|---|
| **Agent CLI** | Claude Code, Cursor, Aider, Codex | **We wrap them, we don't replace.** Partners, not competitors. |
| **LLM frameworks** | LangChain, LlamaIndex, CrewAI | **Different layer.** They orchestrate LLM calls; we govern agent execution. |
| **Output guardrails** | Guardrails AI, NeMo Guardrails | **Overlapping on output validation.** We add governance + QA pipeline; they focus on model output. |
| **Agent observability** | LangSmith, Helicone, Phoenix | **Complementary.** They observe; we enforce + measure SDLC outcomes. |
| **Enterprise policy** | Custom DIY | **Direct alternative.** We provide out-of-the-box what teams build in-house over 3–6 months. |

---

## Non-Goals

- Building a better agent loop than Claude Code or Cursor.
- Competing as a model provider.
- IDE plugin / GUI dashboard as primary surface (CLI + MCP first).
- Locking users to a single agent vendor.

---

## Roadmap Implications

Phase 1 MVP: ✅ complete (confirmed 2026-04-22, all 8 deliverables shipped).

Phase 2 onward re-prioritized around the 3 pillars:

| Phase | Focus | Concrete deliverables |
|---|---|---|
| **Phase 2 (now)** | Governance observability | `agentweave audit view` CLI, Prometheus exporter, session replay |
| **Phase 3** | MCP + policy hierarchy | MCP server public docs, Cursor adapter PoC, contextual permission rules |
| **Phase 4** | Multi-agent via adapter fan-out | Parallel agent invocation across adapters, per-agent governance |
| **Phase 5** | Enterprise | RBAC, SSO, policy hierarchy, Python SDK, CI/CD integrations |
| **Phase 6** | Ecosystem | Plugin marketplace, community adapters, training |

---

## How to Use This Document

- **Product decisions:** check positioning in this file first. If a proposal conflicts with the 3 pillars or non-goals, it needs explicit sign-off to proceed.
- **Spec updates:** `product_spec_agent_harness_framework.md`, `agentweave_product_introduction.md`, and `README.md` reference this file as authoritative.
- **Code changes:** if you're adding features to `packages/inner-harness/src/agent-loop.ts` or built-in tools, check if the work should instead extend an adapter or the SDLC pipeline.
- **Marketing / docs:** the tagline at the top is the single sentence. Don't invent variants.

---

## Change Log

| Date | Change | Author |
|---|---|---|
| 2026-04-22 | Initial pivot — created this file, demoted inner-harness agent-loop, promoted SDLC pipeline to Pillar 2, introduced 3-pillar framing | PO (phucdn7) + Claude |
