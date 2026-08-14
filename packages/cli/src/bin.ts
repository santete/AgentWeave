#!/usr/bin/env node

/**
 * AgentWeave CLI entry point.
 *
 * AgentWeave is the Governance + QA layer for AI coding agents. Canonical
 * positioning: product-spec/POSITIONING.md. Commands below group by pillar.
 *
 * Pillar 1 — Governance:  guard, credentials, audit
 * Pillar 2 — QA Pipeline: pipeline, task, metrics
 * Pillar 3 — Adapters + MCP: mcp
 * Reference (demoted):    run, monitor, session   // agent-loop, not production
 */

import { AGENTWEAVE_VERSION } from "@agentweave/types";
import { runCommand } from "./commands/run.js";
import { chatCommand } from "./commands/chat.js";
import { monitorCommand, monitorExportCommand, monitorServeCommand } from "./commands/monitor.js";
import { sessionCommand } from "./commands/session.js";
import { taskCommand } from "./commands/task.js";
import { metricsCommand } from "./commands/metrics.js";
import { pipelineRunCommand, pipelineShowCommand, pipelineAgentsCommand } from "./commands/pipeline.js";
import { pipelineSetupCommand } from "./commands/pipeline-setup.js";
import { pipelineStatusCommand } from "./commands/pipeline-status.js";
import { pipelineConfigCommand } from "./commands/pipeline-config.js";
import { credentialsCommand } from "./commands/credentials.js";
import { mcpStartCommand, mcpPrintCommand } from "./commands/mcp.js";
import { runGuard, type GuardPhase } from "./commands/guard.js";
import { auditReplayCommand, auditViewCommand } from "./commands/audit.js";
import { policyShowCommand, policyLintCommand } from "./commands/policy.js";
import type { PolicyLevel, PolicyPaths } from "@agentweave/outer-harness";

const args = process.argv.slice(2);

function printHelp(): void {
	console.log(`
  AgentWeave CLI v${AGENTWEAVE_VERSION}
  Governance + QA layer for AI coding agents — enforce policy on Claude Code,
  Cursor, and any MCP-compatible agent, with measurable SDLC metrics.

  ═══ PILLAR 1 — GOVERNANCE ══════════════════════════════════════════════════
  Permission · Budget · Hooks · Input Gate · Audit — enforced on every agent
  tool call via Claude Code hooks or the MCP surface.

  GUARD (backend for .claude/hooks — reads stdin JSON, writes decision):
    agentweave guard pre-tool-use   PreToolUse hook (fail-closed)
    agentweave guard post-tool-use  PostToolUse hook (fail-open)

  CREDENTIALS (encrypted API-key storage for wrapped agents):
    agentweave credentials set <agent> <KEY> <val>   Store API key (encrypted)
    agentweave credentials list                      Show stored keys (masked)
    agentweave credentials remove <agent> <KEY>      Remove a key
    agentweave credentials check <agent>             Check if keys exist

  POLICY (3-file YAML cascade — org/team/user; org may set immutable rules):
    agentweave policy show [options]                 Show resolved cascade
      --policy-org <path>      Override org-level file
      --policy-team <path>     Override team-level file
      --policy-user <path>     Override user-level file
      --format <table|json>    Output format (default: table)
    agentweave policy lint <file> [--as org|team|user]   Validate a single file

  AUDIT (inspect guard decisions written to .agentweave/audit.log):
    agentweave audit view [options]                  Table view (default: last 50)
      --since <5m|1h|2d|ISO>   Only entries after this time
      --tool <name>            Filter by tool
      --decision <approve|block>   Filter by decision
      --limit <n>              Max entries (default: 50)
      --format <table|json>    Output format (default: table)
      --tail                   Follow mode (stream new entries)
      --path <path>            Custom audit log path
    agentweave audit replay <session-id> [options]   Replay a single session as a timeline
      --since <5m|1h|2d|ISO>   Only entries after this time
      --until <5m|1h|2d|ISO>   Only entries before this time
      --format <table|json>    Output format (default: table)
      --path <path>            Custom audit log path

  ═══ PILLAR 2 — QA PIPELINE (SDLC) ══════════════════════════════════════════
  Norm → Ctx → Plan → Exec → Patch → QA → Retry → Out. Delegates Exec to the
  target agent via an adapter. Records M1–M10 metrics for every run.

  PIPELINE:
    agentweave pipeline setup                    Guided setup wizard (mode + auth)
    agentweave pipeline status                   Show current mode + agent auth info
    agentweave pipeline run <prompt> [options]   Run the 8-stage SDLC pipeline
    agentweave pipeline show                     Show pipeline stages & config
    agentweave pipeline agents                   List supported agent CLIs
    agentweave task <prompt> [options]           Alias for pipeline run
    agentweave metrics [options]                 View M1–M10 metrics from stored runs

  PIPELINE CONFIG:
    agentweave pipeline config                   Show module on/off status
    agentweave pipeline config init              Create agentweave.yaml
    agentweave pipeline config on <modules>      Enable modules
    agentweave pipeline config off <modules>     Disable modules
    agentweave pipeline config set <key> <val>   Set config value
    agentweave pipeline config reset             Reset to defaults

  PIPELINE RUN OPTIONS:
    --agent <cmd>         CLI agent to wrap (e.g. claude, cursor, aider)
    --agent-args <args>   Extra args for agent (comma-separated)
    --model <model>       LLM model for agent-loop mode (default: claude-sonnet-4-6)
    --checks <cmds>       QA check commands (comma-separated)
    --retries <n>         Max retries (default: 3)
    --metrics-dir <path>  Metrics storage dir (default: .agentweave/metrics)
    --policy-org <path>   Override org-level policy YAML
    --policy-team <path>  Override team-level policy YAML
    --policy-user <path>  Override user-level policy YAML
    --policy-require-all  Fail if any configured --policy-* path is unresolvable
    --no-policy           Disable policy load even if env/OS paths exist

  METRICS OPTIONS:
    --dir <path>          Metrics directory (default: .agentweave/metrics)
    --history             Show all stored runs

  ═══ PILLAR 3 — ADAPTERS + MCP ══════════════════════════════════════════════
  Distribution — reach agents in the wild (Claude Code, Cursor, any MCP host).

  MCP SERVER:
    agentweave mcp start            Run stdio MCP server (expose governance + QA tools)
    agentweave mcp print-config     Print .mcp.json snippet for Claude Code

  MONITOR (Prometheus-compatible metrics endpoint):
    agentweave monitor export [--instance <n>]     Print metrics exposition to stdout
    agentweave monitor serve [options]             Run /metrics HTTP endpoint
      --port <p>                  Port (default: 9090; use 0 for ephemeral)
      --host <h>                  Bind host (default: 127.0.0.1)
      --instance <n>              Prometheus 'instance' label (default: agentweave)
      --include-session-label     Opt-in: add 'session_id' label (cardinality risk)

  ─── REFERENCE IMPLEMENTATION (agent-loop, demoted post-pivot 2026-04-22) ───
  Use only when no wrapped agent is available. Not the production path.

    agentweave run <prompt> [options]      Run reference agent-loop directly
    agentweave monitor --gateway <url>     Monitor reference gateway (legacy)
    agentweave session list [--dir <path>] List reference-loop sessions

  RUN OPTIONS:
    --model <model>       LLM model (default: claude-sonnet-4-6)
    --budget <usd>        Max budget in USD
    --max-turns <n>       Max turns (default: 50)
    --mode <mode>         Permission mode: default|strict|permissive|plan

  ═══ GLOBAL ════════════════════════════════════════════════════════════════
    --help                Show this help
    --version             Show version

  EXAMPLES:
    # Pillar 2 — QA pipeline around Claude Code
    agentweave pipeline setup
    agentweave pipeline run "Fix the login bug" --agent claude --checks "npm test"
    agentweave metrics
    agentweave metrics --history

    # Pillar 1 — Governance (wire up via .claude/hooks/ then use guard)
    agentweave credentials set claude ANTHROPIC_API_KEY sk-...
    agentweave guard pre-tool-use < event.json    # normally invoked by hook
    agentweave audit view --since 1h --decision block

    # Pillar 3 — MCP distribution
    agentweave mcp print-config > .mcp.json
    agentweave mcp start
`);
}

// ─── Arg Parsing ─────────────────────────────────────────────────

function getFlag(args: string[], flag: string): string | undefined {
	const idx = args.indexOf(flag);
	return idx >= 0 ? args[idx + 1] : undefined;
}

function hasFlag(args: string[], flag: string): boolean {
	return args.includes(flag);
}

/** P3.1 — build PolicyPaths from CLI flags. Returns undefined if none set. */
function collectPolicyPaths(args: string[]): PolicyPaths | undefined {
	const org = getFlag(args, "--policy-org");
	const team = getFlag(args, "--policy-team");
	const user = getFlag(args, "--policy-user");
	if (!org && !team && !user) return undefined;
	const out: PolicyPaths = {};
	if (org) out.org = org;
	if (team) out.team = team;
	if (user) out.user = user;
	return out;
}

export function parseArgs(args: string[]): {
	command: string;
	prompt: string;
	model: string;
	budget?: number;
	maxTurns?: number;
	permissionMode?: "default" | "strict" | "permissive" | "plan";
} {
	let command = "";
	let prompt = "";
	let model = "claude-sonnet-4-6";
	let budget: number | undefined;
	let maxTurns: number | undefined;
	let permissionMode: "default" | "strict" | "permissive" | "plan" | undefined;

	for (let i = 0; i < args.length; i++) {
		const arg = args[i]!;
		switch (arg) {
			case "--model":
				model = args[++i] ?? model;
				break;
			case "--budget": {
				const b = Number.parseFloat(args[++i] ?? "");
				if (Number.isNaN(b) || b < 0 || b > 10000) {
					console.error("Error: --budget must be a number between 0 and 10000");
					process.exit(1);
				}
				budget = b;
				break;
			}
			case "--max-turns": {
				const t = Number.parseInt(args[++i] ?? "", 10);
				if (Number.isNaN(t) || t < 1 || t > 10000) {
					console.error("Error: --max-turns must be an integer between 1 and 10000");
					process.exit(1);
				}
				maxTurns = t;
				break;
			}
			case "--mode": {
				const modeVal = args[++i];
				const validModes = ["default", "strict", "permissive", "plan"] as const;
				if (modeVal && (validModes as readonly string[]).includes(modeVal)) {
					permissionMode = modeVal as typeof permissionMode;
				} else {
					console.error(`Error: Invalid mode "${modeVal}". Valid: ${validModes.join(", ")}`);
					process.exit(1);
				}
				break;
			}
			default:
				if (arg.startsWith("--")) break; // skip unknown flags
				if (!command) {
					command = arg;
				} else if (!prompt) {
					prompt = arg;
				}
				break;
		}
	}

	return { command, prompt, model, budget, maxTurns, permissionMode };
}

// ─── Main ────────────────────────────────────────────────────────

async function main(): Promise<void> {
	if (args.includes("--version")) {
		console.log(AGENTWEAVE_VERSION);
		return;
	}

	if (args.includes("--help") || args.length === 0) {
		printHelp();
		return;
	}

	const parsed = parseArgs(args);

	switch (parsed.command) {
		case "pipeline": {
			// Sub-commands: "pipeline show", "pipeline config ...", "pipeline run <prompt>"
			const subCmd = parsed.prompt; // second positional arg

			if (subCmd === "config") {
				// Parse config sub-action: on/off/set/init/reset
				const pipeIdx = args.indexOf("pipeline");
				const configIdx = args.indexOf("config", pipeIdx + 1);
				const configArgs = args.slice(configIdx + 1).filter((a) => !a.startsWith("--"));

				const action = configArgs[0] ?? "show";
				if (action === "on" || action === "off") {
					pipelineConfigCommand({ action, targets: configArgs.slice(1) });
				} else if (action === "set") {
					pipelineConfigCommand({ action: "set", key: configArgs[1], value: configArgs.slice(2).join(" ") });
				} else if (action === "init") {
					pipelineConfigCommand({ action: "init" });
				} else if (action === "reset") {
					pipelineConfigCommand({ action: "reset" });
				} else {
					pipelineConfigCommand({ action: "show" });
				}
			} else if (subCmd === "status") {
				pipelineStatusCommand();
			} else if (subCmd === "setup") {
				await pipelineSetupCommand();
			} else if (subCmd === "agents") {
				pipelineAgentsCommand();
			} else if (subCmd === "show" || !subCmd) {
				const checksRaw = getFlag(args, "--checks");
				pipelineShowCommand({
					checks: checksRaw ? checksRaw.split(",").map((s) => s.trim()) : undefined,
					retries: getFlag(args, "--retries") ? parseInt(getFlag(args, "--retries")!, 10) : undefined,
					agent: getFlag(args, "--agent"),
				});
			} else {
				// "pipeline run <prompt>" — the "run" is consumed as prompt, real prompt is next positional
				let prompt = subCmd;
				// If subCmd is "run", the actual prompt is the next positional arg
				if (subCmd === "run") {
					// Find prompt after "pipeline" and "run"
					const pipeIdx = args.indexOf("pipeline");
					const runIdx = args.indexOf("run", pipeIdx + 1);
					if (runIdx >= 0 && args[runIdx + 1] && !args[runIdx + 1]!.startsWith("--")) {
						prompt = args[runIdx + 1]!;
					} else {
						console.error("Error: Missing prompt. Usage: agentweave pipeline run <prompt>");
						process.exit(1);
					}
				}

				const agentArgsRaw = getFlag(args, "--agent-args");
				const checksRaw = getFlag(args, "--checks");
				const retriesRaw = getFlag(args, "--retries");

				await pipelineRunCommand({
					prompt,
					agent: getFlag(args, "--agent"),
					agentArgs: agentArgsRaw ? agentArgsRaw.split(",").map((s) => s.trim()) : undefined,
					model: getFlag(args, "--model") ?? parsed.model,
					checks: checksRaw ? checksRaw.split(",").map((s) => s.trim()) : undefined,
					retries: retriesRaw ? parseInt(retriesRaw, 10) : undefined,
					metricsDir: getFlag(args, "--metrics-dir"),
					policyPaths: collectPolicyPaths(args),
					noPolicy: hasFlag(args, "--no-policy"),
					policyRequireAll: hasFlag(args, "--policy-require-all"),
				});
			}
			break;
		}

		case "task": {
			if (!parsed.prompt) {
				console.error("Error: Missing task description. Usage: agentweave task <prompt>");
				process.exit(1);
			}

			const agentArgsRaw = getFlag(args, "--agent-args");
			const checksRaw = getFlag(args, "--checks");
			const retriesRaw = getFlag(args, "--retries");

			await taskCommand({
				prompt: parsed.prompt,
				agent: getFlag(args, "--agent"),
				agentArgs: agentArgsRaw ? agentArgsRaw.split(",").map((s) => s.trim()) : undefined,
				model: getFlag(args, "--model") ?? parsed.model,
				checks: checksRaw ? checksRaw.split(",").map((s) => s.trim()) : undefined,
				retries: retriesRaw ? parseInt(retriesRaw, 10) : undefined,
				plan: hasFlag(args, "--plan"),
				metricsDir: getFlag(args, "--metrics-dir"),
			});
			break;
		}

		case "metrics": {
			await metricsCommand({
				dir: getFlag(args, "--dir"),
				history: hasFlag(args, "--history"),
			});
			break;
		}

		case "mcp": {
				const mcpIdx = args.indexOf("mcp");
				const subAction = args[mcpIdx + 1];
				if (subAction === "print-config") {
					mcpPrintCommand();
				} else {
					await mcpStartCommand();
				}
				break;
			}

			case "guard": {
				const guardIdx = args.indexOf("guard");
				const sub = args[guardIdx + 1];
				const phase: GuardPhase | null =
					sub === "pre-tool-use" ? "pre" : sub === "post-tool-use" ? "post" : null;
				if (!phase) {
					console.error("Error: Usage: agentweave guard pre-tool-use|post-tool-use");
					process.exit(1);
				}
				const code = await runGuard(phase);
				process.exit(code);
			}

			case "audit": {
				const auditIdx = args.indexOf("audit");
				const sub = args[auditIdx + 1];
				const fmt = getFlag(args, "--format");
				const format: "table" | "json" | undefined =
					fmt === "json" || fmt === "table" ? fmt : undefined;
				if (sub === "view") {
					const limitRaw = getFlag(args, "--limit");
					const code = await auditViewCommand({
						path: getFlag(args, "--path"),
						since: getFlag(args, "--since"),
						tool: getFlag(args, "--tool"),
						decision: getFlag(args, "--decision"),
						limit: limitRaw ? parseInt(limitRaw, 10) : undefined,
						format,
						tail: hasFlag(args, "--tail"),
					});
					process.exit(code);
				}
				if (sub === "replay") {
					const sessionId = args[auditIdx + 2];
					if (!sessionId || sessionId.startsWith("--")) {
						console.error("Error: Usage: agentweave audit replay <session-id> [options]");
						process.exit(1);
					}
					const code = await auditReplayCommand({
						sessionId,
						path: getFlag(args, "--path"),
						since: getFlag(args, "--since"),
						until: getFlag(args, "--until"),
						format,
					});
					process.exit(code);
				}
				console.error("Error: Usage: agentweave audit view|replay [options]");
				process.exit(1);
			}

			case "policy": {
				const polIdx = args.indexOf("policy");
				const sub = args[polIdx + 1];
				if (sub === "show") {
					const fmt = getFlag(args, "--format");
					const format: "table" | "json" | undefined =
						fmt === "json" || fmt === "table" ? fmt : undefined;
					const code = policyShowCommand({
						paths: collectPolicyPaths(args),
						format,
					});
					process.exit(code);
				}
				if (sub === "lint") {
					const file = args[polIdx + 2];
					if (!file || file.startsWith("--")) {
						console.error("Error: Usage: agentweave policy lint <file> [--as org|team|user]");
						process.exit(1);
					}
					const asRaw = getFlag(args, "--as");
					let as: PolicyLevel | undefined;
					if (asRaw) {
						if (asRaw !== "org" && asRaw !== "team" && asRaw !== "user") {
							console.error(`Error: --as must be one of: org, team, user (got "${asRaw}")`);
							process.exit(1);
						}
						as = asRaw;
					}
					const code = policyLintCommand({ file, as });
					process.exit(code);
				}
				console.error("Error: Usage: agentweave policy show|lint [options]");
				process.exit(1);
			}

			case "credentials": {
			const credIdx = args.indexOf("credentials");
			const credArgs = args.slice(credIdx + 1).filter((a) => !a.startsWith("--"));
			const credAction = credArgs[0] ?? "list";

			if (credAction === "set") {
				await credentialsCommand({ action: "set", agent: credArgs[1], envVar: credArgs[2], value: credArgs[3] });
			} else if (credAction === "remove") {
				credentialsCommand({ action: "remove", agent: credArgs[1], envVar: credArgs[2] });
			} else if (credAction === "check") {
				credentialsCommand({ action: "check", agent: credArgs[1] });
			} else {
				credentialsCommand({ action: "list" });
			}
			break;
		}

		case "chat": {
			// REPL — giữ hội thoại qua nhiều lượt. Prompt là tuỳ chọn.
			await chatCommand({
				prompt: parsed.prompt || undefined,
				model: parsed.model,
				budget: parsed.budget,
				maxTurns: parsed.maxTurns,
				permissionMode: parsed.permissionMode,
			});
			break;
		}

		case "run": {
			if (!parsed.prompt) {
				console.error("Error: Missing prompt. Usage: agentweave run <prompt>");
				process.exit(1);
			}
			await runCommand({
				prompt: parsed.prompt,
				model: parsed.model,
				budget: parsed.budget,
				maxTurns: parsed.maxTurns,
				permissionMode: parsed.permissionMode,
			});
			break;
		}

		case "monitor": {
			const monIdx = args.indexOf("monitor");
			const sub = args[monIdx + 1];
			if (sub === "export") {
				monitorExportCommand({
					instance: getFlag(args, "--instance"),
					includeSessionLabel: hasFlag(args, "--include-session-label"),
				});
			} else if (sub === "serve") {
				const portRaw = getFlag(args, "--port");
				const port = portRaw ? Number.parseInt(portRaw, 10) : 9090;
				if (Number.isNaN(port) || port < 0 || port > 65535) {
					console.error("Error: --port must be an integer between 0 and 65535");
					process.exit(1);
				}
				await monitorServeCommand({
					port,
					host: getFlag(args, "--host"),
					instance: getFlag(args, "--instance"),
					includeSessionLabel: hasFlag(args, "--include-session-label"),
				});
			} else {
				const gateway = getFlag(args, "--gateway") ?? "http://localhost:9101";
				await monitorCommand({ gateway });
			}
			break;
		}

		case "session": {
			const dir = getFlag(args, "--dir");
			await sessionCommand({ action: "list", dir });
			break;
		}

		default:
			console.error(`Unknown command: ${parsed.command}`);
			printHelp();
			process.exit(1);
	}
}

main().catch((err) => {
	console.error("Fatal error:", err);
	process.exit(1);
});
