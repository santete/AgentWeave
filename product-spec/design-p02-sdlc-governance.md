# P0.2 — Wrap SDLC pipeline in OuterHarness

**Status:** Design · **Author:** /architect · **Date:** 2026-04-22 · **Roadmap ref:** `project_roadmap_plan.md` P0.2 (L)

## Problem

`SDLCOrchestrator` runs standalone with no governance wiring. Governance today only applies in two places:

| Path | What's governed | How |
|---|---|---|
| `pipeline run --agent X` (wrap mode) | Adapter stdout redaction + audit | `AdapterGovernance` in CLI (commit `7a986f8`) |
| `pipeline run` (direct mode, agent-loop) | Nothing | — |
| SDLC stage transitions (either mode) | Nothing | — |

Pillar 1 (Governance) and Pillar 2 (QA Pipeline) never compose at the SDLC level.

## Goals

1. SDLC pipeline emits an audit trail per stage (all 8 phases).
2. Tool calls issued by `AgentLoop` inside `ExecutionBridge` honor `PermissionEngine` when configured.
3. Budget cost accumulates across stages when adapter emits usage.
4. Hard constraint holds: **`@agentweave/inner-harness` must NOT import `@agentweave/outer-harness` runtime.**
5. 579 baseline tests still pass.

## Key insight — the seam already exists

`@agentweave/types/outer.ts` already exports `OuterHarnessConsumer`. That's the clean seam. Inner Harness takes a **type-only import** of a subset; Outer Harness implements the full interface; CLI is the assembly point that plugs Outer into Inner via DI.

No new package, no circular dep, no cross-layer runtime import.

---

## 1. Interface shape — `GovernanceHandle` in `@agentweave/types`

New file: `packages/types/src/governance.ts`

```ts
import type { OuterHarnessConsumer } from "./outer";

/**
 * Minimal subset of OuterHarnessConsumer consumed by Inner Harness SDLC pipeline.
 * Tool-call gating is handled separately via ControlPlane interceptors; this
 * handle only covers non-blocking observation + session lifecycle.
 */
export type GovernanceHandle = Pick<
  OuterHarnessConsumer,
  "onEvent" | "onSessionStart" | "onSessionEnd"
>;
```

**Why `Pick` and not a new interface?** Outer already implements all three methods. Pick keeps Inner aligned with whatever Outer gains in the future without re-typing.

Add two new InnerEvent variants in `packages/types/src/events.ts`:

```ts
// Inside InnerEventPayload union:
| { type: "sdlc:stage_start"; stage: SDLCStageName; phase: number }
| { type: "sdlc:stage_end"; stage: SDLCStageName; phase: number; durationMs: number; status: "success" | "failure" | "skipped" }

export type SDLCStageName =
  | "taskNormalizer" | "contextBuilder" | "planGenerator"
  | "executionBridge" | "patchValidator" | "qualityGate"
  | "retryEngine" | "outputStandardizer";
```

Extend `SDLCModuleContext`:

```ts
// packages/types/src/sdlc.ts
export interface SDLCModuleContext {
  sessionId: string;
  cwd: string;
  signal: AbortSignal;
  config: SDLCConfig;
  metrics: MetricsHandle;
  llmCaller?: LLMCallerFn;
  // NEW — optional governance plumbing
  governance?: GovernanceHandle;        // stage audit + session lifecycle
  controlPlane?: ControlPlane;          // propagated to AgentLoop for tool-call gating
}
```

---

## 2. Where to invoke hooks — stage enter/exit, every stage

**Decision: every enabled stage emits `sdlc:stage_start` + `sdlc:stage_end`**, not just Exec.

**Why:**
- Only 8 stages per pipeline run (micro-scale by nature) — ~8 audit.log calls total per pipeline, each an in-memory append.
- Auditing only Exec hides where the pipeline spends time (slow context build, stuck retry loop) — the whole point of Pillar 1 observability.
- `AuditLogger.log()` is already sub-ms in the happy path.

**How:** hook into `module-runner.ts`, not the orchestrator body. `runModule()` is the single choke-point every stage passes through.

```ts
// In module-runner.ts (before execute)
ctx.governance?.onEvent(makeStageEvent("sdlc:stage_start", module.name, phase));

try {
  const output = await module.execute(input, ctx);
  ctx.governance?.onEvent(makeStageEvent("sdlc:stage_end", module.name, phase, {
    durationMs, status: "success",
  }));
  return output;
} catch (err) {
  ctx.governance?.onEvent(makeStageEvent("sdlc:stage_end", module.name, phase, {
    durationMs, status: "failure",
  }));
  throw err;
}
```

Session lifecycle (`onSessionStart` / `onSessionEnd`) is called by `SDLCOrchestrator.executePipeline()` — once at the top, once at terminal yield.

---

## 3. How ExecutionBridge receives the handle

**Two channels, different purposes:**

### Channel 1 — `context.governance` (already done via SDLCModuleContext)
ExecutionBridge does NOT need this directly. It propagates through `runModule()` for stage audit; the Bridge itself just produces its `SDLCExecutionResult`.

### Channel 2 — `context.controlPlane` → pass to AgentLoop
In `ExecutionBridge.createAgentLoop()`, inject the ControlPlane:

```ts
// execution-bridge.ts (delta shown)
private async createAgentLoop(context: SDLCModuleContext): Promise<InnerHarnessProvider> {
  const config = context.config.execution.agentLoop;
  if (!config) throw new Error("...");

  const { AgentLoop } = await import("../../agent-loop");
  const { BUILT_IN_TOOLS } = await import("../../built-in-tools");

  return new AgentLoop({
    model: config.model,
    fallbackModel: config.fallbackModel,
    maxTurns: config.maxTurns ?? 50,
    systemPrompt: config.systemPrompt,
    tools: BUILT_IN_TOOLS,
    controlPlane: context.controlPlane, // ← NEW, optional; AgentLoop defaults to noop if absent
  });
}
```

AgentLoop already has `controlPlane?: ControlPlane` in its config (verified: `agent-loop.ts:47`, falls back to `createNoopControlPlane()` at :83).

**Process-adapter mode:** governance handle observes stage events; tool-call gating doesn't apply (black-box process). This matches D2 reality — adapter I/O is governed by `AdapterGovernance` at the CLI layer.

**API-direct mode:** same as process-adapter — stage audit only; the raw LLM call has no tool interception surface.

---

## 4. CLI wiring for direct-mode `pipeline run`

Today, `pipeline.ts` has:
- **wrap mode** (`--agent X`): builds `AdapterGovernance`, sends adapter stdout through it.
- **direct mode** (no `--agent`): builds nothing, runs raw agent-loop.

New: new helper `packages/cli/src/lib/sdlc-governance.ts` that reads `agentweave.yaml` (permissions, budget, audit settings) and returns:

```ts
export interface SdlcGovernanceBundle {
  outer: OuterHarness;
  controlPlane: ControlPlane;
}

export function createSdlcGovernance(
  config: Partial<OuterHarnessConfig>,
  sessionId: string,
): SdlcGovernanceBundle;
```

Inside:
1. Construct `ControlPlane` (from `@agentweave/control-plane`).
2. Construct `OuterHarness(config)`.
3. `outer.connectToControlPlane(cp)` — registers interceptors.
4. `outer.onSessionStart({ sessionId })` — primes audit.
5. Return both.

`pipeline.ts` delta (pseudo-diff on lines 343–391):

```ts
const isWrapMode = !!agent;

let adapterGov: AdapterGovernance | null = null;
let sdlcGov: SdlcGovernanceBundle | null = null;

if (isWrapMode) {
  adapterGov = createAdapterGovernance({ sessionId: governanceSessionId });
  // ... existing logSpawn ...
}

// NEW — stage-level + tool-call governance for SDLC itself (both modes)
if (config.governance?.enabled !== false) {
  sdlcGov = createSdlcGovernance(config.governance ?? {}, governanceSessionId);
}

const pipeline = createSDLCPipeline({
  execution: /* ... unchanged ... */,
  modules: /* ... unchanged ... */,
  metrics: /* ... unchanged ... */,
  governance: sdlcGov?.outer,          // NEW — GovernanceHandle (OuterHarness implements)
  controlPlane: sdlcGov?.controlPlane, // NEW — passed down to AgentLoop
});

// ... existing event loop ...

// On completion:
await sdlcGov?.outer.onSessionEnd({ sessionId: governanceSessionId }, terminalResult);
```

**Config surface:** `agentweave.yaml` gains an optional `governance:` block read by `createSdlcGovernance()`. Default: disabled (preserves current behavior when users haven't opted in).

---

## 5. Ordered file-by-file change list

| # | File | Size | Nature |
|---|---|---|---|
| 1 | `packages/types/src/governance.ts` | +10 LOC | NEW — type alias |
| 2 | `packages/types/src/events.ts` | +10 LOC | ADD `sdlc:stage_*` variants + `SDLCStageName` |
| 3 | `packages/types/src/sdlc.ts` | +5 LOC | Extend `SDLCModuleContext` with optional `governance` + `controlPlane` |
| 4 | `packages/types/src/index.ts` | +3 LOC | Re-export new types |
| 5 | `packages/inner-harness/src/sdlc/module-runner.ts` | +15 LOC | Emit `sdlc:stage_start`/`_end` around `execute()` |
| 6 | `packages/inner-harness/src/sdlc/modules/execution-bridge.ts` | +3 LOC | Pass `context.controlPlane` to `new AgentLoop(...)` |
| 7 | `packages/inner-harness/src/sdlc/sdlc-orchestrator.ts` | +30 LOC | Constructor accepts `governance`/`controlPlane`; propagate into `ctx`; call `onSessionStart`/`End` |
| 8 | `packages/inner-harness/src/sdlc/create-pipeline.ts` | +5 LOC | Forward `governance`/`controlPlane` options |
| 9 | `packages/cli/src/lib/sdlc-governance.ts` | +60 LOC | NEW — build `OuterHarness` + `ControlPlane` from config |
| 10 | `packages/cli/src/commands/pipeline.ts` | +30 LOC | Wire `createSdlcGovernance` into direct (and optionally wrap) mode |
| 11 | `packages/inner-harness/__tests__/sdlc/sdlc-governance.test.ts` | +120 LOC | NEW — integration tests (see §6) |
| 12 | `packages/cli/__tests__/pipeline-governance.test.ts` | +60 LOC | NEW — E2E deny rule blocks pipeline |

**Total: ≈ 350 LOC.** Matches the "L" size estimate from the roadmap.

**Implementation order** (strict — each step's tests must pass before moving on):
1. Types (#1–4) — compiles standalone.
2. Inner-harness (#5–8) — can write unit tests using a stub `GovernanceHandle`.
3. CLI helper (#9) — unit test in isolation (mock config).
4. CLI wiring (#10) — E2E.
5. Tests (#11–12) — parallel with each layer.

---

## 6. Test plan

### New tests

**`sdlc-governance.test.ts` (inner-harness)**

1. **Stage events emitted for each enabled stage** — construct pipeline with all stages enabled, stub `GovernanceHandle.onEvent = mock`, run with a trivial `llmCaller`, assert 8 `sdlc:stage_start` + 8 `sdlc:stage_end` events.
2. **Skipped stages do not emit events** — disable `outputStandardizer`, assert no event for it.
3. **`stage_end` captures `durationMs` + `status: "success"`** — assert numeric `durationMs > 0`.
4. **Stage failure emits `status: "failure"` and rethrows** — inject a throwing module, assert event captured BEFORE the throw propagates.
5. **`onSessionStart` called once at start with `sessionId`** — spy handle.
6. **`onSessionEnd` called once at end with `TerminalResult`** — spy handle.
7. **AgentLoop receives the ControlPlane** — mock CP with `registerInterceptor("tool_request", () => deny)`, run pipeline in `agent-loop` mode with a prompt that triggers a tool call, assert tool call denied.
8. **Backward compatible — no governance → pipeline runs unchanged** — omit the option, assert same outcome as current tests.

**`pipeline-governance.test.ts` (CLI)**

9. **Deny rule in `agentweave.yaml` blocks pipeline** — write config with `permissions: [{ pattern: "Bash(*)", behavior: "deny" }]`, run a prompt that would spawn Bash tool, assert non-zero exit + audit entry on disk.
10. **Audit log has 8 stage entries after a successful run** — happy-path pipeline, tail `.agentweave/audit.log`, count `sdlc:stage_*` entries.

### Existing tests at risk

- `packages/inner-harness/__tests__/sdlc/sdlc-orchestrator.test.ts` (9 tests) — constructor gains optional params. **Mitigation:** all new params default to `undefined`; no existing test needs changes.
- `packages/cli/__tests__/bin.test.ts` (14 tests) — unaffected; CLI help surface unchanged.
- `packages/inner-harness/__tests__/sdlc/modules.test.ts` (27 tests) — `module-runner.ts` change is additive with null-guards (`ctx.governance?.onEvent(...)`). Existing module tests pass no governance → no-op.
- Outer-harness tests (250) — untouched.

**Regression budget:** 0 tests must break. Branch-policy: abandon the change if any baseline test turns red and the root cause isn't a trivial test-harness tweak.

---

## 7. Risks + mitigations

| # | Risk | Severity | Mitigation |
|---|---|---|---|
| 1 | Circular dep (`inner → outer`) | HIGH | Type-only import of `GovernanceHandle` from `@agentweave/types`. CLI is the sole assembly point. Verify by `turbo run build` — TypeScript refuses type-only imports at runtime. |
| 2 | AgentLoop constructor doesn't take `controlPlane` | LOW | Verified: already exists (`agent-loop.ts:47`). Defaults to noop CP when omitted. |
| 3 | Per-stage audit I/O slows pipeline | LOW | 8 events per run, all in-memory `AuditLogger.log` calls. Disk flush is opportunistic (already tuned in `AuditLogger`). Measure: bench `.bench-d2-smoke` with/without governance, expect <50ms delta. |
| 4 | Doubled audit when wrap mode also enables SDLC governance | MEDIUM | Keep audit paths distinct by default: `.agentweave/adapter-audit.jsonl` (D2) vs `.agentweave/sdlc-audit.jsonl` (new). Document in `docs/governance-overview.md`. |
| 5 | `SDLCModuleContext` shape change breaks custom modules | LOW | Fields are OPTIONAL additions. Custom modules that ignore them continue to work. |
| 6 | Budget tracking dead in process-adapter mode | DOC-ONLY | ProcessAdapter doesn't emit `llm:stream_end`, so `OuterHarness.onEvent` doesn't accumulate cost. Document: "budget enforcement for wrap mode uses wall-clock timeout; dollar-cost accumulation requires agent-loop or api-direct." |
| 7 | Test 7 (AgentLoop receives CP) depends on LLM mock | MEDIUM | Use the same Mock LLM pattern already in `inner-harness/__tests__/agent-loop.test.ts`. If that mock doesn't exist, pull from `outer-harness` interceptor tests. |

---

## Appendix — ASCII wiring diagram

```
┌──────────────────────────── CLI (assembly point) ────────────────────────────┐
│                                                                              │
│   agentweave.yaml → createSdlcGovernance({permissions, budget, audit})       │
│                       │                                                      │
│                       ▼                                                      │
│                 ┌──────────────┐   connectToControlPlane()  ┌──────────────┐ │
│                 │ OuterHarness │ ────────────────────────▶  │ ControlPlane │ │
│                 └──────┬───────┘                            └──────┬───────┘ │
│                        │                                           │         │
│                        │ governance (GovernanceHandle)             │         │
│                        ▼                                           │         │
│             createSDLCPipeline({ governance, controlPlane })       │         │
│                        │                                           │         │
│                        ▼                                           │         │
│              ┌───────────────────┐                                 │         │
│              │ SDLCOrchestrator  │                                 │         │
│              └─────────┬─────────┘                                 │         │
│                        │                                           │         │
│   ctx.governance ──────┴──▶ module-runner ──▶ emits stage_start    │         │
│                                              / stage_end events    │         │
│                        │                                           │         │
│   ctx.controlPlane ────┴──▶ ExecutionBridge ──▶ AgentLoop ─────────┘         │
│                                                 (tool_request                │
│                                                  interceptors fire)          │
└──────────────────────────────────────────────────────────────────────────────┘

Dep graph (unchanged):
  types  ◀── control-plane  ◀── inner-harness (reads GovernanceHandle as type)
                               ◀── outer-harness (implements OuterHarnessConsumer)
                               ◀── cli (wires both together)
```

---

## Decision summary (for the reviewer)

- **Interface:** `GovernanceHandle = Pick<OuterHarnessConsumer, "onEvent" | "onSessionStart" | "onSessionEnd">` in `@agentweave/types`.
- **Hook points:** all 8 stages via `module-runner.ts`; session lifecycle via `SDLCOrchestrator`.
- **DI:** `SDLCModuleContext` gains two optional fields; CLI is the assembly point.
- **Tool-call gating:** via existing `ControlPlane` interceptors, propagated through `SDLCModuleContext.controlPlane` into `AgentLoop`.
- **Backward compatibility:** all new params optional. Zero baseline test break expected.
- **Size:** ~350 LOC across 12 files. L-sized, matches roadmap.

Ready for `/implement` review. Pick nits first; once approved, implementation follows the ordered step list in §5.
