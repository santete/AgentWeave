# AgentWeave

> **Governance + QA layer for AI coding agents** — enforce policy on Claude Code, Cursor, and any MCP-compatible agent, with measurable SDLC metrics.

AgentWeave is an open-source wrapper around AI coding agents. It does **not** replace Claude Code, Cursor, or Aider — it sits around them and adds three things those agents don't provide: governance (permission rules, budget caps, audit trail), a QA pipeline (SDLC stages with M1–M10 metrics), and distribution channels (Claude Code hooks, MCP server, adapters).

Canonical positioning: [`product-spec/POSITIONING.md`](product-spec/POSITIONING.md).

## Three Pillars

```
┌───────────────────────────────────────────────────────────┐
│  Pillar 1: GOVERNANCE      (Outer Harness)                │
│    Permission · Budget · Hooks · Input Gate · Audit       │
└───────────────────────────────────────────────────────────┘
┌───────────────────────────────────────────────────────────┐
│  Pillar 2: QA PIPELINE     (SDLC Orchestrator)            │
│    Norm → Ctx → Plan → Exec → Patch → QA → Retry → Out    │
│    M1–M10 metrics · Exec delegates to agent via adapter   │
└───────────────────────────────────────────────────────────┘
┌───────────────────────────────────────────────────────────┐
│  Pillar 3: ADAPTERS + MCP  (Distribution)                 │
│    Claude Code hooks · MCP server · Cursor · Aider · …    │
└───────────────────────────────────────────────────────────┘
```

Each pillar stands alone. Use governance without the pipeline. Use the pipeline without MCP. Mix freely.

## Packages

| Package | Pillar | Description |
|---|---|---|
| `@agentweave/types` | — | Shared type contracts (interfaces + Zod schemas) |
| `@agentweave/outer-harness` | 1 | Permission Engine, Budget Manager, Hook Engine, Audit Logger |
| `@agentweave/inner-harness` | 2 | SDLC Pipeline (`src/sdlc/`). Agent-loop code = reference impl only. |
| `@agentweave/adapters` | 3 | Bridges SDLC `Exec` stage to target agents (Claude Code today) |
| `@agentweave/mcp-server` | 3 | MCP server — exposes governance + QA tools to any MCP host |
| `@agentweave/control-plane` | — | Event Bus, Command Bus, Interceptor Registry |
| `@agentweave/sdk` | surface | Public API — `createHarness()` |
| `@agentweave/cli` | surface | CLI — `agentweave pipeline run`, `agentweave guard`, `agentweave metrics` |

## Quick Start

### Option A — Governance only (wrap Claude Code)

Add the PreToolUse hook to enforce AgentWeave policy on every tool call your Claude Code session makes:

```json
// .claude/settings.json
{
  "hooks": {
    "PreToolUse":  [{ "matcher": "Bash|Write|Edit", "hooks": [{ "type": "command", "command": "node ./.claude/hooks/pre-tool-use.cjs" }] }],
    "PostToolUse": [{ "matcher": "Bash|Write|Edit", "hooks": [{ "type": "command", "command": "node ./.claude/hooks/post-tool-use.cjs" }] }]
  }
}
```

```json
// .agentweave/guard.json
{
  "mode": "permissive",
  "permissions": [
    { "pattern": "Bash(rm -rf*)",           "behavior": "deny", "priority": 1000 },
    { "pattern": "Bash(git push --force*)", "behavior": "deny", "priority": 1000 }
  ],
  "audit": { "enabled": true, "path": ".agentweave/audit.log" }
}
```

Every tool call is now audited to `.agentweave/audit.log`.

### Option B — QA Pipeline around your agent

```bash
npm install -g @agentweave/cli
agentweave pipeline run "Fix the login bug in src/auth.ts"
agentweave metrics   # M1-M10 report
```

The pipeline auto-detects Claude Code, runs 8 SDLC stages around it, and writes metrics to `.agentweave/metrics/baseline.json`.

### Option C — SDK (programmatic)

```typescript
import { createHarness } from "@agentweave/sdk";

const harness = createHarness({
  permissions: {
    rules: [
      { pattern: "Bash(git *)", behavior: "allow", source: "project", priority: 50 },
      { pattern: "Bash(rm -rf *)", behavior: "deny", source: "policy", priority: 100 },
    ],
  },
  budget: { maxPerSession: 5.0 },
});

const { result } = await harness.run("Fix the login bug");
```

## Development

```bash
pnpm install
pnpm turbo run build
pnpm turbo run test:unit
pnpm lint
```

## Branch Strategy

See [CONTRIBUTING.md](CONTRIBUTING.md).

```
main        ← production releases (tagged)
develop     ← integration branch
feature/*   ← new features
pivot/*     ← positioning / architecture shifts
release/*   ← release preparation
hotfix/*    ← production fixes
```

## License

MIT
