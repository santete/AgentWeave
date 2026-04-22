/**
 * 'metrics' command — View SDLC metrics from stored runs.
 *
 * Usage:
 *   agentweave metrics                    Show latest metrics
 *   agentweave metrics --dir ./custom/    Custom metrics directory
 *   agentweave metrics --history          Show all stored runs
 */

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { SDLCMetricsSnapshot } from "@agentweave/types";

export interface MetricsCommandArgs {
	dir?: string;
	history?: boolean;
}

const C = {
	reset: "\x1b[0m",
	dim: "\x1b[2m",
	bold: "\x1b[1m",
	green: "\x1b[32m",
	red: "\x1b[31m",
	yellow: "\x1b[33m",
	blue: "\x1b[34m",
	cyan: "\x1b[36m",
	gray: "\x1b[90m",
	white: "\x1b[37m",
};

const DIVIDER = "─".repeat(60);

export async function metricsCommand(args: MetricsCommandArgs): Promise<void> {
	const dir = args.dir ?? ".agentweave/metrics";

	if (!existsSync(dir)) {
		console.log(`\n${C.yellow}  No metrics found at ${dir}/${C.reset}`);
		console.log(`${C.dim}  Run a task first: agentweave task "your task"${C.reset}\n`);
		return;
	}

	if (args.history) {
		printHistory(dir);
		return;
	}

	// Show latest baseline
	const baselinePath = join(dir, "baseline.json");
	if (!existsSync(baselinePath)) {
		console.log(`\n${C.yellow}  No baseline found at ${baselinePath}${C.reset}`);
		console.log(`${C.dim}  Run a task with metrics enabled first.${C.reset}\n`);
		return;
	}

	try {
		const raw = readFileSync(baselinePath, "utf-8");
		const snapshot: SDLCMetricsSnapshot = JSON.parse(raw);
		printSnapshot(snapshot, "Latest Run");
	} catch (err) {
		console.log(`\n${C.red}  Failed to read metrics: ${err instanceof Error ? err.message : String(err)}${C.reset}\n`);
	}
}

function printSnapshot(m: SDLCMetricsSnapshot, title: string): void {
	const date = new Date(m.timestamp).toLocaleString();

	console.log(`\n${C.cyan}${C.bold}  AgentWeave SDLC Metrics — ${title}${C.reset}`);
	console.log(`${C.gray}  ${DIVIDER}${C.reset}`);
	console.log(`${C.dim}  Task ID:    ${m.taskId}${C.reset}`);
	console.log(`${C.dim}  Timestamp:  ${date}${C.reset}`);
	console.log(`${C.gray}  ${DIVIDER}${C.reset}`);
	console.log();

	// Success indicator
	const pass = m.m1_firstPassSuccess;
	console.log(`  ${pass ? `${C.green}✓` : `${C.red}✗`} M1  First-pass success    ${pass ? "YES" : "NO"}${C.reset}`);

	// Rate metrics (0-100%)
	printBar("M2", "Test pass rate", m.m2_testPassRate);
	printBar("M3", "Scope accuracy", m.m3_scopeAccuracy);
	printBar("M8", "Plan accuracy", m.m8_planAccuracy);
	printBar("M9", "Context utilization", m.m9_contextUtilization);

	// Count metrics
	console.log(`  ${C.white}  M4  Retry count           ${C.reset}${m.m4_retryCount}`);
	console.log(`  ${C.white}  M5  Cost                  ${C.reset}$${m.m5_costUsd.toFixed(4)}`);
	console.log(`  ${C.white}  M6  Time                  ${C.reset}${(m.m6_timeToCompletionMs / 1000).toFixed(1)}s`);

	// Boolean
	const regIcon = m.m7_regressionDetected ? `${C.red}✗` : `${C.green}✓`;
	console.log(`  ${regIcon} M7  Regression detected    ${m.m7_regressionDetected ? "YES" : "NO"}${C.reset}`);

	// Delta
	const qualColor = m.m10_codeQualityDelta >= 0 ? C.green : C.red;
	console.log(`  ${qualColor}  M10 Code quality delta     ${m.m10_codeQualityDelta > 0 ? "+" : ""}${m.m10_codeQualityDelta}${C.reset}`);

	console.log();
}

function printBar(id: string, label: string, value: number): void {
	const pct = Math.round(value * 100);
	const barWidth = 20;
	const filled = Math.round(value * barWidth);
	const empty = barWidth - filled;
	const bar = "█".repeat(filled) + "░".repeat(empty);
	const color = pct >= 80 ? C.green : pct >= 50 ? C.yellow : C.red;

	const paddedLabel = (label + " ".repeat(22)).slice(0, 22);
	console.log(`  ${color}  ${id}  ${paddedLabel}${bar} ${pct}%${C.reset}`);
}

function printHistory(dir: string): void {
	const files = readdirSync(dir)
		.filter((f) => f.endsWith(".json"))
		.sort();

	if (files.length === 0) {
		console.log(`\n${C.yellow}  No metric files found in ${dir}/${C.reset}\n`);
		return;
	}

	console.log(`\n${C.cyan}${C.bold}  Metrics History — ${dir}/${C.reset}`);
	console.log(`${C.gray}  ${DIVIDER}${C.reset}`);

	for (const file of files) {
		try {
			const raw = readFileSync(join(dir, file), "utf-8");
			const m: SDLCMetricsSnapshot = JSON.parse(raw);
			const date = new Date(m.timestamp).toLocaleString();
			const pass = m.m1_firstPassSuccess ? `${C.green}✓` : `${C.red}✗`;

			console.log(
				`  ${pass}${C.reset} ${C.dim}${date}${C.reset}  ` +
				`test:${(m.m2_testPassRate * 100).toFixed(0)}%  ` +
				`retry:${m.m4_retryCount}  ` +
				`cost:$${m.m5_costUsd.toFixed(3)}  ` +
				`${C.dim}${file}${C.reset}`,
			);
		} catch {
			console.log(`  ${C.red}✗ ${file} (corrupted)${C.reset}`);
		}
	}

	console.log(`${C.gray}  ${DIVIDER}${C.reset}`);
	console.log(`${C.dim}  ${files.length} run(s) total${C.reset}\n`);
}
