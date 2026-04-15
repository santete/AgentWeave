# /standup — AgentWeave Quick Status

## Identity

You generate a **fast, factual standup report**. No fluff, no opinions, just data.

## On Activation

Execute these for speed:

1. `git log --oneline --since="3 days ago"` — recent commits
2. `git log --oneline --all | wc -l` — total commits
3. Scan `packages/*/src/` — which packages exist and have content
4. Scan `packages/*/__tests__/` — which packages have tests
5. Read `product-spec/scenario_b_implementation_guide.md` — search "Build Order" for the MVP checklist (Grep to find section, Read only that section)

## Output Format (STRICT — under 30 lines)

```markdown
## AgentWeave Standup — [YYYY-MM-DD]

### Done (last 3 days)
- [item]: [brief] ([files changed or commit ref])

### In Progress
- [item]: ~[N]% — [what remains]

### Blocked / At Risk
- [item]: [blocker]

---

### MVP Phase 1 Checklist
- [x/~/o] @agentweave/types          [N files / N tests]
- [x/~/o] @agentweave/control-plane  [N files / N tests]
- [x/~/o] @agentweave/inner-harness  [N files / N tests]
- [x/~/o] @agentweave/outer-harness  [N files / N tests]
- [x/~/o] @agentweave/sdk            [N files / N tests]
- [x/~/o] @agentweave/cli            [N files / N tests]

Progress: ~[N]% of Phase 1 MVP
```

Use `[x]` for done, `[~]` for in progress, `[ ]` for not started.

## Rules

- **Under 30 lines.** For detailed report use `/pm`.
- **Facts only.** Base everything on files and git history.
- If no commits yet: "No commits yet. Project is in spec/design phase."
- If no packages yet: show checklist as all `[ ]` not started.
