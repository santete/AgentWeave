/**
 * 'task' command — Run SDLC pipeline on a task description.
 *
 * Usage:
 *   agentweave task "Fix the login bug"
 *   agentweave task "Add avatar upload" --agent claude --checks "npm test"
 *   agentweave task "Refactor auth" --retries 3 --plan
 */

import { AGENTWEAVE_VERSION } from "@agentweave/types";
import { createSDLCPipeline } from "@agentweave/inner-harness";
import type { SDLCMetricsSnapshot } from "@agentweave/types";

export interface TaskCommandArgs {
	prompt: string;
	agent?: string;        // CLI agent command (default: none — uses agent-loop)
	agentArgs?: string[];  // Extra args for agent
	model?: string;        // LLM model for agent-loop mode
	checks?: string[];     // QA check commands
	retries?: number;      // Max retries (default: 3)
	plan?: boolean;        // Show plan before executing
	metricsDir?: string;   // Metrics storage dir
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

const DIVIDER = "─".repeat(60);

// ─── Main ────────────────────────────────────────────────────────

export async function taskCommand(args: TaskCommandArgs): Promise<void> {
	const startTime = Date.now();

	// Header
	console.log(`\n${C.cyan}${C.bold}  AgentWeave SDLC Engine v${AGENTWEAVE_VERSION}${C.reset}`);
	console.log(`${C.gray}  ${DIVIDER}${C.reset}`);
	console.log(`${C.white}  Task:    ${C.reset}${args.prompt}`);

	// Determine execution mode
	const hasAgent = !!args.agent;
	const mode = hasAgent ? "process-adapter" as const : "agent-loop" as const;
	const model = args.model ?? "claude-sonnet-4-6";

	if (hasAgent) {
		console.log(`${C.white}  Agent:   ${C.reset}${args.agent} ${(args.agentArgs ?? []).join(" ")}`);
	} else {
		console.log(`${C.white}  Mode:    ${C.reset}agent-loop (${model})`);
	}

	// Build QA checks
	const checks = (args.checks ?? []).map((cmd, i) => ({
		type: "custom" as const,
		command: cmd,
		required: true,
	}));

	if (checks.length > 0) {
		console.log(`${C.white}  Checks:  ${C.reset}${checks.map((c) => c.command).join(", ")}`);
	}

	const retries = args.retries ?? 3;
	console.log(`${C.white}  Retries: ${C.reset}${retries}`);

	const metricsDir = args.metricsDir ?? ".agentweave/metrics";
	console.log(`${C.white}  Metrics: ${C.reset}${metricsDir}/`);
	console.log(`${C.gray}  ${DIVIDER}${C.reset}\n`);

	// Create pipeline
	const pipeline = createSDLCPipeline({
		execution: hasAgent
			? { mode: "process-adapter", processAdapter: { command: args.agent!, args: args.agentArgs } }
			: { mode: "agent-loop", agentLoop: { model, maxTurns: 50 } },
		modules: {
			taskNormalizer: { enabled: true },
			contextBuilder: { enabled: true, maxFiles: 15 },
			planGenerator: { enabled: true },
			executionBridge: { enabled: true },
			patchValidator: { enabled: true },
			qualityGate: { enabled: checks.length > 0, checks },
			retryEngine: { enabled: true, maxRetries: retries },
			outputStandardizer: { enabled: false },
		},
		metrics: { enabled: true, baseline: true, persistPath: metricsDir },
	});

	// Run pipeline with live output
	let currentPhase = "";
	let lastEventType = "";

	try {
		const gen = pipeline.run(args.prompt);
		for (;;) {
			const { value: event, done } = await gen.next();
			if (done) break;

			// Render SDLC phase transitions
			if (event.type === "message:assistant") {
				const content = (event as unknown as Record<string, unknown>).content as Array<{ type: string; text: string }>;
				const text = content?.[0]?.text ?? "";

				if (text.startsWith("[SDLC]")) {
					const phase = text.replace("[SDLC] ", "");
					if (phase !== currentPhase) {
						currentPhase = phase;
						printPhase(phase);
					}
				} else if (text.length > 0) {
					// Agent output — show truncated
					const preview = text.length > 200 ? text.slice(0, 200) + "..." : text;
					console.log(`${C.dim}  ${preview}${C.reset}`);
				}
			}

			// Tool events
			if (event.type === "tool:completed") {
				const e = event as unknown as Record<string, unknown>;
				console.log(`${C.green}  ✓ ${e.toolName}${C.reset} ${C.dim}(${((e.durationMs as number) ?? 0).toFixed(0)}ms)${C.reset}`);
			}
			if (event.type === "tool:failed") {
				const e = event as unknown as Record<string, unknown>;
				console.log(`${C.red}  ✗ ${e.toolName}: ${e.error}${C.reset}`);
			}

			// Error events
			if (event.type === "error") {
				const e = event as unknown as Record<string, unknown>;
				console.log(`${C.red}  ERROR: ${e.error}${C.reset}`);
			}

			lastEventType = event.type;
		}
	} catch (err) {
		console.log(`\n${C.red}  Pipeline error: ${err instanceof Error ? err.message : String(err)}${C.reset}`);
	}

	const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

	// Print metrics
	const metrics = pipeline.getLastMetrics();
	const comparison = pipeline.getLastComparison();

	console.log(`\n${C.gray}  ${DIVIDER}${C.reset}`);
	console.log(`${C.cyan}${C.bold}  Results${C.reset}`);
	console.log(`${C.gray}  ${DIVIDER}${C.reset}`);

	if (metrics) {
		printMetrics(metrics, elapsed);

		if (comparison?.baseline) {
			console.log(`\n${C.gray}  ${DIVIDER}${C.reset}`);
			console.log(`${C.cyan}${C.bold}  vs. Baseline${C.reset}`);
			console.log(`${C.gray}  ${DIVIDER}${C.reset}`);
			printComparison(comparison.deltas);
		}
	} else {
		console.log(`${C.yellow}  No metrics collected${C.reset}`);
	}

	console.log(`\n${C.gray}  ${DIVIDER}${C.reset}`);
	console.log(`${C.dim}  Metrics saved to: ${metricsDir}/baseline.json${C.reset}`);
	console.log(`${C.dim}  View with: agentweave metrics${C.reset}\n`);
}

// ─── Render Helpers ──────────────────────────────────────────────

function printPhase(phase: string): void {
	const icon = getPhaseIcon(phase);
	console.log(`\n${C.blue}  ${icon} ${phase}${C.reset}`);
}

function getPhaseIcon(phase: string): string {
	if (phase.includes("Normaliz")) return "📋";
	if (phase.includes("context") || phase.includes("Context")) return "🔍";
	if (phase.includes("plan") || phase.includes("Plan")) return "📝";
	if (phase.includes("Execut")) return "⚡";
	if (phase.includes("Validat")) return "🔎";
	if (phase.includes("quality") || phase.includes("Quality")) return "🧪";
	if (phase.includes("Retry")) return "🔄";
	if (phase.includes("Standard")) return "📦";
	return "▸";
}

function printMetrics(m: SDLCMetricsSnapshot, elapsed: string): void {
	const pass = m.m1_firstPassSuccess;
	const passIcon = pass ? `${C.green}✓` : `${C.red}✗`;

	console.log(`  ${passIcon} First-pass success: ${pass ? "YES" : "NO"}${C.reset}`);
	console.log(`  ${C.white}  Test pass rate:    ${C.reset}${(m.m2_testPassRate * 100).toFixed(0)}%`);
	console.log(`  ${C.white}  Scope accuracy:    ${C.reset}${(m.m3_scopeAccuracy * 100).toFixed(0)}%`);
	console.log(`  ${C.white}  Retry count:       ${C.reset}${m.m4_retryCount}`);
	console.log(`  ${C.white}  Cost:              ${C.reset}$${m.m5_costUsd.toFixed(4)}`);
	console.log(`  ${C.white}  Time:              ${C.reset}${elapsed}s`);

	if (m.m7_regressionDetected) {
		console.log(`  ${C.red}  ⚠ Regression detected${C.reset}`);
	}
	console.log(`  ${C.white}  Plan accuracy:     ${C.reset}${(m.m8_planAccuracy * 100).toFixed(0)}%`);
}

function printComparison(deltas: Record<string, number>): void {
	for (const [key, delta] of Object.entries(deltas)) {
		if (delta === 0) continue;
		const label = METRIC_LABELS[key] ?? key;
		const isGood = isPositiveMetric(key) ? delta > 0 : delta < 0;
		const icon = isGood ? `${C.green}▲` : `${C.red}▼`;
		const sign = delta > 0 ? "+" : "";
		const formatted = key.includes("cost") || key.includes("Cost")
			? `${sign}$${delta.toFixed(4)}`
			: key.includes("time") || key.includes("Time")
				? `${sign}${(delta / 1000).toFixed(1)}s`
				: key.includes("retry") || key.includes("Retry")
					? `${sign}${delta}`
					: `${sign}${(delta * 100).toFixed(1)}%`;

		console.log(`  ${icon} ${label}: ${formatted}${C.reset}`);
	}
}

const METRIC_LABELS: Record<string, string> = {
	m2_testPassRate: "Test pass rate",
	m3_scopeAccuracy: "Scope accuracy",
	m4_retryCount: "Retry count",
	m5_costUsd: "Cost",
	m6_timeToCompletionMs: "Time",
	m8_planAccuracy: "Plan accuracy",
	m9_contextUtilization: "Context utilization",
	m10_codeQualityDelta: "Code quality",
};

/** For these metrics, higher is better */
function isPositiveMetric(key: string): boolean {
	return ["m2_testPassRate", "m3_scopeAccuracy", "m8_planAccuracy", "m9_contextUtilization", "m10_codeQualityDelta"].includes(key);
}
