import { describe, it, expect, vi } from "vitest";
import { AlertEngine, createDefaultAlertRules } from "../src/observability/alert-engine";
import type { MonitorSnapshot, AlertRule } from "@agentweave/types";
import { createEmptyTokenUsage } from "@agentweave/types";

function makeSnapshot(overrides: Partial<MonitorSnapshot> = {}): MonitorSnapshot {
	return {
		sessionId: "ses_1",
		timestamp: Date.now(),
		turnCount: 5,
		totalUsage: { ...createEmptyTokenUsage(), totalCost: 0 },
		turnMetrics: [],
		toolMetrics: new Map(),
		errorCount: 0,
		permissionDeniedCount: 0,
		sessionDurationMs: 10_000,
		...overrides,
	};
}

describe("AlertEngine", () => {
	it("should fire alert when rule condition is met", () => {
		const engine = new AlertEngine();
		engine.addRule({
			name: "test_alert",
			severity: "warning",
			cooldownMs: 0,
			check: (snap) => snap.errorCount > 3,
			message: "Too many errors",
		});

		const fired = engine.check(makeSnapshot({ errorCount: 5 }));
		expect(fired).toHaveLength(1);
		expect(fired[0]!.ruleName).toBe("test_alert");
		expect(fired[0]!.severity).toBe("warning");
	});

	it("should not fire when condition is false", () => {
		const engine = new AlertEngine();
		engine.addRule({
			name: "test_alert",
			severity: "warning",
			cooldownMs: 0,
			check: (snap) => snap.errorCount > 10,
		});

		const fired = engine.check(makeSnapshot({ errorCount: 2 }));
		expect(fired).toHaveLength(0);
	});

	it("should respect cooldown", () => {
		const engine = new AlertEngine();
		engine.addRule({
			name: "cooldown_test",
			severity: "info",
			cooldownMs: 60_000, // 1 minute
			check: () => true, // always fires
		});

		const first = engine.check(makeSnapshot());
		expect(first).toHaveLength(1);

		// Second check within cooldown — should NOT fire
		const second = engine.check(makeSnapshot());
		expect(second).toHaveLength(0);
	});

	it("should notify listeners on alert", () => {
		const engine = new AlertEngine();
		const listener = vi.fn();
		engine.onAlert(listener);

		engine.addRule({
			name: "listener_test",
			severity: "critical",
			cooldownMs: 0,
			check: () => true,
		});

		engine.check(makeSnapshot());
		expect(listener).toHaveBeenCalledOnce();
		expect(listener.mock.calls[0]![0].severity).toBe("critical");
	});

	it("should unsubscribe listener", () => {
		const engine = new AlertEngine();
		const listener = vi.fn();
		const unsub = engine.onAlert(listener);

		engine.addRule({ name: "t", severity: "info", cooldownMs: 0, check: () => true });
		engine.check(makeSnapshot());
		expect(listener).toHaveBeenCalledOnce();

		unsub();
		engine.resetCooldowns();
		engine.check(makeSnapshot());
		expect(listener).toHaveBeenCalledOnce(); // not called again
	});

	it("should store alert history", () => {
		const engine = new AlertEngine();
		engine.addRule({ name: "a", severity: "warning", cooldownMs: 0, check: () => true });
		engine.addRule({ name: "b", severity: "critical", cooldownMs: 0, check: () => true });

		engine.check(makeSnapshot());
		expect(engine.getAlerts()).toHaveLength(2);
		expect(engine.getAlertsBySeverity("critical")).toHaveLength(1);
	});

	it("should remove rules", () => {
		const engine = new AlertEngine();
		engine.addRule({ name: "x", severity: "info", cooldownMs: 0, check: () => true });
		expect(engine.getRules()).toHaveLength(1);

		engine.removeRule("x");
		expect(engine.getRules()).toHaveLength(0);
	});

	it("should not crash when rule check throws", () => {
		const engine = new AlertEngine();
		engine.addRule({
			name: "crasher",
			severity: "warning",
			cooldownMs: 0,
			check: () => { throw new Error("boom"); },
		});

		expect(() => engine.check(makeSnapshot())).not.toThrow();
		expect(engine.getAlerts()).toHaveLength(0);
	});

	it("should create default alert rules", () => {
		const rules = createDefaultAlertRules({ budgetUsd: 5, warningThreshold: 0.8 });
		expect(rules.length).toBeGreaterThanOrEqual(3);
		expect(rules.map((r) => r.name)).toContain("budget_warning");
		expect(rules.map((r) => r.name)).toContain("budget_exceeded");
		expect(rules.map((r) => r.name)).toContain("high_error_rate");
	});

	it("should fire budget_warning from default rules", () => {
		const engine = new AlertEngine();
		for (const rule of createDefaultAlertRules({ budgetUsd: 10 })) {
			engine.addRule(rule);
		}

		const snap = makeSnapshot({
			totalUsage: { ...createEmptyTokenUsage(), totalCost: 8.5 },
		});
		const fired = engine.check(snap);

		const warning = fired.find((a) => a.ruleName === "budget_warning");
		expect(warning).toBeDefined();
	});
});
