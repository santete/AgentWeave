/**
 * 'credentials' command — Manage API keys for AI agents.
 *
 * Usage:
 *   agentweave credentials set claude ANTHROPIC_API_KEY sk-ant-xxx
 *   agentweave credentials set "*" OPENROUTER_API_KEY sk-or-xxx    (global — all agents)
 *   agentweave credentials list
 *   agentweave credentials remove claude ANTHROPIC_API_KEY
 *   agentweave credentials check claude
 */

import { createInterface } from "node:readline";
import {
	setCredential,
	removeCredential,
	listCredentials,
	hasCredentials,
	ensureGitignore,
} from "../credential-store.js";

const C = {
	reset: "\x1b[0m", dim: "\x1b[2m", bold: "\x1b[1m",
	green: "\x1b[32m", red: "\x1b[31m", yellow: "\x1b[33m",
	cyan: "\x1b[36m", gray: "\x1b[90m", white: "\x1b[37m",
};

export interface CredentialsArgs {
	action: "set" | "list" | "remove" | "check";
	agent?: string;
	envVar?: string;
	value?: string;
}

export async function credentialsCommand(args: CredentialsArgs): Promise<void> {
	switch (args.action) {
		case "set":
			await cmdSet(args);
			break;
		case "list":
			cmdList();
			break;
		case "remove":
			cmdRemove(args);
			break;
		case "check":
			cmdCheck(args);
			break;
	}
}

async function cmdSet(args: CredentialsArgs): Promise<void> {
	if (!args.agent || !args.envVar) {
		console.log(`\n  ${C.yellow}Usage: agentweave credentials set <agent> <ENV_VAR> [value]${C.reset}`);
		console.log(`  ${C.dim}If value is omitted, you'll be prompted securely (recommended).${C.reset}`);
		console.log(`  ${C.dim}Examples:${C.reset}`);
		console.log(`    ${C.dim}credentials set claude ANTHROPIC_API_KEY${C.reset}`);
		console.log(`    ${C.dim}credentials set aider OPENAI_API_KEY${C.reset}`);
		console.log(`    ${C.dim}credentials set "*" OPENROUTER_API_KEY   (all agents)${C.reset}\n`);
		return;
	}

	let value = args.value;

	// If value not provided as arg, read from stdin (secure — not visible in ps aux)
	if (!value) {
		value = await readSecretFromStdin(`  Enter value for ${args.envVar}: `);
		if (!value) {
			console.log(`\n  ${C.red}Aborted${C.reset} — no value provided.\n`);
			return;
		}
	} else {
		// Warn if value was passed as CLI arg (visible in process list)
		console.log(`  ${C.yellow}WARNING:${C.reset} ${C.dim}Value passed as CLI argument — visible in process listing.${C.reset}`);
		console.log(`  ${C.dim}For security, omit the value to be prompted: credentials set ${args.agent} ${args.envVar}${C.reset}`);
	}

	ensureGitignore();
	const result = setCredential(args.agent, args.envVar, value);

	if (!result.ok) {
		console.log(`\n  ${C.red}Error:${C.reset} ${result.error}\n`);
		return;
	}

	const scope = args.agent === "*" ? "all agents" : args.agent;
	console.log(`\n  ${C.green}Saved${C.reset} ${args.envVar} for ${C.bold}${scope}${C.reset}`);
	console.log(`  ${C.dim}Encrypted in .agentweave/credentials.json${C.reset}`);
	console.log(`  ${C.dim}Auto-injected when running: agentweave pipeline run --agent ${args.agent === "*" ? "<any>" : args.agent}${C.reset}\n`);
}

function readSecretFromStdin(prompt: string): Promise<string> {
	return new Promise((resolve) => {
		const rl = createInterface({ input: process.stdin, output: process.stdout });
		// Note: Node.js readline doesn't support hidden input natively.
		// On TTY, the value will be visible. For production, use a library like `read` or `inquirer`.
		process.stdout.write(prompt);
		rl.once("line", (line) => {
			rl.close();
			resolve(line.trim());
		});
		rl.once("close", () => resolve(""));
	});
}

function cmdList(): void {
	const creds = listCredentials();

	if (creds.length === 0) {
		console.log(`\n  ${C.yellow}No credentials stored.${C.reset}`);
		console.log(`  ${C.dim}Add with: agentweave credentials set <agent> <ENV_VAR> <value>${C.reset}\n`);
		return;
	}

	console.log(`\n  ${C.cyan}${C.bold}Stored Credentials${C.reset}`);
	console.log(`  ${C.gray}${"─".repeat(60)}${C.reset}`);

	for (const cred of creds) {
		const scope = cred.agent === "*" ? `${C.yellow}global${C.reset}` : cred.agent;
		console.log(`  ${C.white}${cred.envVar.padEnd(30)}${C.reset} ${scope.padEnd(20)} ${C.dim}${cred.masked}${C.reset}`);
	}

	console.log(`  ${C.gray}${"─".repeat(60)}${C.reset}`);
	console.log(`  ${C.dim}${creds.length} credential(s). Keys auto-injected into agent process.${C.reset}\n`);
}

function cmdRemove(args: CredentialsArgs): void {
	if (!args.agent || !args.envVar) {
		console.log(`\n  ${C.yellow}Usage: agentweave credentials remove <agent> <ENV_VAR>${C.reset}\n`);
		return;
	}

	const removed = removeCredential(args.agent, args.envVar);
	if (removed) {
		console.log(`\n  ${C.green}Removed${C.reset} ${args.envVar} for ${args.agent}\n`);
	} else {
		console.log(`\n  ${C.yellow}Not found${C.reset}: ${args.envVar} for ${args.agent}\n`);
	}
}

function cmdCheck(args: CredentialsArgs): void {
	if (!args.agent) {
		console.log(`\n  ${C.yellow}Usage: agentweave credentials check <agent>${C.reset}\n`);
		return;
	}

	const has = hasCredentials(args.agent);
	if (has) {
		console.log(`\n  ${C.green}✓${C.reset} Credentials configured for ${C.bold}${args.agent}${C.reset}`);
		console.log(`  ${C.dim}Keys will be injected when running: agentweave pipeline run --agent ${args.agent}${C.reset}\n`);
	} else {
		console.log(`\n  ${C.red}✗${C.reset} No credentials for ${C.bold}${args.agent}${C.reset}`);
		console.log(`  ${C.dim}Add with: agentweave credentials set ${args.agent} <ENV_VAR> <value>${C.reset}\n`);
	}
}
