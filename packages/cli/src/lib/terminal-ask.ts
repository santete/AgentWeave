/**
 * Terminal ask prompt — interactive y/n/a prompt for PermissionEngine `ask`
 * decisions. Shared by `agentweave run` (reference loop), `agentweave chat`
 * (REPL) and `agentweave pipeline run` (Pillar 2 wrap path).
 *
 * The handler shape is compatible with `OuterHarnessConfig.onAsk`:
 *   (toolName, toolInput, message) => Promise<{ allow; alwaysAllow? }>
 */

import { createInterface } from "node:readline";
import { dungDiff } from "./diff.js";

const C = {
	reset: "\x1b[0m",
	dim: "\x1b[2m",
	bold: "\x1b[1m",
	green: "\x1b[32m",
	red: "\x1b[31m",
	yellow: "\x1b[33m",
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
	// Không có bàn phím thì KHÔNG được hỏi rồi coi im lặng là từ chối: bản trước
	// làm vậy và lý do in ra là "No interceptor (fail-closed)" — sai hoàn toàn so
	// với nguyên nhân thật, khiến người dùng đi tìm nhầm chỗ.
	if (!process.stdin.isTTY) {
		console.log("");
		console.log(`  ${C.yellow}? ASK${C.reset} ${toolName} — ${message}`);
		console.log(
			`  ${C.red}→ Từ chối vì không có bàn phím (stdin không phải TTY).${C.reset}\n` +
				`  ${C.dim}Chạy trong terminal thật, hoặc dùng --mode permissive, ` +
				`hoặc khai luật cho phép sẵn.${C.reset}`,
		);
		return { allow: false };
	}

	console.log("");
	console.log(`  ${C.bgYellow}${C.bold} ASK ${C.reset} ${message}`);

	// Với tool ghi file, hiện DIFF thay vì chỉ in tham số. Duyệt mà không thấy
	// mình đang duyệt cái gì thì lời hỏi chỉ là thủ tục.
	const diff = await dungDiff(toolName, toolInput, process.cwd()).catch(() => null);
	if (diff && diff.text) {
		console.log(diff.text);
	} else if (diff && !diff.text) {
		console.log(`  ${C.dim}(nội dung không đổi)${C.reset}`);
	} else {
		const inputPreview = redactSecrets(JSON.stringify(toolInput)).slice(0, 200);
		console.log(`  Tool: ${C.bold}${toolName}${C.reset}(${inputPreview})`);
	}

	console.log(
		`  ${C.green}[y]${C.reset} Cho phép  ${C.red}[n]${C.reset} Từ chối  ${C.cyan}[a]${C.reset} Luôn cho phép`,
	);

	const rl = createInterface({ input: process.stdin, output: process.stdout });
	const answer = await new Promise<string>((resolve) => {
		rl.question(`  ${C.bold}>${C.reset} `, (ans) => {
			rl.close();
			resolve(ans.trim().toLowerCase());
		});
	});

	if (answer === "a") {
		console.log(`  ${C.cyan}→ Luôn cho phép${C.reset}`);
		return { allow: true, alwaysAllow: true };
	}
	if (answer === "y" || answer === "yes") {
		console.log(`  ${C.green}→ Cho phép${C.reset}`);
		return { allow: true };
	}
	console.log(`  ${C.red}→ Từ chối${C.reset}`);
	return { allow: false };
}
