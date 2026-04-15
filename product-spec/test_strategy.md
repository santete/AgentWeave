# AgentWeave — Test Strategy

> Version: 0.1 Draft
> Date: 2026-04-15
> Muc dich: Dinh nghia cach test toan bo AgentWeave framework

---

## 1. Test Pyramid

```
                    /\
                   /  \
                  / E2E \            ~10 tests  (cham, dat, fragile)
                 / Tests  \
                /----------\
               /            \
              / Integration   \      ~50 tests  (trung binh)
             /   Tests         \
            /------------------\
           /                    \
          /     Unit Tests       \   ~300 tests (nhanh, nhieu)
         /________________________\
```

| Level | Scope | Runner | Speed | Mock LLM? |
|---|---|---|---|---|
| Unit | 1 function/class | vitest | <1s/test | Co (always) |
| Integration | 2+ modules | vitest | <5s/test | Co (mac dinh) hoac Real (optional) |
| E2E | Full harness | vitest + CLI | <30s/test | Co (mac dinh) hoac Real ($$$) |

---

## 2. Mock LLM Strategy

### 2.1 Tai sao mock?

- Goi LLM that: **cham** (2-10s/call), **dat** ($0.01-0.10/call), **non-deterministic**
- Mock LLM: **nhanh** (<1ms), **mien phi**, **deterministic**
- Chi goi LLM that trong: manual integration tests, CI nightly (optional)

### 2.2 Mock LLM Interface

```typescript
import type { LanguageModelV1 } from 'ai'

/**
 * Mock LLM cho testing. Tra ve response predefined.
 * Tuong thich voi Vercel AI SDK LanguageModelV1 interface.
 */
export function createMockLLM(responses: MockResponse[]): LanguageModelV1 {
  let callIndex = 0

  return {
    specificationVersion: 'v1',
    provider: 'mock',
    modelId: 'mock-model',
    defaultObjectGenerationMode: 'json',

    async doGenerate(options) {
      const response = responses[callIndex++]
      if (!response) throw new Error(`No mock response for call #${callIndex}`)

      return {
        text: response.text,
        toolCalls: response.toolCalls ?? [],
        finishReason: response.toolCalls?.length ? 'tool-calls' : 'stop',
        usage: { promptTokens: 100, completionTokens: 50 },
        rawCall: { rawPrompt: null, rawSettings: {} },
      }
    },

    async doStream(options) {
      // Simulate streaming
      const response = responses[callIndex++]
      // ... return ReadableStream
    },
  }
}

// Usage
const mockLLM = createMockLLM([
  // Turn 1: Agent decides to read file
  {
    toolCalls: [{ type: 'tool-call', toolCallId: 'tc_1', toolName: 'FileRead', args: { path: 'src/auth.ts' } }],
  },
  // Turn 2: Agent responds
  {
    text: 'I found a bug in the login function on line 42.',
  },
])
```

### 2.3 Scenario-Based Mocks

```typescript
// Pre-built scenarios cho common test cases
export const MockScenarios = {
  // Agent reads a file, then responds
  simpleRead: [
    { toolCalls: [{ toolName: 'FileRead', args: { path: 'test.ts' } }] },
    { text: 'File content looks good.' },
  ],

  // Agent tries dangerous command (test permission deny)
  dangerousCommand: [
    { toolCalls: [{ toolName: 'Bash', args: { command: 'rm -rf /' } }] },
    { text: 'I was denied. Let me try a safer approach.' },
    { toolCalls: [{ toolName: 'Bash', args: { command: 'ls' } }] },
    { text: 'Done.' },
  ],

  // Agent exceeds budget
  expensiveSession: Array.from({ length: 20 }, () => ({
    toolCalls: [{ toolName: 'Bash', args: { command: 'echo hello' } }],
  })),

  // Agent produces output with secrets
  secretInOutput: [
    { text: 'Here is the config: API_KEY=sk-1234567890abcdef1234567890abcdef1234567890abcdef' },
  ],
}
```

---

## 3. Unit Tests

### 3.1 Per-Package Test Plan

#### `@agentweave/types`

Khong co logic, chi co types. **Khong can unit tests.** Chi can TypeScript compiler check.

#### `@agentweave/control-plane`

| Component | Tests | Key scenarios |
|---|---|---|
| EventBus | 8 | emit/subscribe, wildcard, unsubscribe, error isolation |
| CommandBus | 6 | send/receive, ack, timeout, error |
| InterceptorRegistry | 10 | register, intercept, timeout, fail-open/closed, no handler |
| createControlPlane | 3 | factory, lifecycle, destroy |

#### `@agentweave/inner-harness`

| Component | Tests | Key scenarios |
|---|---|---|
| AgentLoop | 15 | start, terminal detection, abort, max turns, pause/resume |
| ToolExecutor | 10 | serial, concurrent, partition, timeout, error |
| ToolRegistry | 5 | register, unregister, find, duplicate name |
| MessageStore | 5 | append, threading, tool_result pairing |
| ContextManager | 8 | token count, compact trigger, reactive compact |
| TokenCounter | 5 | count per model, cost calculation, cache tokens |
| PromptBuilder | 5 | cached + volatile sections, tool schemas |
| Recovery | 8 | PTL retry, token escalation, fallback model |

#### `@agentweave/outer-harness`

| Component | Tests | Key scenarios |
|---|---|---|
| PermissionEngine | 20 | 7 rule layers, pattern matching, contextual, ask flow, timeout |
| HookEngine | 15 | 5 hook types, matcher, async, timeout, chain |
| OutputPipeline | 15 | 6 stages, streaming mode, batch mode, stage skip |
| InputGate | 5 | validate, transform, reject |
| BudgetManager | 8 | per-session, per-day, warning, exceeded, multi-agent |
| MonitorCollector | 5 | collect, aggregate, export |
| AuditLogger | 5 | log, query, immutable, redact |
| SessionManager | 8 | persist, resume, fork, replay |
| ConfigHierarchy | 10 | 7 levels, merge, hot reload, validation |

#### `@agentweave/sdk`

| Component | Tests | Key scenarios |
|---|---|---|
| createHarness | 5 | default config, custom config, builder pattern |
| stream/run | 5 | stream events, run to completion, abort |

### 3.2 Unit Test Pattern

```typescript
// Moi unit test follow pattern nay
import { describe, it, expect, vi } from 'vitest'

describe('PermissionEngine', () => {
  it('should deny tool matching deny rule', async () => {
    const engine = new PermissionEngine({
      mode: 'default',
      rules: [
        { pattern: 'Bash(rm -rf *)', behavior: 'deny', source: 'policy', priority: 100 },
      ],
      failMode: 'closed',
      timeoutMs: 5000,
      askTimeoutMs: 60000,
    })

    const decision = await engine.evaluate({
      toolName: 'Bash',
      toolInput: { command: 'rm -rf /' },
      toolUseId: 'tu_1',
      turnIndex: 1,
      isReadOnly: false,
      isDestructive: true,
    })

    expect(decision.behavior).toBe('deny')
    expect(decision.source).toContain('policy')
  })
})
```

---

## 4. Integration Tests

### 4.1 Cross-Module Tests

| Test | Modules | Description |
|---|---|---|
| Inner + ControlPlane | inner, control-plane | Agent loop emits events, control plane routes |
| ControlPlane + Outer | control-plane, outer | Intercept tool request, permission decide |
| Inner + Outer (full) | inner, control-plane, outer | Full flow: prompt -> tools -> permission -> output |
| Permission + Hooks | outer | Hook overrides permission decision |
| Output + Streaming | outer | Streaming mode filter vs batch mode validate |
| Budget + MultiAgent | outer | Child budget deducted from parent |
| Config + All | all | Config changes propagate to all modules |

### 4.2 Integration Test Pattern

```typescript
describe('Inner + Outer: tool permission deny', () => {
  it('should deny dangerous tool and agent retries safely', async () => {
    // Setup
    const controlPlane = createControlPlane()
    const outer = new OuterHarness({
      permissions: {
        rules: [{ pattern: 'Bash(rm -rf *)', behavior: 'deny', source: 'test', priority: 100 }],
        failMode: 'closed',
      },
    })
    outer.connectToControlPlane(controlPlane)

    const inner = new AgentLoop({
      controlPlane,
      model: 'mock',
      tools: [BashTool],
    })
    inner.useMockLLM(MockScenarios.dangerousCommand)

    // Execute
    const events: InnerEvent[] = []
    for await (const event of inner.run('Delete all log files')) {
      events.push(event)
    }

    // Assert
    const denied = events.find(e => e.type === 'permission:denied')
    expect(denied).toBeDefined()
    expect(denied.toolName).toBe('Bash')

    // Agent should have retried with safer command
    const allowed = events.find(e => e.type === 'permission:allowed')
    expect(allowed).toBeDefined()
  })
})
```

---

## 5. E2E Tests

### 5.1 CLI E2E

```typescript
describe('CLI E2E', () => {
  it('agentweave run with budget limit', async () => {
    const result = await execCLI([
      'run',
      'List files in current directory',
      '--model', 'mock',
      '--budget', '0.01',
      '--config', './fixtures/test-config.yaml',
    ])

    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('src/')
    expect(result.cost).toBeLessThan(0.01)
  })
})
```

### 5.2 Real LLM Tests (Optional, CI nightly)

```typescript
describe.skipIf(!process.env.ANTHROPIC_API_KEY)('Real LLM E2E', () => {
  it('agent can fix a simple bug with governance', async () => {
    // ... real API call, costs money, slow
  }, { timeout: 60_000 })
})
```

---

## 6. Performance Tests

### 6.1 Benchmarks

| Benchmark | Target | Measure |
|---|---|---|
| EventBus emit (no handlers) | <0.01ms | Time per emit |
| EventBus emit (10 handlers) | <0.1ms | Time per emit |
| Interceptor (passthrough) | <1ms | Time per intercept |
| Permission evaluate (10 rules) | <2ms | Time per evaluate |
| Permission evaluate (100 rules) | <10ms | Time per evaluate |
| Output filter (regex, 1KB text) | <1ms | Time per filter |
| Output filter (regex, 100KB text) | <10ms | Time per filter |
| Hook execute (command, echo) | <100ms | Time per hook |
| Config merge (7 levels) | <5ms | Time per merge |
| Full turn overhead (Inner+Outer) | <50ms | Total governance overhead per turn |

### 6.2 Benchmark Runner

```typescript
import { bench, describe } from 'vitest'

describe('Permission Engine benchmarks', () => {
  const engine = new PermissionEngine({ rules: generate100Rules() })

  bench('evaluate with 100 rules', async () => {
    await engine.evaluate(sampleToolRequest)
  })
})
```

---

## 7. CI Pipeline

```yaml
# .github/workflows/test.yaml
name: Test
on: [push, pull_request]

jobs:
  unit:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - run: pnpm install
      - run: pnpm turbo run test:unit      # Parallel per package

  integration:
    needs: unit
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - run: pnpm install
      - run: pnpm turbo run test:integration

  e2e:
    needs: integration
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - run: pnpm install
      - run: pnpm turbo run build
      - run: pnpm turbo run test:e2e

  benchmark:
    needs: unit
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - run: pnpm install
      - run: pnpm turbo run test:bench
      # Upload benchmark results for tracking
      - uses: benchmark-action/github-action-benchmark@v1
        with:
          tool: 'customSmallerIsBetter'
          output-file-path: benchmark-results.json

  # Optional: real LLM test (nightly only, costs money)
  real-llm:
    if: github.event_name == 'schedule'
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - run: pnpm install
      - run: pnpm turbo run test:real
        env:
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
```

---

## 8. Test Config trong Turborepo

```json
// turbo.json
{
  "pipeline": {
    "test:unit": {
      "outputs": ["coverage/**"],
      "dependsOn": ["^build"]
    },
    "test:integration": {
      "dependsOn": ["^build"]
    },
    "test:e2e": {
      "dependsOn": ["build"]
    },
    "test:bench": {
      "dependsOn": ["^build"],
      "outputs": ["benchmark-results.json"]
    }
  }
}
```

---

## 9. Coverage Targets

| Package | Line Coverage | Branch Coverage |
|---|---|---|
| @agentweave/types | N/A (no logic) | N/A |
| @agentweave/control-plane | 90% | 85% |
| @agentweave/inner-harness | 85% | 80% |
| @agentweave/outer-harness | 85% | 80% |
| @agentweave/sdk | 80% | 75% |
| @agentweave/cli | 70% | 65% |
