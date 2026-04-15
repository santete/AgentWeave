# AgentWeave

> The Control Layer for AI Agents

AgentWeave is an open-source framework that wraps around any AI coding agent, giving you full visibility and governance over everything the agent does.

## Architecture

```
User → [AgentWeave] → [AI Agent] → [AgentWeave] → Output
        (input gate)   (governed)   (output pipeline)
```

**Inner Harness** (execution) + **Outer Harness** (governance), separated by a **Control Plane**.

## Packages

| Package | Description |
|---|---|
| `@agentweave/types` | Shared type contracts (interfaces + Zod schemas) |
| `@agentweave/control-plane` | Event Bus, Command Bus, Interceptor Registry |
| `@agentweave/inner-harness` | Agent Loop execution engine |
| `@agentweave/outer-harness` | Permission Engine, Output Pipeline, Budget Manager |
| `@agentweave/sdk` | Public API — `createHarness()` |
| `@agentweave/cli` | CLI — `agentweave run "prompt"` |

## Quick Start

```typescript
import { createHarness } from "@agentweave/sdk";

const harness = createHarness({
  model: "claude-sonnet-4-6",
  permissions: {
    rules: [
      { pattern: "Bash(git *)", behavior: "allow", source: "project", priority: 50 },
      { pattern: "Bash(rm -rf *)", behavior: "deny", source: "policy", priority: 100 },
    ],
  },
  output: {
    filters: [
      { type: "secret", name: "secrets", patterns: [], replacement: "[REDACTED]" },
    ],
  },
  budget: { maxPerSession: 5.0 },
});

const { result, events } = await harness.run("Fix the login bug");
```

## Development

```bash
# Install dependencies
pnpm install

# Build all packages
pnpm turbo run build

# Run tests
pnpm turbo run test:unit

# Lint
pnpm lint
```

## Branch Strategy

See [CONTRIBUTING.md](CONTRIBUTING.md) for branch naming, PR process, and versioning policy.

```
main        ← production releases (tagged)
develop     ← integration branch
feature/*   ← new features
release/*   ← release preparation
hotfix/*    ← production fixes
```

## License

MIT
