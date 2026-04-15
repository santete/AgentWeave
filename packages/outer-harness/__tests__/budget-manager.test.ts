import { describe, it, expect } from "vitest";
import { BudgetManager } from "../src/governance/budget-manager";

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
