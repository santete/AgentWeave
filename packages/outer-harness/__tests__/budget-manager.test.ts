import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { BudgetManager } from "../src/governance/budget-manager";
import { writeFileSync, mkdirSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

// ─── Core (v1.1.0 tests, preserved) ─────────────────────────────

describe("BudgetManager", () => {
	it("should start at zero cost", () => {
		const bm = new BudgetManager({ warningThreshold: 0.8 });
		expect(bm.getSessionCost()).toBe(0);
		expect(bm.getDailyCost()).toBe(0);
		expect(bm.canProceed()).toBe(true);
	});

	it("should accumulate session cost", () => {
		const bm = new BudgetManager({ maxPerSession: 5, warningThreshold: 0.8 });
		bm.addCost(2.5);
		bm.addCost(1.0);

		expect(bm.getSessionCost()).toBeCloseTo(3.5);
		expect(bm.canProceed()).toBe(true);
	});

	it("should deny when session budget exceeded", () => {
		const bm = new BudgetManager({ maxPerSession: 5, warningThreshold: 0.8 });
		bm.addCost(5.01);

		expect(bm.canProceed()).toBe(false);
		expect(bm.isExceeded()).toBe(true);
	});

	it("should deny when daily budget exceeded", () => {
		const bm = new BudgetManager({ maxPerDay: 10, warningThreshold: 0.8 });
		bm.addCost(10.01);

		expect(bm.canProceed()).toBe(false);
	});

	it("should warn at threshold", () => {
		const bm = new BudgetManager({ maxPerSession: 10, warningThreshold: 0.8 });

		bm.addCost(7);
		expect(bm.isWarning()).toBe(false);

		bm.addCost(1.5);
		expect(bm.isWarning()).toBe(true); // 8.5/10 = 85% > 80%
		expect(bm.canProceed()).toBe(true); // not exceeded yet
	});

	it("should track session and daily independently", () => {
		const bm = new BudgetManager({
			maxPerSession: 5,
			maxPerDay: 20,
			warningThreshold: 0.8,
		});

		bm.addCost(4);
		expect(bm.getSessionCost()).toBeCloseTo(4);
		expect(bm.getDailyCost()).toBeCloseTo(4);
		expect(bm.canProceed()).toBe(true);

		// Reset session, daily continues
		bm.resetSession();
		expect(bm.getSessionCost()).toBe(0);
		expect(bm.getDailyCost()).toBeCloseTo(4);
	});

	it("should provide full status", () => {
		const bm = new BudgetManager({
			maxPerSession: 10,
			maxPerDay: 50,
			warningThreshold: 0.8,
		});
		bm.addCost(3);

		const status = bm.getStatus();
		expect(status.sessionCost).toBeCloseTo(3);
		expect(status.sessionLimit).toBe(10);
		expect(status.dailyLimit).toBe(50);
		expect(status.remainingSession).toBeCloseTo(7);
		expect(status.remainingDaily).toBeCloseTo(47);
		expect(status.isWarning).toBe(false);
		expect(status.isExceeded).toBe(false);
	});

	it("should allow unlimited when no limits set", () => {
		const bm = new BudgetManager({ warningThreshold: 0.8 });
		bm.addCost(1000);

		expect(bm.canProceed()).toBe(true);
		expect(bm.isWarning()).toBe(false);
	});

	it("should reset daily cost", () => {
		const bm = new BudgetManager({ maxPerDay: 10, warningThreshold: 0.8 });
		bm.addCost(8);
		bm.resetDaily();

		expect(bm.getDailyCost()).toBe(0);
		expect(bm.canProceed()).toBe(true);
	});
});

// ─── Per-tool/per-model cost breakdown ───────────────────────────

describe("BudgetManager — breakdown", () => {
	it("should track cost per tool", () => {
		const bm = new BudgetManager({ warningThreshold: 0.8 });
		bm.addCost(1.5, { toolName: "Bash" });
		bm.addCost(0.5, { toolName: "FileRead" });
		bm.addCost(2.0, { toolName: "Bash" });

		const breakdown = bm.getBreakdown();
		expect(breakdown.byTool.Bash).toBe(3.5);
		expect(breakdown.byTool.FileRead).toBe(0.5);
	});

	it("should track cost per model", () => {
		const bm = new BudgetManager({ warningThreshold: 0.8 });
		bm.addCost(1.0, { model: "claude-sonnet-4-6" });
		bm.addCost(0.3, { model: "gpt-4o" });
		bm.addCost(2.0, { model: "claude-sonnet-4-6" });

		const breakdown = bm.getBreakdown();
		expect(breakdown.byModel["claude-sonnet-4-6"]).toBe(3.0);
		expect(breakdown.byModel["gpt-4o"]).toBe(0.3);
	});

	it("should include breakdown in status", () => {
		const bm = new BudgetManager({ warningThreshold: 0.8 });
		bm.addCost(1.0, { toolName: "Bash", model: "claude-sonnet-4-6" });

		const status = bm.getStatus();
		expect(status.breakdown.byTool.Bash).toBe(1.0);
		expect(status.breakdown.byModel["claude-sonnet-4-6"]).toBe(1.0);
	});

	it("should track without metadata (backward compat)", () => {
		const bm = new BudgetManager({ warningThreshold: 0.8 });
		bm.addCost(5);
		expect(bm.getSessionCost()).toBe(5);
		expect(Object.keys(bm.getBreakdown().byTool)).toHaveLength(0);
	});

	it("should clear session breakdown on resetSession but keep daily", () => {
		const bm = new BudgetManager({ warningThreshold: 0.8 });
		bm.addCost(1.0, { toolName: "Bash" });
		bm.resetSession();
		expect(bm.getSessionCost()).toBe(0);
		// Daily breakdown persists
		expect(bm.getBreakdown().byTool.Bash).toBe(1.0);
	});

	it("should ignore non-positive and non-finite cost", () => {
		const bm = new BudgetManager({ warningThreshold: 0.8 });
		bm.addCost(0);
		bm.addCost(-5);
		bm.addCost(NaN);
		bm.addCost(Infinity);
		expect(bm.getSessionCost()).toBe(0);
	});
});

// ─── Cost Estimation ─────────────────────────────────────────────

describe("BudgetManager — estimation", () => {
	it("should estimate within limits", () => {
		const bm = new BudgetManager({ maxPerSession: 10, maxPerDay: 50, warningThreshold: 0.8 });
		bm.addCost(5);

		const est = bm.estimateCost(3);
		expect(est.wouldExceedSession).toBe(false);
		expect(est.wouldExceedDaily).toBe(false);
		expect(est.remainingAfter.session).toBe(2);
		expect(est.remainingAfter.daily).toBe(42);
	});

	it("should detect session would exceed", () => {
		const bm = new BudgetManager({ maxPerSession: 10, warningThreshold: 0.8 });
		bm.addCost(8);

		const est = bm.estimateCost(5);
		expect(est.wouldExceedSession).toBe(true);
		expect(est.remainingAfter.session).toBe(0);
	});

	it("should detect daily would exceed", () => {
		const bm = new BudgetManager({ maxPerDay: 20, warningThreshold: 0.8 });
		bm.addCost(18);

		const est = bm.estimateCost(5);
		expect(est.wouldExceedDaily).toBe(true);
	});

	it("should return undefined remaining when no limits", () => {
		const bm = new BudgetManager({ warningThreshold: 0.8 });

		const est = bm.estimateCost(100);
		expect(est.wouldExceedSession).toBe(false);
		expect(est.wouldExceedDaily).toBe(false);
		expect(est.remainingAfter.session).toBeUndefined();
		expect(est.remainingAfter.daily).toBeUndefined();
	});
});

// ─── Event Emission ──────────────────────────────────────────────

describe("BudgetManager — events", () => {
	it("should emit cost_added on addCost", () => {
		const bm = new BudgetManager({ warningThreshold: 0.8 });
		const events: string[] = [];
		bm.onBudgetEvent((e) => events.push(e.type));

		bm.addCost(1);
		expect(events).toContain("budget:cost_added");
	});

	it("should emit warning on threshold crossing (once)", () => {
		const bm = new BudgetManager({ maxPerSession: 10, warningThreshold: 0.8 });
		const events: string[] = [];
		bm.onBudgetEvent((e) => events.push(e.type));

		bm.addCost(7); // 70% — no warning yet
		expect(events.filter((e) => e === "budget:warning")).toHaveLength(0);

		bm.addCost(1); // 80% — warning fires
		expect(events.filter((e) => e === "budget:warning")).toHaveLength(1);

		bm.addCost(0.5); // 85% — no duplicate warning
		expect(events.filter((e) => e === "budget:warning")).toHaveLength(1);
	});

	it("should emit exceeded on limit crossing (once)", () => {
		const bm = new BudgetManager({ maxPerSession: 10, warningThreshold: 0.8 });
		const events: string[] = [];
		bm.onBudgetEvent((e) => events.push(e.type));

		bm.addCost(10); // exactly at limit
		expect(events.filter((e) => e === "budget:exceeded")).toHaveLength(1);

		bm.addCost(1); // over — no duplicate
		expect(events.filter((e) => e === "budget:exceeded")).toHaveLength(1);
	});

	it("should include metadata in events", () => {
		const bm = new BudgetManager({ warningThreshold: 0.8 });
		let lastEvent: { delta?: number; toolName?: string; model?: string } | null = null;
		bm.onBudgetEvent((e) => { lastEvent = e; });

		bm.addCost(1.5, { toolName: "Bash", model: "claude-sonnet-4-6" });
		expect(lastEvent!.delta).toBe(1.5);
		expect(lastEvent!.toolName).toBe("Bash");
		expect(lastEvent!.model).toBe("claude-sonnet-4-6");
	});

	it("should unsubscribe via returned function", () => {
		const bm = new BudgetManager({ warningThreshold: 0.8 });
		const events: string[] = [];
		const unsub = bm.onBudgetEvent((e) => events.push(e.type));

		bm.addCost(1);
		expect(events).toHaveLength(1);

		unsub();
		bm.addCost(1);
		expect(events).toHaveLength(1); // No more events
	});
});

// ─── Persistence ─────────────────────────────────────────────────

describe("BudgetManager — persistence", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = join(tmpdir(), `agentweave-test-${randomUUID().slice(0, 8)}`);
		mkdirSync(tmpDir, { recursive: true });
	});

	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true });
	});

	it("should flush state to file", () => {
		const persistPath = join(tmpDir, "budget.json");
		const bm = new BudgetManager({ warningThreshold: 0.8, persistPath });
		bm.addCost(5, { toolName: "Bash", model: "claude-sonnet-4-6" });
		bm.flush();

		const raw = JSON.parse(readFileSync(persistPath, "utf-8"));
		expect(raw.dailyCost).toBe(5);
		expect(raw.costByTool.Bash).toBe(5);
		expect(raw.costByModel["claude-sonnet-4-6"]).toBe(5);
		expect(raw.dailyDate).toBe(new Date().toISOString().slice(0, 10));
	});

	it("should restore daily cost from file", () => {
		const persistPath = join(tmpDir, "budget.json");
		const today = new Date().toISOString().slice(0, 10);

		writeFileSync(persistPath, JSON.stringify({
			dailyCost: 12.5,
			dailyDate: today,
			costByTool: { Bash: 10, FileRead: 2.5 },
			costByModel: { "gpt-4o": 12.5 },
		}));

		const bm = new BudgetManager({ warningThreshold: 0.8, persistPath });
		bm.loadPersistedState();

		expect(bm.getDailyCost()).toBe(12.5);
		expect(bm.getBreakdown().byTool.Bash).toBe(10);
		expect(bm.getSessionCost()).toBe(0); // Session NOT restored
	});

	it("should auto-reset daily on date change", () => {
		const persistPath = join(tmpDir, "budget.json");

		writeFileSync(persistPath, JSON.stringify({
			dailyCost: 99,
			dailyDate: "2020-01-01", // Old date
			costByTool: { Bash: 99 },
			costByModel: {},
		}));

		const bm = new BudgetManager({ warningThreshold: 0.8, persistPath });
		bm.loadPersistedState();

		expect(bm.getDailyCost()).toBe(0);
		expect(Object.keys(bm.getBreakdown().byTool)).toHaveLength(0);
	});

	it("should handle missing persist file gracefully", () => {
		const persistPath = join(tmpDir, "nonexistent.json");
		const bm = new BudgetManager({ warningThreshold: 0.8, persistPath });
		bm.loadPersistedState();
		expect(bm.getDailyCost()).toBe(0);
	});

	it("should handle corrupted persist file gracefully", () => {
		const persistPath = join(tmpDir, "budget.json");
		writeFileSync(persistPath, "not json {{{");

		const bm = new BudgetManager({ warningThreshold: 0.8, persistPath });
		bm.loadPersistedState();
		expect(bm.getDailyCost()).toBe(0);
	});

	it("should not persist when persistPath is not set", () => {
		const bm = new BudgetManager({ warningThreshold: 0.8 });
		bm.addCost(5);
		bm.flush(); // Should not throw
		bm.loadPersistedState(); // Should not throw
	});
});
