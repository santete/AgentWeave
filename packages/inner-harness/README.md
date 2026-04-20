# @agentweave/inner-harness

**AI SDLC Engine** — Structured workflow that wraps any AI agent (Claude Code, Cursor, Aider, Codex) with task normalization, planning, quality gates, deterministic retry, and measurable improvement metrics.

Works **standalone** (zero dependencies on control-plane or outer-harness). Plug into the full AgentWeave platform later when you need governance.

## Install

```bash
npm install @agentweave/inner-harness
# or
pnpm add @agentweave/inner-harness
```

Optional peer dependencies (install only when needed):

```bash
# For wrapping CLI agents (process-adapter mode)
pnpm add @agentweave/adapters

# For plugging into governance layer later
pnpm add @agentweave/control-plane
```

## Quick Start

### Minimal — Quality Gate only

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

const gen = pipeline.run("Fix the login bug in AuthService");

for await (const event of gen) {
  if (event.type === "message:assistant") {
    const text = (event as any).content?.[0]?.text;
    if (text?.startsWith("[SDLC]")) console.log(text);
  }
}

// After completion — see improvement metrics
const metrics = pipeline.getLastMetrics();
console.log(`First-pass success: ${metrics?.m1_firstPassSuccess}`);
console.log(`Test pass rate: ${(metrics?.m2_testPassRate ?? 0) * 100}%`);
console.log(`Retry count: ${metrics?.m4_retryCount}`);
console.log(`Cost: $${metrics?.m5_costUsd.toFixed(4)}`);
```

### Full Pipeline — All modules enabled

```typescript
import { createSDLCPipeline } from "@agentweave/inner-harness";

const pipeline = createSDLCPipeline({
  execution: {
    mode: "agent-loop",
    agentLoop: { model: "claude-sonnet-4-6", maxTurns: 30 },
  },
  modules: {
    taskNormalizer: { enabled: true, model: "claude-haiku-4-5" },
    contextBuilder: { enabled: true, maxFiles: 15 },
    planGenerator: { enabled: true, model: "claude-haiku-4-5", maxSteps: 10 },
    executionBridge: { enabled: true },
    patchValidator: { enabled: true, maxFilesChanged: 20 },
    qualityGate: {
      enabled: true,
      checks: [
        { type: "compile", command: "tsc --noEmit", required: true },
        { type: "test", command: "vitest run", required: true },
        { type: "lint", command: "eslint src/", required: false },
      ],
    },
    retryEngine: {
      enabled: true,
      maxRetries: 3,
      strategies: [
        { errorType: "compile_error", action: "fix_specific" },
        { errorType: "test_failure", action: "fix_specific" },
        { errorType: "lint_warning", action: "fix_specific" },
      ],
    },
    outputStandardizer: { enabled: true, commitFormat: "conventional" },
  },
  metrics: { enabled: true, baseline: true, persistPath: ".agentweave/metrics/" },
  llmCaller: async (prompt, model) => {
    // Your LLM integration for meta tasks (planning, normalization)
    // Use any provider — OpenAI, Anthropic, OpenRouter, etc.
    const response = await yourLLMClient.chat(prompt, { model });
    return response.text;
  },
});

for await (const event of pipeline.run("Add user avatar upload feature")) {
  // Handle events as needed
}

// Improvement report
const comparison = pipeline.getLastComparison();
if (comparison?.baseline) {
  console.log("Improvement vs baseline:");
  console.log(`  Test pass rate: ${comparison.deltas.m2_testPassRate > 0 ? "+" : ""}${(comparison.deltas.m2_testPassRate * 100).toFixed(1)}%`);
  console.log(`  Retry count: ${comparison.deltas.m4_retryCount}`);
}
```

---

## Public API Reference

### Entry Points

| Export | Type | Description |
|--------|------|-------------|
| `createSDLCPipeline(options?)` | Factory | **Recommended.** Creates standalone SDLC pipeline. Returns `SDLCOrchestrator`. |
| `SDLCOrchestrator` | Class | Low-level orchestrator. Implements `InnerHarnessProvider`. |
| `AgentLoop` | Class | Direct LLM execution engine. No SDLC workflow. |
| `createNoopControlPlane()` | Factory | Passthrough control plane for standalone mode. |

### `createSDLCPipeline(options?)`

```typescript
function createSDLCPipeline(options?: CreateSDLCPipelineOptions): SDLCOrchestrator
```

**Options:**

```typescript
interface CreateSDLCPipelineOptions {
  modules?: Partial<SDLCConfig["modules"]>;     // Per-module config
  execution?: Partial<SDLCConfig["execution"]>; // Agent target
  metrics?: Partial<SDLCConfig["metrics"]>;     // Metrics collection
  llmCaller?: LLMCallerFn;                     // For planning/normalization
}
```

Unspecified fields use sensible defaults. Every module defaults to `enabled: true` except `outputStandardizer` (`false`).

### `SDLCOrchestrator`

Implements `InnerHarnessProvider` — drop-in replacement for `AgentLoop`.

```typescript
class SDLCOrchestrator implements InnerHarnessProvider {
  // Run the SDLC pipeline
  run(prompt: string, options?: RunOptions): AsyncGenerator<InnerEvent, TerminalResult>;

  // Abort execution
  abort(reason?: string): void;

  // Query state
  getState(): InnerState;
  getMessages(): ReadonlyArray<Message>;
  getUsage(): TokenUsage;

  // Metrics (available after run completes)
  getLastMetrics(): SDLCMetricsSnapshot | null;
  getLastComparison(): SDLCBaselineComparison | null;

  // Plug in a pre-built execution provider (skip dynamic import)
  setExecutionProvider(provider: InnerHarnessProvider): void;
}
```

### `AgentLoop`

Direct LLM execution — no SDLC workflow, just call LLM + execute tools.

```typescript
class AgentLoop implements InnerHarnessProvider {
  constructor(config: AgentLoopConfig);
  run(prompt, options?): AsyncGenerator<InnerEvent, TerminalResult>;
  abort(reason?): void;
  // ...all InnerHarnessProvider methods
}

interface AgentLoopConfig {
  controlPlane?: ControlPlane;  // Optional — uses noop if omitted
  model: string;
  fallbackModel?: string;
  tools?: ToolDefinition[];
  systemPrompt?: string;
  maxTurns?: number;            // Default: 100
  thinkingEnabled?: boolean;    // Default: true
}
```

### Individual SDLC Modules

Each module is independently importable and usable:

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

### Utility Exports

```typescript
import {
  // Config
  getDefaultSDLCConfig,    // Full default config
  validateSDLCConfig,      // Zod validation
  SDLCConfigSchema,        // Zod schema (for custom validation)

  // Metrics
  MetricsCollector,        // M1-M10 collection + baseline comparison

  // Module runner
  runModule,               // Run single module with enable/disable + timing
  ModuleError,             // Error type thrown by modules

  // Tools
  BUILT_IN_TOOLS,          // 6 built-in tools (Bash, FileRead, FileWrite, FileEdit, Grep, Glob)
  getBuiltInTool,          // Get tool by name
  ToolRegistry,            // Tool management
  ToolExecutor,            // Tool execution with concurrent/serial partitioning

  // Standalone
  createNoopControlPlane,  // Passthrough CP for standalone usage

  // Testing
  createMockLLMCaller,     // Deterministic LLM responses for tests
  MockScenarios,           // Predefined test sequences
} from "@agentweave/inner-harness";
```

---

## Configuration Reference

### Execution Modes

#### 1. `agent-loop` — Direct LLM API call

```typescript
execution: {
  mode: "agent-loop",
  agentLoop: {
    model: "claude-sonnet-4-6",    // Required
    fallbackModel: "claude-haiku-4-5",
    maxTurns: 50,
    systemPrompt: "You are a senior engineer...",
    tools: ["Bash", "FileRead", "FileWrite", "FileEdit", "Grep", "Glob"],
  },
}
```

Uses Vercel AI SDK. Auto-detects provider from model name:
- `claude-*` → Anthropic
- `gpt-*`, `o1-*`, `o3-*` → OpenAI
- `gemini-*` → Google
- `OPENROUTER_API_KEY` env → OpenRouter (any model)

#### 2. `process-adapter` — Wrap CLI agent

```typescript
execution: {
  mode: "process-adapter",
  processAdapter: {
    command: "claude",             // CLI binary
    args: ["--print", "--output-format", "stream-json"],
    cwd: "/path/to/project",
    promptMode: "stdin",           // "stdin" | "arg"
  },
}
```

Requires: `pnpm add @agentweave/adapters`

Works with any CLI agent: Claude Code, Cursor, Aider, Codex, custom scripts.

#### 3. `api-direct` — Raw LLM call (no agent loop)

```typescript
execution: {
  mode: "api-direct",
  apiDirect: { model: "claude-sonnet-4-6" },
}
```

Requires `llmCaller` to be provided. Just calls LLM once — no tool loop.

### Module Configuration

Every module has:
- `enabled: boolean` — toggle on/off
- `custom?: string` — path to custom implementation (`.js`/`.ts`/`.mjs`)

#### TaskNormalizer

Converts raw prompt → structured task with goal, context, constraints, definition of done.

```typescript
taskNormalizer: {
  enabled: true,
  model: "claude-haiku-4-5",    // Lightweight model for meta task
  // custom: "./my-normalizer.ts", // Optional custom implementation
}
```

Uses LLM if `llmCaller` provided. Falls back to template parsing (regex extraction).

#### ContextBuilder

Discovers relevant files in the project and injects them into task context.

```typescript
contextBuilder: {
  enabled: true,
  maxFiles: 20,
  maxTokens: 50000,
  includePatterns: ["src/**/*.ts", "tests/**/*.ts"],
  excludePatterns: ["node_modules/**", "dist/**"],
}
```

Uses grep/findstr to search for keywords extracted from the task goal.

#### PlanGenerator

Generates step-by-step execution plan from structured task.

```typescript
planGenerator: {
  enabled: true,
  model: "claude-haiku-4-5",
  maxSteps: 15,
}
```

Plan steps have types: `read`, `write`, `test`, `validate`, `shell`.

#### PatchValidator

Validates that code changes match expected scope.

```typescript
patchValidator: {
  enabled: true,
  maxFilesChanged: 30,     // Flag if more files changed
  scopeStrict: false,       // false = warn, true = fail on out-of-scope
}
```

#### QualityGate

Runs test/lint/compile commands as hard or soft gates.

```typescript
qualityGate: {
  enabled: true,
  checks: [
    { type: "compile",  command: "tsc --noEmit",  required: true  },
    { type: "test",     command: "vitest run",     required: true  },
    { type: "lint",     command: "eslint src/",    required: false },
    { type: "typecheck", command: "tsc --noEmit",  required: true  },
  ],
}
```

**Security:** Commands validated against safe binary allowlist (npm, pnpm, node, tsc, vitest, eslint, etc.). Shell metacharacters rejected.

#### RetryEngine

Classifies errors and retries with targeted fix instructions.

```typescript
retryEngine: {
  enabled: true,
  maxRetries: 3,
  strategies: [
    { errorType: "compile_error",  action: "fix_specific" },
    { errorType: "test_failure",   action: "fix_specific" },
    { errorType: "lint_warning",   action: "fix_specific" },
    { errorType: "scope_violation", action: "regenerate"  },
  ],
}
```

Actions: `fix_specific` (targeted fix), `regenerate` (different approach), `simplify` (reduce scope), `escalate` (give up).

#### OutputStandardizer

Generates conventional commit messages and PR descriptions.

```typescript
outputStandardizer: {
  enabled: true,
  commitFormat: "conventional",  // "conventional" | "freeform"
  prTemplate: "./pr-template.md",
}
```

---

## Metrics (M1-M10)

Every SDLC run collects 10 metrics automatically:

| ID | Metric | Unit | What it measures |
|----|--------|------|-----------------|
| M1 | First-pass success | boolean | Did code pass QA on first attempt? |
| M2 | Test pass rate | 0.0-1.0 | % of test checks that passed |
| M3 | Scope accuracy | 0.0-1.0 | % of changed files that were in plan |
| M4 | Retry count | number | How many retries before success |
| M5 | Cost per task | USD | Total LLM cost |
| M6 | Time to completion | ms | Wall clock time |
| M7 | Regression detected | boolean | Did changes break existing tests? |
| M8 | Plan accuracy | 0.0-1.0 | % of plan steps that were needed |
| M9 | Context utilization | 0.0-1.0 | Efficiency of injected context |
| M10 | Code quality delta | number | Lint warnings improvement (positive = better) |

### Reading Metrics

```typescript
const pipeline = createSDLCPipeline({ /* ... */ });
for await (const event of pipeline.run("task")) { /* ... */ }

const metrics = pipeline.getLastMetrics();
// {
//   taskId: "ses_abc123",
//   m1_firstPassSuccess: true,
//   m2_testPassRate: 0.95,
//   m3_scopeAccuracy: 1.0,
//   m4_retryCount: 1,
//   m5_costUsd: 0.034,
//   m6_timeToCompletionMs: 15000,
//   m7_regressionDetected: false,
//   m8_planAccuracy: 0.8,
//   m9_contextUtilization: 0.75,
//   m10_codeQualityDelta: 3,
// }
```

### Baseline Comparison

Enable `metrics.baseline: true` to compare against previous runs:

```typescript
const pipeline = createSDLCPipeline({
  metrics: { enabled: true, baseline: true, persistPath: ".agentweave/metrics/" },
  // ...
});

for await (const event of pipeline.run("task")) { /* ... */ }

const comparison = pipeline.getLastComparison();
// {
//   current: { m2_testPassRate: 0.95, ... },
//   baseline: { m2_testPassRate: 0.60, ... },
//   deltas: { m2_testPassRate: 0.35, m4_retryCount: -2, ... }
// }
```

Baseline is saved to `persistPath` after each run. Next run compares against it.

---

## Custom Modules

Replace any built-in module with your own implementation:

### 1. Create custom module file

```typescript
// my-quality-gate.ts
import type { SDLCModule, SDLCModuleContext, SDLCExecutionResult, SDLCValidationResult } from "@agentweave/types";

const myGate: SDLCModule<SDLCExecutionResult, SDLCValidationResult> = {
  name: "MyCustomQualityGate",
  async execute(input, context) {
    // Your custom logic here
    const passed = await runMyCustomChecks(input.changedFiles);
    return {
      passed,
      checks: [{ name: "custom", passed, severity: passed ? "info" : "error" }],
    };
  },
};

export default myGate;
```

### 2. Point config to custom module

```typescript
const pipeline = createSDLCPipeline({
  modules: {
    qualityGate: { enabled: true, custom: "./my-quality-gate.ts" },
  },
});
```

**Security:** Custom paths must end in `.js`/`.ts`/`.mjs`. Path traversal (`..`) is rejected.

---

## Integration with AgentWeave Platform

### Standalone (current)

```typescript
import { createSDLCPipeline } from "@agentweave/inner-harness";
// Just works. No other packages needed.
```

### Plug into Control Plane + Outer Harness (later)

When you need governance (permissions, budget control, audit):

```bash
pnpm add @agentweave/control-plane @agentweave/outer-harness @agentweave/sdk
```

```typescript
import { createHarness } from "@agentweave/sdk";

// SDK wires inner + outer through control plane automatically
const harness = createHarness({
  model: "claude-sonnet-4-6",
  permissions: {
    mode: "default",
    rules: [
      { pattern: "Bash(rm -rf *)", behavior: "deny", source: "policy", priority: 100 },
    ],
  },
  budget: { maxPerSession: 5.0 },
});
```

The `SDLCOrchestrator` implements `InnerHarnessProvider` — it plugs into the SDK's `createHarness()` as a drop-in replacement for `AgentLoop`. The Outer Harness governance layer applies transparently.

### Architecture

```
Standalone:
  createSDLCPipeline() → SDLCOrchestrator → [modules] → agent

Full platform:
  createHarness() → SDK → ControlPlane → SDLCOrchestrator → [modules] → agent
                                ↕
                         OuterHarness (governance)
```

---

## YAML Config (for agentweave.yaml integration)

```yaml
inner:
  execution:
    mode: process-adapter
    processAdapter:
      command: claude
      args: ["--print"]

  modules:
    taskNormalizer:
      enabled: true
      model: claude-haiku-4-5

    contextBuilder:
      enabled: true
      maxFiles: 20

    planGenerator:
      enabled: true
      model: claude-haiku-4-5
      maxSteps: 15

    executionBridge:
      enabled: true

    patchValidator:
      enabled: true
      maxFilesChanged: 30

    qualityGate:
      enabled: true
      checks:
        - type: compile
          command: tsc --noEmit
          required: true
        - type: test
          command: vitest run
          required: true
        - type: lint
          command: eslint src/
          required: false

    retryEngine:
      enabled: true
      maxRetries: 3

    outputStandardizer:
      enabled: false

  metrics:
    enabled: true
    baseline: true
    persistPath: .agentweave/metrics/
```

---

## LEGO Composition Examples

Use only what you need:

```typescript
// Just quality gate (simplest useful config)
createSDLCPipeline({
  modules: {
    taskNormalizer: { enabled: false },
    contextBuilder: { enabled: false },
    planGenerator: { enabled: false },
    executionBridge: { enabled: true },
    patchValidator: { enabled: false },
    qualityGate: { enabled: true, checks: [{ type: "test", command: "npm test", required: true }] },
    retryEngine: { enabled: true, maxRetries: 2 },
    outputStandardizer: { enabled: false },
  },
})

// Planning + execution (no QA)
createSDLCPipeline({
  modules: {
    taskNormalizer: { enabled: true },
    contextBuilder: { enabled: true },
    planGenerator: { enabled: true },
    executionBridge: { enabled: true },
    patchValidator: { enabled: false },
    qualityGate: { enabled: false },
    retryEngine: { enabled: false },
    outputStandardizer: { enabled: false },
  },
})

// Everything on (full SDLC)
createSDLCPipeline({
  modules: {
    taskNormalizer: { enabled: true },
    contextBuilder: { enabled: true },
    planGenerator: { enabled: true },
    executionBridge: { enabled: true },
    patchValidator: { enabled: true },
    qualityGate: { enabled: true, checks: [/* ... */] },
    retryEngine: { enabled: true, maxRetries: 3 },
    outputStandardizer: { enabled: true },
  },
})
```

---

## License

MIT
