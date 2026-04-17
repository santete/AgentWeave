/**
 * 'run' command — Execute an agent with a prompt.
 *
 * Usage: agentweave run "Fix the login bug" [--model sonnet] [--budget 5.00]
 */

import { createHarness } from "@agentweave/sdk";
import { AGENTWEAVE_VERSION } from "@agentweave/types";
import type { CreateHarnessOptions, InnerEvent } from "@agentweave/sdk";

export interface RunCommandArgs {
	prompt: string;
	model: string;
	budget?: number;
	maxTurns?: number;
	permissionMode?: "default" | "strict" | "permissive" | "plan";
}

export async function runCommand(args: RunCommandArgs): Promise<void> {
	console.log(`\n  AgentWeave v${AGENTWEAVE_VERSION}\n`);
	console.log(`  Model:  ${args.model}`);
	if (args.budget) console.log(`  Budget: $${args.budget}`);
	console.log(`  Prompt: "${args.prompt}"`);
	console.log("");

	const options: CreateHarnessOptions = {
		model: args.model,
		maxTurns: args.maxTurns ?? 50,
		permissions: {
			mode: args.permissionMode ?? "default",
			rules: [
				{ pattern: "Bash(rm -rf *)", behavior: "deny", source: "policy", priority: 100, message: "Destructive deletion blocked" },
				{ pattern: "FileWrite(*.env)", behavior: "deny", source: "policy", priority: 100, message: "Cannot write to .env files" },
			],
			failMode: "closed",
		},
		output: {
			gateMode: "batch",
			filters: [
				{ type: "secret", name: "secrets", patterns: [], replacement: "[SECRET_REDACTED]" },
				{ type: "pii", name: "pii", entities: ["email", "ssn"], replacement: "[PII_REDACTED]" },
			],
		},
		budget: {
			maxPerSession: args.budget,
			warningThreshold: 0.8,
		},
	};

	const harness = createHarness(options);

	// Stream events to terminal
	const gen = harness.stream(args.prompt, {
		maxBudgetUsd: args.budget,
	});

	for (;;) {
		const { value, done } = await gen.next();
		if (done) {
			const result = value;
			console.log(`\n  ── Session Complete ──`);
			console.log(`  Reason: ${result.reason}`);
			if (result.usage) {
				console.log(`  Tokens: ${result.usage.inputTokens} in / ${result.usage.outputTokens} out`);
				console.log(`  Cost:   $${result.usage.totalCost.toFixed(4)}`);
			}
			console.log("");
			break;
		}

		printEvent(value);
	}
}

function printEvent(event: InnerEvent): void {
	switch (event.type) {
		case "turn:start":
			console.log(`  ── Turn ${event.turnIndex} ──`);
			break;
		case "message:assistant":
			for (const block of event.content) {
				if (block.type === "text") {
					console.log(`  ${block.text}`);
				}
			}
			break;
		case "tool:requested":
			// Redact sensitive patterns from tool input before logging
			console.log(`  Tool: ${event.toolName}(${redactSecrets(JSON.stringify(event.toolInput)).slice(0, 80)})`);
			break;
		case "permission:denied":
			console.log(`  DENIED: ${event.toolName} — ${event.reason}`);
			break;
		case "tool:completed":
			console.log(`  Done: ${event.toolUseId} (${event.durationMs.toFixed(0)}ms)`);
			break;
		case "tool:failed":
			console.log(`  FAILED: ${event.toolUseId} — ${event.error}`);
			break;
		case "agent:spawned":
			console.log(`  Agent: ${event.name} spawned [${event.childAgentId}]`);
			break;
		case "agent:completed":
			console.log(`  Agent: ${event.name} completed`);
			break;
		case "agent:failed":
			console.log(`  Agent: ${event.name} FAILED — ${event.error}`);
			break;
		case "agent:aborted":
			console.log(`  Agent: ${event.name} aborted`);
			break;
		// Other events: silent in default output
	}
}

const SECRET_PATTERNS = [
	/sk-[a-zA-Z0-9]{20,}/g,
	/AKIA[A-Z0-9]{16}/g,
	/ghp_[a-zA-Z0-9]{36}/g,
	/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/g,
];

function redactSecrets(text: string): string {
	let result = text;
	for (const pattern of SECRET_PATTERNS) {
		pattern.lastIndex = 0;
		result = result.replace(pattern, "[REDACTED]");
	}
	return result;
}
