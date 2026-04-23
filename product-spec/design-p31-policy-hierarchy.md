# P3.1 — Policy Hierarchy (org / team / user cascade + immutable rules)

**Status:** Design · **Author:** /architect · **Date:** 2026-04-23 · **Roadmap ref:** `project_roadmap_plan.md` P3.1 (L) · **PO story:** see `/po` output on 2026-04-23

## Problem

Today `PermissionEngine` accepts a flat `PermissionRule[]` from a single `PermissionConfig`. `PermissionRule.source` exists as a 4-value union (`"policy" | "project" | "user" | "runtime"`) but **nothing loads from 3 different files or enforces a precedence**. Consequences:

| Can an Enterprise Admin today… | No, because… |
|---|---|
| Declare a company-wide "no `curl \| sh`" rule that a team lead cannot flip to `allow`? | All rules flatten into one array; team config can add a higher-priority `allow` and win. |
| Ship `.agentweave/policy.org.yaml` to 100 developer machines and guarantee uniform enforcement? | No discovery of org-level files. Each user's local config is the only source. |
| Prove via audit which level (org/team/user) emitted a deny? | `audit view` shows `source: rule:policy` vs `rule:user` but PolicyLoader does not exist, so every rule looks user-sourced. |
| Block a user from overriding compliance rules even with `runtime` rule additions? | `PermissionEngine.addRule()` accepts any `source`, no immutable concept. |

POSITIONING Phase 5 names "policy hierarchy, immutable rules, RBAC" as deliverables. Hierarchy is the prerequisite (RBAC needs to know which level defines roles).

The existing `source` enum already matches the 3 levels we want (policy=org, project=team, user=user). We extend by: (a) a loader that reads 3 files and populates `PermissionConfig.rules` with correct `source` tags, (b) an `immutable: true` flag only honored on `source: "policy"`, (c) an engine split of rules into immutable vs mutable buckets with immutable evaluated first, (d) audit enrichment surfacing the hierarchy level.

## Goals

1. Three YAML files — `policy.org.yaml`, `policy.team.yaml`, `policy.user.yaml` — load in cascade.
2. Discovery order: (1) explicit `--policy-org` / `--policy-team` / `--policy-user` CLI flags > (2) `AGENTWEAVE_POLICY_{ORG,TEAM,USER}` env vars > (3) OS-standard paths.
3. `immutable: true` at org level makes a rule un-overridable by team/user/runtime — **regardless of priority number**.
4. Deny-immutable wins even against `alwaysAllow` entries persisted by AskStore; persisted entry is marked orphaned + audit event emitted.
5. Malformed `policy.org.yaml` fails **closed at boot** (engine refuses to evaluate; CLI exits non-zero). Missing file = silent skip (backward compat).
6. Zero behavior change when only `policy.user.yaml` (or nothing) exists.
7. `audit view` surfaces which hierarchy level the matched rule came from.
8. p99 `PermissionEngine.evaluate` stays ≤ 3 ms (10 rules) — budget in `performance_budget.md` §1.1.
9. Dep graph invariant holds: `outer-harness` imports no `inner-harness`.

## Non-goals

- RBAC (role definitions, user↔role mapping). Needs identity story first. Follow-up ticket.
- SSO / authentication. Out of scope.
- GPG-signed policy files (policy integrity). Backlog — `design-p32-policy-signing.md` TBD.
- Cloud-delivered policy (remote MCP governance). Deferred — will be `design-p41-mcp-cloud-surface.md`.
- Policy hot-reload (watch + re-evaluate). Policies load once at boot; restart to pick up changes. Documented limitation.

---

## 1. File model

### 1.1 Schema

All three files share one schema. Only one field — `immutable` — is level-sensitive.

**File:** `packages/types/src/permissions.ts` (EXTEND existing schema)

```ts
export interface PermissionRule {
  pattern: string;
  behavior: "allow" | "deny" | "ask";
  source: "policy" | "project" | "user" | "runtime";
  priority: number;
  condition?: string;
  message?: string;
  group?: string;
  rateLimit?: RateLimit;

  /**
   * Marks the rule as un-overridable by lower levels or runtime additions.
   * VALID ONLY when `source === "policy"` (org level). If set on team/user/runtime,
   * PolicyLoader rejects the file (fail-closed). Immutable rules evaluate BEFORE
   * mutable rules regardless of priority number.
   */
  immutable?: boolean;
}
```

**File on disk (`policy.org.yaml` example):**

```yaml
version: 1
metadata:
  name: "Acme Corp — Org Security Policy"
  owner: "security@acme.com"
  updatedAt: "2026-04-23"
rules:
  - pattern: "Bash(curl * | sh)"
    behavior: deny
    priority: 100
    immutable: true
    message: "Piping curl to sh is blocked by org policy [SEC-042]"
    group: "shell-injection"

  - pattern: "FileWrite(.env*)"
    behavior: deny
    priority: 100
    immutable: true
    condition: "request.toolInput.path contains \".env\""
    message: "Writing .env files is blocked [SEC-017]"
```

The `source` field is **not** written in the YAML — PolicyLoader assigns it based on which file the rule came from.

### 1.2 Discovery order

The CLI / SDK resolves each file path independently in this priority:

| Rank | Source | Example |
|---|---|---|
| 1 | CLI flag | `--policy-org ./custom-org.yaml` |
| 2 | Env var | `AGENTWEAVE_POLICY_ORG=/opt/secpolicy/acme.yaml` |
| 3 | OS path | see §1.3 |

A file at rank N is only consulted if no rank-N' (N' < N) exists. **Missing file at every rank = level absent (no error).**

### 1.3 OS-standard paths

| Level | Unix / macOS | Windows |
|---|---|---|
| **org** | `/etc/agentweave/policy.org.yaml` | `%PROGRAMDATA%\agentweave\policy.org.yaml` |
| **team** | `/etc/agentweave/policy.team.yaml` | `%PROGRAMDATA%\agentweave\policy.team.yaml` |
| **user** | `~/.agentweave/policy.user.yaml` OR `./policy.user.yaml` (cwd wins if both exist) | `%USERPROFILE%\.agentweave\policy.user.yaml` OR `.\policy.user.yaml` |

Rationale: org + team go to system-wide (`/etc` / `ProgramData`) so a central config-management tool (Ansible, Intune, GPO) can push them without touching user dirs. User policy lives next to the project or in home. Project-local `./policy.user.yaml` beats `~` so per-repo overrides work.

### 1.4 File validation

PolicyLoader runs Zod validation per file:

```ts
const PolicyFileSchema = z.object({
  version: z.literal(1),
  metadata: z.object({
    name: z.string(),
    owner: z.string().optional(),
    updatedAt: z.string().optional(),
  }).optional(),
  rules: z.array(PermissionRuleYamlSchema),
});
```

Where `PermissionRuleYamlSchema` is `PermissionRule` **minus** the `source` field (loader sets it) **plus** this cross-field check:

- If `immutable: true` is set on a file loaded as team or user, reject with `InvalidImmutableLevel` error.

---

## 2. Merge algorithm

### 2.1 Load sequence

```
1. orgPath   = resolvePath("org",   cliFlag, env, osPath)    // undefined if none
2. teamPath  = resolvePath("team",  cliFlag, env, osPath)
3. userPath  = resolvePath("user",  cliFlag, env, osPath)
4. orgRules  = orgPath  ? parse(orgPath,  "policy")  : []
5. teamRules = teamPath ? parse(teamPath, "project") : []
6. userRules = userPath ? parse(userPath, "user")    : []
7. return [...orgRules, ...teamRules, ...userRules]
```

Parse failures propagate via `PolicyLoadError` — see §2.3.

### 2.2 Engine splits into 2 buckets

`PermissionEngine.constructor(config)` now does:

```ts
const immutable = config.rules.filter(r => r.immutable === true);
const mutable   = config.rules.filter(r => r.immutable !== true);
this.immutableCompiled = immutable.sort(byPriorityDesc).map(compileRule);
this.mutableCompiled   = mutable  .sort(byPriorityDesc).map(compileRule);
```

`evaluate()` walks **immutable first**, then **mutable**. First match wins (existing semantic).

Implication: an `immutable: true, behavior: "deny"` at priority 10 **always** beats a non-immutable `allow` at priority 999. User answer #2 (org-immutable thắng bất kể priority).

### 2.3 Fail-closed on malformed org

| Condition | Behavior |
|---|---|
| Org file path resolved + YAML parse fails | `PolicyLoadError` — engine refuses construction; CLI exits 2 with `Malformed org policy: <details>` |
| Org file path resolved + Zod validation fails | Same as above |
| Org file present + any rule has `immutable` on non-policy level | Same as above |
| Team / user file malformed | Same **fail-closed** behavior at boot (if you configure it, you must get it right) |
| Any file **missing** (no rank-1/2/3 path found) | Silent skip, level is absent |

Rationale: a malformed file signals misconfiguration; silently dropping it would mean security rules don't apply. Asymmetric with "file missing = OK" because missing means admin didn't deploy this level at all.

---

## 3. Immutable semantics

### 3.1 The rule

> An immutable deny/ask/allow at org level wins **before** any non-immutable rule evaluates, regardless of pattern priority.

Implemented by the two-bucket split in §2.2. No priority arithmetic tricks.

### 3.2 Override detection (audit only)

When an immutable **deny** matches, the engine ALSO scans mutable rules to detect "what would have happened without this immutable." If any mutable rule would have matched with `behavior: "allow"` — emit a one-time audit event:

```
action: immutable_override_blocked
data:
  immutableRule: { pattern, source, message }
  overridden: [{ pattern, behavior, source, priority }]
  tool: <toolName>
```

Only emits on genuine conflict (mutable rule would have allowed / asked). Pure scan, no behavior change.

### 3.3 Engine-API hardening

`PermissionEngine.addRule(rule)` (runtime additions — used by AskStore for persisted `alwaysAllow`):

```ts
addRule(rule: PermissionRule): void {
  if (rule.immutable) throw new Error("Runtime rules cannot be immutable");
  // Conflict check against immutable bucket BEFORE adding:
  const conflict = this.immutableCompiled.find(c =>
    patternsOverlap(c.rule.pattern, rule.pattern) &&
    wouldConflict(c.rule.behavior, rule.behavior)
  );
  if (conflict) {
    throw new PermissionRuleConflictError(conflict.rule, rule);
  }
  // existing push + sort logic on mutable bucket only
}
```

`patternsOverlap` is an approximation — exact-match and glob-subset are the easy cases; heuristic "may overlap" for regex patterns (side with caller: allow, emit warning).

---

## 4. Ask-flow interaction (user answer #3: deny-immutable wins)

### 4.1 Scenario

1. T=0: user approves an `alwaysAllow` for `Bash(npm run *)` via ask flow. AskStore persists to `.agentweave/ask-approvals.json`.
2. T=1 day: org pushes `policy.org.yaml` with `immutable: true, pattern: "Bash(*)", behavior: "deny"`.
3. T=1 day + boot: engine loads. Conflict: immutable deny covers a persisted `alwaysAllow`.

### 4.2 Resolution

At boot, after PolicyLoader merges + engine constructs, run this reconciliation pass:

```ts
for (const persisted of askStore.list()) {
  const conflict = immutableCompiled.find(c =>
    patternsOverlap(c.rule.pattern, persisted.rule.pattern) &&
    wouldConflict(c.rule.behavior, persisted.rule.behavior)
  );
  if (conflict) {
    askStore.markOrphaned(persisted.rule.pattern, {
      reason: "immutable_conflict",
      conflictWith: conflict.rule.pattern,
    });
    auditLogger.log("ask_approval_orphaned", {
      persisted: persisted.rule,
      conflictingImmutable: conflict.rule,
      timestamp: Date.now(),
    });
  }
}
```

`markOrphaned` sets a flag on the persisted entry; AskStore.load() skips orphaned entries when replaying into the engine. Orphaned entries stay in the file (not deleted) so the user can inspect via `agentweave audit view --since=<date>`.

### 4.3 UX

- `agentweave policy show` flags persisted asks as `[orphaned: org-immutable conflict]`.
- Next ask flow prompt re-asks (since the allow is orphaned); if user approves again, the immutable deny still blocks at eval time → user sees deny with org message.

---

## 5. Engine integration (minimal changes)

### 5.1 New files

| Path | Purpose | LOC estimate |
|---|---|---|
| `packages/outer-harness/src/governance/policy-loader.ts` | NEW. File discovery, parse, Zod validate, merge, return `PermissionRule[]`. | ~180 |
| `packages/outer-harness/src/governance/policy-errors.ts` | NEW. `PolicyLoadError`, `InvalidImmutableLevel`, `PermissionRuleConflictError`. | ~40 |
| `packages/outer-harness/__tests__/policy-loader.test.ts` | NEW. 15+ tests (see §10). | ~400 |
| `packages/outer-harness/__tests__/policy-hierarchy.integration.test.ts` | NEW. End-to-end 3-file cascade through engine. | ~150 |
| `docs/policy-hierarchy.md` | NEW. User-facing guide + YAML examples. | ~250 |
| `product-spec/design-p31-policy-hierarchy.md` | THIS FILE | ~this |

### 5.2 Modified files

| Path | Change |
|---|---|
| `packages/types/src/permissions.ts` | Add `immutable?: boolean` to `PermissionRule`. |
| `packages/outer-harness/src/governance/permission-engine.ts` | Split `compiledRules` into `immutableCompiled` + `mutableCompiled`; evaluate immutable first; harden `addRule` with conflict check; emit `immutable_override_blocked` audit event. |
| `packages/outer-harness/src/governance/ask-store.ts` | Add `markOrphaned()` + skip orphaned in `load()`. |
| `packages/outer-harness/src/outer-harness.ts` | At construction, if config provides `policyPaths`, call PolicyLoader and merge into `PermissionConfig.rules`; run reconciliation vs AskStore. |
| `packages/cli/src/commands/pipeline.ts` | Wire `--policy-org` / `--policy-team` / `--policy-user` flags. |
| `packages/cli/src/commands/policy.ts` | NEW subcommand: `agentweave policy show` / `policy lint <file>`. |
| `packages/cli/src/commands/audit.ts` | Extend `audit view` to include `Source` column (org/team/user/runtime). |
| `packages/outer-harness/package.json` | Add `js-yaml` dep (~34KB). |

### 5.3 Public API

```ts
// packages/outer-harness/src/governance/policy-loader.ts

export interface PolicyPaths {
  org?: string;
  team?: string;
  user?: string;
}

export interface LoadedPolicy {
  rules: PermissionRule[];       // concatenated, tagged with source
  sources: {
    orgPath?: string;             // resolved path (for audit)
    teamPath?: string;
    userPath?: string;
  };
}

export class PolicyLoader {
  /**
   * Resolve paths via CLI flag > env var > OS default, parse each,
   * validate, merge. Throws PolicyLoadError on any malformed file.
   */
  static load(overrides?: PolicyPaths): LoadedPolicy;
}
```

`OuterHarnessConfig` gains:

```ts
export interface OuterHarnessConfig {
  // ... existing
  policy?: {
    paths?: PolicyPaths;
    /** If true, failing to find even one policy file is an error. Default false. */
    requireAll?: boolean;
  };
}
```

### 5.4 Dep graph check

- `policy-loader.ts` imports: `fs/promises`, `path`, `os`, `js-yaml`, `zod`, `@agentweave/types`. ✓
- No import from `@agentweave/inner-harness`. ✓
- No import from `@agentweave/control-plane` (loader is pure). ✓
- Dep graph invariant (outer ≠> inner) held.

---

## 6. Audit extension

### 6.1 `permission_decision` row

Already enriched with `matchedPattern` in commit `654bed6`. Add:

```ts
{
  action: "permission_decision",
  data: {
    tool, behavior, source, matchedPattern,  // existing
    level: "org" | "team" | "user" | "runtime" | "default",  // NEW
    immutable: boolean,                                       // NEW
  }
}
```

Mapping: `source: "policy"` → `level: "org"`, `source: "project"` → `level: "team"`, else identity.

### 6.2 New audit events

- `policy_loaded` — at boot, per level: `{ level, path, ruleCount, sha256 }` — the hash lets forensic verify which file version was in effect.
- `immutable_override_blocked` — see §3.2.
- `ask_approval_orphaned` — see §4.2.

### 6.3 `audit view` CLI

Add `Source` column to tabular output:

```
TIME       TOOL    BEHAVIOR  LEVEL    RULE                      REASON
12:03:17   Bash    deny      org(!)   Bash(curl * | sh)         SEC-042
12:04:02   Grep    allow     user     Grep(*)                   default user allow
```

The `(!)` suffix flags immutable rules. `--format json` includes raw `level` + `immutable` fields.

---

## 7. CLI surface

### 7.1 `agentweave policy show`

Prints effective merged policy, grouped by level, with override warnings:

```
$ agentweave policy show
ORG (/etc/agentweave/policy.org.yaml, 3 rules, loaded sha256:abc123…)
  [immutable] Bash(curl * | sh)      deny    prio=100  SEC-042
  [immutable] FileWrite(.env*)       deny    prio=100  SEC-017
  [         ] Bash(git push *)       ask     prio=50   "confirm push"

TEAM (none)

USER (~/.agentweave/policy.user.yaml, 2 rules)
  [         ] Bash(npm test)         allow   prio=10

RUNTIME (in-memory, 1 rule from ask-store)
  [orphaned] Bash(npm run *)         allow   prio=1
                                              ↳ orphaned by org immutable Bash(curl * | sh)
```

### 7.2 `agentweave policy lint <file>`

Validates a candidate file without loading into the engine. Useful for PR review of org-policy changes. Exit 0 on valid; exit 1 on schema error; exit 2 on immutable-at-wrong-level.

### 7.3 Flags on `pipeline run`

```
--policy-org <path>     Override org policy location
--policy-team <path>    Override team policy location
--policy-user <path>    Override user policy location
--no-policy             Skip all policy files (local dev; refuses if immutable org exists)
```

`--no-policy` is rejected (exit 2) when an immutable org policy resolves — the whole point is that developers cannot skip immutable rules. Documented as expected behavior.

---

## 8. Threat model

| Threat | Mitigation |
|---|---|
| **User locally edits `policy.user.yaml` to add `behavior: "allow"` on a tool the org wants denied.** | Org `immutable: true, deny` in bucket 1 evaluates first. User rule never reaches evaluation. |
| **User sets `immutable: true` in `policy.user.yaml`** to "upgrade" a personal rule. | PolicyLoader rejects with `InvalidImmutableLevel` at boot (fail-closed). |
| **Attacker swaps `policy.org.yaml` with permissive version on a victim's machine.** | Org-path resolution includes `sha256` in `policy_loaded` audit event — forensic can compare against known-good hash. Integrity signing is a follow-up (backlog §Non-goals). |
| **User runs with `--policy-org ./attacker-policy.yaml`** to override. | Allowed by design (local dev convenience). Audit records which path was used. Enterprise deployment should lock flags via wrapper script or hooks. |
| **Malformed org file causes engine to crash silently → tools evaluate with empty rule set.** | Fail-closed at boot: PolicyLoader throws, OuterHarness construction fails, CLI exits 2. Engine never enters a "no rules" state from a malformed file. |
| **Race: org file swapped mid-session.** | Policies load once at boot; no hot-reload. Process restart required. Documented limitation. |
| **AskStore persisted `alwaysAllow` survives a new org deny.** | Reconciliation pass at boot marks conflicting persisted entries orphaned + audit event. Re-ask on next invocation; immutable deny still wins. |
| **Big policy file DoS** (50MB YAML, 1M rules). | `js-yaml` parses with default safeLoad; cap file size at **1 MB** + rule count at **10 000** per level at PolicyLoader entry. Rejects with clear error. |
| **YAML-specific attacks** (aliases explosion / anchors). | Use `js-yaml.load` with `JSON_SCHEMA` (no custom tags). Caps in previous row bound anchor depth. |

### 8.1 OWASP mapping

- **A01:2021 Broken Access Control** — policy hierarchy enforces org-level access rules no matter what user does locally.
- **A05:2021 Security Misconfiguration** — fail-closed on malformed + sha256 in audit = detection of misconfig.
- **A08:2021 Software & Data Integrity** — sha256 hash in `policy_loaded` audit is the hook for a later signing story.
- **A09:2021 Logging & Monitoring** — every override attempt and orphan emits a dedicated audit event.

---

## 9. Performance analysis

### 9.1 Budget check

Target: `PermissionEngine.evaluate` p99 ≤ 3 ms (10 rules), per `performance_budget.md` §1.1.

Current (post-P2.2): p99 = 0.075 ms (measured in review-cycle bench).

Added work per `evaluate()`:
- Two bucket scans instead of one. O(n) unchanged; constant 2× worst case (all rules mutable, immutable bucket empty scan).
- Override-detection scan on immutable deny match (§3.2): one extra pass over mutable bucket. Only runs when immutable deny matches (rare).

Added work at boot (one-shot, not per-eval):
- YAML parse: ~2 ms per typical file (empirical `js-yaml` benchmarks).
- Zod validation: ~5 ms for 50 rules.
- Reconciliation pass against AskStore: O(persisted × immutable). Typical: 10 × 20 = 200 ops, < 1 ms.

Net eval-path change: ~ +5-10% over current p99. Estimated post-change p99 ≈ 0.08 ms — still 37× under 3 ms budget. ✓

### 9.2 Memory

- Typical 3 files × 50 rules × ~500 bytes compiled = 75 KB. Well under any relevant budget.
- No persistent caches beyond what exists.

---

## 10. Test matrix (15+ tests)

### 10.1 `policy-loader.test.ts`

| # | Test | Expected |
|---|---|---|
| 1 | load with all 3 files present, non-overlapping rules | returns all rules tagged with correct sources |
| 2 | load with only `policy.user.yaml` | returns user rules; no org/team entries |
| 3 | load with no files present | returns empty array; no error |
| 4 | load with `immutable: true` in team file | throws `InvalidImmutableLevel` |
| 5 | load with `immutable: true` in user file | throws `InvalidImmutableLevel` |
| 6 | load with malformed YAML in org file | throws `PolicyLoadError` with `parse` reason |
| 7 | load with Zod-invalid rule (bad behavior enum) | throws `PolicyLoadError` with `schema` reason |
| 8 | load respects CLI flag over env var over OS path | highest-rank wins per level |
| 9 | load caps file size at 1 MB | rejects 1.5MB file with clear error |
| 10 | load caps rule count at 10 000 | rejects file with 10 001 rules |
| 11 | load computes sha256 hash per loaded file | hash matches independent calculation |
| 12 | load handles Windows-style paths (`\`) | paths resolve on `process.platform === "win32"` shim |

### 10.2 `policy-hierarchy.integration.test.ts`

| # | Test | Expected |
|---|---|---|
| 13 | org `immutable: deny` + user `allow` same pattern | engine returns deny; `immutable_override_blocked` audit event present |
| 14 | org `immutable: deny` priority=1 + user `allow` priority=999 | engine returns deny (immutable bucket evaluates first) |
| 15 | org `deny` (not immutable) + user `allow` higher priority | user allow wins (non-immutable org is just like any other rule) |
| 16 | no org/team/user files | engine evaluates with default behavior only (regression gate) |
| 17 | persisted `alwaysAllow` conflicts with new immutable deny | AskStore entry marked orphaned; `ask_approval_orphaned` audit event emitted |
| 18 | `addRule` called with immutable flag at runtime | throws `Error` |
| 19 | `addRule` called with rule that conflicts with immutable | throws `PermissionRuleConflictError` |
| 20 | malformed org file at boot | `new OuterHarness()` throws; CLI wrapper exits 2 |
| 21 | `--no-policy` flag when immutable org resolves | CLI exits 2 with explicit error |
| 22 | p99 evaluate with 10 mixed immutable/mutable rules | < 3 ms under vitest bench |

---

## 11. Ordered change list (for `/implement`)

Strictly sequential. Do NOT parallelize — later steps depend on earlier types.

| # | Step | Files | Size |
|---|---|---|---|
| 1 | **Types** — extend `PermissionRule` with `immutable?: boolean`. Export `PolicyPaths`, `LoadedPolicy`, `PolicyLoadError`, `InvalidImmutableLevel`, `PermissionRuleConflictError`. | `packages/types/src/permissions.ts`, `packages/types/src/index.ts` | S |
| 2 | **Loader** — write `policy-loader.ts` + `policy-errors.ts`. Add `js-yaml` dep to `packages/outer-harness/package.json`. | `packages/outer-harness/src/governance/policy-loader.ts` (NEW), `policy-errors.ts` (NEW), `package.json` | M |
| 3 | **Loader tests** — write 12 tests in `policy-loader.test.ts` covering §10.1. | `packages/outer-harness/__tests__/policy-loader.test.ts` (NEW) | M |
| 4 | **Engine split** — modify `permission-engine.ts` to split buckets, evaluate immutable first, scan for `immutable_override_blocked`, harden `addRule`. | `packages/outer-harness/src/governance/permission-engine.ts` | M |
| 5 | **AskStore reconciliation** — add `markOrphaned()` + skip orphaned in `load()`; expose hook for OuterHarness to run reconciliation. | `packages/outer-harness/src/governance/ask-store.ts` | S |
| 6 | **OuterHarness assembly** — in constructor, if `config.policy?.paths` present (or always, reading ambient files), call `PolicyLoader.load()`, merge into `config.permission.rules`, run AskStore reconciliation, emit `policy_loaded` audit events. | `packages/outer-harness/src/outer-harness.ts` | M |
| 7 | **Integration tests** — write 10 tests in `policy-hierarchy.integration.test.ts` covering §10.2. | `packages/outer-harness/__tests__/policy-hierarchy.integration.test.ts` (NEW) | M |
| 8 | **CLI flags + subcommand** — add `--policy-org/-team/-user` / `--no-policy` to `pipeline run`; add `policy show` / `policy lint <file>` subcommands. | `packages/cli/src/commands/pipeline.ts`, `packages/cli/src/commands/policy.ts` (NEW), `packages/cli/bin.ts` | M |
| 9 | **Audit view extension** — add `LEVEL` column + `(!)` immutable marker to table output; include fields in JSON format. | `packages/cli/src/commands/audit.ts` | S |
| 10 | **Docs** — `docs/policy-hierarchy.md` with 3-file example + rollout guide. | `docs/policy-hierarchy.md` (NEW) | M |
| 11 | **Final verify** — `pnpm turbo run build` (expect 10/10) + `pnpm turbo run test:unit` (expect ~702 passing = current 687 + 22 new - any that collapse). | — | — |

Total estimate: 1.5-2 sessions. Steps 1-3 = Session 1; Steps 4-7 = Session 2; Steps 8-11 = Session 2 tail or Session 3 start.

---

## 12. ADR

### ADR-031: YAML + `js-yaml` over JSON or TOML for policy files

**Context.** Policy files are admin-authored and may include comments / multi-line regex explanations. Need 3 files, Zod-validatable.

**Decision.** YAML via `js-yaml` (safe-load, JSON_SCHEMA tag filter only).

**Consequences.** +34 KB install size in outer-harness. Admins get comments + multiline. Caller-friendly error messages.

**Alternatives considered.**
- **JSON**: no comments → policy files with `// SEC-042: …` context become verbose string fields. Rejected.
- **TOML**: fine but `@iarna/toml` is 80 KB and team has zero TOML muscle memory. Rejected on cost/benefit.
- **cosmiconfig full**: overkill — we do not need the multi-file-format discovery; we know it's YAML. Rejected for minimalism.

### ADR-032: Two-bucket split over priority-arithmetic trick

**Context.** Need immutable rules to beat mutable regardless of priority number.

**Decision.** Engine stores two arrays; evaluate immutable first, then mutable.

**Consequences.** Trivial to reason about. Audit output groups naturally. No "invisible priority" magic where a `priority: 10 immutable` secretly has effective priority `10 + 2^53`.

**Alternatives considered.**
- **Promote priority to `Number.MAX_SAFE_INTEGER / 2 + priority`**: works but surprising in audit output ("why does this rule have priority 4500000000000010?"). Rejected.
- **Separate `ImmutableEngine` wrapping `PermissionEngine`**: double evaluate path, doubles config. Rejected.

### ADR-033: Fail-closed on malformed, fail-open on missing

**Context.** A malformed file is a misconfiguration. A missing file is an intentional absence. Treating them the same creates ambiguity.

**Decision.** Malformed → refuse boot + exit 2. Missing → silent skip.

**Consequences.** Operators writing policy must keep it valid; catches typos in CI via `policy lint`. Deployments without policy files (dev laptops, CI without enterprise rules) work unchanged.

**Alternatives considered.**
- **All fail-closed**: breaks every current test and local dev. Rejected.
- **All fail-open**: silently drops security rules on typo. Security anti-pattern. Rejected.

---

## 13. Open questions answered (from /po handoff)

| # | Question | Answer chosen |
|---|---|---|
| 1 | Discovery order — hard-coded paths + CLI override? | **Accepted.** Rank 1 CLI > rank 2 env > rank 3 OS paths. §1.2. |
| 2 | Conflict when both levels have same pattern + different priority — does immutable win regardless? | **Org-immutable wins regardless of priority number.** Two-bucket split (ADR-032). §2.2 / §3.1. |
| 3 | Ask-flow interaction — org deny-immutable vs persisted user `alwaysAllow`? | **Deny-immutable wins.** Persisted entry marked orphaned + audit event. §4. |
| 4 | Performance — cached compiled rules at boot vs per-evaluation? | **p99 ≤ 3 ms preserved** via load-once-at-boot cached compilation + two-bucket split. §9. |
| 5 | Scope boundary — does this touch MCP cloud? | **Pure file-based.** Cloud-delivered policy = separate design `design-p41-mcp-cloud-surface.md`. §Non-goals. |

---

## 14. Ready-for-`/implement` checklist

- [x] Types delta specified (§1.1, §5.3)
- [x] File discovery spec with exact paths per OS (§1.2-1.3)
- [x] Zod schema specified (§1.4)
- [x] Merge algorithm with pseudocode (§2)
- [x] Immutable semantics + runtime hardening (§3)
- [x] Ask-flow reconciliation pseudocode (§4)
- [x] File/LOC estimates (§5.1-5.2)
- [x] Public API surface frozen (§5.3)
- [x] Dep graph invariant verified (§5.4)
- [x] Audit schema delta (§6)
- [x] CLI surface frozen (§7)
- [x] Threat model + OWASP map (§8)
- [x] Performance budget verified against spec (§9)
- [x] 22-test matrix (§10)
- [x] 11-step ordered change list (§11)
- [x] 3 ADRs capturing non-obvious decisions (§12)
- [x] All open questions resolved (§13)

**Handoff:** `/implement` can start at §11 step 1 without further architect input. If implementation surfaces a new question not covered here, update this doc via an ADR addendum before proceeding.
