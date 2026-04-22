# Cursor Integration — Spike (D2)

**Status:** Spike complete. Recommendation: `cursor-agent -p` headless CLI for the PoC adapter.

**Scope:** Decide which Cursor surface AgentWeave wraps as an InnerHarnessProvider. This is Phase D2 of the governance+QA pivot — D1 delivered the Aider adapter, D2 delivers Cursor to prove the "any coding agent under one governance layer" claim.

---

## The four surfaces Cursor exposes

| # | Surface | What it is | Spawnable from AgentWeave? |
|---|---|---|---|
| A | `cursor-agent -p` (headless CLI) | Documented non-interactive CLI, prints to stdout, exits on completion | **Yes** — same shape as `claude --print` and `aider --message` |
| B | Cursor-as-MCP-host | Cursor IDE consumes MCP servers we expose | **Already delivered** — Pillar 3 C2 (`packages/mcp-server/`) |
| C | Cursor Cloud Agents API | v2.6+ cloud sandboxes triggered by Automations | Yes (REST), but requires Cursor Pro + cloud round-trip |
| D | IDE-embedded agent | The agent inside Cursor the editor | **No** direct surface — goes through (B) |

Source: [Cursor CLI headless docs](https://cursor.com/docs/cli/headless), [Cursor MCP docs](https://cursor.com/docs/mcp), [Cursor Automations 2026 changelog](https://cursor.com/changelog/page/3).

---

## Tradeoff table

| Dimension | A. Headless CLI | B. MCP host | C. Cloud Agents API | D. IDE-embedded |
|---|---|---|---|---|
| AgentWeave role | Spawns Cursor, captures stdout/stderr | Cursor spawns us | HTTP client to Cursor's cloud | N/A |
| Governance direction | **Outer** wraps inner ✅ | **Inner** consumes outer's tools | Outer calls remote inner | Not wrappable |
| Fits SDLC `Exec` stage | ✅ Direct | ⚠️ Inverted — Cursor drives, we serve tools | ⚠️ Async, long-latency | ❌ |
| New code needed in D2 | ~60 LOC adapter + tests | **0** (C2 shipped) | ~200 LOC (HTTP + auth + polling) | N/A |
| Auth model | User's Cursor session or API key | User installs MCP server | Cursor Pro + API token | User's IDE |
| Works offline | ✅ | ✅ | ❌ | N/A |
| Production risk | Known issue: `-p` can hang ([forum](https://forum.cursor.com/t/cursor-agent-p-print-headless-mode-hangs-indefinitely-and-never-returns/150246)) — need timeout | Low | Medium (cloud dependency) | — |
| Persona coverage | CLI/CI users, Team Lead, Platform Eng | Cursor IDE users (Developer, AI Researcher) | Automation/scheduled workflows | — |

---

## Open question from D2 planning — answered

> *"Should D2 include a fourth option — wrap Cursor's Claude-compatible API in headless mode?"*

**No.** There is no separate "Claude-compatible API" surface at Cursor. The headless route **is** `cursor-agent -p`; it's a first-class CLI, not a model-API proxy. Dropping that hypothetical option.

---

## Recommendation — surface A (`cursor-agent -p`)

**Why:**

1. **Symmetric with D1 and Claude Code adapter.** ProcessAdapter + arg promptMode + model flag + extra args. Same shape, so the governance wiring, stderr capture, exit-code mapping, and retry classification are already solved.
2. **Covers the primary positioning claim.** Pivot messaging is "wrap any coding agent." Shipping a Cursor CLI adapter alongside Claude Code and Aider is the concrete proof.
3. **Surface B already ships.** The MCP-host route (C2) is the zero-code answer for Cursor IDE users — `agentweave mcp serve` exposes our governance tools to Cursor. D2 does not need to re-solve it.
4. **Lowest complexity.** S (~60 LOC). Aligns with the D2 plan locked at "headless-only."

**Not recommended for D2:**

- **B (MCP host)** — already delivered, document the path in README (handled by C2 docs).
- **C (Cloud Agents API)** — defer. Interesting for Phase 5 enterprise/automation story, but introduces cloud auth, polling, and cost unknowns that don't belong in a PoC.
- **D (IDE-embedded)** — no direct surface; users reach this via (B).

---

## PoC design sketch

Mirrors `aider-adapter.ts` (D1) and `claude-code-adapter.ts`:

```
packages/adapters/src/cursor-adapter.ts
  export interface CursorAdapterConfig {
    model?: string;      // -m <model> (e.g., "sonnet-4", "gpt-5")
    cwd?: string;
    extraArgs?: string[];
    env?: Record<string, string>;
    force?: boolean;     // map to --force (default: true for non-interactive)
  }

  export function buildCursorAdapterConfig(config?): ProcessAdapterConfig
  export function createCursorAdapter(config?): ProcessAdapter

packages/adapters/__tests__/cursor-adapter.test.ts
  // same test shape as aider-adapter.test.ts
```

CLI args assembled: `cursor-agent [--force] [-m <model>] [...extraArgs] -p <prompt>`.
- `-p` goes last so `promptMode: "arg"` appends the prompt as its value (same trick as `--message` for Aider).
- `parseJson: false` (stdout is plain text — stream-JSON flag is not documented for `-p`).
- `stderr.capture: true` to preserve the "known hang" signal for retry classification.

CLI preset to add to `packages/cli/src/agent-presets.ts`:

```ts
cursor: {
  name: "Cursor Agent",
  command: "cursor-agent",
  args: ["--force", "-p"],
  promptMode: "arg",
  parseJson: false,
  stderr: { capture: true, asEvents: false },
  install: "curl https://cursor.com/install -fsS | bash",
  verifyCommand: "cursor-agent --version",
  notes: "Requires Cursor account login or CURSOR_API_KEY. -p mode can hang on some prompts — pipeline timeout catches it.",
}
```

---

## Known risks (carry into PoC)

- **Headless hang bug.** `cursor-agent -p` can hang indefinitely on some prompts. Resolved: `ProcessAdapter.processTimeoutMs` + Windows tree-kill (`taskkill /T /F`) now SIGTERMs the child after N ms, falls back to SIGKILL after 5 s, and returns exit reason `"timeout"`. CLI defaults to 300 s.
- **Auth variance.** Cursor CLI logs in via browser flow or `CURSOR_API_KEY`. Document both in the PoC README note but don't enforce either — the adapter is auth-agnostic.

## Inherited governance coverage

`agentweave pipeline run --agent X` now wires a minimal governance wrapper around adapter output (`packages/cli/src/lib/adapter-governance.ts`). Because the adapter is a black-box process — no tool-call events crossing the boundary — the coverage is intentionally partial:

| Governance module | Applies to adapter? | Notes |
|---|---|---|
| **OutputPipeline** | ✅ | Secret + PII redaction on every assistant text chunk before UI/persist. Built-in patterns plus extra filters. |
| **AuditLogger** | ✅ | Records `adapter:spawn`, `adapter:message`, `adapter:exit` to `.agentweave/adapter-audit.jsonl`. |
| **BudgetManager (wall-clock)** | ✅ | Enforced via `ProcessAdapter.processTimeoutMs` (CLI default 5 min). |
| **BudgetManager (cost $)** | ❌ | Adapter doesn't emit token usage. Use the agent's own billing console. |
| **PermissionEngine** | ❌ | By design — adapter owns tool-calling internally, so CLI has no pre-tool hook to gate. Users who need tool-level governance should drive Cursor via MCP-host (C2) and let AgentWeave's MCP tools gate there. |
| **HookEngine (tool-pre/post)** | ❌ | Same reason as PermissionEngine. |
| **HookEngine (session-level)** | ⚠️ | Session markers only — no in-flight tool events. |

---

## Acceptance-criteria mapping (from D2 story)

| Criterion | Covered by |
|---|---|
| Spike doc with tradeoff table | This doc |
| PoC adapter for chosen surface | Next step — `packages/adapters/src/cursor-adapter.ts` |
| Same 3 governance checks as D1 (permission, budget, audit) | Inherits `ProcessAdapter` → `OuterHarness` wiring already exercised by Aider tests |
| At least 1 SDLC stage (QA gate) runs against Cursor output | CLI preset + `pipeline run --agent cursor` path |
| README note on auth (subscription vs API key) | `notes` field on CLI preset + covered above |
