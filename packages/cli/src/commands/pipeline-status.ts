/**
 * 'pipeline status' — Show current pipeline state + agent auth info.
 */

import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { AGENTWEAVE_VERSION } from "@agentweave/types";
import { loadConfig } from "../config-loader.js";
import { listCredentials, hasCredentials } from "../credential-store.js";
import { AGENT_PRESETS } from "../agent-presets.js";

const C = {
	reset: "\x1b[0m",
	bold: "\x1b[1m",
	dim: "\x1b[2m",
	green: "\x1b[32m",
	red: "\x1b[31m",
	yellow: "\x1b[33m",
	cyan: "\x1b[36m",
	gray: "\x1b[90m",
	white: "\x1b[37m",
};
const LINE = "─".repeat(60);

export function pipelineStatusCommand(): void {
	const { config, source } = loadConfig();

	console.log(`\n  ${C.cyan}${C.bold}AgentWeave Pipeline Status${C.reset}`);
	console.log(`  ${C.gray}${LINE}${C.reset}`);
	console.log(`  ${C.white}Version:${C.reset}  ${AGENTWEAVE_VERSION}`);

	// Config source
	const configLabel = source
		? `${C.green}${source}${C.reset}`
		: `${C.yellow}no config file (using defaults)${C.reset}`;
	console.log(`  ${C.white}Config:${C.reset}   ${configLabel}`);

	// Execution mode from config
	const mode = config.execution.mode;
	console.log(`  ${C.white}Mode:${C.reset}     ${C.bold}${mode}${C.reset}`);
	console.log(`  ${C.gray}${LINE}${C.reset}`);

	// Show configured mode status
	switch (mode) {
		case "process-adapter":
			showProcessAdapterStatus(config);
			break;
		case "agent-loop":
			showAgentLoopStatus(config);
			break;
		case "api-direct":
			showApiDirectStatus(config);
			break;
	}

	// Auto-detect installed agent CLIs (regardless of configured mode)
	console.log(`\n  ${C.gray}${LINE}${C.reset}`);
	console.log(`  ${C.white}${C.bold}Detected Agent CLIs:${C.reset}`);
	const detected = detectInstalledAgents();
	if (detected.length > 0) {
		for (const d of detected) {
			console.log(
				`    ${C.green}✓${C.reset} ${d.name.padEnd(18)} ${C.dim}${d.version}${C.reset}${d.auth ? `  ${d.auth}` : ""}`,
			);
		}
		if (mode !== "process-adapter" && !source) {
			console.log(
				`\n  ${C.yellow}Tip:${C.reset} You have agent CLI(s) installed. To use wrap mode:`,
			);
			console.log(
				`  ${C.dim}    agentweave pipeline run "task" --agent ${detected[0]!.key}${C.reset}`,
			);
			console.log(
				`  ${C.dim}    agentweave pipeline config set execution.agent ${detected[0]!.key}${C.reset}`,
			);
		}
	} else {
		console.log(`    ${C.dim}none found${C.reset}`);
		console.log(`    ${C.dim}Install: npm i -g @anthropic-ai/claude-code${C.reset}`);
	}

	// Credentials summary
	console.log(`\n  ${C.gray}${LINE}${C.reset}`);
	const creds = listCredentials();
	if (creds.length > 0) {
		console.log(
			`  ${C.white}Credentials:${C.reset} ${C.green}${creds.length} key(s) stored${C.reset}`,
		);
		for (const c of creds) {
			const scope = c.agent === "*" ? `${C.yellow}global${C.reset}` : c.agent;
			console.log(`    ${c.envVar.padEnd(28)} ${scope.padEnd(15)} ${C.dim}${c.masked}${C.reset}`);
		}
	} else {
		console.log(`  ${C.white}Credentials:${C.reset} ${C.dim}none stored${C.reset}`);
	}

	// Metrics
	console.log(`\n  ${C.gray}${LINE}${C.reset}`);
	const metricsDir = config.metrics.persistPath ?? ".agentweave/metrics";
	if (existsSync(metricsDir)) {
		console.log(`  ${C.white}Metrics:${C.reset}   ${C.green}ON${C.reset} → ${metricsDir}/`);
		console.log(`  ${C.dim}           View: agentweave metrics${C.reset}`);
	} else {
		console.log(
			`  ${C.white}Metrics:${C.reset}   ${C.dim}no data yet (run a task first)${C.reset}`,
		);
	}

	console.log();
}

// ─── Auto-Detect Installed Agents ────────────────────────────────

interface DetectedAgent {
	key: string;
	name: string;
	version: string;
	auth?: string;
}

function detectInstalledAgents(): DetectedAgent[] {
	const detected: DetectedAgent[] = [];

	// Claude Code
	try {
		const version = execSync("claude --version", {
			timeout: 5000,
			encoding: "utf-8",
			stdio: "pipe",
		}).trim();
		let auth = "";
		try {
			const raw = execSync("claude auth status", {
				timeout: 5000,
				encoding: "utf-8",
				stdio: "pipe",
			}).trim();
			const info = JSON.parse(raw);
			if (info.loggedIn) {
				const method =
					info.authMethod === "claude.ai"
						? "subscription"
						: info.authMethod === "api-key"
							? "API key"
							: info.authMethod;
				const plan = info.subscriptionType ? ` (${info.subscriptionType})` : "";
				auth = `${C.green}logged in${C.reset} via ${method}${plan}`;
			} else {
				auth = `${C.red}not logged in${C.reset} ${C.dim}(run: claude login)${C.reset}`;
			}
		} catch {
			/* auth check failed */
		}
		detected.push({ key: "claude", name: "Claude Code", version, auth });
	} catch {
		/* not installed */
	}

	// Aider
	try {
		const version = execSync("aider --version", {
			timeout: 5000,
			encoding: "utf-8",
			stdio: "pipe",
		}).trim();
		const hasKey =
			!!process.env.ANTHROPIC_API_KEY || !!process.env.OPENAI_API_KEY || hasCredentials("aider");
		const auth = hasKey
			? `${C.green}API key available${C.reset}`
			: `${C.yellow}no API key${C.reset}`;
		detected.push({ key: "aider", name: "Aider", version, auth });
	} catch {
		/* not installed */
	}

	// Codex
	try {
		const version = execSync("codex --version", {
			timeout: 5000,
			encoding: "utf-8",
			stdio: "pipe",
		}).trim();
		const hasKey = !!process.env.OPENAI_API_KEY || hasCredentials("codex");
		const auth = hasKey
			? `${C.green}API key available${C.reset}`
			: `${C.yellow}no API key${C.reset}`;
		detected.push({ key: "codex", name: "Codex CLI", version, auth });
	} catch {
		/* not installed */
	}

	return detected;
}

// ─── Process Adapter Status ──────────────────────────────────────

function showProcessAdapterStatus(config: ReturnType<typeof loadConfig>["config"]): void {
	const pa = config.execution.processAdapter;
	if (!pa) {
		console.log(`  ${C.red}✗ No agent configured${C.reset}`);
		console.log(`  ${C.dim}Run: agentweave pipeline setup${C.reset}`);
		return;
	}

	const cmd = pa.command;
	const args = pa.args?.join(" ") ?? "";
	console.log(
		`  ${C.white}Agent:${C.reset}    ${C.bold}${cmd}${C.reset} ${C.dim}${args}${C.reset}`,
	);

	// Check if agent CLI is installed
	process.stdout.write(`  ${C.white}Installed:${C.reset} `);
	try {
		const version = execSync(`${cmd} --version`, {
			timeout: 5000,
			encoding: "utf-8",
			stdio: "pipe",
		}).trim();
		console.log(`${C.green}✓${C.reset} ${C.dim}${version}${C.reset}`);
	} catch {
		console.log(`${C.red}✗ not found${C.reset}`);
		console.log(
			`  ${C.dim}Install: ${AGENT_PRESETS[cmd]?.install ?? `install ${cmd} CLI`}${C.reset}`,
		);
		return;
	}

	// Check agent auth status (Claude Code specific)
	if (cmd === "claude") {
		showClaudeAuthStatus();
	} else if (cmd === "aider") {
		showAiderAuthStatus();
	} else {
		console.log(`  ${C.white}Auth:${C.reset}     ${C.dim}managed by ${cmd} CLI${C.reset}`);
	}
}

function showClaudeAuthStatus(): void {
	try {
		const raw = execSync("claude auth status", {
			timeout: 5000,
			encoding: "utf-8",
			stdio: "pipe",
		}).trim();
		const info = JSON.parse(raw);

		const loggedIn = info.loggedIn === true;
		const method = info.authMethod ?? "unknown";
		const email = info.email ?? "";
		const org = info.orgName ?? "";
		const sub = info.subscriptionType ?? "";

		if (loggedIn) {
			console.log(`  ${C.white}Auth:${C.reset}     ${C.green}✓ logged in${C.reset}`);
			console.log(
				`  ${C.white}Method:${C.reset}   ${C.bold}${method}${C.reset}${method === "claude.ai" ? ` ${C.dim}(subscription — no API key needed)${C.reset}` : method === "api-key" ? ` ${C.dim}(API key)${C.reset}` : ""}`,
			);
			if (email) console.log(`  ${C.white}Account:${C.reset}  ${email}`);
			if (org) console.log(`  ${C.white}Org:${C.reset}      ${org}`);
			if (sub) console.log(`  ${C.white}Plan:${C.reset}     ${C.cyan}${sub}${C.reset}`);
		} else {
			console.log(`  ${C.white}Auth:${C.reset}     ${C.red}✗ not logged in${C.reset}`);
			console.log(`  ${C.dim}Run: claude login${C.reset}`);
		}
	} catch {
		console.log(
			`  ${C.white}Auth:${C.reset}     ${C.yellow}unable to check (run: claude auth status)${C.reset}`,
		);
	}
}

function showAiderAuthStatus(): void {
	const hasKey =
		!!process.env.ANTHROPIC_API_KEY || !!process.env.OPENAI_API_KEY || hasCredentials("aider");
	if (hasKey) {
		console.log(`  ${C.white}Auth:${C.reset}     ${C.green}✓ API key available${C.reset}`);
	} else {
		console.log(`  ${C.white}Auth:${C.reset}     ${C.red}✗ no API key${C.reset}`);
		console.log(`  ${C.dim}Run: agentweave credentials set aider ANTHROPIC_API_KEY${C.reset}`);
	}
}

// ─── Agent Loop Status ───────────────────────────────────────────

function showAgentLoopStatus(config: ReturnType<typeof loadConfig>["config"]): void {
	const al = config.execution.agentLoop;
	const model = al?.model ?? "not configured";

	console.log(`  ${C.white}Model:${C.reset}    ${C.bold}${model}${C.reset}`);

	// Detect provider from model name
	let provider = "unknown";
	let envVar = "";
	if (model.startsWith("claude")) {
		provider = "Anthropic";
		envVar = "ANTHROPIC_API_KEY";
	} else if (model.startsWith("gpt") || model.startsWith("o1") || model.startsWith("o3")) {
		provider = "OpenAI";
		envVar = "OPENAI_API_KEY";
	} else if (model.startsWith("gemini")) {
		provider = "Google";
		envVar = "GOOGLE_GENERATIVE_AI_API_KEY";
	} else if (process.env.OPENROUTER_API_KEY) {
		provider = "OpenRouter";
		envVar = "OPENROUTER_API_KEY";
	}

	console.log(`  ${C.white}Provider:${C.reset} ${provider}`);

	// Check API key
	const hasKey = !!process.env[envVar] || hasCredentials("*");
	if (hasKey) {
		console.log(`  ${C.white}Auth:${C.reset}     ${C.green}✓ ${envVar} available${C.reset}`);
	} else {
		console.log(`  ${C.white}Auth:${C.reset}     ${C.red}✗ ${envVar} not found${C.reset}`);
		console.log(`  ${C.dim}Run: agentweave credentials set "*" ${envVar}${C.reset}`);
	}
}

// ─── API Direct Status ───────────────────────────────────────────

function showApiDirectStatus(config: ReturnType<typeof loadConfig>["config"]): void {
	showAgentLoopStatus(config); // Same auth as agent-loop
	console.log(`  ${C.dim}Note: api-direct mode = single LLM call, no tool execution${C.reset}`);
}
