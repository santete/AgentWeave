# @agentweave/inner-harness

> Two roles live in this package. Read this section before using any export.

**Canonical positioning:** [`product-spec/POSITIONING.md`](../../product-spec/POSITIONING.md).

## Two roles — know which one you want

### Role A — SDLC Pipeline *(Pillar 2, promoted post-pivot 2026-04-22)*

The **production** surface. A meta-workflow that runs **above** any AI coding agent (Claude Code, Cursor, Aider, …) and adds deterministic stages around its code-generation: task normalization, context assembly, planning, patch validation, quality gates, retry classification, output standardization. Produces M1–M10 improvement metrics across runs.

- Source: [`src/sdlc/`](src/sdlc/)
- Primary factory: `createSDLCPipeline()`
- Delegates the `Exec` stage to an agent via `@agentweave/adapters`
- **This is the USP.** New feature work for Pillar 2 lives here.

### Role B — Agent Loop + built-in tools *(reference implementation, demoted post-pivot 2026-04-22)*

A plain LLM agent loop with 6 built-in tools. Historically the "inner execution" layer; **no longer the production path** — AgentWeave now delegates execution to Claude Code / Cursor / MCP-compatible agents via adapters. Kept for:

1. Offline / local use cases (no Claude Code available)
2. Teaching the `InnerHarnessProvider` contract (Role A implements the same interface)
3. Test infrastructure for the outer-harness governance tests

- Source: [`src/agent-loop.ts`](src/agent-loop.ts), [`src/tool-executor.ts`](src/tool-executor.ts), [`src/built-in-tools/`](src/built-in-tools/)
- Factory: direct `new AgentLoop(config)`
- **Frozen for new features.** Bug fixes only when tests break.
- Source files carry `REFERENCE IMPLEMENTATION — not production path` headers.

Rule of thumb: **building on AgentWeave → Role A. Rebuilding Claude Code → you probably don't want this package.**

---

## Install

```bash
pnpm add @agentweave/inner-harness
```

Optional peer packages:

```bash
pnpm add @agentweave/adapters        # wrap a CLI agent (Role A production path)
pnpm add @agentweave/control-plane   # plug into the governance layer later
```

---

## Role A — SDLC Pipeline quick start

### Minimal — quality gate only

```typescript
import { createSDLCPipeline } from "@agentweave/inner-harness";

const pipeline = createSDLCPipeline({
  execution: {
    mode: "process-adapter",
    processAdapter: { command: "claude", args: ["--print"] },
  },
  modules: {
    taskNormalizer: { enabled: false },
    contextBuilder: { enabled: false },
    planGenerator: { enabled: false },
    executionBridge: { enabled: true },
    patchValidator: { enabled: false },
    qualityGate: {
      enabled: true,
      checks: [
        { type: "test", command: "npm test", required: true },
        { type: "lint", command: "npm run lint", required: false },
      ],
    },
    retryEngine: { enabled: true, maxRetries: 2 },
    outputStandardizer: { enabled: false },
  },
});

for await (const event of pipeline.run("Fix the login bug in AuthService")) {
  if (event.type === "message:assistant") {
    const text = (event as { content?: Array<{ text?: string }> }).content?.[0]?.text;
    if (text?.startsWith("[SDLC]")) console.log(text);
  }
}

const metrics = pipeline.getLastMetrics();
console.log(`First-pass success: ${metrics?.m1_firstPassSuccess}`);
console.log(`Test pass rate:     ${(metrics?.m2_testPassRate ?? 0) * 100}%`);
console.log(`Retry count:        ${metrics?.m4_retryCount}`);
console.log(`Cost:               $${metrics?.m5_costUsd.toFixed(4)}`);
```

### Full pipeline — all modules enabled

```typescript
const pipeline = createSDLCPipeline({
  execution: {
    mode: "agent-loop",
    agentLoop: { model: "claude-sonnet-4-6", maxTurns: 30 },
  },
  modules: {
    taskNormalizer:     { enabled: true, model: "claude-haiku-4-5" },
    contextBuilder:     { enabled: true, maxFiles: 15 },
    planGenerator:      { enabled: true, model: "claude-haiku-4-5", maxSteps: 10 },
    executionBridge:    { enabled: true },
    patchValidator:     { enabled: true, maxFilesChanged: 20 },
    qualityGate: {
      enabled: true,
      checks: [
        { type: "compile", command: "tsc --noEmit",  required: true  },
        { type: "test",    command: "vitest run",    required: true  },
        { type: "lint",    command: "eslint src/",   required: false },
      ],
    },
    retryEngine:        { enabled: true, maxRetries: 3 },
    outputStandardizer: { enabled: true, commitFormat: "conventional" },
  },
  metrics: { enabled: true, baseline: true, persistPath: ".agentweave/metrics/" },
  llmCaller: async (prompt, model) => {
    const response = await yourLLMClient.chat(prompt, { model });
    return response.text;
  },
});
```

### Individual SDLC modules

```typescript
import {
  TaskNormalizerModule,
  ContextBuilderModule,
  PlanGeneratorModule,
  ExecutionBridgeModule,
  PatchValidatorModule,
  QualityGateModule,
  RetryEngineModule,
  OutputStandardizerModule,
} from "@agentweave/inner-harness";
```

Every module implements `SDLCModule<TInput, TOutput>`:

```typescript
interface SDLCModule<TInput, TOutput> {
  readonly name: string;
  execute(input: TInput, context: SDLCModuleContext): Promise<TOutput>;
}
```

---

## Role B — Agent Loop (reference impl)

Use when you genuinely need a self-contained LLM loop and *not* AgentWeave's governance or Pillar 2 value. Most users should pick Role A with a `process-adapter` execution mode instead.

```typescript
import { AgentLoop, BUILT_IN_TOOLS } from "@agentweave/inner-harness";

const loop = new AgentLoop({
  model: "claude-sonnet-4-6",
  tools: BUILT_IN_TOOLS,
  maxTurns: 100,
});

for await (const event of loop.run("Explain this repo in 3 bullets")) {
  // handle events
}
```

Provider auto-detection from model name: `claude-*` → Anthropic, `gpt-*` → OpenAI, `gemini-*` → Google, `OPENROUTER_API_KEY` → OpenRouter.

**What you get up:** governance, audit log, permission enforcement, M1–M10 metrics, multi-agent orchestration, adapter-based agent swapping. Those live in the outer-harness, adapters, and SDLC pipeline — not this loop.

---

## Public API — exports at a glance

| Export | Role | Purpose |
|---|---|---|
| `createSDLCPipeline(options?)` | A | **Recommended.** Pipeline factory, returns `SDLCOrchestrator`. |
| `SDLCOrchestrator` | A | Pipeline class. Implements `InnerHarnessProvider`. |
| `TaskNormalizerModule`, `ContextBuilderModule`, … (8 modules) | A | Individual SDLC stage modules. |
| `MetricsCollector` | A | M1–M10 collection + baseline comparison. |
| `getDefaultSDLCConfig`, `validateSDLCConfig`, `SDLCConfigSchema` | A | Config helpers + Zod schema. |
| `AgentLoop` | B | Direct LLM loop, no SDLC workflow. |
| `BUILT_IN_TOOLS`, `getBuiltInTool`, `ToolRegistry`, `ToolExecutor` | B | Reference tool surface (6 tools). |
| `createNoopControlPlane` | A + B | Passthrough control plane for standalone use. |
| `createMockLLMCaller`, `MockScenarios` | tests | Deterministic LLM responses for tests. |

Both `SDLCOrchestrator` and `AgentLoop` implement the same `InnerHarnessProvider` interface — the pipeline is a drop-in replacement for the loop.

---

## Configuration

### Execution modes

**`process-adapter`** — wrap a CLI agent (Claude Code, Cursor CLI, any subprocess):

```typescript
execution: {
  mode: "process-adapter",
  processAdapter: { command: "claude", args: ["--print"] },
}
```

This is the production path. Pair with `@agentweave/adapters` for proper bridging.

**`agent-loop`** — use the reference `AgentLoop`. Pillar 2 value still applies (metrics, quality gates) but the exec stage now runs in-process instead of delegating.

```typescript
execution: {
  mode: "agent-loop",
  agentLoop: { model: "claude-sonnet-4-6", maxTurns: 30 },
}
```

### Metrics

```typescript
metrics: {
  enabled: true,
  baseline: true,                         // compare each run against first run
  persistPath: ".agentweave/metrics/",    // JSONL per run
}
```

Reports land as `baseline.json` and per-run timestamped files. Read with `agentweave metrics` or `agentweave metrics --history` from the CLI.

---

## How this package fits AgentWeave

```
         ┌──────────────────────────────────────┐
         │  Pillar 1  Outer Harness             │
         │  governance, audit, hooks, budget    │
         └──────────────────────────────────────┘
                       ▲
                       │  intercepts
                       │
         ┌──────────────────────────────────────┐
         │  Pillar 2  inner-harness (THIS PKG)  │
         │  └─ Role A: SDLC Pipeline  (USP)     │
         │  └─ Role B: Agent Loop     (ref)     │
         └──────────────────────────────────────┘
                       │
                       │  Exec stage delegates via
                       ▼
         ┌──────────────────────────────────────┐
         │  Pillar 3  @agentweave/adapters      │
         │  Claude Code, Cursor, Aider, …       │
         └──────────────────────────────────────┘
```

All three pillars stand alone — see [`product-spec/POSITIONING.md`](../../product-spec/POSITIONING.md).

---

## License

MIT
