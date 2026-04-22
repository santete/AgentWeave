# P2.2 — Contextual permission rules

**Status:** Design · **Author:** /architect · **Date:** 2026-04-22 · **Roadmap ref:** `project_roadmap_plan.md` P2.2 (M)

## Problem

Today `PermissionRule.condition` is limited to four `ToolRequest` fields:

```
request.toolName | request.isReadOnly | request.isDestructive | request.turnIndex
```

(See `packages/outer-harness/src/governance/permission-engine.ts:129-185`.)

That forces security-sensitive rules to be written coarsely — e.g. we can express *"deny Bash on destructive calls"* but cannot express any of these real asks from POSITIONING Phase 3 / persona needs:

| Want to express | Today? |
|---|---|
| "Deny `Bash` outside 09:00–18:00 on weekdays" (Team Lead, Security) | ❌ no time |
| "Allow `FileWrite` only under `src/**`, never under `.env*` or `node_modules/**`" (Security) | ❌ no path glob |
| "Deny `Bash` commands containing `curl | sh` or `sudo`" (Security) | ❌ no arg regex |
| "Deny production tools when `session.projectId == 'prod'`" (Platform Engineer) | ❌ no session ctx |
| "Deny network tools when `env.CI == 'true'`" (Enterprise Admin) | ❌ no env |

POSITIONING Phase 3 names "Contextual permission rules" as a Pillar-1 deliverable; the engine's mini-DSL is the right foundation to extend because it is (a) already sandboxed (no `eval`), (b) already priority-layered, (c) already fail-safe on parse error.

## Goals

1. Rules can reference **time**, **session**, **env**, and **tool-arg** context via the same `condition` string (no new rule field).
2. Two new operators: **`matches(field, /regex/)`** and **`pathMatches(field, "glob")`** — both scoped, bounded, fail-safe.
3. Zero behavior change when no rule uses the new fields/operators (baseline tests stay green).
4. `env.*` access is **opt-in via allowlist** — no raw `process.env` leakage.
5. No new package, no new dep, stays within `@agentweave/outer-harness`.
6. Dep graph invariant holds: `outer-harness` does not import from `inner-harness`.

## Non-goals

- Full JS expression sandbox (would require `vm2`/`isolated-vm`; rejected — OWASP risk + perf).
- Cross-request stateful conditions ("deny if 5 Bash calls in last minute") — already covered by `rateLimit` on rules.
- User-defined functions — condition DSL stays closed.
- Time-zone configuration — server local time only; document this explicitly.

---

## 1. Context model

### 1.1 New context object

Introduce a single `PermissionContext` that the engine builds once per `evaluate()` call. It is the union of ambient info (clock, env) plus per-request info (session, tool). No public API change for callers.

**File:** `packages/outer-harness/src/governance/permission-context.ts` (NEW)

```ts
/**
 * Ambient + per-request fields available to rule conditions.
 * Built fresh on every evaluate() — do NOT cache across requests.
 */
export interface PermissionContext {
  // Per-request (from ToolRequest — existing fields preserved)
  request: {
    toolName: string;
    toolInput: Record<string, unknown>;  // NEW: whole input available for matches()/pathMatches()
    isReadOnly: boolean;
    isDestructive: boolean;
    turnIndex: number;
    toolUseId: string;
  };

  // Session (may be undefined if OuterHarness has no active session)
  session: {
    sessionId?: string;
    agentId?: string;
    userId?: string;
    projectId?: string;
    model?: string;
    cwd?: string;
  };

  // Ambient clock (server local time — documented limitation)
  time: {
    hour: number;     // 0–23
    minute: number;   // 0–59
    weekday: number;  // 0 (Sun) – 6 (Sat), matches Date.getDay()
    iso: string;      // ISO 8601, handy for audit but rarely compared
    epochMs: number;
  };

  // Environment variables — ONLY those in envAllowlist are exposed. Everything
  // else resolves to undefined (not an error — rule evaluates as if absent).
  env: Record<string, string | undefined>;
}

export interface PermissionContextOptions {
  /** Session info from the last onSessionStart(). Empty object if no session. */
  session?: Partial<PermissionContext["session"]>;
  /** Env var names that rules may read. Default: empty (strict). */
  envAllowlist?: readonly string[];
  /** Override clock — tests only. */
  now?: () => Date;
}
```

### 1.2 New field namespaces exposed to the DSL

| Namespace | Resolver | Example condition |
|---|---|---|
| `request.*` | `ctx.request.<field>` | `request.isDestructive == true` (unchanged) |
| `session.*` | `ctx.session.<field>` | `session.projectId == "prod"` |
| `time.*` | `ctx.time.<field>` | `time.hour >= 18 \|\| time.hour < 9` |
| `env.*` | `ctx.env.<VAR>` (allowlisted only) | `env.CI == "true"` |
| Tool-arg | `request.toolInput.<key>` with dot-path | `contains(request.toolInput.command, "sudo")` |

All five are resolved by one extended `resolveField()` — see §2.2.

### 1.3 What *cannot* be referenced

- `request.toolInput` as a whole object — only string leaves (cmp operators return `false` on non-primitive).
- Any `process.env` var not in `envAllowlist` — returns `undefined` (rule skipped).
- Anything under `file_path` that isn't a string (safety).

---

## 2. Engine changes

### 2.1 Wiring — `OuterHarness` builds context, passes to engine

```
packages/outer-harness/src/outer-harness.ts
  onToolRequested(request)
    │
    ├─ buildPermissionContext(request, lastSession, envAllowlist)   ← NEW helper
    │
    └─ permissions.evaluate(request, context)                        ← ctx is new 2nd arg
```

The existing single-arg `evaluate(request)` is kept as an overload that builds a minimal context internally (so external callers and existing tests are unaffected).

### 2.2 Engine surface — `PermissionEngine.evaluate(request, context?)`

**File:** `packages/outer-harness/src/governance/permission-engine.ts` (MODIFY)

```ts
async evaluate(
  request: ToolRequest,
  context?: PermissionContext,
): Promise<PermissionDecision>
```

- When `context` is omitted (backward compat): engine calls `buildDefaultContext(request)` which fills `request.*` from the ToolRequest and leaves `session`/`env` empty and `time` from `new Date()`. All existing tests pass unchanged.
- When provided: condition evaluator sees the full namespaces.

### 2.3 New operators

Regex:
```
matches(field, /pattern/flags)     // flags limited to: i, m, s  (no g)
```

Path glob (minimatch-compatible subset — same one `packages/outer-harness/src/governance/output-pipeline.ts` already uses for glob filters, if any; otherwise vendored as a 30-line matcher):
```
pathMatches(field, "src/**/*.ts")
pathMatches(field, "!.env*")       // negation when pattern starts with "!"
```

Both fail-safe: unparseable pattern → `false` → rule skipped (same as existing condition parser on `try/catch`).

### 2.4 Resolver extension

Single change to `resolveField()`:

```ts
function resolveField(field: string, ctx: PermissionContext): string | number | boolean | undefined {
  // Dot-walk — "session.projectId", "request.toolInput.command", "env.CI", "time.hour"
  const parts = field.split(".");
  let cur: unknown = ctx;
  for (const part of parts) {
    if (cur == null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  if (typeof cur === "string" || typeof cur === "number" || typeof cur === "boolean") return cur;
  return undefined;  // complex values aren't comparable — rule evaluates as missing
}
```

One function replaces the hardcoded switch at `permission-engine.ts:176-185`.

### 2.5 Safety bounds (see §3 threat model)

| Bound | Value | Enforced where |
|---|---|---|
| Max condition length | 512 chars | `compileRule()` — longer → rule dropped at compile, warning logged |
| Max regex length (inside `matches()`) | 256 chars | compile-time |
| Regex timeout | none (rely on length cap + no backrefs) | — |
| Max depth of field path | 4 segments | `resolveField()` short-circuits |
| Env allowlist default | `[]` | `OuterHarnessConfig.permissions.envAllowlist` |

---

## 3. Threat model

| Threat | Vector | Mitigation |
|---|---|---|
| **ReDoS via `matches()`** | Attacker-controlled rule with `^(a+)+$` pattern | Length cap (256) + no backreferences allowed in compiled regex. RegExp construction itself is safe; match is bounded by input length. |
| **Information leak via `env.*`** | Rule reads secrets (`env.OPENAI_API_KEY`) and routes to `deny`'s `message` field which ends up in audit log | **Opt-in allowlist** — default `[]`. CLI config validator rejects config with `env.*` rule if no allowlist set. |
| **Time-based evasion** (OWASP A01) | Attacker tries to smuggle a destructive call during deny-window by spoofing clock | Server clock only; no `time.*` override from agent input. Document that air-gapped nodes must have `ntp` configured. |
| **Path-traversal in `pathMatches()`** (OWASP A01) | Tool input `../../etc/passwd` evades `src/**` deny | `pathMatches()` normalizes with `path.posix.normalize()` before matching. Document that absolute paths match against the full path; relative paths are normalized but not resolved against `cwd`. |
| **Condition injection** | Attacker gets a condition string into `runtime`-source rule | Fail-safe parse (existing), plus length cap. `runtime` source rules can only be added programmatically (`addRule`) — not from YAML — so the trust boundary stays at the config loader. |
| **Denial-of-service via rule explosion** | Config with 10k rules each with condition | `scenario_b_implementation_guide.md` §perf budget: permission decision ≤ 1 ms. Cap enforced in config validator: `rules.length ≤ 1000`. |
| **Privilege escalation via session spoofing** | Agent sets `session.projectId = "dev"` to bypass prod rule | `session.*` is populated by OuterHarness from `SessionInfo` supplied at `onSessionStart()` — never from agent/tool input. Hard invariant in `buildPermissionContext()`. |

**OWASP mapping:**

- A01 Broken Access Control — the very thing this feature implements. Mitigation: `strict` mode default-deny still fires if no rule matches; `permissive` default-allow is documented as dev-only.
- A03 Injection — covered by fail-safe parse + length caps; no `eval`/`vm` introduced.
- A08 Software & Data Integrity — rule source layering (`policy` > `project` > `user` > `runtime`) means enterprise policy can pin `deny` rules that runtime additions cannot shadow. Unchanged from today, but enforced test in `test-matrix/enterprise-pin.test.ts`.

---

## 4. Rule-evaluation order — unchanged

```
for rule in compiledRules (sorted by priority desc):
  if rule.group in disabledGroups: skip
  if !matchCompiled(rule.pattern, request): skip
  if rule.condition && !evaluateCondition(rule.condition, ctx): skip  ← only line that sees new context
  if rule.behavior == "allow" && rule.rateLimit && !checkRateLimit: deny
  return decision
return defaultDecision(request)
```

The **only** line that changes is `evaluateCondition` — now takes `ctx: PermissionContext` instead of `request: ToolRequest`. Priority order, source layering, rate limiting, group toggling, dry-run mode, audit trail: all untouched.

**Why this matters:** P2.2 is additive. A rule with no `condition` or only old fields (`request.isReadOnly`) behaves *exactly* as before. `packages/outer-harness/__tests__/permission-engine.test.ts` (~30 existing tests) must stay green without modification — this is the regression gate.

---

## 5. Config surface

### 5.1 New `PermissionConfig` field

**File:** `packages/types/src/permissions.ts` (MODIFY)

```ts
export interface PermissionConfig {
  mode: PermissionMode;
  rules: PermissionRule[];
  failMode: "open" | "closed";
  timeoutMs: number;
  askTimeoutMs: number;
  envAllowlist?: readonly string[];  // NEW — env vars exposed to `env.*`. Default [].
}
```

Zod schema update in whichever config loader validates it (search: `PermissionConfigSchema` in `packages/cli/src/lib/config/`).

### 5.2 YAML examples (`agentweave.yaml`)

```yaml
permissions:
  mode: default
  envAllowlist: ["CI", "NODE_ENV"]    # explicit opt-in
  rules:
    # After-hours lockout (Team Lead)
    - pattern: "Bash(*)"
      behavior: "deny"
      source: "policy"
      priority: 200
      condition: "time.hour >= 18 || time.hour < 9 || time.weekday == 0 || time.weekday == 6"
      message: "Bash tools are locked outside business hours (Mon–Fri 09:00–18:00)."

    # Path-scoped writes (Security)
    - pattern: "FileWrite(*)"
      behavior: "deny"
      source: "policy"
      priority: 150
      condition: "pathMatches(request.toolInput.file_path, \".env*\") || pathMatches(request.toolInput.file_path, \"node_modules/**\")"
      message: "Writes to env files and dependencies are forbidden."

    # Dangerous Bash payloads (Security)
    - pattern: "Bash(*)"
      behavior: "deny"
      source: "policy"
      priority: 175
      condition: "matches(request.toolInput.command, /\\bsudo\\b/) || matches(request.toolInput.command, /curl\\s.*\\|\\s*sh/)"
      message: "Detected dangerous shell pattern."

    # Production guardrail (Platform Engineer)
    - pattern: "*"
      behavior: "deny"
      source: "policy"
      priority: 500
      condition: "session.projectId == \"prod\" && request.isDestructive == true"
      message: "Destructive tools are denied in prod."

    # CI-only enforcement (Enterprise Admin)
    - pattern: "HttpFetch(*)"
      behavior: "deny"
      source: "policy"
      priority: 100
      condition: "env.CI == \"true\""
      message: "Network fetches are denied in CI; use pinned fixtures."
```

### 5.3 CLI affordances (no new subcommand needed)

- `agentweave audit view` already shows `matched` pattern; extend the `reason` column to surface when a condition mismatch caused a rule to be *skipped* — `--verbose` mode only, logged at audit level not decision level.
- `agentweave config validate` (existing, wherever config-validate lives) gains a P2.2-specific check: if any rule references `env.X` and `envAllowlist` is empty → error with fix suggestion.

---

## 6. File placement & change list

| # | File | Change | Notes |
|---|---|---|---|
| 1 | `packages/types/src/permissions.ts` | MODIFY | add `envAllowlist?` to `PermissionConfig` |
| 2 | `packages/outer-harness/src/governance/permission-context.ts` | NEW | `PermissionContext` + `buildPermissionContext()` |
| 3 | `packages/outer-harness/src/governance/permission-engine.ts` | MODIFY | `evaluate(req, ctx?)`, `resolveField()` rewrite, `matches()` + `pathMatches()` operators, compile-time length caps |
| 4 | `packages/outer-harness/src/outer-harness.ts` | MODIFY | capture `SessionInfo` on `onSessionStart`; pass ctx to `evaluate()` |
| 5 | `packages/outer-harness/src/index.ts` | MODIFY | export `PermissionContext`, `PermissionContextOptions` |
| 6 | `packages/outer-harness/__tests__/permission-engine-context.test.ts` | NEW | full test matrix (§7) |
| 7 | `packages/outer-harness/__tests__/permission-context.test.ts` | NEW | builder-in-isolation |
| 8 | `packages/cli/src/lib/config/*` (wherever schema lives) | MODIFY | Zod for `envAllowlist`; validator rule for `env.X` without allowlist |
| 9 | `docs/` (nothing — docs regenerated from types + spec; no MDX churn) | — | — |

**Estimated size:** M — ~350 LOC across 4 new/modified source files + 2 test files. 1 focused session.

**Dep graph check:** all edits stay in `types` (leaf) and `outer-harness` (depends on types + control-plane only). No inner-harness touches. ✅

---

## 7. Test matrix

Tests live in `packages/outer-harness/__tests__/`. Target: every table row = at least one `it()` block.

### 7.1 Field resolution (`permission-context.test.ts`)

| Field | Input | Expect |
|---|---|---|
| `request.toolName` | `ToolRequest{toolName: "Bash"}` | `"Bash"` |
| `request.toolInput.command` | `toolInput: {command: "ls"}` | `"ls"` |
| `request.toolInput.file_path` | `toolInput: {file_path: "src/x.ts"}` | `"src/x.ts"` |
| `request.toolInput.nested` | `toolInput: {nested: {k: 1}}` | `undefined` (non-primitive leaf) |
| `session.projectId` | `SessionInfo{projectId: "prod"}` | `"prod"` |
| `session.missing` | absent | `undefined` |
| `time.hour` | `now = 2026-04-22T14:30Z` | `14` (server local) |
| `time.weekday` | Sunday | `0` |
| `env.CI` | allowlist=["CI"], env.CI="true" | `"true"` |
| `env.SECRET` | not in allowlist, env.SECRET="x" | `undefined` |
| Depth > 4 | `a.b.c.d.e` | `undefined` |

### 7.2 Operator correctness (`permission-engine-context.test.ts`)

| Condition | Scenario | Expect rule fires? |
|---|---|---|
| `time.hour >= 18` | now = 19:00 | ✅ |
| `time.hour >= 18 \|\| time.hour < 9` | now = 07:30 | ✅ |
| `time.weekday == 0` | Sunday | ✅ |
| `matches(request.toolInput.command, /\bsudo\b/)` | cmd = "sudo rm" | ✅ |
| `matches(request.toolInput.command, /\bsudo\b/)` | cmd = "pseudonym" | ❌ (word boundary) |
| `matches(x, /(a+)+$/)` | pattern len > 256 | ❌ rule dropped at compile, warning logged |
| `pathMatches(request.toolInput.file_path, "src/**/*.ts")` | path = "src/x/y.ts" | ✅ |
| `pathMatches(path, "!.env*")` | path = ".env.local" | ❌ (negation) |
| `pathMatches(path, "src/**")` | path = "../../etc/passwd" | ❌ (normalized out of src) |
| `session.projectId == "prod"` | projectId unset | ❌ (undefined != "prod") |
| `env.CI == "true"` | not in allowlist | ❌ (undefined) |

### 7.3 Logical combination

| Condition | Scenario | Expect |
|---|---|---|
| `A && B` both true | — | fires |
| `A && B` one false | — | no-fire |
| `A \|\| B` both false | — | no-fire |
| `A && B \|\| C` (left-assoc, `\|\|` lowest) | `A=false, B=*, C=true` | fires (C branch) |

### 7.4 Fail-safe (invariant: invalid condition never crashes)

| Input | Expect |
|---|---|
| Condition with unclosed paren | rule skipped, others still evaluate |
| Regex with unsupported flag `g` | rule skipped |
| Field path with non-ASCII | rule skipped |
| Condition > 512 chars | rule dropped at compile, audit warning |

### 7.5 Regression — baseline (critical)

Run existing `permission-engine.test.ts` unchanged. All ~30 tests must pass. This is the zero-behavior-change proof.

### 7.6 End-to-end (CLI integration)

Add one test to `packages/cli/__tests__/pipeline-governance.test.ts`:

- Config with time-based deny rule, `now` mocked to 20:00 → `controlPlane.intercept("tool_request", Bash)` returns `deny` with the rule's `message`. Audit log entry includes `matched_rule.pattern` and `reason`.

---

## 8. Performance

Per `performance_budget.md` §3 (Permission engine): p95 decision latency ≤ 1 ms at 100 rules.

| Operation | Cost | Notes |
|---|---|---|
| Build context per request | ~5 μs | Object construction + 6 `Date.get*()` calls |
| Resolve dot-path field | ~1 μs | Array split + 2–4 lookups |
| `matches()` | ~5–50 μs | Bounded by 256-char pattern cap + input length |
| `pathMatches()` | ~5–20 μs | Minimatch compiled once at rule-compile time (cached on `CompiledRule`) |
| 100 rules × condition | ~200 μs | Well under 1 ms budget |

**Cache strategy:** compile regex + glob at `compileRule()` time (same as existing pattern compilation at engine construction). `PermissionContext` is built per request — too small to cache.

---

## 9. Rollout & migration

1. Ship engine + types changes behind no flag — additive, backward compatible.
2. Ship config schema additions (`envAllowlist`) — defaults preserve today's behavior.
3. Update `docs/governance-hooks.md` with the four example rules from §5.2.
4. MEMORY.md entry for P2.2 shipped; P2.2 moves from "open" to "done" in roadmap.

**No breaking change.** A dependent package that instantiates `PermissionEngine` directly keeps working — the new `context` argument is optional.

---

## 10. Open questions (for PO confirmation before `/implement`)

1. **Time zone:** server local time only, or add `time.utcHour`? → recommendation: ship local-only for MVP, add UTC in a follow-up if a customer asks. (**Decision needed.**)
2. **Wildcard env:** allow `envAllowlist: ["*"]` as an explicit "expose everything" opt-out? → recommendation: **no** — forces deliberate declarations. (**Decision needed.**)
3. **`pathMatches()` basedir:** match against raw `file_path` string, or resolve against `session.cwd` first? → recommendation: **raw** — avoids surprising the user, keeps semantics local to the rule. Document this clearly. (**Decision needed.**)

---

## 11. DoD

- [ ] All tests in §7 pass + baseline stays green
- [ ] `pnpm turbo run build` 10/10
- [ ] `pnpm turbo run test:unit` ≥ 655 + new tests (expected ~20 new)
- [ ] `packages/types/src/permissions.ts` JSDoc updated for `envAllowlist`
- [ ] `docs/governance-hooks.md` extended with contextual-rule examples
- [ ] Config validator rejects `env.X` reference without allowlist entry
- [ ] Dep graph check: `outer-harness` imports nothing from `inner-harness`
- [ ] MEMORY.md + `project_roadmap_plan.md` updated to mark P2.2 shipped
