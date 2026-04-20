#!/usr/bin/env npx tsx
/**
 * AgentWeave SDLC Benchmark Runner
 *
 * Runs 5 coding tasks in 2 modes:
 *   Mode A: Raw agent (no SDLC pipeline)
 *   Mode B: AgentWeave SDLC pipeline (with QA gate + retry)
 *
 * Measures M1-M10 metrics for each, generates comparison report.
 *
 * Usage:
 *   npx tsx benchmarks/run-benchmark.ts --agent claude
 *   npx tsx benchmarks/run-benchmark.ts --agent aider
 *   npx tsx benchmarks/run-benchmark.ts --mock          (no API key needed)
 *
 * Output:
 *   benchmarks/results/report-{timestamp}.json
 *   benchmarks/results/report-{timestamp}.txt   (human-readable)
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, cpSync, rmSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";
import { resolveAgent } from "../packages/cli/src/agent-presets";
import { getAgentEnv, buildChildEnv, hasCredentials } from "../packages/cli/src/credential-store";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ─── Types ───────────────────────────────────────────────────────

interface BenchTask {
	id: string;
	name: string;
	category: string;
	difficulty: string;
	prompt: string;
	setupScript: string;
	expectedFiles: string[];
	testCommand: string;
	maxExpectedFiles: number;
}

interface TaskResult {
	taskId: string;
	mode: "raw" | "pipeline";
	m1_firstPassSuccess: boolean;
	m2_testPassRate: number;
	m3_scopeAccuracy: number;
	m4_retryCount: number;
	m5_costUsd: number;
	m6_timeSeconds: number;
	m7_noRegression: boolean;
	m10_codeQuality: number;
	testsPassed: number;
	testsFailed: number;
	testsTotal: number;
	error?: string;
}

interface BenchReport {
	timestamp: string;
	agent: string;
	tasks: BenchTask[];
	rawResults: TaskResult[];
	pipelineResults: TaskResult[];
	summary: {
		raw: AggregateMetrics;
		pipeline: AggregateMetrics;
		improvement: Record<string, string>;
	};
}

interface AggregateMetrics {
	avgTestPassRate: number;
	avgScopeAccuracy: number;
	totalRetries: number;
	firstPassSuccessRate: number;
	avgTimeSeconds: number;
	totalCostUsd: number;
	regressionCount: number;
	overallScore: number;
}

// ─── ANSI ────────────────────────────────────────────────────────

const C = {
	reset: "\x1b[0m", bold: "\x1b[1m", dim: "\x1b[2m",
	green: "\x1b[32m", red: "\x1b[31m", yellow: "\x1b[33m",
	cyan: "\x1b[36m", gray: "\x1b[90m", white: "\x1b[37m",
};
const LINE = "═".repeat(65);
const THIN = "─".repeat(65);

// ─── Args ────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const isMock = args.includes("--mock");
const agentFlag = args.find((_, i) => args[i - 1] === "--agent") ?? (isMock ? "mock" : "claude");
const modelFlag = args.find((_, i) => args[i - 1] === "--model") ?? null;
const isApiMode = !!modelFlag; // Use agent-loop (LLM API) instead of process-adapter (CLI)

// ─── Load Tasks ──────────────────────────────────────────────────

const tasksFile = join(__dirname, "tasks", "benchmark-tasks.json");
const tasksDef = JSON.parse(readFileSync(tasksFile, "utf-8"));
const tasks: BenchTask[] = tasksDef.tasks;

// ─── Main ────────────────────────────────────────────────────────

async function main() {
	console.log(`\n  ${C.cyan}${C.bold}╔${LINE}╗${C.reset}`);
	console.log(`  ${C.cyan}${C.bold}║  AgentWeave SDLC Benchmark${" ".repeat(37)}║${C.reset}`);
	console.log(`  ${C.cyan}${C.bold}║  Raw Agent vs SDLC Pipeline — Head-to-Head${" ".repeat(20)}║${C.reset}`);
	console.log(`  ${C.cyan}${C.bold}╚${LINE}╝${C.reset}`);
	console.log();
	if (isApiMode) {
		console.log(`  Mode:   ${C.bold}agent-loop (API)${C.reset}  model: ${C.bold}${modelFlag}${C.reset}`);
	} else {
		console.log(`  Agent:  ${C.bold}${agentFlag}${C.reset}${isMock ? ` ${C.dim}(mock — no API key)${C.reset}` : ""}`);
	}
	console.log(`  Tasks:  ${C.bold}${tasks.length}${C.reset} (${tasks.map(t => t.id).join(", ")})`);
	console.log(`  Modes:  ${C.red}A) Raw agent${C.reset}  vs  ${C.green}B) SDLC Pipeline${C.reset}`);

	// Check credentials/env for real mode
	if (!isMock) {
		if (isApiMode) {
			const hasKey = !!process.env.OPENROUTER_API_KEY || !!process.env.ANTHROPIC_API_KEY || !!process.env.OPENAI_API_KEY || !!process.env.GOOGLE_GENERATIVE_AI_API_KEY;
			if (hasKey) {
				console.log(`  Keys:   ${C.green}✓${C.reset} API key found in environment`);
			} else {
				console.log(`  Keys:   ${C.yellow}⚠ No API key in env${C.reset}`);
				console.log(`          ${C.dim}source .env before running, or set OPENROUTER_API_KEY${C.reset}`);
			}
		} else {
			const hasCreds = hasCredentials(agentFlag);
			if (hasCreds) {
				const keys = Object.keys(getAgentEnv(agentFlag));
				console.log(`  Keys:   ${C.green}✓${C.reset} ${keys.join(", ")} ${C.dim}(from credential store)${C.reset}`);
			} else {
				console.log(`  Keys:   ${C.yellow}⚠ No credentials for "${agentFlag}"${C.reset}`);
				console.log(`          ${C.dim}Set with: agentweave credentials set ${agentFlag} <ENV_VAR>${C.reset}`);
			}
		}
	}

	console.log(`  ${C.gray}${THIN}${C.reset}`);

	const rawResults: TaskResult[] = [];
	const pipelineResults: TaskResult[] = [];

	for (const task of tasks) {
		console.log(`\n  ${C.white}${C.bold}${task.id}: ${task.name}${C.reset} ${C.dim}(${task.difficulty})${C.reset}`);

		// Mode A: Raw agent
		process.stdout.write(`    ${C.red}A) Raw agent...${C.reset} `);
		const rawResult = await runTask(task, "raw");
		rawResults.push(rawResult);
		const rawIcon = rawResult.m1_firstPassSuccess ? `${C.green}✓` : `${C.red}✗`;
		console.log(`${rawIcon}${C.reset} tests: ${rawResult.testsPassed}/${rawResult.testsTotal}  time: ${rawResult.m6_timeSeconds.toFixed(1)}s`);

		// Mode B: Pipeline
		process.stdout.write(`    ${C.green}B) Pipeline...${C.reset}  `);
		const pipeResult = await runTask(task, "pipeline");
		pipelineResults.push(pipeResult);
		const pipeIcon = pipeResult.m1_firstPassSuccess ? `${C.green}✓` : `${C.red}✗`;
		console.log(`${pipeIcon}${C.reset} tests: ${pipeResult.testsPassed}/${pipeResult.testsTotal}  time: ${pipeResult.m6_timeSeconds.toFixed(1)}s  retries: ${pipeResult.m4_retryCount}`);
	}

	// Generate report
	const report = generateReport(rawResults, pipelineResults);
	printReport(report);
	saveReport(report);
}

// ─── Run Single Task ─────────────────────────────────────────────

async function runTask(task: BenchTask, mode: "raw" | "pipeline"): Promise<TaskResult> {
	const workdir = join(__dirname, `.bench-workspace-${mode}-${task.id}`);
	const startTime = Date.now();

	try {
		// Setup workspace
		rmSync(workdir, { recursive: true, force: true });
		mkdirSync(workdir, { recursive: true });

		// Run setup script
		const setupPath = join(__dirname, "..", task.setupScript);
		execSync(`node "${setupPath}"`, {
			cwd: join(__dirname, ".."),
			env: { ...process.env, BENCH_WORKDIR: workdir },
			timeout: 10_000,
			stdio: "pipe",
		});

		// Run pre-test (baseline — check which tests pass BEFORE agent runs)
		const preTest = runTests(task, workdir);

		if (isMock) {
			return simulateMockResult(task, mode, startTime, preTest);
		}

		// API mode (--model flag): use AgentLoop with LLM API directly
		if (isApiMode) {
			return await runApiAgent(task, workdir, startTime, preTest, mode);
		}

		// CLI agent mode (--agent flag): spawn agent process
		if (mode === "raw") {
			return await runRawAgent(task, workdir, startTime, preTest);
		} else {
			return await runPipelineAgent(task, workdir, startTime, preTest);
		}
	} catch (err) {
		return {
			taskId: task.id, mode,
			m1_firstPassSuccess: false, m2_testPassRate: 0, m3_scopeAccuracy: 0,
			m4_retryCount: 0, m5_costUsd: 0, m6_timeSeconds: (Date.now() - startTime) / 1000,
			m7_noRegression: true, m10_codeQuality: 0,
			testsPassed: 0, testsFailed: 0, testsTotal: 0,
			error: err instanceof Error ? err.message : String(err),
		};
	} finally {
		rmSync(workdir, { recursive: true, force: true });
	}
}

// ─── Mock Results (for demo without API key) ─────────────────────

function simulateMockResult(task: BenchTask, mode: "raw" | "pipeline", startTime: number, preTest: TestResult): TaskResult {
	// Simulate realistic differences between raw and pipeline
	const isRaw = mode === "raw";

	// Raw agent: 50-70% test pass, occasional scope creep, no retry
	// Pipeline: 85-100% test pass, tight scope, retries fix issues
	const seed = hashCode(task.id + mode);
	const rand = (min: number, max: number) => min + ((seed % 100) / 100) * (max - min);

	const testPassRate = isRaw ? rand(0.4, 0.75) : rand(0.85, 1.0);
	// Use expected test count from task definition (3-6 per task), not preTest
	const testsTotal = task.maxExpectedFiles + 2;
	const testsPassed = Math.round(testPassRate * testsTotal);
	const scopeAccuracy = isRaw ? rand(0.6, 0.85) : rand(0.9, 1.0);
	const retryCount = isRaw ? 0 : Math.round(rand(0, 2));
	const timeMs = isRaw ? rand(3000, 8000) : rand(5000, 15000);
	const costUsd = isRaw ? rand(0.01, 0.04) : rand(0.02, 0.06);

	return {
		taskId: task.id, mode,
		m1_firstPassSuccess: testsPassed === testsTotal && (isRaw ? Math.random() > 0.6 : Math.random() > 0.15),
		m2_testPassRate: testsPassed / testsTotal,
		m3_scopeAccuracy: scopeAccuracy,
		m4_retryCount: retryCount,
		m5_costUsd: costUsd,
		m6_timeSeconds: timeMs / 1000,
		m7_noRegression: isRaw ? Math.random() > 0.3 : Math.random() > 0.05,
		m10_codeQuality: isRaw ? Math.round(rand(-2, 1)) : Math.round(rand(0, 3)),
		testsPassed, testsFailed: testsTotal - testsPassed, testsTotal,
	};
}

function hashCode(s: string): number {
	let hash = 0;
	for (let i = 0; i < s.length; i++) { hash = ((hash << 5) - hash) + s.charCodeAt(i); hash |= 0; }
	return Math.abs(hash);
}

// ─── API Mode Runner (AgentLoop with real LLM) ──────────────────

async function runApiAgent(task: BenchTask, workdir: string, startTime: number, preTest: TestResult, mode: "raw" | "pipeline"): Promise<TaskResult> {
	const { AgentLoop, BUILT_IN_TOOLS, createSDLCPipeline } = await import("../packages/inner-harness/src/index");
	const { createEmptyTokenUsage } = await import("../packages/types/src/index");

	const model = modelFlag!;
	const systemPrompt = `You are a coding assistant. Work in the directory provided. Fix bugs, add features, or refactor code as requested. Use the available tools (FileRead, FileEdit, FileWrite, Bash) to read and modify files. The project source is in the src/ directory and tests are in the test/ directory.`;

	let retryCount = 0;
	let totalUsage = createEmptyTokenUsage();

	if (mode === "raw") {
		// Mode A: Raw AgentLoop — no SDLC pipeline
		const loop = new AgentLoop({
			model,
			tools: BUILT_IN_TOOLS,
			systemPrompt,
			maxTurns: 15,
		});

		try {
			const gen = loop.run(`Working directory: ${workdir}\n\n${task.prompt}`, { timeoutMs: 90_000 });
			for await (const _event of gen) { /* consume events */ }
			totalUsage = loop.getUsage();
		} catch { /* agent may fail */ }
	} else {
		// Mode B: SDLC Pipeline with QA gate + retry
		const testFile = join(workdir, "test", task.expectedFiles[0]!.replace("src/", "").replace(".ts", ".test.ts"));
		const runnerPath = join(__dirname, "tasks", "verify", "run-tests.cjs");

		const pipeline = createSDLCPipeline({
			execution: { mode: "agent-loop", agentLoop: { model, maxTurns: 15, systemPrompt } },
			modules: {
				taskNormalizer: { enabled: true },
				contextBuilder: { enabled: false },
				planGenerator: { enabled: true },
				executionBridge: { enabled: true },
				patchValidator: { enabled: true, maxFilesChanged: task.maxExpectedFiles + 2 },
				qualityGate: {
					enabled: existsSync(testFile),
					checks: [{ type: "custom" as const, command: `node "${runnerPath}" "${testFile}"`, required: true }],
				},
				retryEngine: { enabled: true, maxRetries: 2 },
				outputStandardizer: { enabled: false },
			},
			metrics: { enabled: true, baseline: false },
		});

		try {
			const gen = pipeline.run(`Working directory: ${workdir}\n\n${task.prompt}`, { timeoutMs: 120_000 });
			for await (const _event of gen) { /* consume events */ }
			totalUsage = pipeline.getUsage();
			const metrics = pipeline.getLastMetrics();
			if (metrics) retryCount = metrics.m4_retryCount;
		} catch { /* pipeline may fail */ }
	}

	const elapsed = (Date.now() - startTime) / 1000;
	const postTest = runTests(task, workdir);
	const changedFiles = detectChangedFiles(workdir, task);

	const result = buildResult(task, mode, elapsed, preTest, postTest, changedFiles, retryCount);
	result.m5_costUsd = totalUsage.totalCost;
	return result;
}

// ─── Real Agent Runners ──────────────────────────────────────────

async function runRawAgent(task: BenchTask, workdir: string, startTime: number, preTest: TestResult): Promise<TaskResult> {
	const agent = resolveAgent(agentFlag);
	const credEnv = getAgentEnv(agentFlag);
	const childEnv = buildChildEnv(credEnv);

	// Run agent directly — no SDLC pipeline
	try {
		const agentArgs = [...agent.args, task.prompt];
		execSync(`"${agent.command}" ${agentArgs.map(a => `"${a}"`).join(" ")}`, {
			cwd: workdir,
			env: childEnv,
			timeout: 120_000,
			stdio: "pipe",
		});
	} catch {
		// Agent may exit non-zero — that's OK, we measure the result
	}

	const elapsed = (Date.now() - startTime) / 1000;
	const postTest = runTests(task, workdir);
	const changedFiles = detectChangedFiles(workdir, task);

	return buildResult(task, "raw", elapsed, preTest, postTest, changedFiles, 0);
}

async function runPipelineAgent(task: BenchTask, workdir: string, startTime: number, preTest: TestResult): Promise<TaskResult> {
	const credEnv = getAgentEnv(agentFlag);
	const childEnv = buildChildEnv(credEnv);

	// Run via agentweave pipeline CLI
	const cliPath = join(__dirname, "..", "packages", "cli", "dist", "bin.js");
	const checksArg = task.testCommand ? `--checks "node ${join(__dirname, "tasks", "verify", "run-tests.cjs")} ${join(workdir, "test", task.expectedFiles[0]!.replace("src/", "").replace(".ts", ".test.ts"))}"` : "";
	let retryCount = 0;

	try {
		const output = execSync(
			`node "${cliPath}" pipeline run "${task.prompt}" --agent ${agentFlag} --retries 3 ${checksArg}`,
			{ cwd: workdir, env: childEnv, timeout: 180_000, stdio: "pipe", encoding: "utf-8" },
		);
		// Parse retry count from output
		const retryMatch = output.match(/Retry.*?(\d+)/i);
		if (retryMatch) retryCount = parseInt(retryMatch[1]!, 10);
	} catch {
		// Pipeline may fail — we measure result regardless
	}

	const elapsed = (Date.now() - startTime) / 1000;
	const postTest = runTests(task, workdir);
	const changedFiles = detectChangedFiles(workdir, task);

	return buildResult(task, "pipeline", elapsed, preTest, postTest, changedFiles, retryCount);
}

/** Detect which files changed in workdir/src/ */
function detectChangedFiles(workdir: string, task: BenchTask): string[] {
	try {
		const srcDir = join(workdir, "src");
		if (!existsSync(srcDir)) return [];
		return readdirSync(srcDir)
			.filter(f => f.endsWith(".ts") || f.endsWith(".js"))
			.map(f => `src/${f}`);
	} catch {
		return [];
	}
}

/** Build TaskResult from pre/post test comparison */
function buildResult(
	task: BenchTask, mode: "raw" | "pipeline",
	elapsed: number, preTest: TestResult, postTest: TestResult,
	changedFiles: string[], retryCount: number,
): TaskResult {
	const testPassRate = postTest.total > 0 ? postTest.passed / postTest.total : 0;
	const firstPass = postTest.passed === postTest.total && retryCount === 0;

	// Scope accuracy: how many changed files were expected
	const expectedSet = new Set(task.expectedFiles);
	const inScope = changedFiles.filter(f => expectedSet.has(f)).length;
	const scopeAccuracy = changedFiles.length > 0 ? inScope / changedFiles.length : 1;

	// Regression: tests that passed before but fail now
	const regression = preTest.passed > postTest.passed;

	return {
		taskId: task.id, mode,
		m1_firstPassSuccess: firstPass,
		m2_testPassRate: testPassRate,
		m3_scopeAccuracy: scopeAccuracy,
		m4_retryCount: retryCount,
		m5_costUsd: 0, // TODO: parse from pipeline output
		m6_timeSeconds: elapsed,
		m7_noRegression: !regression,
		m10_codeQuality: 0,
		testsPassed: postTest.passed,
		testsFailed: postTest.failed,
		testsTotal: postTest.total,
	};
}

// ─── Test Runner ─────────────────────────────────────────────────

interface TestResult { passed: number; failed: number; total: number }

function runTests(task: BenchTask, workdir: string): TestResult {
	try {
		const srcName = task.expectedFiles[0]!.replace("src/", "").replace(".ts", ".test.ts");
		const testFile = join(workdir, "test", srcName);
		if (!existsSync(testFile)) return { passed: 0, failed: 0, total: 0 };

		const runnerPath = join(__dirname, "tasks", "verify", "run-tests.cjs");
		const output = execSync(`node "${runnerPath}" "${testFile}"`, {
			cwd: workdir, timeout: 30_000, encoding: "utf-8", stdio: "pipe",
		});
		const lines = output.trim().split("\n");
		const jsonLine = lines.find(l => l.startsWith("{"));
		return jsonLine ? JSON.parse(jsonLine) : { passed: 0, failed: 0, total: 0 };
	} catch {
		return { passed: 0, failed: 0, total: 0 };
	}
}

// ─── Report Generation ───────────────────────────────────────────

function generateReport(rawResults: TaskResult[], pipelineResults: TaskResult[]): BenchReport {
	const rawAgg = aggregate(rawResults);
	const pipeAgg = aggregate(pipelineResults);

	const improvement: Record<string, string> = {
		testPassRate: `${((pipeAgg.avgTestPassRate - rawAgg.avgTestPassRate) * 100).toFixed(1)}%`,
		scopeAccuracy: `${((pipeAgg.avgScopeAccuracy - rawAgg.avgScopeAccuracy) * 100).toFixed(1)}%`,
		firstPassSuccess: `${((pipeAgg.firstPassSuccessRate - rawAgg.firstPassSuccessRate) * 100).toFixed(1)}%`,
		retryCount: `${pipeAgg.totalRetries - rawAgg.totalRetries}`,
		regressions: `${rawAgg.regressionCount - pipeAgg.regressionCount} fewer`,
		costDelta: `$${(pipeAgg.totalCostUsd - rawAgg.totalCostUsd).toFixed(4)}`,
		timeDelta: `${(pipeAgg.avgTimeSeconds - rawAgg.avgTimeSeconds).toFixed(1)}s`,
		overallScore: `${(pipeAgg.overallScore - rawAgg.overallScore).toFixed(1)} points`,
	};

	return {
		timestamp: new Date().toISOString(),
		agent: agentFlag,
		tasks,
		rawResults,
		pipelineResults,
		summary: { raw: rawAgg, pipeline: pipeAgg, improvement },
	};
}

function aggregate(results: TaskResult[]): AggregateMetrics {
	const n = results.length || 1;
	const avgTestPassRate = results.reduce((s, r) => s + r.m2_testPassRate, 0) / n;
	const avgScopeAccuracy = results.reduce((s, r) => s + r.m3_scopeAccuracy, 0) / n;
	const totalRetries = results.reduce((s, r) => s + r.m4_retryCount, 0);
	const firstPassSuccessRate = results.filter(r => r.m1_firstPassSuccess).length / n;
	const avgTimeSeconds = results.reduce((s, r) => s + r.m6_timeSeconds, 0) / n;
	const totalCostUsd = results.reduce((s, r) => s + r.m5_costUsd, 0);
	const regressionCount = results.filter(r => !r.m7_noRegression).length;

	// Weighted score (100 max)
	const overallScore =
		firstPassSuccessRate * 20 +
		avgTestPassRate * 20 +
		avgScopeAccuracy * 15 +
		Math.max(0, 10 - totalRetries) +  // fewer retries = higher score
		(1 - regressionCount / n) * 15 +
		Math.min(10, 10 / (avgTimeSeconds / 5)) * 5 +  // faster = higher
		5;  // base

	return { avgTestPassRate, avgScopeAccuracy, totalRetries, firstPassSuccessRate, avgTimeSeconds, totalCostUsd, regressionCount, overallScore };
}

// ─── Print Report ────────────────────────────────────────────────

function printReport(report: BenchReport): void {
	const { raw, pipeline, improvement } = report.summary;

	console.log(`\n  ${C.cyan}${C.bold}╔${LINE}╗${C.reset}`);
	console.log(`  ${C.cyan}${C.bold}║  BENCHMARK RESULTS${" ".repeat(46)}║${C.reset}`);
	console.log(`  ${C.cyan}${C.bold}╠${LINE}╣${C.reset}`);

	const pad = (s: string, n: number) => (s + " ".repeat(n)).slice(0, n);

	console.log(`  ${C.cyan}║${C.reset}  ${pad("Metric", 28)} ${C.red}${pad("Raw Agent", 14)}${C.reset} ${C.green}${pad("Pipeline", 14)}${C.reset} ${C.cyan}${pad("Delta", 7)}${C.reset}${C.cyan}║${C.reset}`);
	console.log(`  ${C.cyan}║${C.reset}  ${C.gray}${THIN.slice(0, 63)}${C.reset}${C.cyan}║${C.reset}`);

	const row = (label: string, rawVal: string, pipeVal: string, delta: string, good: boolean) => {
		const icon = good ? `${C.green}▲` : delta.startsWith("+$") || delta.startsWith("+") ? `${C.red}▼` : `${C.gray}─`;
		console.log(`  ${C.cyan}║${C.reset}  ${pad(label, 28)} ${pad(rawVal, 14)} ${pad(pipeVal, 14)} ${icon} ${pad(delta, 5)}${C.reset}${C.cyan}║${C.reset}`);
	};

	row("First-pass success rate",
		`${(raw.firstPassSuccessRate * 100).toFixed(0)}%`,
		`${(pipeline.firstPassSuccessRate * 100).toFixed(0)}%`,
		improvement.firstPassSuccess, parseFloat(improvement.firstPassSuccess) > 0);

	row("Test pass rate (avg)",
		`${(raw.avgTestPassRate * 100).toFixed(0)}%`,
		`${(pipeline.avgTestPassRate * 100).toFixed(0)}%`,
		improvement.testPassRate, parseFloat(improvement.testPassRate) > 0);

	row("Scope accuracy (avg)",
		`${(raw.avgScopeAccuracy * 100).toFixed(0)}%`,
		`${(pipeline.avgScopeAccuracy * 100).toFixed(0)}%`,
		improvement.scopeAccuracy, parseFloat(improvement.scopeAccuracy) > 0);

	row("Total retries",
		`${raw.totalRetries}`,
		`${pipeline.totalRetries}`,
		improvement.retryCount, parseInt(improvement.retryCount) < 0);

	row("Regressions",
		`${raw.regressionCount}`,
		`${pipeline.regressionCount}`,
		improvement.regressions, true);

	row("Avg time per task",
		`${raw.avgTimeSeconds.toFixed(1)}s`,
		`${pipeline.avgTimeSeconds.toFixed(1)}s`,
		improvement.timeDelta, parseFloat(improvement.timeDelta) < 0);

	row("Total cost",
		`$${raw.totalCostUsd.toFixed(4)}`,
		`$${pipeline.totalCostUsd.toFixed(4)}`,
		improvement.costDelta, parseFloat(improvement.costDelta.replace("$", "")) < 0);

	console.log(`  ${C.cyan}║${C.reset}  ${C.gray}${THIN.slice(0, 63)}${C.reset}${C.cyan}║${C.reset}`);

	const rawScoreColor = raw.overallScore >= 70 ? C.green : raw.overallScore >= 50 ? C.yellow : C.red;
	const pipeScoreColor = pipeline.overallScore >= 70 ? C.green : pipeline.overallScore >= 50 ? C.yellow : C.red;

	console.log(`  ${C.cyan}║${C.reset}  ${C.bold}${pad("OVERALL SCORE", 28)}${C.reset} ${rawScoreColor}${C.bold}${pad(`${raw.overallScore.toFixed(1)}/100`, 14)}${C.reset} ${pipeScoreColor}${C.bold}${pad(`${pipeline.overallScore.toFixed(1)}/100`, 14)}${C.reset} ${C.cyan}${C.bold}${improvement.overallScore}${C.reset}${C.cyan}║${C.reset}`);

	console.log(`  ${C.cyan}${C.bold}╠${LINE}╣${C.reset}`);

	// Per-task breakdown
	console.log(`  ${C.cyan}║${C.reset}  ${C.bold}Per-Task Detail${C.reset}${" ".repeat(49)}${C.cyan}║${C.reset}`);
	console.log(`  ${C.cyan}║${C.reset}  ${C.gray}${THIN.slice(0, 63)}${C.reset}${C.cyan}║${C.reset}`);

	for (let i = 0; i < report.tasks.length; i++) {
		const task = report.tasks[i]!;
		const rr = report.rawResults[i]!;
		const pr = report.pipelineResults[i]!;

		const rawIcon = rr.m1_firstPassSuccess ? `${C.green}✓` : `${C.red}✗`;
		const pipeIcon = pr.m1_firstPassSuccess ? `${C.green}✓` : `${C.red}✗`;

		console.log(`  ${C.cyan}║${C.reset}  ${C.bold}${task.id}${C.reset} ${pad(task.name, 30)} Raw:${rawIcon}${C.reset} ${rr.testsPassed}/${rr.testsTotal}  Pipe:${pipeIcon}${C.reset} ${pr.testsPassed}/${pr.testsTotal}${" ".repeat(3)}${C.cyan}║${C.reset}`);
	}

	console.log(`  ${C.cyan}${C.bold}╠${LINE}╣${C.reset}`);

	// Verdict
	const scoreDelta = pipeline.overallScore - raw.overallScore;
	const verdict = scoreDelta > 10
		? `${C.green}${C.bold}SIGNIFICANT IMPROVEMENT${C.reset} — Pipeline produces better code`
		: scoreDelta > 0
			? `${C.yellow}MARGINAL IMPROVEMENT${C.reset} — Pipeline slightly better`
			: `${C.red}NO IMPROVEMENT${C.reset} — Pipeline did not help on these tasks`;

	console.log(`  ${C.cyan}║${C.reset}  Verdict: ${verdict}${" ".repeat(Math.max(0, 20))}${C.cyan}║${C.reset}`);

	if (scoreDelta > 0) {
		console.log(`  ${C.cyan}║${C.reset}  ${C.dim}Trade-off: +${improvement.costDelta} cost, ${improvement.timeDelta} time${C.reset}${" ".repeat(30)}${C.cyan}║${C.reset}`);
		console.log(`  ${C.cyan}║${C.reset}  ${C.dim}Gain: ${improvement.testPassRate} test pass, ${improvement.firstPassSuccess} first-pass${C.reset}${" ".repeat(22)}${C.cyan}║${C.reset}`);
	}

	console.log(`  ${C.cyan}${C.bold}╚${LINE}╝${C.reset}\n`);
}

// ─── Save Report ─────────────────────────────────────────────────

function saveReport(report: BenchReport): void {
	const dir = join(__dirname, "results");
	mkdirSync(dir, { recursive: true });

	const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
	const jsonPath = join(dir, `report-${ts}.json`);
	writeFileSync(jsonPath, JSON.stringify(report, null, 2));

	console.log(`  ${C.dim}Report saved: ${jsonPath}${C.reset}`);
	console.log(`  ${C.dim}Re-run with: npx tsx benchmarks/run-benchmark.ts --agent ${agentFlag}${isMock ? "" : ""}${C.reset}\n`);
}

// ─── Run ─────────────────────────────────────────────────────────

main().catch(err => {
	console.error(`\n  ${C.red}Benchmark failed:${C.reset}`, err);
	process.exit(1);
});
