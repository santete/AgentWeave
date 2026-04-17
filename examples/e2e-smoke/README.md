# E2E Smoke Test

Run a real agent session with full AgentWeave governance.

## Prerequisites

```bash
export ANTHROPIC_API_KEY=sk-ant-...
```

## Run

```bash
npx tsx examples/e2e-smoke/run.ts
```

## What it proves

1. Real LLM call (Claude Haiku — cheapest)
2. Built-in tools (Bash, FileRead) actually execute
3. Permission rules enforce (deny `rm`, allow `ls`)
4. Output filters ready (secrets + PII)
5. Budget tracking ($0.50 cap)
6. Events stream to terminal in real-time

## Expected cost

~$0.01 per run (Haiku model, simple prompt, 1-2 tool calls).
