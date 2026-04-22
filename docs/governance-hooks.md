# Governance Hooks — `.claude/hooks/` ↔ AgentWeave Outer Harness

Claude Code supports per-session hooks that fire before and after every tool
call. AgentWeave ships a thin **guard** CLI that those hooks can shell into.
Each invocation reads the Claude Code payload from stdin, evaluates it
against your permission rules and budget, writes an audit entry, and replies
with a decision JSON. The process is short-lived; all state lives on disk.

This layer is independent from the Option 2 MCP server:

| Layer  | Purpose                                    | How the agent invokes it |
|--------|--------------------------------------------|--------------------------|
| MCP    | QA tools (`validate_patch`, `run_quality_gate`, metrics) | The agent *chooses* to call these tools |
| Hooks  | Governance (permissions, budget, audit)    | Claude Code runs them on *every* tool call |

## 1. How a tool call flows

```
Claude Code picks a tool (Bash / Write / Edit / ...)
        │
        ▼
PreToolUse hook fires     ← .claude/hooks/pre-tool-use.cjs
        │
        ▼
node shim → `agentweave guard pre-tool-use`
        │
        ▼
PermissionEngine → BudgetManager → audit-log
        │
        ├─► decision "approve" → Claude Code runs the tool
        └─► decision "block"   → tool is denied, reason shown to agent
```

`PostToolUse` runs after the tool and is used only for audit/cost accounting;
it is fail-open — a broken hook must not stop the agent.

## 2. Install

1. Build the workspace and link the CLI globally:

   ```bash
   pnpm install
   pnpm turbo build
   cd packages/cli && npm link
   ```

2. Verify the CLI is reachable (hooks shell to `agentweave` via PATH):

   ```bash
   agentweave --version
   ```

3. Copy the example config:

   ```bash
   cp .agentweave/guard.example.json .agentweave/guard.json
   ```

4. Activate the hooks in `.claude/settings.json`. The repo ships a template
   at `.claude/hooks/agentweave-hooks.example.json`; merge its `hooks.PreToolUse`
   and `hooks.PostToolUse` entries into your `.claude/settings.json`. Minimal
   activation:

   ```json
   {
     "hooks": {
       "PreToolUse":  [{ "matcher": "Bash|Write|Edit", "hooks": [{ "type": "command", "command": "node ./.claude/hooks/pre-tool-use.cjs" }] }],
       "PostToolUse": [{ "matcher": "Bash|Write|Edit", "hooks": [{ "type": "command", "command": "node ./.claude/hooks/post-tool-use.cjs" }] }]
     }
   }
   ```

   > ⚠️ Merging replaces matchers. If you already have entries for `Bash|Write|Edit`
   > you either need to chain both hooks under the same matcher or widen the
   > matcher regex. Claude Code runs hooks sequentially.

5. Restart Claude Code so it reloads `.claude/settings.json`.

## 3. Config — `.agentweave/guard.json`

Recognized fields (all but `mode` are optional):

| Field           | Type                     | Notes |
|-----------------|--------------------------|-------|
| `mode`          | `default \| strict \| permissive \| plan` | Fallback when no rule matches. `strict` denies everything unmatched; `permissive` allows it; `plan` denies only destructive tools. |
| `permissions[]` | `{ pattern, behavior, priority?, message?, group? }` | `pattern` uses the existing AgentWeave matcher (e.g. `Bash(git *)`, `Write(*.env)`, `*`). `behavior` is `allow`/`deny`/`ask`. |
| `budget`        | `{ maxPerSession?, maxPerDay?, warningThreshold?, costPerToolCall?, persistPath? }` | Pre-tool-use blocks when next call would push over the cap; post-tool-use records the cost. |
| `audit`         | `{ enabled, path }` | JSONL appended per event. |
| `envAllowlist`  | `string[]`               | Env vars exposed to rule conditions via `env.*`. Anything outside this list resolves to `undefined` at condition-eval time (fail-closed). Default: `[]`. |

### 3.1 Context available to rule conditions

Conditions can reference four namespaces (see `design-p22-contextual-rules.md`):

- `request.*` — `toolName`, `toolInput.<key>`, `isReadOnly`, `isDestructive`, `turnIndex`, `toolUseId`. **Always populated** from the Claude Code hook payload.
- `time.*` — `hour`, `minute`, `weekday`, `iso`, `epochMs`. **Always populated** from server wall-clock.
- `session.*` — `sessionId` and `cwd` are populated from the hook payload's `session_id` and `cwd` fields. Other session fields (`agentId`, `userId`, `projectId`, `model`) are **not set in hook mode** — Claude Code does not ship them. Rules referencing those fields will skip (fail-safe).
- `env.*` — only vars listed in `envAllowlist` (above) are readable. Anything else resolves to `undefined`. Prevents accidental secret reads into audit output.

Example rule using context:
```json
{ "pattern": "Bash(curl*)",
  "behavior": "deny",
  "condition": "env.CI != \"true\" && time.hour >= 18" }
```

`ask` has no native Claude Code equivalent, so the guard surfaces `ask` as a
block with the rule's `message`. The user then edits config or confirms out
of band before retrying.

A ready-made example lives at `.agentweave/guard.example.json`.

## 4. YAML vs JSON

The loader accepts `.agentweave/guard.json`, `guard.yaml`, or `guard.yml`. The
parser tries JSON first (since JSON is valid YAML) and falls back to a very
minimal comment-stripped JSON parse. **Use JSON unless you need comments** —
regex-heavy permission patterns are painful to get right in ambiguous YAML.

## 5. Fail-behavior

| Condition                      | Pre-hook                 | Post-hook |
|--------------------------------|--------------------------|-----------|
| Unexpected crash in guard code | **fail-closed (exit 2)** | fail-open (exit 0) |
| Malformed JSON / empty stdin   | **fail-closed (exit 2)** | fail-open |
| Schema-invalid payload         | **fail-closed (exit 2)** | fail-open |
| `agentweave` CLI missing       | **fail-closed (exit 2)** | fail-open |
| `deny` rule matches            | exit 2, reason surfaced  | n/a |
| `ask` rule matches             | exit 2, message surfaced | n/a |

Fail-closed on the pre-hook is deliberate: a silent governance failure is worse
than a blocked tool call. Post-hook failures must never stop the agent since
they only record state.

## 6. Windows notes

- Hook scripts are `.cjs` so Claude Code's default Node can run them without
  ESM flags.
- They spawn `agentweave` with `shell: true`, which lets Windows resolve
  `agentweave.cmd` via `PATH`.
- Stdin is piped; no manual quoting. Known Windows-spawn argument-quoting bug
  (fixed in `ProcessAdapter`, see `project_critical_bugs.md`) does not apply
  because the hook doesn't pass arbitrary args.

## 7. Verify activation

Once hooks are registered, run any Claude Code command and check for the
audit log:

```bash
tail -n 5 .agentweave/audit.log
```

Every tool call should produce one `pre` and one `post` entry. If nothing
appears, confirm:

1. `agentweave --version` resolves from a fresh shell.
2. `.claude/settings.json` has the hook entries and Claude Code was restarted.
3. `.agentweave/guard.json` exists and is valid JSON.

## 8. Relationship to other governance paths

- `agentweave pipeline run` (SDLC engine) has its own governance wired through
  `OuterHarness`. The hooks are for when a developer runs `claude` *raw*,
  outside the pipeline. The two paths do not stomp on each other.
- Process-adapter mode (`--agent claude`) already goes through SDLC governance,
  so adding hooks on top is double-counting; prefer one path per session.
