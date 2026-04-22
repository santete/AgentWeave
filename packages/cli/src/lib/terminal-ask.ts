/**
 * Terminal ask prompt — interactive y/n/a prompt for PermissionEngine `ask`
 * decisions. Shared by `agentweave run` (reference loop) and `agentweave
 * pipeline run` (Pillar 2 wrap path).
 *
 * The handler shape is compatible with `OuterHarnessConfig.onAsk`:
 *   (toolName, toolInput, message) => Promise<{ allow; alwaysAllow? }>
 */

import { createInterface } from "node:readline";

const C = {
	reset: "\x1b[0m",
	bold: "\x1b[1m",
	green: "\x1b[32m",
	red: "\x1b[31m",
	cyan: "\x1b[36m",
	bgYellow: "\x1b[43m",
};

const SECRET_PATTERNS = [
	/sk-[a-zA-Z0-9]{20,}/g,
	/AKIA[A-Z0-9]{16}/g,
	/ghp_[a-zA-Z0-9]{36}/g,
	/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/g,
];

export function redactSecrets(text: string): string {
	let out = text;
	for (const pat of SECRET_PATTERNS) out = out.replace(pat, "[REDACTED]");
	return out;
}

export async function terminalAskPrompt(
	toolName: string,
	toolInput: Record<string, unknown>,
	message: string,
): Promise<{ allow: boolean; alwaysAllow?: boolean }> {
	const inputPreview = redactSecrets(JSON.stringify(toolInput)).slice(0, 60);
	console.log("");
	console.log(`  ${C.bgYellow}${C.bold} ASK ${C.reset} ${message}`);
	console.log(`  Tool: ${C.bold}${toolName}${C.reset}(${inputPreview})`);
	console.log(`  ${C.green}[y]${C.reset} Allow  ${C.red}[n]${C.reset} Deny  ${C.cyan}[a]${C.reset} Always Allow`);

	const rl = createInterface({ input: process.stdin, output: process.stdout });
	const answer = await new Promise<string>((resolve) => {
		rl.question(`  ${C.bold}>${C.reset} `, (ans) => {
			rl.close();
			resolve(ans.trim().toLowerCase());
		});
	});

	if (answer === "a") {
		console.log(`  ${C.cyan}→ Always allowed${C.reset}`);
		return { allow: true, alwaysAllow: true };
	}
	if (answer === "y" || answer === "yes") {
		console.log(`  ${C.green}→ Allowed${C.reset}`);
		return { allow: true };
	}
	console.log(`  ${C.red}→ Denied${C.reset}`);
	return { allow: false };
}
