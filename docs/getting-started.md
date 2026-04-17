# AgentWeave — Getting Started Guide

> Version 1.0.0 | The Control Layer for AI Agents

AgentWeave is an open-source governance framework that wraps AI coding agents with permissions, monitoring, budget control, and multi-agent orchestration.

---

## Table of Contents

1. [Installation](#1-installation)
2. [Quick Start (Solo Developer)](#2-quick-start-solo-developer)
3. [Scenario A: Local Development](#3-scenario-a-local-development)
4. [Scenario B: Team Gateway (Multi-Dev)](#4-scenario-b-team-gateway-multi-dev)
5. [Scenario C: Multi-Agent Orchestration](#5-scenario-c-multi-agent-orchestration)
6. [Scenario D: Plugin Development](#6-scenario-d-plugin-development)
7. [Scenario E: Wrapping External Agents (Adapters)](#7-scenario-e-wrapping-external-agents)
8. [CLI Reference](#8-cli-reference)
9. [REST API Reference](#9-rest-api-reference)
10. [Configuration Reference](#10-configuration-reference)
11. [Deployment Guide](#11-deployment-guide)
12. [Troubleshooting](#12-troubleshooting)

---

## 1. Installation

### Prerequisites

- Node.js 22+ (or Bun 1.1+)
- pnpm 9+

### From npm (when published)

```bash
# SDK for programmatic usage
npm install @agentweave/sdk

# CLI for command-line usage
npm install -g @agentweave/cli

# Gateway for team/enterprise topology
npm install @agentweave/gateway
```

### From source

```bash
git clone https://github.com/santete/AgentWeave.git
cd AgentWeave
pnpm install
pnpm turbo run build
```

### Verify installation

```bash
agentweave --version
# 1.0.0
```

---

## 2. Quick Start (Solo Developer)

The simplest way to use AgentWeave — everything runs locally on your machine.

### TypeScript SDK

```typescript
import { createHarness } from "@agentweave/sdk";

const harness = createHarness({
  model: "claude-sonnet-4-6",
  permissions: {
    mode: "default",
    rules: [
      { pattern: "Bash(git *)", behavior: "allow", source: "user", priority: 50 },
      { pattern: "Bash(rm -rf *)", behavior: "deny", source: "policy", priority: 100 },
    ],
  },
  output: {
    filters: [
      { type: "secret", name: "secrets", patterns: ["sk-[a-zA-Z0-9]{20,}"] },
      { type: "pii", name: "pii", entities: ["email", "ssn"] },
    ],
  },
  budget: { maxPerSession: 5.0, warningThreshold: 0.8 },
});

// Run to completion
const { result, events } = await harness.run("Fix the login bug in src/auth.ts");
console.log(`Completed: ${result.reason}, cost: $${harness.getUsage().totalCost}`);

// Or stream events in real-time
for await (const event of harness.stream("Refactor the database module")) {
  if (event.type === "tool:requested") {
    console.log(`Tool: ${event.toolName}`);
  }
}
```

### CLI

```bash
# Basic run
agentweave run "Fix the login bug"

# With budget and model
agentweave run "Refactor auth module" --model claude-opus-4-6 --budget 10

# Read-only mode (plan mode — no file writes)
agentweave run "Review code quality" --mode plan
```

---

## 3. Scenario A: Local Development

**Topology:** Everything in-process. No network. No server.

```
+─────────────────────────────────────────────+
│  DEV NODE (your laptop)                      │
│                                              │
│  ┌──────────┐  ┌──────────┐  ┌────────────┐ │
│  │  Inner    │  │ Control  │  │  Outer     │ │
│  │  Harness  │◄►│  Plane   │◄►│  Harness   │ │
│  │ (Agent)   │  │          │  │(Governance)│ │
│  └──────────┘  └──────────┘  └────────────┘ │
│       │                            │         │
│       ▼                            ▼         │
│  [LLM API]                    [Local Files]  │
+─────────────────────────────────────────────+
```

### Full example with custom tools

```typescript
import { createHarness } from "@agentweave/sdk";
import { z } from "zod";

// Define a custom tool
const myTool = {
  name: "DatabaseQuery",
  description: "Run a read-only SQL query",
  parameters: z.object({
    query: z.string().describe("SQL SELECT query"),
  }),
  execute: async ({ query }) => {
    // Your database logic here
    return `Results for: ${query}`;
  },
  metadata: {
    isReadOnly: true,
    isDestructive: false,
    isConcurrencySafe: true,
    category: "custom" as const,
  },
};

const harness = createHarness({
  model: "claude-sonnet-4-6",
  tools: [myTool],
  permissions: {
    mode: "default",
    rules: [
      { pattern: "DatabaseQuery(*)", behavior: "allow", source: "project", priority: 50 },
      { pattern: "Bash(*)", behavior: "deny", source: "policy", priority: 100 },
    ],
    failMode: "closed", // Deny by default
  },
  output: {
    gateMode: "batch",
    filters: [
      { type: "secret", name: "secrets", patterns: [], replacement: "[SECRET]" },
    ],
  },
  budget: {
    maxPerSession: 10.0,
    maxPerDay: 50.0,
    warningThreshold: 0.8,
  },
});

// Set LLM caller (for testing with mocks)
import { createMockLLMCaller, MockScenarios } from "@agentweave/sdk";
harness.setLLMCaller(createMockLLMCaller(MockScenarios.simpleResponse));

const { result } = await harness.run("Show me the user table schema");
console.log(result);
```

### Pause, resume, abort

```typescript
const harness = createHarness({ model: "claude-sonnet-4-6" });

// Start streaming
const gen = harness.stream("Long running task");

// Read some events
const first = await gen.next();

// Abort after 30 seconds
setTimeout(() => harness.abort("timeout"), 30_000);

for await (const event of gen) {
  console.log(event.type);
}
```

---

## 4. Scenario B: Team Gateway (Multi-Dev)

**Topology:** Multiple developers connect to a shared Gateway for centralized governance.

```
DEV NODE A ──┐                    ┌── Gateway Server
DEV NODE B ──┤── WebSocket (WS) ──┤   ├── Shared PermissionEngine
DEV NODE C ──┘                    │   ├── Shared BudgetManager
                                  │   ├── REST API (:9101)
                                  │   └── Dashboard (GET /)
                                  └── LLM API
```

### Step 1: Start the Gateway

```typescript
// gateway-server.ts
import { GatewayServer, issueToken } from "@agentweave/gateway";

const SECRET = "your-secure-jwt-secret-at-least-32-chars";

const gateway = new GatewayServer({
  port: 9100,        // WebSocket port
  restPort: 9101,    // REST API + Dashboard
  auth: { secret: SECRET },
  permissions: {
    mode: "default",
    rules: [
      { pattern: "Bash(rm -rf *)", behavior: "deny", source: "policy", priority: 100 },
      { pattern: "Bash(sudo *)", behavior: "deny", source: "policy", priority: 100 },
      { pattern: "FileWrite(*.env)", behavior: "deny", source: "policy", priority: 100 },
      { pattern: "FileRead(*)", behavior: "allow", source: "project", priority: 50 },
    ],
    failMode: "closed",
    timeoutMs: 5000,
    askTimeoutMs: 60000,
  },
  budget: { maxPerSession: 20.0, warningThreshold: 0.8 },
});

await gateway.start();
console.log("Gateway running on ws://localhost:9100 + http://localhost:9101");

// Issue tokens for developers
const devToken = issueToken("dev-alice", "developer", SECRET);
const leadToken = issueToken("lead-bob", "team_lead", SECRET);
const adminToken = issueToken("admin-carol", "admin", SECRET);

console.log("Developer token:", devToken);
console.log("Team Lead token:", leadToken);
```

### Step 2: Connect from Dev Node

```typescript
// dev-client.ts
import { AWOCPClient } from "@agentweave/protocol";

const client = new AWOCPClient({
  url: "ws://gateway.team.local:9100/awocp/v1",
  token: "eyJ...", // JWT token from admin
  sessionId: "ses_alice_001",
  agentId: "agent_alice",
  userId: "dev-alice",
});

const auth = await client.connect();
console.log("Connected:", auth.status); // "ok"

// Now intercept tool requests through the gateway
const decision = await client.interceptTool({
  toolName: "Bash",
  toolInput: { command: "rm -rf /tmp/logs" },
  toolUseId: "tu_1",
  turnIndex: 1,
  isReadOnly: false,
  isDestructive: true,
});

console.log(decision.behavior); // "deny" — blocked by gateway policy

// Forward events for monitoring
client.sendEvent({
  id: "e1", timestamp: Date.now(),
  sessionId: "ses_alice_001", agentId: "agent_alice",
  type: "turn:start", turnIndex: 1,
});
```

### Step 3: Monitor via Dashboard

Open `http://localhost:9101/` in a browser.

Set your JWT in the browser console:
```javascript
localStorage.setItem('agentweave_token', 'eyJ...');
```

The dashboard shows:
- Connected agents (user, role, session)
- Permission rules (pattern, behavior, source)
- Health status (auto-refresh every 5s)

### Step 4: Manage rules via REST API

```bash
# List rules (requires JWT)
curl -H "Authorization: Bearer $TOKEN" http://localhost:9101/api/rules

# Add a rule (team_lead or admin only)
curl -X POST -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"pattern": "Bash(npm test)", "behavior": "allow", "source": "project", "priority": 60}' \
  http://localhost:9101/api/rules

# Delete rule by index
curl -X DELETE -H "Authorization: Bearer $TOKEN" \
  http://localhost:9101/api/rules/0

# View connected clients
curl -H "Authorization: Bearer $TOKEN" http://localhost:9101/api/clients

# View metrics
curl -H "Authorization: Bearer $TOKEN" http://localhost:9101/api/metrics

# Health check (no auth)
curl http://localhost:9101/api/health
```

### CLI monitoring

```bash
# Poll gateway health from terminal
agentweave monitor --gateway http://localhost:9101
```

---

## 5. Scenario C: Multi-Agent Orchestration

**Topology:** A coordinator agent spawns worker agents, each with their own budget and permissions.

```
Coordinator (Opus, $20 budget)
  ├── Worker 1: Research (Haiku, $2, read-only)
  ├── Worker 2: Implement (Sonnet, $10, full access)
  └── Worker 3: Test (Sonnet, $5, read + bash)
```

### Spawn and manage child agents

```typescript
import { createHarness, createMockLLMCaller } from "@agentweave/sdk";

const harness = createHarness({
  model: "claude-opus-4-6",
  multiAgent: {
    maxConcurrentAgents: 5,
    totalBudgetUsd: 20.0,
  },
  permissions: { mode: "permissive" },
});

// Spawn a research worker
const researcher = harness.spawnAgent({
  name: "research-worker",
  prompt: "Research authentication patterns in this codebase",
  model: "claude-haiku-4-5",
  budgetUsd: 2.0,
  maxTurns: 20,
  timeoutMs: 120_000,
  permissions: {
    mode: "plan", // Read-only
  },
});

// Spawn an implementation worker
const implementer = harness.spawnAgent({
  name: "implement-worker",
  prompt: "Implement JWT authentication based on research results",
  model: "claude-sonnet-4-6",
  budgetUsd: 10.0,
  maxTurns: 50,
});

// Run workers in parallel
const [researchResult, implResult] = await Promise.all([
  researcher.run(),
  implementer.run(),
]);

// Send messages between agents
implementer.send(researcher.id, "result", {
  summary: "Found 3 auth patterns",
  files: ["src/auth/jwt.ts"],
});

const messages = implementer.receive();
console.log(messages); // [{ from: researcher.id, type: "result", ... }]

// Check orchestrator state
const orch = harness.getOrchestrator()!;
console.log(orch.getAgents()); // All agents with their states
console.log(orch.getTotalSpent()); // Total $ spent across all agents
```

### File locking (prevent concurrent edits)

```typescript
const lockManager = harness.getOrchestrator()!.getLockManager();

// Worker A acquires lock on a file
const acquired = await lockManager.acquire("src/auth.ts", researcher.id, 30_000);
if (acquired) {
  // Edit the file...
  lockManager.release("src/auth.ts", researcher.id);
}
```

---

## 6. Scenario D: Plugin Development

### Create a plugin

```typescript
// my-lint-plugin.ts
import type { PluginManifest, ToolDefinition } from "@agentweave/types";
import { z } from "zod";

const lintTool: ToolDefinition = {
  name: "Lint",
  description: "Run ESLint on a file",
  parameters: z.object({ path: z.string() }),
  execute: async ({ path }) => {
    // Your lint logic here
    return `Lint passed: ${path}`;
  },
  metadata: {
    isReadOnly: true,
    isDestructive: false,
    isConcurrencySafe: true,
    category: "custom",
  },
};

const plugin: PluginManifest = {
  name: "lint-plugin",
  version: "1.0.0",
  description: "Adds ESLint tool to the agent",
  permissions: {
    tools: { register: ["Lint"] },
    hooks: { events: ["PostToolUse"] },
  },
  activate: async (context) => ({
    tools: [lintTool],
    hooks: [{
      event: "PostToolUse",
      matcher: "FileWrite|FileEdit",
      definition: {
        type: "command",
        event: "PostToolUse",
        command: "npx eslint --fix $TOOL_INPUT",
        timeout: 15000,
      },
    }],
  }),
  deactivate: async () => {
    console.log("Lint plugin deactivated");
  },
};

export default plugin;
```

### Use the plugin

```typescript
import { createHarness } from "@agentweave/sdk";
import lintPlugin from "./my-lint-plugin";

const harness = createHarness({
  model: "claude-sonnet-4-6",
  plugins: [lintPlugin],
});

// The Lint tool is now available to the agent
// PostToolUse hook runs ESLint after every file write
```

---

## 7. Scenario E: Wrapping External Agents

### Wrap Claude Code CLI

```typescript
import { createClaudeCodeAdapter } from "@agentweave/adapters";

const adapter = createClaudeCodeAdapter({
  model: "sonnet",
  cwd: "/path/to/project",
});

// Use as InnerHarnessProvider
for await (const event of adapter.run("Fix the bug in auth.ts")) {
  console.log(event.type, event);
}
```

### Wrap any CLI tool

```typescript
import { ProcessAdapter } from "@agentweave/adapters";

const adapter = new ProcessAdapter({
  command: "python",
  args: ["agent.py"],
  promptMode: "stdin", // Send prompt via stdin
  parseJson: true,     // Parse stdout as JSON events
});

for await (const event of adapter.run("Analyze the dataset")) {
  if (event.type === "message:assistant") {
    console.log("Agent says:", event.content);
  }
}
```

---

## 8. CLI Reference

```
agentweave v1.0.0 — The Control Layer for AI Agents

COMMANDS:
  run <prompt> [options]           Run an agent with a prompt
  monitor [--gateway <url>]        Monitor gateway metrics (live)
  session list [--dir <path>]      List saved sessions

RUN OPTIONS:
  --model <model>                  LLM model (default: claude-sonnet-4-6)
  --budget <usd>                   Max budget in USD (0-10000)
  --max-turns <n>                  Max turns (1-10000, default: 50)
  --mode <mode>                    Permission mode:
                                     default    — deny unknown tools
                                     strict     — deny everything not explicitly allowed
                                     permissive — allow everything not explicitly denied
                                     plan       — read-only mode (no file writes)

GLOBAL:
  --help                           Show help
  --version                        Show version

EXAMPLES:
  agentweave run "Fix the login bug"
  agentweave run "Refactor auth" --model claude-opus-4-6 --budget 10
  agentweave run "Review code" --mode plan
  agentweave monitor --gateway http://gateway:9101
  agentweave session list
```

---

## 9. REST API Reference

**Base URL:** `http://localhost:9101` (default: gateway WS port + 1)

| Method | Path | Auth | Role | Description |
|--------|------|------|------|-------------|
| GET | `/api/health` | No | — | Health check + client count |
| GET | `/` | No | — | Web dashboard |
| GET | `/api/rules` | JWT | Any | List permission rules |
| POST | `/api/rules` | JWT | team_lead+ | Add a permission rule |
| DELETE | `/api/rules/:index` | JWT | team_lead+ | Remove rule by index |
| GET | `/api/clients` | JWT | Any | List connected WS clients |
| GET | `/api/metrics` | JWT | Any | Monitor snapshot |

**Authentication:** `Authorization: Bearer <jwt>`

**Roles:** `developer` (read), `team_lead` (read+write rules), `admin` (all)

---

## 10. Configuration Reference

### Permission Modes

| Mode | Default Behavior | Use Case |
|------|------------------|----------|
| `default` | Deny unknown tools | Normal development |
| `strict` | Deny everything | Production/CI |
| `permissive` | Allow everything | Prototyping |
| `plan` | Read-only tools only | Code review |

### Output Filters

| Type | Config | What it catches |
|------|--------|-----------------|
| `secret` | `patterns: string[]` | API keys, tokens (sk-*, AKIA*, ghp_*) |
| `pii` | `entities: string[]` | Email, SSN, phone, credit card |
| `regex` | `pattern: string` | Custom regex |
| `denylist` | `words: string[]` | Specific words/phrases |

### Sandbox Config

```typescript
{
  sandbox: {
    allowedPaths: ["src/", "tests/"],        // Only these dirs accessible
    deniedPaths: ["/etc", ".env", ".ssh"],    // Always blocked (+ defaults)
    networkAccess: false,                      // Block network calls
  }
}
```

**Default denied paths:** `/etc`, `/var`, `/root`, `/sys`, `/proc`, `.env`, `.ssh`, `.aws`, `.gnupg`, `credentials`

---

## 11. Deployment Guide

### Solo Developer (Local)

No setup needed. Install SDK, write code, run.

```bash
npm install @agentweave/sdk
```

### Team (Gateway)

1. **Deploy Gateway** (Docker or bare metal):
```bash
# Start gateway server
node gateway-server.js
# Listens on:
#   ws://0.0.0.0:9100   — AWOCP WebSocket
#   http://0.0.0.0:9101  — REST API + Dashboard
```

2. **Issue tokens** for each developer:
```typescript
import { issueToken } from "@agentweave/gateway";
const token = issueToken("alice", "developer", SECRET);
```

3. **Configure dev machines** to connect:
```typescript
const client = new AWOCPClient({
  url: "ws://gateway:9100/awocp/v1",
  token: token,
  // ...
});
```

4. **Monitor** via dashboard: `http://gateway:9101/`

### CI/CD Pipeline

```yaml
# .github/workflows/agent-review.yaml
- uses: actions/setup-node@v4
  with:
    node-version: 22

- run: npm install @agentweave/sdk

- run: node review-agent.js
  env:
    ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
```

```typescript
// review-agent.js
import { createHarness } from "@agentweave/sdk";

const harness = createHarness({
  model: "claude-haiku-4-5",
  permissions: { mode: "plan" },    // Read-only
  budget: { maxPerSession: 1.0 },    // $1 max per review
});

const { result } = await harness.run("Review this PR for bugs and security issues");
```

---

## 12. Troubleshooting

### "Permission denied" for a tool

Check your permission rules. In `closed` failMode, tools not explicitly allowed are denied:

```typescript
permissions: {
  rules: [
    { pattern: "YourTool(*)", behavior: "allow", source: "project", priority: 50 },
  ],
  failMode: "closed",
}
```

### Gateway connection refused

1. Verify gateway is running: `curl http://localhost:9101/api/health`
2. Check JWT token hasn't expired (default 24h)
3. Verify port numbers match (WS: 9100, REST: 9101)

### Budget exceeded

The agent stops when `totalCost >= maxPerSession`. Check:
```typescript
harness.getUsage().totalCost  // Current cost
```

### Plugin not loading

1. Ensure plugin has `name`, `version`, and `activate` function
2. Check permissions match: tools/hooks declared in `permissions` must match what `activate` returns
3. Duplicate plugin names are rejected

### Session files location

Default: `~/.agentweave/sessions/`

List sessions: `agentweave session list`

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────┐
│  @agentweave/sdk (createHarness)                             │
│                                                              │
│  ┌──────────────┐  ┌──────────────┐  ┌───────────────────┐  │
│  │ Inner Harness │  │ Control Plane│  │  Outer Harness    │  │
│  │              │  │              │  │                   │  │
│  │ AgentLoop    │◄►│ EventBus     │◄►│ PermissionEngine  │  │
│  │ ToolRegistry │  │ CommandBus   │  │ OutputPipeline    │  │
│  │ ToolExecutor │  │ Interceptors │  │ BudgetManager     │  │
│  │ TokenCounter │  │              │  │ HookEngine        │  │
│  │ MessageStore │  │              │  │ InputGate         │  │
│  │              │  │              │  │ MonitorCollector   │  │
│  │              │  │              │  │ SessionManager     │  │
│  │              │  │              │  │ AlertEngine        │  │
│  │              │  │              │  │ AuditLogger        │  │
│  │              │  │              │  │ ConfigHierarchy    │  │
│  │              │  │              │  │ MultiAgentOrch.    │  │
│  │              │  │              │  │ PluginLoader       │  │
│  └──────────────┘  └──────────────┘  └───────────────────┘  │
│                                                              │
│  @agentweave/protocol          @agentweave/gateway           │
│  (AWOCPClient)          ──►    (AWOCPServer + REST API)      │
│                                                              │
│  @agentweave/adapters          @agentweave/cli               │
│  (ProcessAdapter)              (agentweave run/monitor/session)│
└─────────────────────────────────────────────────────────────┘
```

**9 packages. 332 tests. MIT License.**

GitHub: https://github.com/santete/AgentWeave
