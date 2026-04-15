import { describe, it, expect } from "vitest";
import { TokenCounter } from "../src/token-counter";

describe("TokenCounter", () => {
	it("should start at zero", () => {
		const counter = new TokenCounter();
		const usage = counter.getUsage();

		expect(usage.inputTokens).toBe(0);
		expect(usage.outputTokens).toBe(0);
		expect(usage.totalCost).toBe(0);
	});

	it("should accumulate token counts", () => {
		const counter = new TokenCounter();
		counter.add({ inputTokens: 100, outputTokens: 50 });
		counter.add({ inputTokens: 200, outputTokens: 100 });

		const usage = counter.getUsage();
		expect(usage.inputTokens).toBe(300);
		expect(usage.outputTokens).toBe(150);
	});

	it("should calculate cost for sonnet model", () => {
		const counter = new TokenCounter();
		counter.add({ inputTokens: 1_000_000, outputTokens: 1_000_000 });
		counter.recalculateCost("claude-sonnet-4-6");

		const usage = counter.getUsage();
		// Sonnet: $3/M input + $15/M output = $18
		expect(usage.totalCost).toBeCloseTo(18, 1);
	});

	it("should calculate cost for haiku model", () => {
		const counter = new TokenCounter();
		counter.add({ inputTokens: 1_000_000, outputTokens: 1_000_000 });
		counter.recalculateCost("claude-haiku-4-5");

		const usage = counter.getUsage();
		// Haiku: $0.8/M input + $4/M output = $4.8
		expect(usage.totalCost).toBeCloseTo(4.8, 1);
	});

	it("should use default pricing for unknown model", () => {
		const counter = new TokenCounter();
		counter.add({ inputTokens: 1_000_000, outputTokens: 1_000_000 });
		counter.recalculateCost("unknown-model");

		// Default = Sonnet pricing
		expect(counter.getUsage().totalCost).toBeCloseTo(18, 1);
	});

	it("should account for cache tokens", () => {
		const counter = new TokenCounter();
		counter.add({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 1_000_000 });
		counter.recalculateCost("claude-sonnet-4-6");

		// Cache read = 10% of input price = $3 * 0.1 = $0.3/M
		expect(counter.getUsage().totalCost).toBeCloseTo(0.3, 1);
	});

	it("should reset to zero", () => {
		const counter = new TokenCounter();
		counter.add({ inputTokens: 100, outputTokens: 50 });
		counter.reset();

		const usage = counter.getUsage();
		expect(usage.inputTokens).toBe(0);
		expect(usage.totalCost).toBe(0);
	});

	it("should return a copy (not reference)", () => {
		const counter = new TokenCounter();
		counter.add({ inputTokens: 100 });

		const usage1 = counter.getUsage();
		counter.add({ inputTokens: 200 });
		const usage2 = counter.getUsage();

		expect(usage1.inputTokens).toBe(100);
		expect(usage2.inputTokens).toBe(300);
	});
});
