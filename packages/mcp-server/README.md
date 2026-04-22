# @agentweave/mcp-server

MCP (Model Context Protocol) server that exposes AgentWeave's QA pipeline as
tools any MCP-compatible host — Claude Code, Cursor, Continue, Windsurf — can
call during a coding session.

**Canonical positioning:** [`product-spec/POSITIONING.md`](../../product-spec/POSITIONING.md).

This package is **Pillar 3 — Distribution**: the surface that reaches agents
in the wild. It does **not** spawn or wrap an agent. It hands the host a set
of deterministic verification tools the agent can call between edits.

```
┌───────────────────────────────┐           ┌──────────────────────────┐
│  Claude Code / Cursor / …     │  MCP      │  @agentweave/mcp-server  │
│  (generates code, edits)      │ ◀──────▶  │  (stdio, JSON-RPC)       │
└───────────────────────────────┘           └──────────────────────────┘
                                                       │
                                                       ▼
                                       ┌───────────────────────────────┐
                                       │  Inner Harness — Pillar 2     │
                                       │  QA modules (pure verifiers)  │
                                       └───────────────────────────────┘
```

---

## Tools exposed

| Tool | What it does |
|---|---|
| `validate_patch` | Scope check — files changed vs expected, hard cap on file count, empty-patch detection. Returns M3 scope accuracy. |
| `run_quality_gate` | Run tests / lint / typecheck / compile. Commands must start with a binary in a safe allowlist; shell metacharacters rejected. |
| `record_metrics` | Persist an M1–M10 snapshot to disk for later comparison. |
| `compare_metrics` | Delta between a current snapshot and a baseline (from disk or inline). |

No agent is invoked; the tools run pure verification logic, so there is no
recursion risk when your MCP host already *is* a coding agent.

---

## Install

```bash
pnpm add -D @agentweave/mcp-server
# or from the workspace
pnpm install
pnpm turbo build
```

The package ships a `bin` entry (`agentweave-mcp`) and an ESM library export
(`createAgentWeaveMcpServer`).

---

## Quickstart — Claude Code

From the repo root:

```bash
agentweave mcp print-config > .mcp.json
```

This writes (or use this snippet directly):

```json
{
  "mcpServers": {
    "agentweave": {
      "command": "node",
      "args": ["./packages/mcp-server/dist/server.js"]
    }
  }
}
```

Claude Code auto-loads `.mcp.json` from the repo root. The four tools appear
in the tool list on next session.

Ask the agent to call them:

> "After you edit, run `run_quality_gate` with `npm test` and `tsc --noEmit`,
> then `validate_patch` with the files you changed."

---

## Quickstart — other MCP hosts

Spawn the server over stdio:

```bash
agentweave mcp start
# or directly:
node /abs/path/to/packages/mcp-server/dist/server.js
```

The server speaks MCP's stdio transport: JSON-RPC on stdin/stdout, logs on
stderr.

---

## Programmatic use

```typescript
import { createAgentWeaveMcpServer } from "@agentweave/mcp-server";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

const server = createAgentWeaveMcpServer();
await server.connect(new StdioServerTransport());
```

---

## Security

- `run_quality_gate` commands are matched against a safe allowlist (npm, pnpm,
  vitest, jest, tsc, eslint, biome, node, …).
- Shell metacharacters (`;`, `|`, `&`, backtick, `$`, `(`, `)`, `{`, `}`) are
  rejected to prevent chaining.
- The server never spawns an AI agent — pure verification logic only.
- `AGENTWEAVE_MCP_MODE=1` is set so downstream code can short-circuit if it
  ever starts an inner loop.

Full security model + recursion guard: [`docs/mcp-integration.md`](../../docs/mcp-integration.md).

---

## How this package fits AgentWeave

AgentWeave is a Governance + QA layer that stands above any coding agent. The
three pillars:

| Pillar | Package | Role |
|---|---|---|
| 1 — Governance | `@agentweave/outer-harness` + `agentweave guard` | Per-tool-call policy (permission, budget, audit) |
| 2 — QA Pipeline | `@agentweave/inner-harness` (SDLC) | 8-stage SDLC with M1–M10 metrics |
| 3 — Distribution | **this package** + `@agentweave/adapters` | Reach agents in the wild |

For the hooks-based governance path (every tool call, not just opt-in ones),
see [`docs/governance-hooks.md`](../../docs/governance-hooks.md).

---

## License

MIT
