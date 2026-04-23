# Policy Hierarchy — `org / team / user` cascade

AgentWeave loads up to three YAML files into the permission engine at boot and
merges them with runtime rules:

| Level | Intent | Source label in audit | Rule `source` internally |
|-------|--------|------------------------|---------------------------|
| **org**  | Organization-wide baseline. Can use `immutable: true`. | `org`  | `policy`  |
| **team** | Project / team layer. Overrides org within the mutable bucket. | `team` | `project` |
| **user** | Individual operator overrides. | `user` | `user`    |

Higher tiers always load before lower tiers. An **immutable** deny at `org`
overrides any conflicting `allow`/`ask` from `team` or `user`; the attempt is
recorded in the audit log but never silently dropped.

## 1. File discovery

For every level, paths are tried in order — first existing file wins, missing
files are silently skipped (unless `--policy-require-all` is set):

1. **CLI flag** — `--policy-org <path>` / `--policy-team <path>` / `--policy-user <path>`
2. **Environment variable** — `AGENTWEAVE_POLICY_ORG` / `_TEAM` / `_USER`
3. **OS-standard path:**

   | Level  | Linux / macOS                      | Windows                                       |
   |--------|------------------------------------|------------------------------------------------|
   | org    | `/etc/agentweave/policy.org.yaml`  | `%PROGRAMDATA%\agentweave\policy.org.yaml`    |
   | team   | `/etc/agentweave/policy.team.yaml` | `%PROGRAMDATA%\agentweave\policy.team.yaml`   |
   | user   | `./policy.user.yaml` → `~/.agentweave/policy.user.yaml` | `.\policy.user.yaml` → `%USERPROFILE%\.agentweave\policy.user.yaml` |

Disable all policy loading for a single run with `--no-policy`.

## 2. File schema

```yaml
version: 1                 # required, literal 1
metadata:                  # optional, purely informational
  name: acme-baseline
  owner: security@acme.example
  updatedAt: 2026-04-22
rules:
  - pattern: "Bash(rm *)"  # PermissionRule DSL (see P2.2 docs)
    behavior: deny         # allow | deny | ask
    priority: 100          # higher wins within the same bucket
    immutable: true        # org only — throws InvalidImmutableLevel elsewhere
    message: "rm is not allowed on production paths."
    # condition, group, rateLimit all optional — see PermissionRule type
```

Caps enforced at load time: file ≤ 1 MB, ≤ 10 000 rules per file. Malformed
YAML, schema failures, and `immutable: true` outside `org` all **fail closed at
boot** (the process throws before the agent runs).

## 3. End-to-end example — 3-file cascade

`/etc/agentweave/policy.org.yaml` (owned by security):

```yaml
version: 1
metadata: { name: acme-org, owner: secops@acme }
rules:
  - pattern: "Bash(rm -rf /*)"
    behavior: deny
    priority: 1000
    immutable: true
    message: "Destructive root removal is permanently denied."
  - pattern: "Write(/etc/*)"
    behavior: deny
    priority: 900
    immutable: true
```

`/etc/agentweave/policy.team.yaml` (owned by a specific team):

```yaml
version: 1
metadata: { name: platform-team }
rules:
  - pattern: "Bash(kubectl *)"
    behavior: ask
    priority: 500
  - pattern: "Bash(git push *)"
    behavior: ask
    priority: 500
```

`~/.agentweave/policy.user.yaml` (per-operator, opt-in):

```yaml
version: 1
rules:
  - pattern: "Bash(ls *)"
    behavior: allow
    priority: 100
  - pattern: "Bash(git push origin main)"
    behavior: deny           # Tightens the team "ask" rule
    priority: 600
```

Effective decision table for this cascade:

| Tool call                    | Result | Why                                             |
|------------------------------|--------|-------------------------------------------------|
| `Bash(rm -rf /)`             | deny   | Org immutable — cannot be overridden            |
| `Write(/etc/hosts)`          | deny   | Org immutable                                   |
| `Bash(kubectl apply ...)`    | ask    | Team rule; no higher-priority conflict           |
| `Bash(git push origin main)` | deny   | User `priority: 600` beats team `ask:500`        |
| `Bash(ls -la)`               | allow  | User rule (no conflict above)                    |

## 4. Inspecting the loaded cascade

```bash
# Human-readable snapshot of what's currently loaded
agentweave policy show

# Machine-readable (paths, rule counts, sha256 per file)
agentweave policy show --format json

# Dry-run a draft file before dropping it into /etc or ~/.agentweave
agentweave policy lint ./draft.policy.org.yaml          # infers level from filename
agentweave policy lint ./draft.yaml --as team           # explicit override
```

`agentweave audit view` now renders a **LEVEL** column (`org`/`team`/`user`/
`rt`/`hook`) and suffixes immutable decisions with `(!)` — e.g.
`block(!)` means the tool was denied by an immutable rule and no lower tier
could have relaxed it.

## 5. Rollout recipe

1. **Start mutable.** Draft `policy.org.yaml` without `immutable:` and land it
   in a staging environment. Run `agentweave policy lint` in CI on every PR
   that touches the file.
2. **Audit first, enforce later.** Leave `failMode` as-is, watch
   `agentweave audit view --decision block --since 24h` for false positives.
3. **Promote to immutable.** Once a rule is stable, add `immutable: true` at
   the org level. The `(!)` marker in audit makes violations visible
   immediately.
4. **Add tiers incrementally.** Teams file first, then let individuals add
   `policy.user.yaml` for narrower scoping. Track per-file drift via the
   `sha256` hash printed by `policy show`.
5. **Require resolution in CI/CD.** Pass `--policy-require-all` with explicit
   `--policy-org/--policy-team` paths so a missing or misspelled file becomes
   a hard boot error instead of silent no-op.

## 6. Audit events to watch

Every tool call and every boot emits structured entries to the audit log. The
four events directly tied to the policy cascade:

| Action                         | When it fires                                                                 | Typical follow-up                                      |
|--------------------------------|--------------------------------------------------------------------------------|--------------------------------------------------------|
| `policy_loaded`                | Once per resolved file at boot. Includes `level`, `path`, `ruleCount`, `sha256`. | Reconcile hash vs. CI artifact to detect drift.        |
| `permission_decision`          | Every `tool_request`. Includes `behavior`, `source`, `matchedPattern`.          | Feed into dashboards / alerts.                         |
| `immutable_override_blocked`   | A lower-tier rule would have allowed/asked, but an org immutable denied it.     | Usually informational; investigate only if unexpected. |
| `ask_approval_orphaned`        | Startup found a persisted "approved ask" that conflicts with a new immutable.   | Remove the stale entry from `.agentweave/ask-approvals.json`. |

## 7. Troubleshooting

**`Error: Policy load failed: ... (schema)` at boot**

Schema validation rejected the file. Run `agentweave policy lint <path>` to
see the zod error in isolation.

**`Error: Invalid immutable rule at <level> level`**

`immutable: true` is only legal at `org`. Either move the rule into the org
file or drop the flag. The engine fails closed at boot so a demoted file
never runs.

**`agentweave policy show` reports "0/3 levels resolved" unexpectedly**

The loader found no files on the discovery path. Confirm with
`--format json` what it *tried*; most common cause is a typo in
`AGENTWEAVE_POLICY_*` or a path that doesn't match the OS-standard location
above.

**Audit log shows `immutable_override_blocked` entries on every call**

Expected if an operator or team rule is actively trying to relax an org
immutable — the engine silently preserves the immutable decision but logs
the attempt. Either update the org policy intentionally or remove the
conflicting lower-tier rule.

**Audit log shows `ask_approval_orphaned` after an org policy update**

A previously-approved `ask` rule persisted to `.agentweave/ask-approvals.json`
now conflicts with a newly-loaded immutable deny. The orphaned entry is kept
for forensic review but no longer influences the engine. Delete it once you
confirm the new policy is correct.

**`--policy-require-all` throws "unresolved path"**

At least one `--policy-*` flag pointed at a file that does not exist. Either
fix the path or drop `--policy-require-all` (missing files are then silently
skipped, matching the default discovery behavior).

## 8. See also

- `docs/governance-hooks.md` — how Claude Code hooks invoke `agentweave
  guard`, which is the process that reads the loaded policy at runtime.
- `product-spec/design-p31-policy-hierarchy.md` — full design spec, including
  precedence proof and security model.
- `@agentweave/outer-harness` `PolicyLoader` — programmatic API if you are
  embedding the loader in custom tooling.
