# Contributing to AgentWeave

## Branch Strategy (Git Flow)

```
main ─────────●─────────────────●──────────── production releases
              │                 ↑
              │           release/v0.2.0
              │                 ↑
develop ──────●────●────●───────●──────────── integration
                   │    ↑       ↑
                   │  feature/ hotfix/
                   │    ↑
              feature/inner-harness
```

### Branch Types

| Branch | From | Merges To | Naming | Purpose |
|---|---|---|---|---|
| `main` | — | — | `main` | Production releases. Only release + hotfix merge here. Tagged. |
| `develop` | `main` | — | `develop` | Integration branch. All features merge here first. |
| `feature/*` | `develop` | `develop` | `feature/<scope>-<description>` | New features, improvements |
| `release/*` | `develop` | `main` + `develop` | `release/v<semver>` | Release preparation, final fixes |
| `hotfix/*` | `main` | `main` + `develop` | `hotfix/<description>` | Critical production fixes |

### Branch Naming Convention

```
feature/types-discriminated-unions
feature/inner-harness-agent-loop
feature/outer-permission-engine
feature/sdk-create-harness
feature/cli-run-command
release/v0.1.0
release/v0.2.0
hotfix/fix-cost-delta-tracking
```

**Rules:**
- Lowercase, kebab-case
- Prefix with type (`feature/`, `release/`, `hotfix/`)
- Include package scope when relevant (`feature/inner-xxx`, `feature/outer-xxx`)
- Keep under 50 chars

## Commit Convention

Follow [Conventional Commits](https://www.conventionalcommits.org/):

```
<type>(<scope>): <description>

[optional body]

[optional footer]
```

### Types

| Type | Description |
|---|---|
| `feat` | New feature |
| `fix` | Bug fix |
| `refactor` | Code change that neither fixes a bug nor adds a feature |
| `test` | Adding or updating tests |
| `docs` | Documentation only changes |
| `build` | Build system or external dependencies |
| `ci` | CI/CD configuration |
| `chore` | Other changes that don't modify src or test |
| `perf` | Performance improvement |

### Scopes

| Scope | Package |
|---|---|
| `types` | @agentweave/types |
| `control-plane` | @agentweave/control-plane |
| `inner` | @agentweave/inner-harness |
| `outer` | @agentweave/outer-harness |
| `sdk` | @agentweave/sdk |
| `cli` | @agentweave/cli |
| `repo` | Monorepo config, CI, docs |

### Examples

```
feat(inner): add AgentLoop with AsyncGenerator pattern
fix(outer): fix cost delta tracking in BudgetManager
test(control-plane): add InterceptorRegistry timeout test
docs(repo): add CONTRIBUTING.md with git flow
build(repo): setup monorepo with pnpm + turborepo
refactor(types): use discriminated unions for HookDefinition
```

## Versioning

We use [Semantic Versioning](https://semver.org/):

```
v<MAJOR>.<MINOR>.<PATCH>[-<pre-release>]

MAJOR  Breaking changes to public API (createHarness, SDK types)
MINOR  New features, backward-compatible
PATCH  Bug fixes, backward-compatible
```

### Pre-release Tags

| Tag | Meaning | Example |
|---|---|---|
| `-alpha.N` | In development, unstable | `v0.1.0-alpha.1` |
| `-beta.N` | Feature-complete, testing | `v0.1.0-beta.1` |
| `-rc.N` | Release candidate | `v0.1.0-rc.1` |
| (none) | Stable release | `v0.1.0` |

### Phase-to-Version Mapping

| Phase | Version | Milestone |
|---|---|---|
| Phase 1: Core MVP | `v0.1.0` | Agent loop + governance + SDK + CLI |
| Phase 2: Observability | `v0.2.0` | Traces, alerts, dashboard |
| Phase 3: Advanced Control | `v0.3.0` | Hooks, streaming, AWOCP |
| Phase 4: Multi-Agent | `v0.4.0` | Orchestration, coordinator |
| Phase 5: Enterprise | `v0.5.0` | RBAC, SSO, plugins |
| Phase 6: Ecosystem | `v1.0.0` | Stable public API |

## Pull Request Process

1. Create feature branch from `develop`
2. Implement changes with tests
3. Ensure `pnpm turbo run build` passes
4. Ensure `pnpm turbo run test:unit` passes
5. Create PR to `develop` using the PR template
6. Request review
7. Address review feedback
8. Squash merge to `develop`

### PR Size Guidelines

| Size | Files Changed | Recommendation |
|---|---|---|
| **S** | 1-5 | Single review pass |
| **M** | 6-15 | Standard review |
| **L** | 16-30 | Break into smaller PRs if possible |
| **XL** | 30+ | Must be justified (initial setup, large refactor) |

## Release Process

1. Create `release/vX.Y.Z` from `develop`
2. Update version in all `package.json` files
3. Update `CHANGELOG.md`
4. Final testing on release branch
5. Merge to `main` via PR
6. Tag `main` with `vX.Y.Z`
7. Merge back to `develop`
8. Create GitHub Release with release notes

## Code Review Checklist

- [ ] TypeScript strict compliance (no `any`)
- [ ] Tests exist for new functionality
- [ ] Dependency graph respected (types <- control-plane <- inner/outer <- sdk <- cli)
- [ ] Zod validation at external boundaries
- [ ] No secrets in logs or error messages
- [ ] Performance budget met (see `product-spec/performance_budget.md`)
- [ ] Documentation updated if public API changed
