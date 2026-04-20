/**
 * MetricsCollector — Collects M1-M10 metrics per SDLC task.
 * Supports baseline comparison and persistence.
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type {
	SDLCMetricsSnapshot,
	SDLCBaselineComparison,
	SDLCPlan,
	SDLCExecutionResult,
	SDLCValidationResult,
	MetricsHandle,
} from "@agentweave/types";

export class MetricsCollector {
	private taskId: string;
	private startTime: number;
	private recordings = new Map<string, number | boolean>();
	private activeTimers = new Map<string, number>();

	constructor(taskId: string) {
		this.taskId = taskId;
		this.startTime = Date.now();
	}

	/** Create a write-only handle for passing to modules. */
	createHandle(): MetricsHandle {
		return {
			record: (metric: string, value: number | boolean) => {
				this.recordings.set(metric, value);
			},
			startTimer: (label: string) => {
				const start = performance.now();
				this.activeTimers.set(label, start);
				return () => {
					const elapsed = performance.now() - start;
					this.recordings.set(`timer:${label}`, elapsed);
					this.activeTimers.delete(label);
					return elapsed;
				};
			},
		};
	}

	/** Record a metric value directly. */
	record(metric: string, value: number | boolean): void {
		this.recordings.set(metric, value);
	}

	/** Get a recorded metric. */
	get(metric: string): number | boolean | undefined {
		return this.recordings.get(metric);
	}

	/** Compute final snapshot from collected data. */
	finalize(
		executionResult: SDLCExecutionResult | null,
		plan: SDLCPlan | null,
		qaResult: SDLCValidationResult | null,
		_patchResult: SDLCValidationResult | null,
	): SDLCMetricsSnapshot {
		const retryCount = (this.recordings.get("retryCount") as number) ?? 0;

		// M1: first-pass success = QA passed on first attempt (retryCount === 0)
		const qaPassedFirst = qaResult?.passed === true && retryCount === 0;

		// M2: test pass rate from QA checks
		const testChecks = qaResult?.checks.filter((c) => c.name === "test") ?? [];
		const testPassRate = testChecks.length > 0
			? testChecks.filter((c) => c.passed).length / testChecks.length
			: 1;

		// M3: scope accuracy
		const expectedFiles = plan?.estimatedFiles ?? [];
		const changedFiles = executionResult?.changedFiles ?? [];
		const scopeAccuracy = changedFiles.length > 0 && expectedFiles.length > 0
			? changedFiles.filter((f) => expectedFiles.includes(f)).length / changedFiles.length
			: 1;

		// M5: cost
		const costUsd = executionResult?.usage.totalCost ?? 0;

		// M6: time
		const timeMs = Date.now() - this.startTime;

		// M7: regression detected
		const regressionDetected = (this.recordings.get("regressionDetected") as boolean) ?? false;

		// M8: plan accuracy
		const totalSteps = plan?.steps.length ?? 0;
		const doneSteps = plan?.steps.filter((s) => s.done).length ?? 0;
		const planAccuracy = totalSteps > 0 ? doneSteps / totalSteps : 1;

		// M9: context utilization
		const contextUtilization = (this.recordings.get("contextUtilization") as number) ?? 1;

		// M10: code quality delta
		const codeQualityDelta = (this.recordings.get("codeQualityDelta") as number) ?? 0;

		return {
			taskId: this.taskId,
			timestamp: Date.now(),
			m1_firstPassSuccess: qaPassedFirst,
			m2_testPassRate: testPassRate,
			m3_scopeAccuracy: scopeAccuracy,
			m4_retryCount: retryCount,
			m5_costUsd: costUsd,
			m6_timeToCompletionMs: timeMs,
			m7_regressionDetected: regressionDetected,
			m8_planAccuracy: planAccuracy,
			m9_contextUtilization: contextUtilization,
			m10_codeQualityDelta: codeQualityDelta,
		};
	}

	// ─── Baseline Comparison ────────────────────────────────────

	static compare(
		current: SDLCMetricsSnapshot,
		baseline: SDLCMetricsSnapshot | null,
	): SDLCBaselineComparison {
		if (!baseline) {
			return { current, baseline: null, deltas: {} };
		}

		const deltas: Record<string, number> = {
			m2_testPassRate: current.m2_testPassRate - baseline.m2_testPassRate,
			m3_scopeAccuracy: current.m3_scopeAccuracy - baseline.m3_scopeAccuracy,
			m4_retryCount: current.m4_retryCount - baseline.m4_retryCount,
			m5_costUsd: current.m5_costUsd - baseline.m5_costUsd,
			m6_timeToCompletionMs: current.m6_timeToCompletionMs - baseline.m6_timeToCompletionMs,
			m8_planAccuracy: current.m8_planAccuracy - baseline.m8_planAccuracy,
			m9_contextUtilization: current.m9_contextUtilization - baseline.m9_contextUtilization,
			m10_codeQualityDelta: current.m10_codeQualityDelta - baseline.m10_codeQualityDelta,
		};

		return { current, baseline, deltas };
	}

	// ─── Persistence ────────────────────────────────────────────

	static loadBaseline(path: string): SDLCMetricsSnapshot | null {
		try {
			const raw = readFileSync(path, "utf-8");
			return JSON.parse(raw) as SDLCMetricsSnapshot;
		} catch {
			return null;
		}
	}

	static saveBaseline(path: string, snapshot: SDLCMetricsSnapshot): void {
		try {
			mkdirSync(dirname(path), { recursive: true });
			writeFileSync(path, JSON.stringify(snapshot, null, 2), "utf-8");
		} catch {
			// Best-effort — don't crash
		}
	}
}
