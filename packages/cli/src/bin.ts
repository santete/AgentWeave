#!/usr/bin/env node

/**
 * AgentWeave CLI entry point.
 *
 * Commands:
 *   agentweave task <prompt>       Run SDLC pipeline on a task
 *   agentweave metrics             View SDLC metrics from stored runs
 *   agentweave run <prompt>        Run agent directly (low-level)
 *   agentweave monitor             Monitor gateway
 *   agentweave session list        List sessions
 */

import { AGENTWEAVE_VERSION } from "@agentweave/types";
import { runCommand } from "./commands/run.js";
import { monitorCommand } from "./commands/monitor.js";
import { sessionCommand } from "./commands/session.js";
import { taskCommand } from "./commands/task.js";
import { metricsCommand } from "./commands/metrics.js";
import { pipelineRunCommand, pipelineShowCommand, pipelineAgentsCommand } from "./commands/pipeline.js";
import { pipelineSetupCommand } from "./commands/pipeline-setup.js";
import { pipelineStatusCommand } from "./commands/pipeline-status.js";
import { pipelineConfigCommand } from "./commands/pipeline-config.js";
import { credentialsCommand } from "./commands/credentials.js";

const args = process.argv.slice(2);

function printHelp(): void {
	console.log(`
  AgentWeave CLI v${AGENTWEAVE_VERSION}
  AI SDLC Engine + Governance Layer for AI Agents

  SDLC PIPELINE:
    agentweave pipeline setup                    Guided setup wizard (mode + auth)
    agentweave pipeline status                   Show current mode + agent auth info
    agentweave pipeline run <prompt> [options]   Run 8-step SDLC pipeline
    agentweave pipeline show                     Show pipeline steps & config
    agentweave pipeline agents                   List supported AI agent CLIs
    agentweave task <prompt> [options]            Alias for pipeline run
    agentweave metrics [options]                  View collected metrics

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

  CREDENTIALS:
    agentweave credentials set <agent> <KEY> <val>   Store API key (encrypted)
    agentweave credentials list                      Show stored keys (masked)
    agentweave credentials remove <agent> <KEY>      Remove a key
    agentweave credentials check <agent>             Check if keys exist

  METRICS OPTIONS:
    --dir <path>          Metrics directory (default: .agentweave/metrics)
    --history             Show all stored runs

  AGENT (low-level):
    agentweave run <prompt> [options]      Run agent directly
    agentweave monitor [--gateway <url>]   Monitor gateway
    agentweave session list [--dir <path>] List sessions

  RUN OPTIONS:
    --model <model>       LLM model (default: claude-sonnet-4-6)
    --budget <usd>        Max budget in USD
    --max-turns <n>       Max turns (default: 50)
    --mode <mode>         Permission mode: default|strict|permissive|plan

  GLOBAL:
    --help                Show this help
    --version             Show version

  EXAMPLES:
    agentweave pipeline show
    agentweave pipeline config init
    agentweave pipeline config on qa retry
    agentweave pipeline config off normalize context
    agentweave pipeline config set qa.checks "pnpm test:unit,eslint src/"
    agentweave pipeline config set execution.agent claude
    agentweave pipeline run "Fix the login bug" --agent claude --checks "npm test"
    agentweave task "Fix bug" --agent claude --checks "npm test"
    agentweave metrics
    agentweave metrics --history
    agentweave run "List files" --model claude-sonnet-4-6
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
			const gateway = getFlag(args, "--gateway") ?? "http://localhost:9101";
			await monitorCommand({ gateway });
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
