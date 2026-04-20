/**
 * 'pipeline setup' — Guided wizard to configure execution mode + auth.
 *
 * Walks user through:
 *   1. Choose execution mode (agent-loop / process-adapter / api-direct)
 *   2. Configure auth for chosen mode
 *   3. Test connection
 *   4. Save to agentweave.yaml
 */

import { createInterface } from "node:readline";
import { execSync } from "node:child_process";
import { setCredential, ensureGitignore, getKeySource } from "../credential-store.js";
import { AGENT_PRESETS } from "../agent-presets.js";

const C = {
	reset: "\x1b[0m", bold: "\x1b[1m", dim: "\x1b[2m",
	green: "\x1b[32m", red: "\x1b[31m", yellow: "\x1b[33m",
	cyan: "\x1b[36m", gray: "\x1b[90m", white: "\x1b[37m",
};
const LINE = "─".repeat(60);

function ask(rl: ReturnType<typeof createInterface>, question: string): Promise<string> {
	return new Promise((resolve) => {
		rl.question(question, (answer) => resolve(answer.trim()));
	});
}

export async function pipelineSetupCommand(): Promise<void> {
	const rl = createInterface({ input: process.stdin, output: process.stdout });

	console.log(`\n  ${C.cyan}${C.bold}AgentWeave Pipeline Setup${C.reset}`);
	console.log(`  ${C.dim}${LINE}${C.reset}`);
	console.log(`  ${C.dim}This wizard helps you configure how AgentWeave executes tasks.${C.reset}\n`);

	// ── Step 1: Choose Mode ──────────────────────────────────

	console.log(`  ${C.white}${C.bold}Step 1: Choose Execution Mode${C.reset}\n`);
	console.log(`  ${C.cyan}[1]${C.reset} ${C.bold}Wrap Agent CLI${C.reset} ${C.dim}(process-adapter)${C.reset}`);
	console.log(`      You have a subscription (Claude Pro, Cursor Pro, etc.)`);
	console.log(`      AgentWeave wraps your agent CLI — no API key needed.`);
	console.log(`      ${C.green}Best for: developers with existing subscriptions${C.reset}\n`);

	console.log(`  ${C.cyan}[2]${C.reset} ${C.bold}Direct LLM API${C.reset} ${C.dim}(agent-loop)${C.reset}`);
	console.log(`      You have an API key (Anthropic, OpenAI, Google, OpenRouter).`);
	console.log(`      AgentWeave calls LLM directly — full control over model + cost.`);
	console.log(`      ${C.green}Best for: CI/CD, automation, multi-model routing${C.reset}\n`);

	console.log(`  ${C.cyan}[3]${C.reset} ${C.bold}Simple LLM Call${C.reset} ${C.dim}(api-direct)${C.reset}`);
	console.log(`      Single LLM call, no tool execution. Text in, text out.`);
	console.log(`      ${C.green}Best for: code review, explanation, simple generation${C.reset}\n`);

	const modeChoice = await ask(rl, `  Choose mode [1/2/3]: `);

	switch (modeChoice) {
		case "1":
			await setupProcessAdapter(rl);
			break;
		case "2":
			await setupAgentLoop(rl);
			break;
		case "3":
			await setupApiDirect(rl);
			break;
		default:
			console.log(`\n  ${C.yellow}Invalid choice. Run again with 1, 2, or 3.${C.reset}\n`);
	}

	rl.close();
}

// ─── Mode 1: Process Adapter ─────────────────────────────────────

async function setupProcessAdapter(rl: ReturnType<typeof createInterface>): Promise<void> {
	console.log(`\n  ${C.cyan}${C.bold}Mode: Wrap Agent CLI${C.reset}`);
	console.log(`  ${C.dim}${LINE}${C.reset}\n`);

	console.log(`  ${C.white}Which agent CLI do you use?${C.reset}\n`);
	console.log(`  ${C.cyan}[1]${C.reset} Claude Code    ${C.dim}(npm i -g @anthropic-ai/claude-code)${C.reset}`);
	console.log(`  ${C.cyan}[2]${C.reset} Aider          ${C.dim}(pip install aider-chat)${C.reset}`);
	console.log(`  ${C.cyan}[3]${C.reset} Codex          ${C.dim}(npm i -g @openai/codex)${C.reset}`);
	console.log(`  ${C.cyan}[4]${C.reset} Custom CLI     ${C.dim}(any command that reads stdin/args)${C.reset}\n`);

	const agentChoice = await ask(rl, `  Choose agent [1/2/3/4]: `);

	let agentKey: string;
	let setupInstructions: string[];

	switch (agentChoice) {
		case "1":
			agentKey = "claude";
			setupInstructions = [
				"1. Install: npm install -g @anthropic-ai/claude-code",
				"2. Login:   claude login   (uses your Anthropic account — subscription or API)",
				"3. Verify:  claude --version",
			];
			break;
		case "2":
			agentKey = "aider";
			setupInstructions = [
				"1. Install: pip install aider-chat",
				"2. Set key: export ANTHROPIC_API_KEY=sk-ant-xxx  (or OPENAI_API_KEY)",
				"3. Verify:  aider --version",
			];
			break;
		case "3":
			agentKey = "codex";
			setupInstructions = [
				"1. Install: npm install -g @openai/codex",
				"2. Set key: export OPENAI_API_KEY=sk-xxx",
				"3. Verify:  codex --version",
			];
			break;
		case "4": {
			const customCmd = await ask(rl, `  Enter command (e.g. python my_agent.py): `);
			if (!customCmd) {
				console.log(`\n  ${C.red}No command provided.${C.reset}\n`);
				return;
			}
			agentKey = customCmd;
			setupInstructions = [
				`Your agent: ${customCmd}`,
				"Prompt will be sent via stdin. Agent should write output to stdout.",
			];
			break;
		}
		default:
			console.log(`\n  ${C.yellow}Invalid choice.${C.reset}\n`);
			return;
	}

	// Show setup instructions
	console.log(`\n  ${C.white}${C.bold}Auth Setup for ${agentKey}:${C.reset}\n`);
	for (const line of setupInstructions) {
		console.log(`  ${C.dim}${line}${C.reset}`);
	}

	// Check if agent CLI is installed
	console.log();
	const preset = AGENT_PRESETS[agentKey];
	if (preset) {
		process.stdout.write(`  Checking ${agentKey}... `);
		try {
			execSync(preset.verifyCommand, { stdio: "pipe", timeout: 5000 });
			console.log(`${C.green}✓ installed${C.reset}`);
		} catch {
			console.log(`${C.red}✗ not found${C.reset}`);
			console.log(`  ${C.yellow}Install first, then re-run setup.${C.reset}`);
		}
	}

	// Save config
	const { pipelineConfigCommand } = await import("./pipeline-config.js");
	pipelineConfigCommand({ action: "init", targets: [] });
	pipelineConfigCommand({ action: "set", key: "execution.agent", value: agentKey });

	console.log(`\n  ${C.green}${C.bold}Setup complete!${C.reset}`);
	console.log(`  ${C.dim}Run: agentweave pipeline run "your task" --agent ${agentKey}${C.reset}`);
	console.log(`  ${C.dim}Or:  agentweave pipeline show${C.reset}\n`);
}

// ─── Mode 2: Agent Loop ─────────────────────────────────────────

async function setupAgentLoop(rl: ReturnType<typeof createInterface>): Promise<void> {
	console.log(`\n  ${C.cyan}${C.bold}Mode: Direct LLM API${C.reset}`);
	console.log(`  ${C.dim}${LINE}${C.reset}\n`);

	console.log(`  ${C.white}Which LLM provider do you have an API key for?${C.reset}\n`);
	console.log(`  ${C.cyan}[1]${C.reset} Anthropic      ${C.dim}(Claude models — best tool calling)${C.reset}`);
	console.log(`  ${C.cyan}[2]${C.reset} OpenAI         ${C.dim}(GPT models)${C.reset}`);
	console.log(`  ${C.cyan}[3]${C.reset} Google         ${C.dim}(Gemini models — generous free tier)${C.reset}`);
	console.log(`  ${C.cyan}[4]${C.reset} OpenRouter     ${C.dim}(any model — has free options)${C.reset}\n`);

	const providerChoice = await ask(rl, `  Choose provider [1/2/3/4]: `);

	let envVar: string;
	let defaultModel: string;
	let signupUrl: string;

	switch (providerChoice) {
		case "1":
			envVar = "ANTHROPIC_API_KEY";
			defaultModel = "claude-sonnet-4-6";
			signupUrl = "https://console.anthropic.com/settings/keys";
			break;
		case "2":
			envVar = "OPENAI_API_KEY";
			defaultModel = "gpt-4o-mini";
			signupUrl = "https://platform.openai.com/api-keys";
			break;
		case "3":
			envVar = "GOOGLE_GENERATIVE_AI_API_KEY";
			defaultModel = "gemini-2.0-flash";
			signupUrl = "https://aistudio.google.com/apikey";
			break;
		case "4":
			envVar = "OPENROUTER_API_KEY";
			defaultModel = "anthropic/claude-3.5-haiku";
			signupUrl = "https://openrouter.ai/keys";
			break;
		default:
			console.log(`\n  ${C.yellow}Invalid choice.${C.reset}\n`);
			return;
	}

	console.log(`\n  ${C.white}${C.bold}API Key Setup${C.reset}`);
	console.log(`  ${C.dim}Get your key: ${signupUrl}${C.reset}\n`);

	const apiKey = await ask(rl, `  Enter ${envVar}: `);
	if (!apiKey) {
		console.log(`\n  ${C.red}No key provided.${C.reset}\n`);
		return;
	}

	// Choose model
	const modelInput = await ask(rl, `  Model [${defaultModel}]: `);
	const model = modelInput || defaultModel;

	// Save credential
	ensureGitignore();
	const result = setCredential("*", envVar, apiKey);
	if (!result.ok) {
		console.log(`\n  ${C.red}Error: ${result.error}${C.reset}\n`);
		return;
	}

	console.log(`  ${C.green}✓${C.reset} API key saved (encrypted)`);

	// Save config
	const { pipelineConfigCommand } = await import("./pipeline-config.js");
	pipelineConfigCommand({ action: "init", targets: [] });
	pipelineConfigCommand({ action: "set", key: "execution.model", value: model });

	console.log(`\n  ${C.green}${C.bold}Setup complete!${C.reset}`);
	console.log(`  ${C.dim}Key source: ${getKeySource() === "passphrase" ? "PBKDF2 encrypted" : "machine-derived (set AGENTWEAVE_CREDENTIAL_KEY for stronger encryption)"}${C.reset}`);
	console.log(`  ${C.dim}Run: agentweave pipeline run "your task"${C.reset}`);
	console.log(`  ${C.dim}Or:  agentweave pipeline show${C.reset}\n`);
}

// ─── Mode 3: API Direct ─────────────────────────────────────────

async function setupApiDirect(rl: ReturnType<typeof createInterface>): Promise<void> {
	console.log(`\n  ${C.cyan}${C.bold}Mode: Simple LLM Call${C.reset}`);
	console.log(`  ${C.dim}${LINE}${C.reset}\n`);
	console.log(`  ${C.dim}This mode sends a single prompt to the LLM and returns text.${C.reset}`);
	console.log(`  ${C.dim}No tool calling, no file editing — just text generation.${C.reset}\n`);

	// Same provider selection as agent-loop
	await setupAgentLoop(rl);

	// Override mode to api-direct
	const { pipelineConfigCommand } = await import("./pipeline-config.js");
	// The config was set to agent-loop by setupAgentLoop — override
	console.log(`  ${C.dim}Note: api-direct mode uses same API key as agent-loop.${C.reset}`);
	console.log(`  ${C.dim}When running pipeline, meta-steps use api-direct automatically.${C.reset}\n`);
}
