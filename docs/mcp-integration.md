# MCP Integration — AgentWeave ↔ Claude Code (and any MCP host)

AgentWeave ships an MCP (Model Context Protocol) server that exposes the Inner
Harness QA layer as tools your agent can call mid-session. This is **Pillar 3 —
Distribution**: the surface that reaches coding agents in the wild. Canonical
positioning: [`product-spec/POSITIONING.md`](../product-spec/POSITIONING.md).

The split:

- **Agent (Claude Code, Cursor, etc.)** — generates code, makes edits, plans
- **AgentWeave MCP tools** — verifies: scope, tests/lint, metrics snapshots

No agent is spawned by the MCP server — it runs pure verification logic, so there
is no recursion risk when your host already *is* Claude Code.

> MCP covers the **QA layer** (tools the agent *chooses* to call). For
> **governance** (permissions, budget, audit on *every* tool call), see
> `docs/governance-hooks.md` — that uses Claude Code's `.claude/hooks/` rather
> than MCP, because hooks run per tool invocation whereas MCP tool calls are
> opt-in.

## Tools exposed

| Tool | Purpose |
|------|---------|
| `validate_patch` | Scope check: changed files vs estimated files, hard limit on file count, empty-patch detection. Returns M3 scope accuracy. |
| `run_quality_gate` | Run test/lint/typecheck/compile/custom commands. Commands are validated against a safe binary allowlist; shell metacharacters are rejected. |
| `record_metrics` | Persist an M1-M10 snapshot to disk for later comparison. |
| `compare_metrics` | Delta between a current snapshot and a baseline (from disk or inline). |

## Install — Claude Code (repo-local)

Build the workspace first:

```bash
pnpm install
pnpm turbo build
```

Then point Claude Code at the server. The repo already ships a `.mcp.json` at
the root; Claude Code picks it up automatically when started from the repo:

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

Alternatively, generate a snippet with absolute paths you can paste into
`~/.claude.json` or any MCP host config:

```bash
agentweave mcp print-config
```

## Install — Other MCP hosts (Cursor, Continue, etc.)

Spawn the server over stdio:

```bash
agentweave mcp start
```

or directly:

```bash
node /absolute/path/to/packages/mcp-server/dist/server.js
```

The server speaks the MCP stdio transport (JSON-RPC on stdin/stdout, logs on
stderr).

## Example — Claude Code session

Once registered, Claude Code will surface the tools in its tool list. You can
ask it to use them:

> "After you finish editing, call `run_quality_gate` with `npm test` and `tsc
> --noEmit`, then `validate_patch` with the files you changed."

The agent calls the tools, receives JSON results, and decides whether to retry
or continue based on the pass/fail output.

## Security notes

- `run_quality_gate` commands must start with a binary in the safe allowlist
  (npm, pnpm, vitest, jest, tsc, eslint, biome, node, etc.) — see
  `packages/inner-harness/src/sdlc/modules/quality-gate.ts`.
- Shell metacharacters (`; | & \` $ ( ) { }`) are rejected to prevent chaining.
- The server does **not** spawn AI agents — it only runs verification logic.
- The env var `AGENTWEAVE_MCP_MODE=1` is set in child processes; downstream
  code can use this to guard against recursion.

## Recursion guard

If you ever extend the MCP server to invoke inner modules that might themselves
spawn an agent (e.g. a future `generate_plan` tool calling the LLM), check
`process.env.AGENTWEAVE_MCP_MODE` before doing so and short-circuit. This
prevents an infinite loop when Claude Code is both the host and the invoked
agent.
