/**
 * 'run' command — Execute an agent with full governance visibility.
 */

import { createHarness } from "@agentweave/sdk";
import { BUILT_IN_TOOLS } from "@agentweave/inner-harness";
import { AGENTWEAVE_VERSION } from "@agentweave/types";
import type { CreateHarnessOptions, InnerEvent } from "@agentweave/sdk";
import { redactSecrets, terminalAskPrompt } from "../lib/terminal-ask.js";
import { napTriThuc } from "../lib/nap-tri-thuc";
import { dungCoLap } from "../lib/co-lap";
import { docCauHinhAgent } from "../lib/agent-config";
import { LUAT_NGUY_HIEM } from "../lib/luat-nguy-hiem.js";

export interface RunCommandArgs {
	prompt: string;
	model: string;
	budget?: number;
	maxTurns?: number;
	permissionMode?: "default" | "strict" | "permissive" | "plan";
}

// ─── ANSI Colors ────────────────────────────────────────────────

const C = {
	reset: "\x1b[0m",
	dim: "\x1b[2m",
	bold: "\x1b[1m",
	green: "\x1b[32m",
	red: "\x1b[31m",
	yellow: "\x1b[33m",
	blue: "\x1b[34m",
	cyan: "\x1b[36m",
	magenta: "\x1b[35m",
	gray: "\x1b[90m",
	bgRed: "\x1b[41m",
	bgGreen: "\x1b[42m",
	bgYellow: "\x1b[43m",
	white: "\x1b[37m",
};

// ─── Session State ──────────────────────────────────────────────

let toolCallCount = 0;
let permissionAllowed = 0;
let permissionDenied = 0;
let turnCount = 0;
/** Đang ở giữa đoạn chữ đang chảy. */
let dangChayChu = false;
const startTime = Date.now();

// ─── Main ───────────────────────────────────────────────────────

export async function runCommand(args: RunCommandArgs): Promise<void> {
	printHeader(args);

	const options: CreateHarnessOptions = {
		model: args.model || "qwen3-coder:30b",
		tools: BUILT_IN_TOOLS,
		maxTurns: args.maxTurns ?? 50,
		permissions: {
			mode: args.permissionMode ?? "default",
			rules: [
				...LUAT_NGUY_HIEM,
				{ pattern: "FileRead(*)", behavior: "allow", source: "project", priority: 50 },
				{ pattern: "Grep(*)", behavior: "allow", source: "project", priority: 50 },
				{ pattern: "Glob(*)", behavior: "allow", source: "project", priority: 50 },
				{ pattern: "Bash(ls *)", behavior: "allow", source: "project", priority: 50 },
				{ pattern: "Bash(cat *)", behavior: "allow", source: "project", priority: 50 },
				{ pattern: "Bash(echo *)", behavior: "allow", source: "project", priority: 50 },
				{ pattern: "Bash(git *)", behavior: "allow", source: "project", priority: 50 },
			],
			failMode: "closed",
		},
		output: {
			gateMode: "batch",
			filters: [
				{ type: "secret", name: "secrets", patterns: [], replacement: "[SECRET]" },
				{ type: "pii", name: "pii", entities: ["email", "ssn"], replacement: "[PII]" },
			],
		},
		budget: {
			maxPerSession: args.budget,
			warningThreshold: 0.8,
		},
		onAsk: terminalAskPrompt,
	};

	const { config: cauHinhDuAn } = await docCauHinhAgent(process.cwd());
	const coLap = await dungCoLap(process.cwd(), cauHinhDuAn);
	if (coLap.hong) {
		console.error(`✗ ${coLap.thongBao}`);
		process.exitCode = 1;
		return;
	}
	if (coLap.thongBao) console.error(`🔒 ${coLap.thongBao}`);

	const harness = createHarness({ ...options, processSandbox: coLap.binding });

	// Rule, skill và bộ nhớ của dự án. Thiếu bước này thì `agentweave run` chạy
	// với một agent KHÔNG biết quy ước nào của dự án — khác hẳn `chat` và `serve`
	// mà không có gì báo, nên người dùng tưởng hai lệnh tương đương.
	await napTriThuc(harness.inner, { goc: process.cwd(), cauHinh: {}, quiet: true });

	const gen = harness.stream(args.prompt, { maxBudgetUsd: args.budget });

	for (;;) {
		const { value, done } = await gen.next();
		if (done) {
			printFooter(value, harness);
			break;
		}
		printEvent(value);
	}
}

// ─── Header ─────────────────────────────────────────────────────

function printHeader(args: RunCommandArgs): void {
	console.log("");
	console.log(`  ${C.cyan}${C.bold}AgentWeave${C.reset} ${C.dim}v${AGENTWEAVE_VERSION}${C.reset}`);
	console.log(`  ${C.dim}The Control Layer for AI Agents${C.reset}`);
	console.log("");
	console.log(`  ${C.gray}┌─────────────────────────────────────────────┐${C.reset}`);
	console.log(`  ${C.gray}│${C.reset} Model:      ${C.bold}${args.model}${C.reset}`);
	console.log(
		`  ${C.gray}│${C.reset} Mode:       ${C.yellow}${args.permissionMode ?? "default"}${C.reset}`,
	);
	console.log(
		`  ${C.gray}│${C.reset} Budget:     ${args.budget ? `$${args.budget}` : "unlimited"}`,
	);
	console.log(`  ${C.gray}│${C.reset} Max turns:  ${args.maxTurns ?? 50}`);
	console.log(
		`  ${C.gray}│${C.reset} Tools:      ${C.dim}Bash, FileRead, FileWrite, FileEdit, Grep, Glob${C.reset}`,
	);
	console.log(`  ${C.gray}│${C.reset} Filters:    ${C.dim}secrets, PII${C.reset}`);
	console.log(`  ${C.gray}│${C.reset} Sandbox:    ${C.dim}deny /etc, .env, .ssh, .aws${C.reset}`);
	console.log(`  ${C.gray}└─────────────────────────────────────────────┘${C.reset}`);
	console.log("");
	console.log(`  ${C.bold}Prompt:${C.reset} ${args.prompt}`);
	console.log("");
}

// ─── Event Printer ──────────────────────────────────────────────

function printEvent(event: InnerEvent): void {
	switch (event.type) {
		case "turn:start":
			turnCount = event.turnIndex;
			console.log(`  ${C.cyan}── Turn ${event.turnIndex} ──${C.reset}`);
			break;

		case "llm:request_start":
			console.log(
				`  ${C.dim}  LLM request → ${event.model} (est. ${event.estimatedInputTokens} tokens)${C.reset}`,
			);
			break;

		case "llm:stream_end":
			console.log(
				`  ${C.dim}  LLM response ← ${event.usage.inputTokens}in/${event.usage.outputTokens}out (${event.stopReason})${C.reset}`,
			);
			break;

		case "tool:requested":
			if (dangChayChu) {
				process.stdout.write("\n");
				dangChayChu = false;
			}
			console.log(
				`  ${C.yellow}  ⚡ TOOL${C.reset} ${C.bold}${event.toolName}${C.reset}(${redactSecrets(JSON.stringify(event.toolInput)).slice(0, 100)})`,
			);
			break;

		case "permission:allowed":
			permissionAllowed++;
			console.log(
				`  ${C.green}  ✓ ALLOW${C.reset} ${event.toolName} ${C.dim}[${event.source}]${C.reset}`,
			);
			break;

		case "permission:denied":
			permissionDenied++;
			console.log(
				`  ${C.red}  ✗ DENY${C.reset}  ${event.toolName} — ${event.reason} ${C.dim}[${event.source}]${C.reset}`,
			);
			break;

		case "permission:asking":
			console.log(`  ${C.yellow}  ? ASK${C.reset}   ${event.toolName} — ${event.askMessage}`);
			break;

		case "tool:completed":
			toolCallCount++;
			const preview =
				typeof event.result === "string"
					? event.result.slice(0, 120)
					: JSON.stringify(event.result).slice(0, 120);
			console.log(`  ${C.green}  ✓ DONE${C.reset}  ${event.durationMs.toFixed(0)}ms`);
			console.log(
				`  ${C.dim}  ↳ ${preview.replace(/\n/g, "\\n")}${preview.length >= 120 ? "..." : ""}${C.reset}`,
			);
			break;

		case "tool:failed":
			toolCallCount++;
			console.log(
				`  ${C.red}  ✗ FAIL${C.reset}  ${event.error} ${C.dim}(${event.durationMs.toFixed(0)}ms)${C.reset}`,
			);
			break;

		case "llm:stream_delta":
			if (!dangChayChu) {
				process.stdout.write(`\n  ${C.bold}${C.white}Agent:${C.reset} `);
				dangChayChu = true;
			}
			process.stdout.write(event.delta);
			break;

		case "message:assistant":
			// Chữ đã chảy ra ở llm:stream_delta; chỉ đóng đoạn.
			if (dangChayChu) {
				process.stdout.write("\n\n");
				dangChayChu = false;
			}
			break;

		case "message:tool_result":
			// Already shown in tool:completed preview
			break;

		case "error":
			console.log(
				`  ${C.bgRed}${C.white} ERROR ${C.reset} ${event.error} ${event.recoverable ? C.dim + "(recoverable)" + C.reset : ""}`,
			);
			break;

		case "agent:spawned":
			console.log(`  ${C.magenta}  ◆ SPAWN${C.reset} ${event.name} [${event.childAgentId}]`);
			break;
		case "agent:completed":
			console.log(`  ${C.green}  ◆ DONE${C.reset}  ${event.name}`);
			break;
		case "agent:failed":
			console.log(`  ${C.red}  ◆ FAIL${C.reset}  ${event.name} — ${event.error}`);
			break;
		case "agent:aborted":
			console.log(`  ${C.yellow}  ◆ ABORT${C.reset} ${event.name}`);
			break;

		// Silently tracked (visible in footer summary)
		case "turn:end":
		case "context:compacted":
		case "context:usage":
		case "recovery:retry":
		case "recovery:fallback":
		case "terminal":
			break;
	}
}

// ─── Footer ─────────────────────────────────────────────────────

function printFooter(
	result: import("@agentweave/types").TerminalResult,
	harness: import("@agentweave/sdk").HarnessInstance,
): void {
	const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
	const usage = harness.getUsage();
	const audit = harness.outer.getAuditLogger().size();

	const reasonColor =
		result.reason === "completed" ? C.green : result.reason === "aborted" ? C.yellow : C.red;

	console.log(`  ${C.cyan}═══════════════════════════════════════════════${C.reset}`);
	console.log(`  ${C.bold}Session Summary${C.reset}`);
	console.log(`  ${C.cyan}═══════════════════════════════════════════════${C.reset}`);
	console.log("");
	console.log(`  Status:       ${reasonColor}${C.bold}${result.reason.toUpperCase()}${C.reset}`);
	console.log(`  Duration:     ${elapsed}s (${turnCount} turns)`);
	console.log("");
	console.log(`  ${C.bold}Governance${C.reset}`);
	console.log(`  ├─ Tools called:     ${toolCallCount}`);
	console.log(
		`  ├─ Permissions:      ${C.green}${permissionAllowed} allowed${C.reset} / ${C.red}${permissionDenied} denied${C.reset}`,
	);
	console.log(`  ├─ Audit log:        ${audit} entries`);
	console.log(`  └─ Output filters:   secrets, PII active`);
	console.log("");
	console.log(`  ${C.bold}Usage${C.reset}`);
	console.log(`  ├─ Input tokens:     ${usage.inputTokens.toLocaleString()}`);
	console.log(`  ├─ Output tokens:    ${usage.outputTokens.toLocaleString()}`);
	console.log(`  └─ Cost:             $${usage.totalCost.toFixed(4)}`);
	console.log("");
}
