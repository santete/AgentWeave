# AgentWeave

## Governance + QA Layer for AI Coding Agents

> Claude Code, Cursor, and Aider write code.
> AgentWeave enforces policy, measures SDLC quality, and audits every tool call — without replacing the agent you already use.

> **Canonical positioning:** [`POSITIONING.md`](./POSITIONING.md). This document is marketing-facing prose; if anything conflicts, POSITIONING.md wins.

---

## The Problem: AI Agents Are Powerful — and Uncontrolled

AI coding agents like Claude Code, Codex, Cursor, and Aider are transforming software engineering. They write code, fix bugs, run tests, and ship features — often faster than humans.

But there's a critical gap:

**Nobody controls what happens between the prompt and the output.**

| What you want | What actually happens |
|---|---|
| Agent fixes a bug | Agent runs `rm -rf` on your test directory |
| Agent writes clean code | Agent leaks your API key in the output |
| Agent stays under budget | Agent burns $47 in a single session |
| Agent follows team standards | Every developer has different agent configs |
| You know what agent did | You get a wall of text with no audit trail |
| Agent stops when it should | Agent loops 200 times rewriting the same file |

The AI model is not the problem. **The lack of governance around it** is.

---

## What Is AgentWeave?

AgentWeave is an **open-source governance + QA layer** that wraps around AI coding agents you already use — Claude Code, Cursor, Aider, or any MCP-compatible agent — and adds three things those agents don't provide:

1. **Governance** — permission rules, budget caps, audit trail, hooks.
2. **QA Pipeline** — deterministic SDLC stages around the agent, with M1–M10 metrics measured across runs.
3. **Adapters + MCP** — distribution channels so the same governance works against any agent.

### What AgentWeave is NOT

We do not rebuild the agent loop. Claude Code and Cursor ship excellent agent loops, tool-calling runtimes, and streaming UX. Competing with them there burns engineering hours for commodity parity. AgentWeave sits **around** those agents, not in their place.

```
Before AgentWeave:

  User --> [Claude Code / Cursor / ...] --> Output
           (black box, no governance)

After AgentWeave:

  User --> [AgentWeave governance] --> [Agent] --> [AgentWeave audit + QA] --> Output
           (permissions, budget,     (unchanged,   (metrics, validation,
            input validation)         wrapped via   audit trail)
                                      hooks/MCP)
```

You don't modify the agent. You **wrap** it — via Claude Code hooks, the MCP server, or the SDLC pipeline adapter. AgentWeave intercepts every tool call and measures every run, leaving the agent's execution to the vendor best-equipped to build it.

---

## Core Capabilities

### 1. Output Control Pipeline

**The killer feature.** Every piece of output from your AI agent passes through a 6-stage pipeline before reaching anyone:

```
Agent Output
  |
  [Intercept]    Capture raw output
  [Validate]     Check safety, quality, schema compliance
  [Filter]       Remove secrets, PII, sensitive paths
  [Transform]    Format, add disclaimers, enforce style
  [Review]       Human-in-the-loop gate (optional)
  [Deliver]      Route to terminal, IDE, Slack, webhook
  |
  User
```

**What this means:**
- API keys in agent output? **Auto-redacted** before you see them.
- Agent generates harmful code? **Caught and rejected** with a retry prompt.
- Output too long or unstructured? **Auto-summarized** or reformatted.
- Need compliance review? **Hold output** until a human approves.

**Real-time streaming control:** Two modes — **Streaming Mode** runs stateless filters (secrets, PII, regex) per-buffer during streaming with a sliding context window, so sensitive data never reaches your screen. **Batch Mode** runs the full 6-stage pipeline (including validation, review, and LLM-based transforms) on complete output. Mode is auto-selected based on your config, or set explicitly.

---

### 2. Permission Engine

Granular, layered control over what tools your agent can use:

```yaml
permissions:
  rules:
    - pattern: "Bash(git *)"        # Allow all git commands
      behavior: allow

    - pattern: "Bash(rm -rf *)"     # Block destructive commands
      behavior: deny

    - pattern: "FileWrite(*.env)"   # Block writing to env files
      behavior: deny

    - pattern: "FileEdit(src/security/*)"  # Always ask for security files
      behavior: ask
```

**6 evaluation layers** (highest priority wins):

```
Policy rules      (enterprise-managed, immutable)
  |
Project rules     (team-managed, committed to repo)
  |
User rules        (personal preferences)
  |
Role-based rules  (developer vs reviewer vs admin)
  |
Contextual rules  (branch=main? cost>$5? after-hours?)
  |
ML classifier     (auto-assess risk score)
```

A junior developer gets `ask` mode. A senior gets `allow`. A CI bot gets `read-only`. Same agent, different governance — zero code changes.

---

### 3. Hook Engine

Automate anything at any point in the agent lifecycle:

| Hook Event | Example Use Case |
|---|---|
| **PreToolUse** | Validate bash commands before execution |
| **PostToolUse** | Auto-lint files after agent writes them |
| **OutputReady** | Quality-score every response |
| **SessionEnd** | Run full test suite when agent finishes |
| **BudgetWarning** | Notify Slack when cost hits 80% |
| **ToolFailure** | Alert PagerDuty on repeated errors |

**5 hook types** to fit any workflow:

- **Command hooks** — Run shell scripts (`npm test`, `eslint --fix`)
- **Prompt hooks** — Ask a lightweight LLM to evaluate ("Is this safe?")
- **Agent hooks** — Spawn a full agent to verify changes (run tests, review code)
- **HTTP hooks** — Call any webhook or API
- **Function hooks** — Run custom TypeScript logic inline (zero-overhead, in-process)

```yaml
hooks:
  PostToolUse:
    - matcher: "FileWrite(*.ts)"
      type: command
      command: "npx eslint --fix $FILE_PATH"
      async: true

  SessionEnd:
    - type: command
      command: "npm test"
      timeout: 60000
```

Your agent writes TypeScript? ESLint runs automatically. Every time. No exceptions.

---

### 4. Real-Time Monitoring & Observability

Know exactly what your agent is doing, in real time:

**Live Metrics:**
- Token usage (input, output, thinking, cache)
- Cost tracking (per-turn, per-tool, per-session, per-day)
- Latency (time-to-first-token, tool execution, total)
- Tool call frequency and success rates
- Context window utilization
- Error rates and recovery attempts

**Full Session Traces:**
Every decision, every tool call, every permission check — recorded and replayable.

```
Turn 3:
  LLM called: claude-sonnet-4-6 (1,200 input / 450 output tokens, $0.008)
  Tool requested: Bash("npm test")
  Permission: ALLOWED (rule: project/allow/Bash(npm *))
  Hook (PreToolUse): PASS (shellcheck: no issues)
  Tool executed: 4.2s, exit code 0
  Hook (PostToolUse): PASS
```

**Alerts:**
- Budget exceeded? Agent pauses automatically.
- Error rate above 50%? Slack notification.
- Agent running for 10+ minutes? Dashboard warning.
- Unusual cost spike? Anomaly alert.

---

### 5. Multi-Model, Multi-Provider

AgentWeave's Inner Harness supports any LLM through the Vercel AI SDK:

| Provider | Models | Status |
|---|---|---|
| **Anthropic** | Claude Opus, Sonnet, Haiku (4.x) | Full support |
| **OpenAI** | GPT-4o, GPT-4-turbo, o1/o3 | Full support |
| **Google** | Gemini 2.5 Pro/Flash | Full support |
| **AWS Bedrock** | Claude, Titan, Llama | Full support |
| **Google Vertex** | Claude, Gemini | Full support |
| **Azure** | OpenAI models, Claude (Foundry) | Full support |
| **Ollama / Local** | Llama, Mistral, Qwen, DeepSeek | Full support |

Switch models mid-session. Use Opus for complex reasoning, Haiku for simple tasks, local models for privacy-sensitive work — all governed by the same rules.

---

### 6. Multi-Agent Orchestration

Run multiple agents in parallel with centralized governance:

```
Coordinator Agent (Opus)
  |
  +-- Worker 1: "Research auth patterns"    [Haiku, read-only, $2 budget]
  +-- Worker 2: "Research database schema"  [Haiku, read-only, $2 budget]
  |
  (wait for results)
  |
  +-- Worker 3: "Implement auth module"     [Sonnet, full access, $8 budget]
  +-- Worker 4: "Write tests"              [Sonnet, write access, $5 budget]
  |
  (verify all changes)
  |
  Result: Complete feature with tests
```

**Per-agent governance:**
- Different model per agent (expensive for reasoning, cheap for grunt work)
- Different permission rules per agent (researcher = read-only, implementer = full)
- Individual budgets (total = sum of all agents)
- Shared audit trail

---

### 7. Session Management

Every session is persisted, replayable, and forkable:

- **Save & Resume:** Agent crashed? Network dropped? Resume from exactly where you left off.
- **Fork & Compare:** Try two approaches from the same point. Compare cost, quality, and tool usage.
- **Replay:** Step through any historical session turn-by-turn. See every decision the agent (and AgentWeave) made.
- **Export:** Generate Markdown reports, JSON data, or HTML summaries of any session.

---

### 8. Configuration Hierarchy

One framework, multiple levels of control:

```
Level 1: Defaults           Built-in sensible defaults (works out of the box)
Level 2: User config        ~/.agentweave/config.yaml (personal preferences)
Level 3: Project config     .agentweave/config.yaml (team standards, committed to repo)
Level 4: Local overrides    .agentweave/config.local.yaml (machine-specific, gitignored)
Level 5: CLI flags          --model, --budget, --permissions (per-session)
Level 6: Environment vars   AGENTWEAVE_MODEL, AGENTWEAVE_BUDGET
Level 7: Policy rules       Enterprise-managed (immutable, cannot be overridden)
```

A developer can customize their experience. A team lead can enforce standards. An enterprise admin can set hard limits. Nobody steps on anyone's toes.

---

## Technology

### Architecture: 3 Pillars

AgentWeave is structured around **three independent pillars**. Each works standalone; combine any subset.

```
┌───────────────────────────────────────────────────────────┐
│  Pillar 1: GOVERNANCE   (Outer Harness)                   │
│    Permission · Budget · Hooks · Input Gate · Audit       │
└───────────────────────────────────────────────────────────┘
┌───────────────────────────────────────────────────────────┐
│  Pillar 2: QA PIPELINE   (SDLC Orchestrator)              │
│    Norm → Ctx → Plan → Exec → Patch → QA → Retry → Out    │
│    M1–M10 metrics · Exec delegates to agent via adapter   │
└───────────────────────────────────────────────────────────┘
┌───────────────────────────────────────────────────────────┐
│  Pillar 3: ADAPTERS + MCP   (Distribution)                │
│    Claude Code hooks · MCP server · Cursor · Aider · …    │
└───────────────────────────────────────────────────────────┘
```

**Why this matters:**
- Use **governance alone** — raw Claude Code + `.claude/hooks/` + `agentweave guard`. Zero pipeline overhead, full policy enforcement.
- Use **QA pipeline alone** — wraps any agent, adds measurable SDLC metrics without touching governance.
- Combine both — governance policy enforced *inside* each pipeline run.
- Agent vendor choice stays with the user. Swap Claude Code → Cursor → Aider; governance + pipeline stay the same.

### Legacy note: Inner Harness as reference implementation

The repo contains an inner-harness agent-loop implementation (`packages/inner-harness/src/agent-loop.ts`, built-in tools) from an earlier design. **It is no longer the production execution path** — execution delegates to external agents via adapters. The inner-harness code is retained as:

- **Reference implementation** for teaching + offline/local use cases.
- **Test infrastructure** for governance unit tests (mock LLM, deterministic tool execution).

Do not build new features against the internal agent loop. New execution work goes into adapters (`packages/adapters/`) or the SDLC pipeline (`packages/inner-harness/src/sdlc/`).

### Built on Modern Standards

| Component | Technology | Why |
|---|---|---|
| Language | TypeScript (strict) | Type-safe contracts between all layers |
| LLM Integration | Vercel AI SDK | Multi-provider, streaming-native, tool-calling built-in |
| Validation | Zod | Schema = types = validation = LLM tool schemas |
| Observability | OpenTelemetry | Vendor-neutral metrics, traces, logs |
| Protocol | AWOCP (WebSocket + gRPC) | Real-time bidirectional, high-performance |
| Configuration | YAML + cosmiconfig | Human-readable, multi-source hierarchy |
| Storage | JSONL (transcripts) | Append-only, streamable, grep-friendly |

---

## Competitive Advantages

### Why AgentWeave vs Building Your Own

| Capability | DIY | AgentWeave |
|---|---|---|
| Basic permission rules | 2-3 weeks to build | 5 minutes to configure |
| Output filtering (PII, secrets) | 1-2 weeks + ongoing regex maintenance | Built-in, battle-tested patterns |
| Real-time cost tracking | 1 week + per-provider logic | Automatic, multi-provider |
| Session persistence & replay | 2+ weeks | Built-in |
| Multi-agent budget governance | 3+ weeks | Declarative YAML config |
| Audit trail | 1-2 weeks | Built-in, tamper-evident |
| Hook system | 2-3 weeks | 5 hook types, 18+ events, ready to use |

**Estimated savings: 3-6 months of engineering time** to reach feature parity.

### Why AgentWeave vs Competitors

| Feature | AgentWeave | Guardrails AI | LangSmith | Custom Wrappers |
|---|---|---|---|---|
| Output control (6-stage pipeline) | Full | Partial (validate only) | No (observe only) | Manual |
| Tool-level permission engine | 6 layers, contextual | No | No | Basic |
| Hook automation (5 types) | Full | No | No | Manual |
| Multi-agent governance | Per-agent budgets, rules | No | Trace only | Manual |
| Real-time streaming control | Per-buffer filter + post-stream validate | No | No | No |
| Session fork & compare | Built-in | No | No | No |
| Inner Harness swappable | Any LLM, any agent | Tied to framework | Tied to LangChain | Tied to implementation |
| Enterprise policy hierarchy | 7 levels, immutable policies | No | No | No |
| Deployment: local to cloud | Single binary to K8s cluster | SaaS only | SaaS only | Custom |
| Open source | Yes | Partial | No | N/A |

---

## Benefits by Role

### For Developers

**Your agent, your rules — but with a safety net.**

- **Never leak secrets again.** Output filters catch API keys, tokens, and credentials before they reach your terminal — even in streaming mode.
- **Cost visibility.** See exactly how much each session costs, in real-time. Set budgets so you never get a surprise bill.
- **Resume anywhere.** Network dropped? Laptop crashed? Resume your agent session from exactly where it stopped.
- **Zero config to start.** `npx agentweave run "Fix the bug"` works out of the box with sensible defaults.

### For Team Leads

**Enforce standards without micromanaging.**

- **Shared rules.** Define permission and output rules once in `.agentweave/config.yaml`, commit to repo. Every developer on the team gets the same governance.
- **Automatic quality gates.** Agent writes TypeScript? ESLint runs automatically via hooks. Every time. No "I forgot to lint."
- **Team dashboard.** See who's using what, how much it costs, and what agents are doing — without reading individual transcripts.
- **Code review for agents.** Output validation catches low-quality or unsafe code before it enters the codebase.

### For Security Engineers

**AI agents follow your security policy — guaranteed.**

- **Immutable deny rules.** `Bash(rm -rf *)`, `FileWrite(*.env)`, `Bash(sudo *)` — blocked at the framework level, not the prompt level. No jailbreak bypasses this.
- **PII/secret redaction.** Built-in patterns for AWS keys, GitHub tokens, SSH keys, credit cards, SSNs, emails, phone numbers. Custom patterns via regex.
- **Full audit trail.** Every tool call, every permission decision, every output — logged with timestamps, user IDs, and decision sources. Tamper-evident chain.
- **Compliance-ready.** Export audit logs for SOC2, HIPAA, GDPR reviews. Retention policies configurable per data type.

### For Platform Engineers

**Govern 100+ agents from a single control plane.**

- **Centralized Gateway.** One Gateway Node serves all developers. Shared permission rules, shared budgets, shared monitoring.
- **Infrastructure as code.** All governance config is YAML — version-controlled, reviewed, deployed via CI/CD.
- **Scaling built-in.** Gateway scales horizontally (K8s replicas). Observability stack is standard (Prometheus + Grafana + Loki).
- **Progressive deployment.** Start local (zero infra), add Gateway when team grows, add enterprise features when org requires compliance. No rearchitecture needed.

### For Enterprise / CTO

**AI adoption without AI risk.**

- **Policy enforcement.** Enterprise policies are immutable — developers cannot override them. Period.
- **Cost control.** Per-user, per-team, per-project budgets. Daily and monthly caps. Automatic pause when exceeded.
- **Vendor flexibility.** Not locked into one LLM provider. Switch between Anthropic, OpenAI, Google, Azure, or local models — governance stays the same.
- **Risk reduction.** Output validation, permission gates, and audit trails reduce the risk of AI-generated code introducing vulnerabilities or leaking data.
- **ROI visibility.** Dashboard shows: how many hours saved, how many bugs caught, how much spent — per team, per project, per quarter.

---

## Use Cases

### Use Case 1: Solo Developer — Cost Control

**Before AgentWeave:**
> "I asked Claude to refactor my auth module. It ran for 45 minutes, used 500K tokens, and cost me $12. The result was worse than what I started with."

**After AgentWeave:**
```yaml
budget:
  maxPerSession: 3.00
  warningThreshold: 0.8
```
Agent pauses at $2.40 with a warning. You review progress, decide to continue or stop. Total cost: $2.80.

---

### Use Case 2: Team — Preventing Accidents

**Before AgentWeave:**
> "A junior developer's agent ran `rm -rf tests/` because the model hallucinated a cleanup step. We lost 3 hours of work."

**After AgentWeave:**
```yaml
permissions:
  rules:
    - pattern: "Bash(rm -rf *)"
      behavior: deny
      message: "Destructive deletion is not allowed. Remove files individually."
```
Agent gets denied instantly. Adjusts strategy. Uses safe single-file removal. Junior developer never sees the dangerous command.

---

### Use Case 3: Security — Secret Protection

**Before AgentWeave:**
> "The agent included our production database credentials in its response when explaining the connection setup."

**After AgentWeave:**
```yaml
output:
  pipeline:
    filter:
      enabled: true
      filters:
        - name: secrets
          type: secret
          patterns:
            - "postgres://[^\\s]+"
            - "mongodb\\+srv://[^\\s]+"
            - "sk-[a-zA-Z0-9]{48}"
          replacement: "[CREDENTIAL_REDACTED]"
```
Credentials are auto-redacted in real-time streaming. The developer sees `[CREDENTIAL_REDACTED]` — the actual value never reaches the terminal.

---

### Use Case 4: Enterprise — Compliance

**Before AgentWeave:**
> "We have 200 developers using AI agents. We have no idea what they're doing, how much it costs, or whether they're following our security policies."

**After AgentWeave:**
- Gateway Node: centralized governance for all 200 developers
- Immutable policy rules: enterprise security team manages, developers cannot override
- Audit DB: every decision logged, exported monthly for compliance review
- Dashboard: real-time view of all active sessions, costs, alerts
- Budget: $50/developer/month cap, automatic pause on exceed

---

### Use Case 5: CI/CD — Automated Code Review

**Before AgentWeave:**
> "We want AI to review every PR, but we can't trust it to run arbitrary commands in our CI pipeline."

**After AgentWeave:**
```yaml
# .github/workflows/agent-review.yaml
- uses: agentweave/action@v1
  with:
    prompt: "Review this PR for bugs, security issues, and code quality"
    config: |
      inner:
        model: claude-haiku-4-5
        tools: [file-read, grep, glob]    # Read-only tools ONLY
      permissions:
        mode: plan                         # Read-only mode
        rules:
          - { pattern: "Bash(*)", behavior: deny }
          - { pattern: "FileWrite(*)", behavior: deny }
      budget:
        maxPerSession: 1.00               # $1 max per review
```
Agent can read code and search, but cannot modify anything or run commands. Cost capped at $1 per PR. Safe for CI.

---

### Use Case 6: Multi-Agent — Complex Feature

**Before AgentWeave:**
> "I tried running 5 agents in parallel. Two of them edited the same file and corrupted it. One of them ran for 20 minutes doing nothing useful. Total cost: $35."

**After AgentWeave:**
```yaml
multi_agent:
  maxConcurrentAgents: 5
  totalBudgetUsd: 15.00
  types:
    research:
      model: claude-haiku-4-5
      tools: [file-read, grep, glob]
      budgetUsd: 2.00
    implementation:
      model: claude-sonnet-4-6
      tools: [file-read, file-write, file-edit, bash, grep, glob]
      budgetUsd: 8.00
```
Research agents are cheap and read-only. Implementation agent has full access but capped budget. File conflicts prevented by sequential scheduling. Total cost: $11. Feature complete.

---

## Getting Started

### 30 Seconds: Install and Run

```bash
npm install -g @agentweave/cli

agentweave run "Fix the login bug in src/auth.ts"
```

That's it. Sensible defaults applied. Secret filtering on. Cost tracking active.

### 5 Minutes: Add Team Rules

```bash
# In your project root
mkdir .agentweave
cat > .agentweave/config.yaml << 'EOF'
inner:
  model: claude-sonnet-4-6

permissions:
  rules:
    - { pattern: "Bash(git *)", behavior: allow }
    - { pattern: "Bash(npm *)", behavior: allow }
    - { pattern: "Bash(rm -rf *)", behavior: deny }
    - { pattern: "FileWrite(*.env)", behavior: deny }

output:
  pipeline:
    filter:
      enabled: true
      filters:
        - { name: secrets, type: secret, patterns: ["sk-.*", "AKIA.*", "ghp_.*"] }

budget:
  maxPerSession: 5.00
EOF

# Commit to repo — every team member gets same rules
git add .agentweave/config.yaml
git commit -m "Add AgentWeave governance config"
```

### 30 Minutes: Deploy Team Gateway

```bash
# Docker one-liner
docker run -d \
  -p 9100:9100 \
  -p 8080:8080 \
  -v ./team-config:/config \
  agentweave/gateway:latest

# Developer connects automatically
# (add to .agentweave/config.yaml)
# gateway: "wss://gateway.team.internal:9100"
```

---

## Programmatic SDK

### TypeScript

```typescript
import { createHarness } from '@agentweave/sdk'

const harness = createHarness({
  inner: { model: 'claude-sonnet-4-6' },
  permissions: {
    rules: [
      { pattern: 'Bash(git *)', behavior: 'allow' },
      { pattern: 'Bash(rm *)', behavior: 'deny' },
    ],
  },
  budget: { maxPerSession: 5.0 },
})

// Stream with full control
for await (const event of harness.stream('Fix the login bug')) {
  if (event.type === 'llm:stream_delta') process.stdout.write(event.delta)
  if (event.type === 'tool:requested') console.log(`Tool: ${event.toolName}`)
}

// Or one-liner
const result = await harness.run('Fix the login bug')
```

### Custom Output Interceptor

```typescript
harness.output.intercept('validate', async (output) => {
  if (output.text.includes('DROP TABLE')) {
    return { action: 'reject', reason: 'SQL injection in output' }
  }
  return { action: 'pass' }
})

harness.output.intercept('filter', async (output) => ({
  ...output,
  text: output.text.replace(/\b\d{3}-\d{2}-\d{4}\b/g, '[SSN_REDACTED]'),
}))
```

### Custom Hooks

```typescript
harness.hooks.on('PreToolUse', { matcher: 'Bash' }, async (event) => {
  if (event.toolInput.command.includes('sudo')) {
    return { decision: 'deny', reason: 'sudo not allowed' }
  }
  return { decision: 'pass' }
})

harness.hooks.on('SessionEnd', async (event) => {
  await fetch('https://slack.webhook.com/agent-done', {
    method: 'POST',
    body: JSON.stringify({
      text: `Agent session complete. Cost: $${event.usage.totalCost}`,
    }),
  })
})
```

---

## Deployment Options

| Deployment | Infrastructure | Best For | Setup Time |
|---|---|---|---|
| **Local** | None (single binary) | Solo developer | 30 seconds |
| **Team** | 1 Docker container (Gateway) | 5-50 developers | 30 minutes |
| **Enterprise** | K8s cluster (Gateway + Observability + Config) | 50-1000+ developers | 1-2 days |
| **CI/CD** | GitHub Action / GitLab CI step | Automated pipelines | 5 minutes |
| **Air-gapped** | Local + local LLM (Ollama) | Classified environments | 1 hour |

**Progressive upgrade:** Start local, add Gateway when you need shared rules, add enterprise features when compliance requires it. **No rearchitecture, no code changes** — just add infrastructure and config.

---

## Open Source & Extensible

AgentWeave is open source (MIT license) and designed for extensibility:

- **Custom tools:** Register any tool with a Zod schema
- **Custom hooks:** Write TypeScript functions, shell scripts, or HTTP integrations
- **Custom output filters:** Regex patterns, functions, or external services
- **Custom LLM providers:** Any provider supported by Vercel AI SDK + custom adapters
- **Custom permission layers:** Database-backed rules, ML classifiers, external policy engines
- **Plugin system:** Bundle tools + hooks + config as installable packages

---

## Pricing

| Tier | Price | Includes |
|---|---|---|
| **Community** | Free, open source | Full CLI, all core features, local deployment |
| **Team** | $15/developer/month | Gateway Node, web dashboard, shared config, team analytics |
| **Enterprise** | Custom pricing | SSO/SAML, immutable policies, audit DB, SLA, dedicated support |

*AgentWeave never touches your code or LLM data. All processing runs in YOUR infrastructure. We never see your prompts, outputs, or API keys.*

---

## FAQ

**Does AgentWeave slow down my agent?**
In passthrough mode: <1ms overhead (in-process function calls). With full governance (permission + output pipeline): 10-50ms per tool call. Monitoring is always non-blocking.

**Does it work with my existing agent?**
If it's a CLI agent (Claude Code, Codex, Aider): wrap it with `agentweave wrap -- <command>`. If you're building custom: use the SDK to build a governed agent from scratch with full control.

**Can agents bypass AgentWeave?**
No. AgentWeave intercepts at the harness level, not the prompt level. The agent's LLM doesn't know AgentWeave exists — it just sees permission denied results and output transformations as part of the normal conversation flow.

**Does it support non-coding agents?**
Yes. While optimized for coding agents, the framework is agent-type agnostic. Permission rules, output filters, hooks, and monitoring work with any tool-calling agent.

**Can I use it with local/private LLMs?**
Yes. Via Ollama integration (Vercel AI SDK supports Ollama natively). All data stays on your machine. Zero external API calls.

**What if AgentWeave crashes?**
Configurable: fail-open (agent continues with no governance — for dev) or fail-closed (agent stops — for enterprise). Session state is persisted to disk, so you can resume after restart.

---

## Summary

| What | AgentWeave |
|---|---|
| **Category** | Governance + QA layer for AI coding agents |
| **Core function** | Enforce policy, measure SDLC quality, audit tool calls — around Claude Code, Cursor, Aider, or any MCP agent |
| **Architecture** | 3 independent pillars — Governance · QA Pipeline · Adapters + MCP |
| **Key differentiator** | M1–M10 SDLC metrics measured across runs (first-pass success, retry count, quality delta) — data Claude Code does not expose |
| **Distribution** | Claude Code hooks (`.claude/hooks/`), MCP server, per-agent adapters |
| **What we do NOT build** | Agent loops, tool-calling runtimes, model routing — those belong to the agent vendor |
| **Deployment** | Local binary to K8s cluster, progressive upgrade |
| **Config** | YAML, 7-level hierarchy (defaults to enterprise policy) |
| **Integrations** | Slack, GitHub Actions, Grafana, Prometheus, PagerDuty, any webhook |
| **License** | Open source (MIT) |
| **Languages** | TypeScript SDK (Python planned) |
| **Platforms** | macOS, Linux, Windows, Docker, Kubernetes |

---

**Your AI coding agents already write code well.**
**AgentWeave enforces the policy, measures the quality, and keeps the audit trail — so you can trust what they ship.**

```
npm install -g @agentweave/cli
agentweave pipeline run "Fix the login bug"      # QA pipeline around your agent
agentweave guard pre-tool-use                   # or: wire .claude/hooks for governance only
```
