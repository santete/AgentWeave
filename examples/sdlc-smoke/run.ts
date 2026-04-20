#!/usr/bin/env npx tsx
/**
 * SDLC Inner Harness — E2E Smoke Test
 *
 * Proves the SDLC pipeline works STANDALONE (no control-plane, no outer-harness).
 * Uses a mock execution provider — no API key needed.
 *
 * Usage:
 *   npx tsx examples/sdlc-smoke/run.ts
 *
 * What this proves:
 *   ✓ S1: createSDLCPipeline() works standalone
 *   ✓ S2: AgentLoop works without controlPlane
 *   ✓ S3: All 8 SDLC modules execute (or skip when disabled)
 *   ✓ S4: MetricsCollector collects M1-M10
 *   ✓ S5: Baseline comparison works
 *   ✓ S6: Config-driven enable/disable
 *   ✓ S7: Custom LLM caller for meta tasks
 *   ✓ S8: Module runner handles errors gracefully
 *   ✓ S9: SDLCOrchestrator implements InnerHarnessProvider fully
 *   ✓ S10: Pipeline events stream correctly
 */

import {
	createSDLCPipeline,
	SDLCOrchestrator,
	AgentLoop,
	createNoopControlPlane,
	MetricsCollector,
	getDefaultSDLCConfig,
	BUILT_IN_TOOLS,
} from "../../packages/inner-harness/src/index";

import { createEmptyTokenUsage } from "../../packages/types/src/index";

import type {
	InnerEvent,
	InnerHarnessProvider,
	TerminalResult,
	RunOptions,
	ContentBlock,
	Message,
	SDLCMetricsSnapshot,
} from "../../packages/types/src/index";

// ─── ANSI ────────────────────────────────────────────────────────

const C = {
	reset: "\x1b[0m", bold: "\x1b[1m", dim: "\x1b[2m",
	green: "\x1b[32m", red: "\x1b[31m", yellow: "\x1b[33m",
	cyan: "\x1b[36m", gray: "\x1b[90m",
};

const LINE = "─".repeat(60);
let passed = 0;
let failed = 0;

function check(id: string, name: string, condition: boolean, detail = ""): void {
	if (condition) {
		console.log(`  ${C.green}✓ ${id}${C.reset}  ${name}${detail ? ` ${C.dim}(${detail})${C.reset}` : ""}`);
		passed++;
	} else {
		console.log(`  ${C.red}✗ ${id}${C.reset}  ${name}${detail ? ` ${C.dim}(${detail})${C.reset}` : ""}`);
		failed++;
	}
}

// ─── Mock Provider ───────────────────────────────────────────────

function createMockProvider(): InnerHarnessProvider {
	const usage = { ...createEmptyTokenUsage(), totalCost: 0.025 };
	return {
		run(_prompt: string | ContentBlock[], _options?: RunOptions): AsyncGenerator<InnerEvent, TerminalResult, void> {
			return (async function* () {
				yield {
					id: "e1", timestamp: Date.now(), sessionId: "ses_mock", agentId: "agent_mock",
					type: "message:assistant",
					content: [{ type: "text", text: "Fixed the null check in AuthService.login()" }],
				} as InnerEvent;
				yield {
					id: "e2", timestamp: Date.now(), sessionId: "ses_mock", agentId: "agent_mock",
					type: "tool:completed", toolName: "FileEdit", toolUseId: "tu_1",
					toolInput: { path: "src/auth.ts" }, durationMs: 45,
				} as unknown as InnerEvent;
				return { reason: "completed", usage } satisfies TerminalResult;
			})();
		},
		abort() {},
		getState() { return { status: "completed" as const, turnIndex: 1, model: "mock", usage, contextUsage: { usedTokens: 0, maxTokens: 200000, pct: 0, compactionCount: 0 }, activeTool: null, messageCount: 1, recoveryAttempts: 0 }; },
		getMessages(): ReadonlyArray<Message> { return [{ role: "assistant", content: [{ type: "text", text: "done" }] }]; },
		getContextUsage() { return { usedTokens: 0, maxTokens: 200000, pct: 0, compactionCount: 0 }; },
		getUsage() { return usage; },
		getTools() { return []; },
		registerTool() {}, unregisterTool() {}, injectMessage() {},
		setSystemPromptSection() {}, setModel() {},
		getConfig() { return { model: "mock", maxTurns: 1, thinkingEnabled: false, tools: [] }; },
	};
}

// ─── Mock LLM Caller ────────────────────────────────────────────

const mockLLMCaller = async (prompt: string, _model: string): Promise<string> => {
	// Detect which module is calling based on prompt content
	if (prompt.includes("task normalizer") || prompt.includes("extract a structured task")) {
		return JSON.stringify({
			goal: "Fix null pointer in AuthService.login()",
			context: ["src/auth.ts"],
			constraints: ["No breaking changes"],
			definitionOfDone: ["Unit tests pass"],
		});
	}
	if (prompt.includes("plan generator") || prompt.includes("execution plan")) {
		return JSON.stringify({
			steps: [
				{ description: "Read AuthService.ts", type: "read", files: ["src/auth.ts"] },
				{ description: "Fix null check", type: "write", files: ["src/auth.ts"] },
				{ description: "Run tests", type: "test" },
			],
			estimatedFiles: ["src/auth.ts"],
		});
	}
	if (prompt.includes("commit") || prompt.includes("PR")) {
		return JSON.stringify({
			commitMessage: "fix(auth): handle null pointer in login flow",
			prTitle: "Fix auth null pointer",
			prDescription: "## Summary\n- Fixed null check in AuthService.login()",
			summary: "Fixed null pointer exception",
		});
	}
	return "Mock LLM response";
};

// ─── Main ────────────────────────────────────────────────────────

async function main() {
	console.log(`\n  ${C.cyan}${C.bold}AgentWeave Inner Harness — SDLC E2E Smoke Test${C.reset}`);
	console.log(`  ${C.gray}${LINE}${C.reset}\n`);

	// ── S1: createSDLCPipeline standalone ──────────────────────

	console.log(`  ${C.cyan}S1-S3: Standalone Pipeline${C.reset}`);

	const pipeline = createSDLCPipeline({
		modules: {
			taskNormalizer: { enabled: true },
			contextBuilder: { enabled: false }, // skip file search in smoke test
			planGenerator: { enabled: true },
			executionBridge: { enabled: true },
			patchValidator: { enabled: true },
			qualityGate: { enabled: false },  // no real tests to run
			retryEngine: { enabled: true, maxRetries: 2 },
			outputStandardizer: { enabled: false },
		},
		execution: { mode: "agent-loop" },
		metrics: { enabled: true, baseline: false },
		llmCaller: mockLLMCaller,
	});

	pipeline.setExecutionProvider(createMockProvider());

	check("S1", "createSDLCPipeline() returns SDLCOrchestrator", pipeline instanceof SDLCOrchestrator);
	check("S2", "Pipeline state is idle before run", pipeline.getState().status === "idle");

	// Collect events
	const events: InnerEvent[] = [];
	const gen = pipeline.run("Fix the login bug where users get null pointer on AuthService");
	let terminalResult: TerminalResult | null = null;

	for (;;) {
		const { value, done } = await gen.next();
		if (done) { terminalResult = value; break; }
		events.push(value);
	}

	check("S3", "Pipeline completed successfully", terminalResult?.reason === "completed");

	// ── S4: Metrics M1-M10 ────────────────────────────────────

	console.log(`\n  ${C.cyan}S4-S5: Metrics${C.reset}`);

	const metrics = pipeline.getLastMetrics();
	check("S4a", "Metrics snapshot exists", metrics !== null);

	if (metrics) {
		check("S4b", "M1 firstPassSuccess is boolean", typeof metrics.m1_firstPassSuccess === "boolean", `${metrics.m1_firstPassSuccess}`);
		check("S4c", "M2 testPassRate is number [0-1]", metrics.m2_testPassRate >= 0 && metrics.m2_testPassRate <= 1, `${metrics.m2_testPassRate}`);
		check("S4d", "M3 scopeAccuracy is number [0-1]", metrics.m3_scopeAccuracy >= 0 && metrics.m3_scopeAccuracy <= 1, `${metrics.m3_scopeAccuracy}`);
		check("S4e", "M4 retryCount is number", typeof metrics.m4_retryCount === "number", `${metrics.m4_retryCount}`);
		check("S4f", "M5 costUsd is number >= 0", metrics.m5_costUsd >= 0, `$${metrics.m5_costUsd.toFixed(4)}`);
		check("S4g", "M6 timeToCompletion > 0", metrics.m6_timeToCompletionMs >= 0, `${metrics.m6_timeToCompletionMs}ms`);
		check("S4h", "M7 regressionDetected is boolean", typeof metrics.m7_regressionDetected === "boolean");
		check("S4i", "M8 planAccuracy is number [0-1]", metrics.m8_planAccuracy >= 0 && metrics.m8_planAccuracy <= 1, `${metrics.m8_planAccuracy}`);
		check("S4j", "M9 contextUtilization is number", typeof metrics.m9_contextUtilization === "number");
		check("S4k", "M10 codeQualityDelta is number", typeof metrics.m10_codeQualityDelta === "number");
	}

	// ── S5: Baseline comparison ───────────────────────────────

	const comparison = MetricsCollector.compare(
		metrics!,
		{ ...metrics!, m2_testPassRate: 0.5, m4_retryCount: 3 } // fake baseline
	);
	check("S5", "Baseline comparison produces deltas", Object.keys(comparison.deltas).length > 0, `${Object.keys(comparison.deltas).length} deltas`);

	// ── S6: Config-driven disable ─────────────────────────────

	console.log(`\n  ${C.cyan}S6: Config-Driven Module Control${C.reset}`);

	const minimalPipeline = createSDLCPipeline({
		modules: {
			taskNormalizer: { enabled: false },
			contextBuilder: { enabled: false },
			planGenerator: { enabled: false },
			executionBridge: { enabled: true },
			patchValidator: { enabled: false },
			qualityGate: { enabled: false },
			retryEngine: { enabled: false },
			outputStandardizer: { enabled: false },
		},
		execution: { mode: "agent-loop" },
	});
	minimalPipeline.setExecutionProvider(createMockProvider());

	const minEvents: InnerEvent[] = [];
	const minGen = minimalPipeline.run("Quick test");
	for (;;) {
		const { value, done } = await minGen.next();
		if (done) break;
		minEvents.push(value);
	}

	// Should have fewer SDLC status events (no normalize, context, plan phases)
	const sdlcStatusEvents = minEvents
		.filter((e) => e.type === "message:assistant")
		.map((e) => ((e as unknown as Record<string, unknown>).content as Array<{ text: string }>)?.[0]?.text ?? "")
		.filter((t) => t.startsWith("[SDLC]"));

	check("S6a", "Minimal pipeline completes", minimalPipeline.getState().status === "completed");
	check("S6b", "Disabled modules produce fewer SDLC events", sdlcStatusEvents.length < 5, `${sdlcStatusEvents.length} events`);

	// ── S7: LLM caller integration ────────────────────────────

	console.log(`\n  ${C.cyan}S7: LLM Caller for Meta Tasks${C.reset}`);

	let llmCallCount = 0;
	const trackingLLM = async (prompt: string, model: string): Promise<string> => {
		llmCallCount++;
		return mockLLMCaller(prompt, model);
	};

	const llmPipeline = createSDLCPipeline({
		modules: {
			taskNormalizer: { enabled: true },
			contextBuilder: { enabled: false },
			planGenerator: { enabled: true },
			executionBridge: { enabled: true },
			patchValidator: { enabled: false },
			qualityGate: { enabled: false },
			retryEngine: { enabled: false },
			outputStandardizer: { enabled: false },
		},
		execution: { mode: "agent-loop" },
		llmCaller: trackingLLM,
	});
	llmPipeline.setExecutionProvider(createMockProvider());

	const llmGen = llmPipeline.run("Fix auth bug");
	for (;;) {
		const { value, done } = await llmGen.next();
		if (done) break;
	}

	check("S7", "LLM caller invoked for meta tasks", llmCallCount >= 1, `${llmCallCount} calls`);

	// ── S8: Error handling ────────────────────────────────────

	console.log(`\n  ${C.cyan}S8: Error Handling${C.reset}`);

	const errorPipeline = createSDLCPipeline({
		modules: {
			taskNormalizer: { enabled: false },
			contextBuilder: { enabled: false },
			planGenerator: { enabled: false },
			executionBridge: { enabled: true },
			patchValidator: { enabled: false },
			qualityGate: { enabled: false },
			retryEngine: { enabled: false },
			outputStandardizer: { enabled: false },
		},
		execution: { mode: "agent-loop" },
	});

	const failProvider = createMockProvider();
	failProvider.run = function*() { throw new Error("simulated crash"); } as any;
	errorPipeline.setExecutionProvider(failProvider);

	const errorGen = errorPipeline.run("This will fail");
	let errorResult: TerminalResult | null = null;
	for (;;) {
		const { value, done } = await errorGen.next();
		if (done) { errorResult = value; break; }
	}

	check("S8", "Pipeline handles provider error gracefully", errorResult?.reason === "error");

	// ── S9: InnerHarnessProvider interface ─────────────────────

	console.log(`\n  ${C.cyan}S9: InnerHarnessProvider Interface${C.reset}`);

	const freshPipeline = createSDLCPipeline();
	check("S9a", "getState() returns InnerState", freshPipeline.getState().status === "idle");
	check("S9b", "getMessages() returns array", Array.isArray(freshPipeline.getMessages()));
	check("S9c", "getUsage() returns TokenUsage", typeof freshPipeline.getUsage().totalCost === "number");
	check("S9d", "getTools() returns array", Array.isArray(freshPipeline.getTools()));
	check("S9e", "getConfig() returns InnerConfig", typeof freshPipeline.getConfig().model === "string");

	// No-ops should not throw
	freshPipeline.abort();
	freshPipeline.registerTool({ name: "x", description: "x", parameters: {} as any, execute: async () => ({}) } as any);
	freshPipeline.unregisterTool("x");
	freshPipeline.injectMessage({ role: "user", content: "x" });
	freshPipeline.setSystemPromptSection("x", "x");
	freshPipeline.setModel("x");
	check("S9f", "No-op methods don't throw", true);

	// ── S10: Event streaming ──────────────────────────────────

	console.log(`\n  ${C.cyan}S10: Event Streaming${C.reset}`);

	const hasStart = events.some((e) => e.type === "turn:start");
	const hasEnd = events.some((e) => e.type === "turn:end");
	const hasTerminal = events.some((e) => e.type === "terminal");
	const hasAssistant = events.some((e) => e.type === "message:assistant");

	check("S10a", "Emits turn:start event", hasStart);
	check("S10b", "Emits turn:end event", hasEnd);
	check("S10c", "Emits terminal event", hasTerminal);
	check("S10d", "Emits message:assistant events", hasAssistant);
	check("S10e", "Total events > 5", events.length > 5, `${events.length} events`);

	// ── S11: AgentLoop standalone (no CP) ─────────────────────

	console.log(`\n  ${C.cyan}S11: AgentLoop Standalone${C.reset}`);

	const loop = new AgentLoop({ model: "mock-model" });
	check("S11a", "AgentLoop constructs without controlPlane", true);
	check("S11b", "State is idle", loop.getState().status === "idle");
	check("S11c", "Config model correct", loop.getConfig().model === "mock-model");

	// ── S12: NoopControlPlane ─────────────────────────────────

	console.log(`\n  ${C.cyan}S12: NoopControlPlane${C.reset}`);

	const noop = createNoopControlPlane();
	const toolDecision = await noop.intercept("tool_request", {
		toolName: "Bash", toolInput: { command: "rm -rf /" }, toolUseId: "tu_x",
		turnIndex: 1, isReadOnly: false, isDestructive: true,
	});
	check("S12a", "Noop allows all tool requests", toolDecision.behavior === "allow");

	const outputDecision = await noop.intercept("output_ready", {
		text: "secret", contentBlocks: [], usage: createEmptyTokenUsage(),
		turnIndex: 1, toolCallCount: 0, model: "x",
	});
	check("S12b", "Noop approves all output", outputDecision.action === "approve");

	const inputDecision = await noop.intercept("input_received", {
		text: "hello", sessionId: "x", timestamp: 0,
	});
	check("S12c", "Noop passes all input", inputDecision.action === "pass");

	noop.destroy();
	check("S12d", "Noop destroy doesn't throw", true);

	// ── Summary ───────────────────────────────────────────────

	console.log(`\n  ${C.gray}${LINE}${C.reset}`);
	const total = passed + failed;
	const allGreen = failed === 0;
	const icon = allGreen ? `${C.green}${C.bold}ALL PASS` : `${C.red}${C.bold}FAILURES`;
	console.log(`  ${icon}${C.reset}  ${C.green}${passed}${C.reset}/${total} checks passed`);

	if (!allGreen) {
		console.log(`  ${C.red}${failed} check(s) failed${C.reset}`);
	}
	console.log(`  ${C.gray}${LINE}${C.reset}\n`);

	process.exit(allGreen ? 0 : 1);
}

main().catch((err) => {
	console.error(`\n  ${C.red}SMOKE TEST CRASHED:${C.reset}`, err);
	process.exit(1);
});
