import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { MetricsCollector } from "../../src/sdlc/metrics-collector";
import { createEmptyTokenUsage } from "@agentweave/types";
import type { SDLCExecutionResult, SDLCPlan, SDLCValidationResult } from "@agentweave/types";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdirSync, rmSync, existsSync } from "node:fs";
import { randomUUID } from "node:crypto";

function makeExecResult(overrides: Partial<SDLCExecutionResult> = {}): SDLCExecutionResult {
	return {
		success: true,
		changedFiles: ["src/app.ts"],
		output: "done",
		usage: { ...createEmptyTokenUsage(), totalCost: 0.05 },
		durationMs: 1000,
		terminalReason: "completed",
		...overrides,
	};
}

function makePlan(overrides: Partial<SDLCPlan> = {}): SDLCPlan {
	return {
		taskId: "task_1",
		steps: [
			{ index: 0, description: "Edit app.ts", type: "write", files: ["src/app.ts"], done: true },
			{ index: 1, description: "Run tests", type: "test", done: true },
		],
		estimatedFiles: ["src/app.ts"],
		...overrides,
	};
}

function makeQA(passed: boolean, checks: Array<{ name: string; passed: boolean }> = []): SDLCValidationResult {
	return {
		passed,
		checks: checks.map((c) => ({ ...c, severity: "error" as const })),
	};
}

describe("MetricsCollector", () => {
	it("should create a handle that records values", () => {
		const mc = new MetricsCollector("task_1");
		const handle = mc.createHandle();

		handle.record("retryCount", 2);
		handle.record("regressionDetected", true);

		expect(mc.get("retryCount")).toBe(2);
		expect(mc.get("regressionDetected")).toBe(true);
	});

	it("should create a handle that tracks timers", async () => {
		const mc = new MetricsCollector("task_1");
		const handle = mc.createHandle();

		const stop = handle.startTimer("execution");
		await new Promise((r) => setTimeout(r, 20));
		const elapsed = stop();

		expect(elapsed).toBeGreaterThan(10);
		expect(mc.get("timer:execution")).toBeGreaterThan(10);
	});

	it("should finalize snapshot with all 10 metrics", () => {
		const mc = new MetricsCollector("task_1");
		const result = makeExecResult({ changedFiles: ["src/app.ts"] });
		const plan = makePlan({ estimatedFiles: ["src/app.ts"] });
		const qa = makeQA(true, [{ name: "test", passed: true }]);

		const snapshot = mc.finalize(result, plan, qa, null);

		expect(snapshot.taskId).toBe("task_1");
		expect(snapshot.m1_firstPassSuccess).toBe(true);
		expect(snapshot.m2_testPassRate).toBe(1);
		expect(snapshot.m3_scopeAccuracy).toBe(1); // all changed files in scope
		expect(snapshot.m4_retryCount).toBe(0);
		expect(snapshot.m5_costUsd).toBe(0.05);
		expect(snapshot.m6_timeToCompletionMs).toBeGreaterThanOrEqual(0);
		expect(snapshot.m7_regressionDetected).toBe(false);
		expect(snapshot.m8_planAccuracy).toBe(1); // all steps done
		expect(snapshot.m9_contextUtilization).toBe(1); // default
		expect(snapshot.m10_codeQualityDelta).toBe(0);
	});

	it("should report first-pass failure when retries occurred", () => {
		const mc = new MetricsCollector("task_1");
		mc.record("retryCount", 2);

		const qa = makeQA(true, [{ name: "test", passed: true }]);
		const snapshot = mc.finalize(makeExecResult(), null, qa, null);

		expect(snapshot.m1_firstPassSuccess).toBe(false);
		expect(snapshot.m4_retryCount).toBe(2);
	});

	it("should calculate scope accuracy with mismatched files", () => {
		const mc = new MetricsCollector("task_1");
		const result = makeExecResult({ changedFiles: ["src/app.ts", "src/unrelated.ts", "docs/readme.md"] });
		const plan = makePlan({ estimatedFiles: ["src/app.ts"] });

		const snapshot = mc.finalize(result, plan, null, null);

		// 1 out of 3 changed files was in scope
		expect(snapshot.m3_scopeAccuracy).toBeCloseTo(1 / 3);
	});

	it("should calculate plan accuracy with partial completion", () => {
		const mc = new MetricsCollector("task_1");
		const plan: SDLCPlan = {
			taskId: "task_1",
			steps: [
				{ index: 0, description: "Step 1", type: "write", done: true },
				{ index: 1, description: "Step 2", type: "write", done: false },
				{ index: 2, description: "Step 3", type: "test", done: true },
			],
			estimatedFiles: [],
		};

		const snapshot = mc.finalize(makeExecResult(), plan, null, null);
		expect(snapshot.m8_planAccuracy).toBeCloseTo(2 / 3);
	});

	it("should handle null inputs gracefully", () => {
		const mc = new MetricsCollector("task_1");
		const snapshot = mc.finalize(null, null, null, null);

		expect(snapshot.m1_firstPassSuccess).toBe(false); // no QA = not success
		expect(snapshot.m2_testPassRate).toBe(1); // no test checks = default 1
		expect(snapshot.m3_scopeAccuracy).toBe(1); // no files = default 1
		expect(snapshot.m5_costUsd).toBe(0);
	});

	it("should record custom metrics from handle", () => {
		const mc = new MetricsCollector("task_1");
		const handle = mc.createHandle();

		handle.record("contextUtilization", 0.75);
		handle.record("codeQualityDelta", 5);

		const snapshot = mc.finalize(makeExecResult(), null, null, null);
		expect(snapshot.m9_contextUtilization).toBe(0.75);
		expect(snapshot.m10_codeQualityDelta).toBe(5);
	});
});

describe("MetricsCollector — comparison", () => {
	it("should compute deltas between current and baseline", () => {
		const baseline = {
			taskId: "task_0", timestamp: 0,
			m1_firstPassSuccess: false, m2_testPassRate: 0.6,
			m3_scopeAccuracy: 0.7, m4_retryCount: 3,
			m5_costUsd: 0.10, m6_timeToCompletionMs: 5000,
			m7_regressionDetected: true, m8_planAccuracy: 0.5,
			m9_contextUtilization: 0.8, m10_codeQualityDelta: 0,
		};

		const current = {
			taskId: "task_1", timestamp: 1,
			m1_firstPassSuccess: true, m2_testPassRate: 0.95,
			m3_scopeAccuracy: 0.95, m4_retryCount: 1,
			m5_costUsd: 0.12, m6_timeToCompletionMs: 6000,
			m7_regressionDetected: false, m8_planAccuracy: 0.9,
			m9_contextUtilization: 0.85, m10_codeQualityDelta: 3,
		};

		const comparison = MetricsCollector.compare(current, baseline);

		expect(comparison.deltas.m2_testPassRate).toBeCloseTo(0.35);
		expect(comparison.deltas.m3_scopeAccuracy).toBeCloseTo(0.25);
		expect(comparison.deltas.m4_retryCount).toBe(-2); // improved (fewer retries)
		expect(comparison.deltas.m5_costUsd).toBeCloseTo(0.02); // slightly more expensive
	});

	it("should return empty deltas when no baseline", () => {
		const current = {
			taskId: "task_1", timestamp: 1,
			m1_firstPassSuccess: true, m2_testPassRate: 0.9,
			m3_scopeAccuracy: 0.9, m4_retryCount: 0,
			m5_costUsd: 0.05, m6_timeToCompletionMs: 2000,
			m7_regressionDetected: false, m8_planAccuracy: 1,
			m9_contextUtilization: 0.8, m10_codeQualityDelta: 2,
		};

		const comparison = MetricsCollector.compare(current, null);
		expect(comparison.baseline).toBeNull();
		expect(Object.keys(comparison.deltas)).toHaveLength(0);
	});
});

describe("MetricsCollector — persistence", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = join(tmpdir(), `agentweave-metrics-${randomUUID().slice(0, 8)}`);
		mkdirSync(tmpDir, { recursive: true });
	});

	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true });
	});

	it("should save and load baseline", () => {
		const path = join(tmpDir, "baseline.json");
		const snapshot = {
			taskId: "task_1", timestamp: Date.now(),
			m1_firstPassSuccess: true, m2_testPassRate: 0.9,
			m3_scopeAccuracy: 0.95, m4_retryCount: 0,
			m5_costUsd: 0.05, m6_timeToCompletionMs: 2000,
			m7_regressionDetected: false, m8_planAccuracy: 1,
			m9_contextUtilization: 0.8, m10_codeQualityDelta: 2,
		};

		MetricsCollector.saveBaseline(path, snapshot);
		expect(existsSync(path)).toBe(true);

		const loaded = MetricsCollector.loadBaseline(path);
		expect(loaded).not.toBeNull();
		expect(loaded!.taskId).toBe("task_1");
		expect(loaded!.m2_testPassRate).toBe(0.9);
	});

	it("should return null for missing baseline file", () => {
		const loaded = MetricsCollector.loadBaseline(join(tmpDir, "nope.json"));
		expect(loaded).toBeNull();
	});

	it("should handle corrupted baseline file", () => {
		const path = join(tmpDir, "bad.json");
		const { writeFileSync: wfs } = require("node:fs");
		wfs(path, "not json{{{");

		const loaded = MetricsCollector.loadBaseline(path);
		expect(loaded).toBeNull();
	});
});
