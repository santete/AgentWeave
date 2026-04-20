# AgentWeave CLI — User Guide

AgentWeave wraps any AI coding agent (Claude Code, Cursor, Aider, Codex) with a structured 8-step SDLC pipeline. Your agent still does the coding — AgentWeave makes sure the code is planned, tested, validated, and retried automatically.

---

## Install

### From npm (when published)

```bash
npm install -g agentweave
```

### From local repo (development)

```bash
git clone https://github.com/santete/AgentWeave.git
cd AgentWeave
pnpm install
pnpm turbo run build
cd packages/cli && npm link
```

Verify:

```bash
agentweave --version
# 1.1.0
```

---

## First Run

When you run AgentWeave for the first time without config, it guides you:

```bash
$ agentweave pipeline run "Fix the bug"

  ⚠ First run detected — no agentweave.yaml found.
  Run setup wizard to choose your execution mode:

    agentweave pipeline setup       Guided wizard
    agentweave pipeline status      Check current state

  Or run directly with an agent:

    agentweave pipeline run "your task" --agent claude
    agentweave pipeline run "your task" --agent aider
    agentweave pipeline run "your task" --model claude-haiku-4-5
```

---

## Setup Wizard

```bash
agentweave pipeline setup
```

The wizard walks you through 3 steps:

### Step 1: Choose Execution Mode

```
  [1] Wrap Agent CLI (process-adapter)
      You have a subscription (Claude Pro, Cursor Pro, etc.)
      AgentWeave wraps your agent CLI — no API key needed.
      Best for: developers with existing subscriptions

  [2] Direct LLM API (agent-loop)
      You have an API key (Anthropic, OpenAI, Google, OpenRouter).
      AgentWeave calls LLM directly — full control over model + cost.
      Best for: CI/CD, automation, multi-model routing

  [3] Simple LLM Call (api-direct)
      Single LLM call, no tool execution. Text in, text out.
      Best for: code review, explanation, simple generation
```

### Step 2: Configure Agent or API Key

**Mode 1 (Wrap Agent CLI):**
```
  Which agent CLI do you use?

  [1] Claude Code    (npm i -g @anthropic-ai/claude-code)
  [2] Aider          (pip install aider-chat)
  [3] Codex          (npm i -g @openai/codex)
  [4] Custom CLI

  Auth Setup for claude:
  1. Install: npm install -g @anthropic-ai/claude-code
  2. Login:   claude login
  3. Verify:  claude --version
```

**Mode 2 (Direct LLM API):**
```
  Which LLM provider?

  [1] Anthropic      (Claude — best tool calling)
  [2] OpenAI         (GPT models)
  [3] Google         (Gemini — generous free tier)
  [4] OpenRouter     (any model — has free options)

  Enter ANTHROPIC_API_KEY: ████████
  ✓ API key saved (encrypted)
```

### Step 3: Done

```
  Setup complete!
  Run: agentweave pipeline run "your task" --agent claude
```

---

## Check Status

```bash
agentweave pipeline status
```

Shows everything about your current setup:

```
  AgentWeave Pipeline Status
  ──────────────────────────────────────────────────────
  Version:  1.1.0
  Config:   agentweave.yaml
  Mode:     process-adapter
  ──────────────────────────────────────────────────────
  Agent:    claude --print --output-format text
  Installed: ✓ 2.1.104 (Claude Code)
  Auth:     ✓ logged in
  Method:   claude.ai (subscription — no API key needed)
  Account:  user@example.com
  Org:      My Company
  Plan:     team

  ──────────────────────────────────────────────────────
  Credentials: 2 key(s) stored
    ANTHROPIC_API_KEY            claude    ●●●●●●●●●●xxxx
    OPENROUTER_API_KEY           global    ●●●●●●●●●●xxxx

  ──────────────────────────────────────────────────────
  Metrics:   ON → .agentweave/metrics/
             View: agentweave metrics
```

---

## 3 Execution Modes

### Mode 1: Wrap Agent CLI (`--agent`)

Your AI agent CLI (Claude Code, Cursor, Aider) does the actual coding. AgentWeave wraps it with the 8-step SDLC pipeline.

**Requirements:** Agent CLI installed + logged in. No API key needed.

```bash
# Claude Code (subscription)
agentweave pipeline run "Fix the login bug" --agent claude

# Aider
agentweave pipeline run "Add user avatars" --agent aider

# Codex
agentweave pipeline run "Refactor auth" --agent codex

# Custom script
agentweave pipeline run "Fix bug" --agent "./my-agent.sh"
```

**How auth works:**
- Claude Code → uses your `claude login` session (subscription)
- Aider → needs API key in env or credential store
- Codex → needs OPENAI_API_KEY in env or credential store

### Mode 2: Direct LLM API (`--model`)

AgentWeave calls the LLM API directly. Full control over model choice and cost.

**Requirements:** API key (Anthropic, OpenAI, Google, or OpenRouter).

```bash
# With API key in credential store
agentweave credentials set "*" ANTHROPIC_API_KEY
agentweave pipeline run "Fix the bug" --model claude-haiku-4-5

# Or with env var
export ANTHROPIC_API_KEY=sk-ant-xxx
agentweave pipeline run "Fix the bug" --model claude-haiku-4-5
```

### Mode 3: Simple LLM Call

Single LLM call, no tool execution. Text in, text out. Used internally by the pipeline for meta-tasks (planning, normalization).

---

## Pipeline Commands

### Show Pipeline Config

```bash
agentweave pipeline show
```

Shows all 8 steps with ON/OFF status, agent config, and per-module settings.

### Show Pipeline Status

```bash
agentweave pipeline status
```

Shows mode, agent auth info, credentials, metrics storage.

### List Supported Agents

```bash
agentweave pipeline agents
```

Shows all built-in agent presets with install instructions.

### Run Pipeline

```bash
agentweave pipeline run <prompt> [options]
# or shorthand:
agentweave task <prompt> [options]
```

**Options:**

| Flag | Description | Default |
|------|-------------|---------|
| `--agent <name>` | Agent CLI to wrap (claude, aider, codex, custom) | none |
| `--agent-args <args>` | Extra args (comma-separated) | none |
| `--model <model>` | LLM model for API mode | claude-sonnet-4-6 |
| `--checks <cmds>` | QA commands (comma-separated) | none |
| `--retries <n>` | Max retry attempts | 3 |
| `--metrics-dir <path>` | Metrics storage | .agentweave/metrics |

---

## Pipeline Config

### Initialize Config

```bash
agentweave pipeline config init
```

Creates `agentweave.yaml` — commit this to git for team-shared config.

### Toggle Modules

```bash
# Enable
agentweave pipeline config on qa retry
agentweave pipeline config on all

# Disable
agentweave pipeline config off normalize context plan
agentweave pipeline config off all
```

**Module aliases:**

| Full name | Aliases |
|-----------|---------|
| taskNormalizer | normalize, task |
| contextBuilder | context, ctx |
| planGenerator | plan, planner |
| executionBridge | execute, exec |
| patchValidator | patch, validator |
| qualityGate | qa, quality, test |
| retryEngine | retry |
| outputStandardizer | output, commit |

### Set Config Values

```bash
# Agent
agentweave pipeline config set execution.agent claude

# Model (for API mode)
agentweave pipeline config set execution.model claude-sonnet-4-6

# QA checks
agentweave pipeline config set qa.checks "npm test,eslint src/"

# Retry
agentweave pipeline config set retry.maxRetries 5

# Patch validator
agentweave pipeline config set patch.maxFilesChanged 15
agentweave pipeline config set patch.scopeStrict true

# Context builder
agentweave pipeline config set context.maxFiles 30

# Plan generator
agentweave pipeline config set plan.maxSteps 10
```

### Reset Config

```bash
agentweave pipeline config reset
```

---

## Credentials

### How Credentials Work

```
Admin/Tech Lead (once):
  agentweave credentials set claude ANTHROPIC_API_KEY
  # Enter value: ████████
  # → Encrypted in .agentweave/credentials.json
  # → .agentweave/ auto-added to .gitignore

Developer (every day):
  agentweave pipeline run "Fix bug" --agent claude
  # → Keys auto-injected into agent process
  # → Developer never sees the actual key
```

### Commands

```bash
# Store key (recommended: omit value, prompted securely)
agentweave credentials set claude ANTHROPIC_API_KEY

# Store global key (for all agents)
agentweave credentials set "*" OPENROUTER_API_KEY

# List stored keys (masked)
agentweave credentials list

# Check if keys exist for an agent
agentweave credentials check claude

# Remove a key
agentweave credentials remove claude ANTHROPIC_API_KEY
```

### Security

| Layer | Protection |
|-------|-----------|
| Storage | AES-256-GCM encrypted at rest |
| Key derivation | PBKDF2 from passphrase, or machine-derived |
| File permissions | 0o600 (owner-only on Linux/Mac) |
| Git | `.agentweave/` auto-added to .gitignore |
| Display | Only last 4 chars visible in `list` |
| Injection | Minimal env allowlist to child process |
| Output | Credential values scrubbed from pipeline output |
| Audit | Operations logged to `.agentweave/credential-audit.log` |

For stronger encryption:
```bash
export AGENTWEAVE_CREDENTIAL_KEY="your-strong-passphrase"
agentweave credentials set claude ANTHROPIC_API_KEY
```

---

## Metrics

### View Latest Run

```bash
agentweave metrics
```

### View History

```bash
agentweave metrics --history
```

### 10 Metrics Explained

| ID | What it measures | Good value |
|----|-----------------|------------|
| M1 | Code passed all checks on first attempt? | YES |
| M2 | What % of test checks passed? | 100% |
| M3 | What % of changed files were in the plan? | 100% |
| M4 | How many retries before success? | 0 |
| M5 | Total LLM cost | Low |
| M6 | Total wall clock time | Low |
| M7 | Did any passing test break? | NO |
| M8 | What % of planned steps were needed? | 100% |
| M9 | Context utilization efficiency | High |
| M10 | Lint warnings improvement | Positive |

### Baseline Comparison

Each run saves to `.agentweave/metrics/baseline.json`. Next run compares automatically:

```
  vs. Previous Run
  ──────────────────────────────────────────────────────
  ▲ Test pass rate:   +35.0%
  ▲ Scope accuracy:   +25.0%
  ▲ Retry count:      -2
  ▼ Cost:             +$0.0200
```

---

## Common Workflows

### Solo Developer

```bash
# Quick setup — just QA + retry
agentweave pipeline config init
agentweave pipeline config off all
agentweave pipeline config on exec qa retry
agentweave pipeline config set qa.checks "npm test"

# Run tasks
agentweave pipeline run "Fix the login null pointer" --agent claude
```

### Team — Shared Policy

```bash
# Tech lead sets up once
agentweave pipeline config init
agentweave pipeline config set execution.agent claude
agentweave pipeline config set qa.checks "pnpm typecheck,pnpm test:unit,pnpm lint"
agentweave pipeline config set patch.scopeStrict true
git add agentweave.yaml
git commit -m "chore: add agentweave pipeline config"

# Every developer clones and runs
agentweave pipeline run "Implement user avatar upload" --agent claude
```

### CI/CD

```bash
export AGENTWEAVE_CREDENTIAL_KEY="${{ secrets.AGENTWEAVE_KEY }}"
agentweave credentials set "*" ANTHROPIC_API_KEY "${{ secrets.ANTHROPIC_KEY }}"
agentweave pipeline run "$TASK" --agent claude --checks "npm test" --retries 2

if [ $? -ne 0 ]; then
  agentweave metrics
  exit 1
fi
```

### Benchmark — Compare Agents

```bash
npx tsx benchmarks/run-benchmark.ts --agent claude
npx tsx benchmarks/run-benchmark.ts --mock    # demo without API key
```

---

## Troubleshooting

### "First run detected"

Run the setup wizard:
```bash
agentweave pipeline setup
```

Or specify an agent directly:
```bash
agentweave pipeline run "task" --agent claude
```

### "ENOENT: spawn claude"

Agent CLI not installed or not in PATH:
```bash
npm install -g @anthropic-ai/claude-code
claude --version
```

### "not logged in"

```bash
claude login    # for Claude Code
```

Check auth status:
```bash
agentweave pipeline status
```

### "ANTHROPIC_API_KEY not found"

For process-adapter mode (wrap CLI), you usually don't need an API key — the agent uses its own auth (subscription). For agent-loop mode:

```bash
agentweave credentials set "*" ANTHROPIC_API_KEY
```

### "Quality gate failed"

Check which check failed, then either fix the code or make the check optional:
```bash
# Edit agentweave.yaml → change "required": true to false
```

### Pipeline too slow

Disable unnecessary steps:
```bash
agentweave pipeline config off normalize context plan
```

---

## File Reference

| File | Purpose | Git? |
|------|---------|------|
| `agentweave.yaml` | Pipeline config (team-shared) | **Commit** |
| `.agentweave/credentials.json` | Encrypted API keys | **Never commit** |
| `.agentweave/credential-audit.log` | Credential access log | **Never commit** |
| `.agentweave/metrics/baseline.json` | Latest run metrics | Optional |

`.agentweave/` is auto-added to `.gitignore` on first use.
