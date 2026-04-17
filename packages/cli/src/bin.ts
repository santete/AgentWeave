#!/usr/bin/env node

/**
 * AgentWeave CLI entry point.
 *
 * Usage:
 *   agentweave run "prompt"           Run agent with prompt
 *   agentweave run "prompt" --model   Specify model
 *   agentweave run "prompt" --budget  Set budget limit (USD)
 *   agentweave --version              Show version
 *   agentweave --help                 Show help
 */

import { AGENTWEAVE_VERSION } from "@agentweave/types";
import { runCommand } from "./commands/run.js";
import { monitorCommand } from "./commands/monitor.js";
import { sessionCommand } from "./commands/session.js";

const args = process.argv.slice(2);

function printHelp(): void {
	console.log(`
  AgentWeave CLI v${AGENTWEAVE_VERSION}
  The Control Layer for AI Agents

  USAGE:
    agentweave run <prompt> [options]
    agentweave monitor [--gateway <url>]
    agentweave session list [--dir <path>]

  RUN OPTIONS:
    --model <model>       LLM model (default: claude-sonnet-4-6)
    --budget <usd>        Max budget in USD
    --max-turns <n>       Max turns (default: 50)
    --mode <mode>         Permission mode: default|strict|permissive|plan

  GLOBAL:
    --help                Show this help
    --version             Show version

  EXAMPLES:
    agentweave run "Fix the login bug"
    agentweave run "Refactor auth module" --model claude-opus-4-6 --budget 10
    agentweave monitor --gateway http://localhost:9101
    agentweave session list
    agentweave run "Review code quality" --mode plan
`);
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

	if (parsed.command === "run") {
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
	} else if (parsed.command === "monitor") {
		const gwIdx = args.indexOf("--gateway");
		const gateway = gwIdx >= 0 ? args[gwIdx + 1] ?? "http://localhost:9101" : "http://localhost:9101";
		await monitorCommand({ gateway });
	} else if (parsed.command === "session") {
		const dirIdx = args.indexOf("--dir");
		const dir = dirIdx >= 0 ? args[dirIdx + 1] : undefined;
		await sessionCommand({ action: "list", dir });
	} else {
		console.error(`Unknown command: ${parsed.command}`);
		printHelp();
		process.exit(1);
	}
}

main().catch((err) => {
	console.error("Fatal error:", err);
	process.exit(1);
});
