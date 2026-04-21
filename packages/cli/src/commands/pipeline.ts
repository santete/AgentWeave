/**
 * 'pipeline' command — AgentWeave SDLC Pipeline.
 *
 * Usage:
 *   agentweave pipeline run "Fix the login bug" --agent claude --checks "npm test"
 *   agentweave pipeline show                    Show 8-step pipeline config
 *   agentweave pipeline run "Add feature" --retries 3 --checks "pnpm test:unit,pnpm lint"
 */

import { execSync } from "node:child_process";
import { AGENTWEAVE_VERSION } from "@agentweave/types";
import { createSDLCPipeline } from "@agentweave/inner-harness";
import type { SDLCMetricsSnapshot, SDLCConfig } from "@agentweave/types";
import { loadConfig } from "../config-loader.js";
import { resolveAgent, AGENT_PRESETS, listPresets } from "../agent-presets.js";
import { getAgentEnv, hasCredentials, scrubCredentials, buildChildEnv, ensureGitignore } from "../credential-store.js";

export interface PipelineRunArgs {
	prompt: string;
	agent?: string;
	agentArgs?: string[];
	model?: string;
	checks?: string[];
	retries?: number;
	metricsDir?: string;
}

// ─── ANSI ────────────────────────────────────────────────────────

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
	white: "\x1b[37m",
};

const LINE = "─".repeat(62);

const VALID_CHECK_TYPES = new Set(["test", "lint", "compile", "typecheck", "custom"]);

/** Parse "type:command" or plain "command" into a QualityGateCheck shape. */
function parseCheck(raw: string): { type: string; command: string; required: true } {
	const colonIdx = raw.indexOf(":");
	if (colonIdx > 0 && VALID_CHECK_TYPES.has(raw.slice(0, colonIdx))) {
		return { type: raw.slice(0, colonIdx), command: raw.slice(colonIdx + 1), required: true };
	}
	return { type: "custom", command: raw, required: true };
}
const BOX_T = "┌" + "─".repeat(62) + "┐";
const BOX_B = "└" + "─".repeat(62) + "┘";
const BOX_M = "├" + "─".repeat(62) + "┤";
const BOX_L = "│";

// ─── 8-Step Definition ───────────────────────────────────────────

const STEPS = [
	{ num: 1, key: "taskNormalizer",    name: "Task Normalize",      icon: "📋", desc: "Raw input → structured task (goal, context, constraints)" },
	{ num: 2, key: "contextBuilder",    name: "Context Build",       icon: "🔍", desc: "Discover relevant files, schemas, conventions" },
	{ num: 3, key: "planGenerator",     name: "Plan Generate",       icon: "📝", desc: "Task → step-by-step execution plan" },
	{ num: 4, key: "executionBridge",   name: "Execute",             icon: "⚡", desc: "Delegate to AI agent (Claude, Cursor, Aider...)" },
	{ num: 5, key: "patchValidator",    name: "Patch Validate",      icon: "🔎", desc: "Check scope, file count, no side effects" },
	{ num: 6, key: "qualityGate",       name: "Quality Gate",        icon: "🧪", desc: "Run tests, lint, compile, typecheck" },
	{ num: 7, key: "retryEngine",       name: "Retry Engine",        icon: "🔄", desc: "Classify error → strategy → targeted retry" },
	{ num: 8, key: "outputStandardizer", name: "Output Standardize", icon: "📦", desc: "Generate commit message, PR description" },
] as const;

// ─── pipeline show ───────────────────────────────────────────────

export function pipelineShowCommand(cliOverrides?: { checks?: string[]; retries?: number; agent?: string; model?: string }): void {
	// Load real config from agentweave.yaml (or defaults)
	const { config, source } = loadConfig();

	// CLI flags override config
	if (cliOverrides?.agent) {
		config.execution.mode = "process-adapter";
		config.execution.processAdapter = { command: cliOverrides.agent };
	}
	if (cliOverrides?.checks && cliOverrides.checks.length > 0) {
		config.modules.qualityGate.enabled = true;
		(config.modules.qualityGate as Record<string, unknown>).checks = cliOverrides.checks.map(parseCheck);
	}
	if (cliOverrides?.retries !== undefined) {
		config.modules.retryEngine.maxRetries = cliOverrides.retries;
	}

	const sourceLabel = source ? `from ${source}` : "defaults (no agentweave.yaml found)";

	console.log(`\n  ${C.cyan}${C.bold}AgentWeave SDLC Pipeline${C.reset}`);
	console.log(`  ${C.dim}8-Step AI Development Workflow${C.reset}`);
	console.log(`  ${C.dim}Config: ${sourceLabel}${C.reset}`);
	console.log(`  ${C.gray}${LINE}${C.reset}`);

	// Execution target
	const mode = config.execution.mode;
	if (mode === "process-adapter" && config.execution.processAdapter) {
		const cmd = config.execution.processAdapter.command;
		const extra = config.execution.processAdapter.args?.join(" ") ?? "";
		console.log(`  ${C.white}Agent:${C.reset}   ${cmd} ${extra}`);
	} else if (mode === "agent-loop" && config.execution.agentLoop) {
		console.log(`  ${C.white}Mode:${C.reset}    agent-loop (${config.execution.agentLoop.model})`);
	} else {
		console.log(`  ${C.white}Mode:${C.reset}    ${mode}`);
	}

	// Metrics
	const metricsOn = config.metrics.enabled;
	console.log(`  ${C.white}Metrics:${C.reset} ${metricsOn ? `${C.green}ON${C.reset}` : `${C.gray}OFF${C.reset}`}${config.metrics.persistPath ? ` → ${config.metrics.persistPath}` : ""}`);
	console.log(`  ${C.gray}${LINE}${C.reset}`);

	// Separate steps into categories based on wrap mode
	const isWrapMode = config.execution.mode === "process-adapter" ||
		(config.execution.mode === "agent-loop" && !config.modules.taskNormalizer.enabled);

	if (isWrapMode) {
		// Show agent-handled vs agentweave-added sections
		console.log(`\n  ${C.gray}Agent handles: task understanding, planning, code generation${C.reset}`);
		console.log(`  ${C.gray}${LINE}${C.reset}`);
		console.log(`  ${C.cyan}${C.bold}AgentWeave adds: QA + Validation + Metrics${C.reset}`);
	}

	// 8 steps
	for (const step of STEPS) {
		const modConf = config.modules[step.key as keyof SDLCConfig["modules"]];
		const enabled = modConf?.enabled ?? false;
		const statusTag = enabled ? `${C.green}${C.bold} ON ${C.reset}` : `${C.gray} OFF${C.reset}`;

		// In wrap mode: dim the agent-handled steps, highlight unique value
		const isUniqueValue = ["patchValidator", "qualityGate", "retryEngine"].includes(step.key);
		const isMetrics = step.key === "executionBridge"; // bridge is always needed

		// Build detail string from config
		const detail = getModuleDetail(step.key, modConf, config);

		console.log();
		if (isWrapMode && !enabled && !isUniqueValue && !isMetrics) {
			// Dim disabled steps that agent handles
			console.log(`  ${C.gray}${step.icon} Step ${step.num}  ${step.name}${" ".repeat(Math.max(0, 22 - step.name.length))}[ OFF] agent handles this${C.reset}`);
		} else if (isWrapMode && isUniqueValue && enabled) {
			// Highlight unique value steps
			console.log(`  ${step.icon} ${C.bold}Step ${step.num}${C.reset}  ${C.white}${C.bold}${step.name}${C.reset}${" ".repeat(Math.max(0, 22 - step.name.length))}[${statusTag}] ${C.cyan}★ unique value${C.reset}`);
			console.log(`     ${C.dim}${step.desc}${C.reset}`);
			if (detail) console.log(`     ${C.cyan}${detail}${C.reset}`);
		} else {
			console.log(`  ${step.icon} ${C.bold}Step ${step.num}${C.reset}  ${C.white}${step.name}${C.reset}${" ".repeat(Math.max(0, 22 - step.name.length))}[${statusTag}]`);
			console.log(`     ${C.dim}${step.desc}${C.reset}`);
			if (detail) console.log(`     ${C.cyan}${detail}${C.reset}`);
		}

		if (step.num < 8) {
			console.log(`     ${C.gray}↓${C.reset}`);
		}
	}

	console.log(`\n  ${C.gray}${LINE}${C.reset}`);
	console.log(`  ${C.dim}Metrics M1-M10 collected automatically.${C.reset}`);
	if (isWrapMode) {
		console.log(`  ${C.dim}★ = what AgentWeave adds that your agent can't do alone.${C.reset}`);
	}
	console.log(`  ${C.dim}Edit agentweave.yaml to change config. CLI flags override.${C.reset}\n`);
}

/** Extract meaningful detail from module config. */
function getModuleDetail(key: string, modConf: Record<string, unknown>, config: SDLCConfig): string {
	if (!modConf?.enabled) return "";
	const c = modConf as Record<string, unknown>;

	switch (key) {
		case "taskNormalizer":
			return c.model ? `model: ${c.model}` : "";
		case "contextBuilder": {
			const parts: string[] = [];
			if (c.maxFiles) parts.push(`maxFiles: ${c.maxFiles}`);
			if (c.maxTokens) parts.push(`maxTokens: ${c.maxTokens}`);
			if (Array.isArray(c.includePatterns) && c.includePatterns.length > 0)
				parts.push(`include: ${(c.includePatterns as string[]).join(", ")}`);
			return parts.join("  ");
		}
		case "planGenerator": {
			const parts: string[] = [];
			if (c.model) parts.push(`model: ${c.model}`);
			if (c.maxSteps) parts.push(`maxSteps: ${c.maxSteps}`);
			return parts.join("  ");
		}
		case "executionBridge":
			return ""; // already shown in Agent/Mode line above
		case "patchValidator": {
			const parts: string[] = [];
			if (c.maxFilesChanged) parts.push(`maxFiles: ${c.maxFilesChanged}`);
			if (c.scopeStrict) parts.push("strict: yes");
			return parts.join("  ");
		}
		case "qualityGate": {
			const checks = c.checks as Array<{ command: string; required: boolean }> | undefined;
			if (!checks || checks.length === 0) return "no checks configured";
			return checks.map((ch) => `${ch.required ? "●" : "○"} ${ch.command}`).join("  ");
		}
		case "retryEngine": {
			const parts: string[] = [];
			if (c.maxRetries !== undefined) parts.push(`max: ${c.maxRetries}`);
			const strategies = c.strategies as Array<{ errorType: string; action: string }> | undefined;
			if (strategies && strategies.length > 0)
				parts.push(strategies.map((s) => `${s.errorType}→${s.action}`).join(", "));
			return parts.join("  ");
		}
		case "outputStandardizer":
			return c.commitFormat ? `format: ${c.commitFormat}` : "";
		default:
			return "";
	}
}

// ─── pipeline run ────────────────────────────────────────────────

// ─── pipeline agents ─────────────────────────────────────────────

export function pipelineAgentsCommand(): void {
	console.log(`\n  ${C.cyan}${C.bold}Supported AI Agent CLIs${C.reset}`);
	console.log(`  ${C.gray}${LINE}${C.reset}\n`);

	for (const [key, preset] of Object.entries(AGENT_PRESETS)) {
		if (key === "custom") continue;
		const tag = `${C.bold}--agent ${key}${C.reset}`;
		console.log(`  ${tag}`);
		console.log(`  ${C.white}${preset.name}${C.reset}`);
		console.log(`  ${C.dim}Command:  ${preset.command} ${preset.args.join(" ")}${C.reset}`);
		console.log(`  ${C.dim}Prompt:   via ${preset.promptMode}${C.reset}`);
		console.log(`  ${C.dim}Install:  ${preset.install}${C.reset}`);
		console.log(`  ${C.dim}Notes:    ${preset.notes}${C.reset}`);
		console.log();
	}

	console.log(`  ${C.bold}--agent <custom-command>${C.reset}`);
	console.log(`  ${C.white}Any CLI tool${C.reset}`);
	console.log(`  ${C.dim}Prompt sent via stdin. Stdout parsed as text.${C.reset}`);
	console.log(`  ${C.dim}Example: --agent "python my_agent.py"${C.reset}`);

	console.log(`\n  ${C.gray}${LINE}${C.reset}`);
	console.log(`  ${C.dim}Usage: agentweave pipeline run "task" --agent <name>${C.reset}`);
	console.log(`  ${C.dim}Custom: agentweave pipeline run "task" --agent ./my-agent.sh${C.reset}\n`);
}

// ─── pipeline run ────────────────────────────────────────────────

export async function pipelineRunCommand(args: PipelineRunArgs): Promise<void> {
	const startTime = Date.now();
	let hasAgent = !!args.agent;
	const model = args.model ?? "claude-sonnet-4-6";
	const retries = args.retries ?? 3;
	const metricsDir = args.metricsDir ?? ".agentweave/metrics";

	// Smart auto-detect: no config + no --agent → find best available agent
	const { config: loadedConfig, source } = loadConfig();
	if (!hasAgent) {
		// Check if config has agent set
		if (loadedConfig.execution.mode === "process-adapter" && loadedConfig.execution.processAdapter?.command) {
			args.agent = loadedConfig.execution.processAdapter.command;
			hasAgent = true;
		} else if (!source) {
			// No config file — auto-detect installed agents
			const detected = autoDetectAgent();
			if (detected) {
				args.agent = detected.key;
				hasAgent = true;
				console.log(`\n  ${C.green}Auto-detected:${C.reset} ${detected.name} (${detected.version})`);
				console.log(`  ${C.dim}Save as default: agentweave pipeline config set execution.agent ${detected.key}${C.reset}`);
			} else {
				// No agent CLI found, no API key → guide user
				console.log(`\n  ${C.yellow}${C.bold}No agent CLI detected and no API key configured.${C.reset}`);
				console.log(`  ${C.dim}Setup your environment:${C.reset}\n`);
				console.log(`    ${C.cyan}agentweave pipeline setup${C.reset}      ${C.dim}Guided wizard${C.reset}`);
				console.log(`    ${C.cyan}agentweave pipeline status${C.reset}     ${C.dim}Check what's available${C.reset}\n`);
				console.log(`  ${C.dim}Or install an agent CLI:${C.reset}`);
				console.log(`    ${C.dim}npm i -g @anthropic-ai/claude-code && claude login${C.reset}\n`);
				return;
			}
		}
	}

	// Ensure .agentweave/ is gitignored (credentials, metrics)
	ensureGitignore();

	// Resolve agent preset
	const agent = hasAgent ? resolveAgent(args.agent!) : null;
	if (agent && args.agentArgs) {
		agent.args.push(...args.agentArgs);
	}

	const checks = (args.checks ?? []).map(parseCheck);

	// Header
	console.log(`\n  ${BOX_T}`);
	console.log(`  ${BOX_L}  ${C.cyan}${C.bold}AgentWeave SDLC Pipeline v${AGENTWEAVE_VERSION}${C.reset}${" ".repeat(34 - AGENTWEAVE_VERSION.length)}${BOX_L}`);
	console.log(`  ${BOX_M}`);
	console.log(`  ${BOX_L}  ${C.white}Task:${C.reset}    ${truncate(args.prompt, 52)}${" ".repeat(Math.max(0, 53 - Math.min(args.prompt.length, 52)))}${BOX_L}`);

	if (agent) {
		const label = agent.presetName ?? args.agent!;
		const cmdStr = `${agent.command} ${agent.args.join(" ")}`.trim();
		console.log(`  ${BOX_L}  ${C.white}Agent:${C.reset}   ${truncate(label, 52)}${" ".repeat(Math.max(0, 53 - Math.min(label.length, 52)))}${BOX_L}`);
		console.log(`  ${BOX_L}  ${C.dim}         ${truncate(cmdStr, 52)}${C.reset}${" ".repeat(Math.max(0, 53 - Math.min(cmdStr.length, 52)))}${BOX_L}`);
	} else {
		console.log(`  ${BOX_L}  ${C.white}Mode:${C.reset}    agent-loop (${model})${" ".repeat(Math.max(0, 37 - model.length))}${BOX_L}`);
	}

	if (checks.length > 0) {
		const checksStr = checks.map((c) => c.command).join(", ");
		console.log(`  ${BOX_L}  ${C.white}Checks:${C.reset}  ${truncate(checksStr, 52)}${" ".repeat(Math.max(0, 53 - Math.min(checksStr.length, 52)))}${BOX_L}`);
	}

	console.log(`  ${BOX_L}  ${C.white}Retries:${C.reset} ${retries}${" ".repeat(52)}${BOX_L}`);

	// Credential injection for agent mode
	let agentEnv: Record<string, string> | undefined;
	if (agent) {
		const agentKey = args.agent!.toLowerCase();
		const credEnv = getAgentEnv(agentKey);
		// Subscription-mode claude CLI manages its own auth; API key would force API mode (and fail if invalid)
		if (agentKey === "claude" || agentKey === "claude-json") delete credEnv.ANTHROPIC_API_KEY;
		const credCount = Object.keys(credEnv).length;
		if (credCount > 0) {
			agentEnv = credEnv;
			const keyNames = Object.keys(credEnv).join(", ");
			console.log(`  ${BOX_L}  ${C.green}Keys:${C.reset}    ${truncate(keyNames, 52)} ${C.dim}(auto-injected)${C.reset}${" ".repeat(Math.max(0, 20 - Math.min(keyNames.length, 15)))}${BOX_L}`);
		} else if (!hasCredentials("*")) {
			console.log(`  ${BOX_L}  ${C.yellow}Keys:${C.reset}    ${C.dim}none (set with: agentweave credentials set)${C.reset}${" ".repeat(6)}${BOX_L}`);
		}
	}

	console.log(`  ${BOX_B}`);

	// Pipeline visual
	console.log();
	printPipelineProgress(0, "starting");

	// Smart defaults: wrap mode (agent CLI) vs direct mode (agent-loop)
	// Wrap mode: agent already handles task understanding, planning, context — AgentWeave
	// adds QA layer on top (validate, test, retry, measure)
	// Direct mode: AgentWeave handles full SDLC pipeline internally
	const isWrapMode = !!agent;

	const pipeline = createSDLCPipeline({
		execution: agent
			? { mode: "process-adapter", processAdapter: { command: agent.command, args: agent.args, promptMode: agent.promptMode, env: agentEnv ? buildChildEnv(agentEnv) : undefined } }
			: { mode: "agent-loop", agentLoop: { model, maxTurns: 50 } },
		modules: {
			// In wrap mode: agent handles these → OFF (agent does it better)
			// In direct mode: AgentWeave handles these → ON
			taskNormalizer: { enabled: !isWrapMode },
			contextBuilder: { enabled: !isWrapMode, maxFiles: 15 },
			planGenerator: { enabled: !isWrapMode },

			// Always ON
			executionBridge: { enabled: true },

			// AgentWeave's unique value — agent can't do these
			patchValidator: { enabled: true },
			qualityGate: { enabled: checks.length > 0, checks },
			retryEngine: { enabled: true, maxRetries: retries },

			// Optional
			outputStandardizer: { enabled: false },
		},
		metrics: { enabled: true, baseline: true, persistPath: metricsDir },
	});

	// Run pipeline
	let currentStep = 0;

	try {
		const gen = pipeline.run(args.prompt);
		for (;;) {
			const { value: event, done } = await gen.next();
			if (done) break;

			if (event.type === "message:assistant") {
				const content = (event as unknown as Record<string, unknown>).content as Array<{ type: string; text: string }>;
				const text = content?.[0]?.text ?? "";

				if (text.startsWith("[SDLC]")) {
					const phase = text.replace("[SDLC] ", "");
					const stepIdx = matchPhaseToStep(phase);
					if (stepIdx > currentStep) {
						currentStep = stepIdx;
						printPipelineProgress(currentStep, "running");
					}
				} else if (text.length > 0 && text.length < 300) {
					console.log(`${C.dim}    ${scrubCredentials(text.slice(0, 120))}${C.reset}`);
				}
			}

			if (event.type === "tool:completed") {
				const e = event as unknown as Record<string, unknown>;
				console.log(`${C.green}    ✓ ${e.toolName}${C.reset} ${C.dim}${((e.durationMs as number) ?? 0).toFixed(0)}ms${C.reset}`);
			}
			if (event.type === "tool:failed") {
				const e = event as unknown as Record<string, unknown>;
				console.log(`${C.red}    ✗ ${e.toolName}: ${scrubCredentials(String(e.error))}${C.reset}`);
			}
			if (event.type === "error") {
				const e = event as unknown as Record<string, unknown>;
				console.log(`${C.red}    ERROR: ${scrubCredentials(String(e.error))}${C.reset}`);
			}
		}
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		console.log(`\n${C.red}  Pipeline error: ${scrubCredentials(msg)}${C.reset}`);
	}

	printPipelineProgress(9, "done");

	// Results
	const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
	const metrics = pipeline.getLastMetrics();
	const comparison = pipeline.getLastComparison();

	console.log(`\n  ${BOX_T}`);
	console.log(`  ${BOX_L}  ${C.cyan}${C.bold}Pipeline Results${C.reset}${" ".repeat(44)}${BOX_L}`);
	console.log(`  ${BOX_M}`);

	if (metrics) {
		printMetricsBox(metrics, elapsed);

		if (comparison?.baseline) {
			console.log(`  ${BOX_M}`);
			console.log(`  ${BOX_L}  ${C.cyan}${C.bold}vs. Previous Run${C.reset}${" ".repeat(43)}${BOX_L}`);
			console.log(`  ${BOX_M}`);
			printComparisonBox(comparison.deltas);
		}
	} else {
		console.log(`  ${BOX_L}  ${C.yellow}No metrics collected${C.reset}${" ".repeat(40)}${BOX_L}`);
	}

	console.log(`  ${BOX_M}`);
	console.log(`  ${BOX_L}  ${C.dim}Saved: ${metricsDir}/baseline.json${C.reset}${" ".repeat(Math.max(0, 55 - metricsDir.length - 14))}${BOX_L}`);
	console.log(`  ${BOX_L}  ${C.dim}View:  agentweave metrics${C.reset}${" ".repeat(35)}${BOX_L}`);
	console.log(`  ${BOX_B}\n`);
}

// ─── Pipeline Progress Visual ────────────────────────────────────

function printPipelineProgress(activeStep: number, state: "starting" | "running" | "done"): void {
	const steps = ["1:Norm", "2:Ctx", "3:Plan", "4:Exec", "5:Patch", "6:QA", "7:Retry", "8:Out"];

	const parts = steps.map((label, i) => {
		const stepNum = i + 1;
		if (stepNum < activeStep) return `${C.green}[${label}]${C.reset}`;
		if (stepNum === activeStep) return `${C.cyan}${C.bold}[${label}]${C.reset}`;
		return `${C.gray}[${label}]${C.reset}`;
	});

	const arrows = steps.slice(1).map((_, i) => {
		const stepNum = i + 2;
		if (stepNum <= activeStep) return `${C.green}→${C.reset}`;
		return `${C.gray}→${C.reset}`;
	});

	let line = "  ";
	for (let i = 0; i < parts.length; i++) {
		line += parts[i];
		if (i < arrows.length) line += arrows[i];
	}

	if (state === "done") {
		line += ` ${C.green}${C.bold} DONE${C.reset}`;
	}

	console.log(line);
}

function matchPhaseToStep(phase: string): number {
	if (phase.includes("Normaliz")) return 1;
	if (phase.includes("context") || phase.includes("Context")) return 2;
	if (phase.includes("plan") || phase.includes("Plan")) return 3;
	if (phase.includes("Execut")) return 4;
	if (phase.includes("Validat") && phase.includes("patch")) return 5;
	if (phase.includes("Validat")) return 5;
	if (phase.includes("quality") || phase.includes("Quality")) return 6;
	if (phase.includes("Retry")) return 7;
	if (phase.includes("Standard")) return 8;
	return 0;
}

// ─── Metrics Box ─────────────────────────────────────────────────

function printMetricsBox(m: SDLCMetricsSnapshot, elapsed: string): void {
	const pass = m.m1_firstPassSuccess;
	const icon = pass ? `${C.green}✓ PASS` : `${C.red}✗ FAIL`;

	console.log(`  ${BOX_L}  ${icon}${C.reset}  First-pass success${" ".repeat(36)}${BOX_L}`);
	console.log(`  ${BOX_L}${" ".repeat(62)}${BOX_L}`);
	printMetricLine("Test pass rate", `${(m.m2_testPassRate * 100).toFixed(0)}%`, m.m2_testPassRate);
	printMetricLine("Scope accuracy", `${(m.m3_scopeAccuracy * 100).toFixed(0)}%`, m.m3_scopeAccuracy);
	printMetricLine("Plan accuracy", `${(m.m8_planAccuracy * 100).toFixed(0)}%`, m.m8_planAccuracy);
	console.log(`  ${BOX_L}  Retry count:      ${m.m4_retryCount}${" ".repeat(Math.max(0, 41 - String(m.m4_retryCount).length))}${BOX_L}`);
	console.log(`  ${BOX_L}  Cost:             $${m.m5_costUsd.toFixed(4)}${" ".repeat(Math.max(0, 40 - m.m5_costUsd.toFixed(4).length))}${BOX_L}`);
	console.log(`  ${BOX_L}  Time:             ${elapsed}s${" ".repeat(Math.max(0, 41 - elapsed.length - 1))}${BOX_L}`);

	if (m.m7_regressionDetected) {
		console.log(`  ${BOX_L}  ${C.red}⚠ Regression detected${C.reset}${" ".repeat(38)}${BOX_L}`);
	}
}

function printMetricLine(label: string, valueStr: string, ratio: number): void {
	const barW = 15;
	const filled = Math.round(ratio * barW);
	const bar = "█".repeat(filled) + "░".repeat(barW - filled);
	const color = ratio >= 0.8 ? C.green : ratio >= 0.5 ? C.yellow : C.red;
	const padLabel = (label + " ".repeat(17)).slice(0, 17);
	const padVal = (valueStr + " ".repeat(5)).slice(0, 5);
	console.log(`  ${BOX_L}  ${padLabel}${color}${bar}${C.reset} ${padVal}${" ".repeat(19)}${BOX_L}`);
}

function printComparisonBox(deltas: Record<string, number>): void {
	const LABELS: Record<string, string> = {
		m2_testPassRate: "Test pass rate",
		m3_scopeAccuracy: "Scope accuracy",
		m4_retryCount: "Retry count",
		m5_costUsd: "Cost",
		m6_timeToCompletionMs: "Time",
		m8_planAccuracy: "Plan accuracy",
	};
	const POSITIVE = new Set(["m2_testPassRate", "m3_scopeAccuracy", "m8_planAccuracy"]);

	for (const [key, delta] of Object.entries(deltas)) {
		if (Math.abs(delta) < 0.001) continue;
		const label = LABELS[key];
		if (!label) continue;

		const isGood = POSITIVE.has(key) ? delta > 0 : delta < 0;
		const icon = isGood ? `${C.green}▲` : `${C.red}▼`;
		const sign = delta > 0 ? "+" : "";
		const fmt = key.includes("cost") || key.includes("Cost")
			? `${sign}$${delta.toFixed(4)}`
			: key.includes("retry") || key.includes("Retry")
				? `${sign}${delta}`
				: `${sign}${(delta * 100).toFixed(1)}%`;

		const padLabel = (label + " ".repeat(17)).slice(0, 17);
		console.log(`  ${BOX_L}  ${icon} ${padLabel}${fmt}${C.reset}${" ".repeat(Math.max(0, 39 - fmt.length))}${BOX_L}`);
	}
}

function truncate(s: string, max: number): string {
	return s.length > max ? s.slice(0, max - 3) + "..." : s;
}

// ─── Auto-Detect Best Available Agent ────────────────────────────

interface DetectedAgentInfo { key: string; name: string; version: string; loggedIn: boolean }

function autoDetectAgent(): DetectedAgentInfo | null {
	// Priority: claude > aider > codex (claude has best tool calling + subscription support)
	const candidates: Array<{ key: string; name: string; cmd: string; authCheck?: () => boolean }> = [
		{
			key: "claude", name: "Claude Code", cmd: "claude",
			authCheck: () => {
				try {
					const raw = execSync("claude auth status", { timeout: 5000, encoding: "utf-8", stdio: "pipe" });
					return JSON.parse(raw).loggedIn === true;
				} catch { return false; }
			},
		},
		{ key: "aider", name: "Aider", cmd: "aider" },
		{ key: "codex", name: "Codex CLI", cmd: "codex" },
	];

	for (const c of candidates) {
		try {
			const version = execSync(`${c.cmd} --version`, { timeout: 5000, encoding: "utf-8", stdio: "pipe" }).trim();
			const loggedIn = c.authCheck ? c.authCheck() : true;
			if (loggedIn) {
				return { key: c.key, name: c.name, version, loggedIn };
			}
		} catch { /* not installed */ }
	}

	return null;
}
