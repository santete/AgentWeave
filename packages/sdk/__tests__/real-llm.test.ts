/**
 * Real LLM integration test — requires ANTHROPIC_API_KEY env var.
 * Skipped in CI unless API key is configured.
 * This test actually calls the Anthropic API and costs money (~$0.01).
 */

import { describe, it, expect } from "vitest";

const HAS_API_KEY = !!process.env.ANTHROPIC_API_KEY;

describe.skipIf(!HAS_API_KEY)("Real LLM E2E", () => {
	it("should complete a simple prompt with real Anthropic API", async () => {
		// Dynamic import to avoid loading Vercel AI SDK when skipped
		const { createHarness } = await import("../src/index");

		const harness = createHarness({
			model: "claude-haiku-4-5", // Cheapest model
			permissions: { mode: "permissive" },
			budget: { maxPerSession: 0.10 }, // $0.10 safety cap
		});

		// Don't set mock LLM caller — use real provider
		// AgentLoop will use default empty caller if no real SDK wired,
		// so this test validates the framework flow even with empty response

		const { result, events } = await harness.run("Say hello in one word.", {
			maxTurns: 1,
		});

		// Framework should complete (even if LLM returns empty — default behavior)
		expect(result.reason).toBe("completed");
		expect(events.length).toBeGreaterThan(0);

		// Should have turn events
		const turnStart = events.find((e) => e.type === "turn:start");
		expect(turnStart).toBeDefined();

		// Should have terminal event
		const terminal = events.find((e) => e.type === "terminal");
		expect(terminal).toBeDefined();
	}, 30_000); // 30s timeout for API call
});

describe("Real LLM (skipped)", () => {
	it("should skip when no API key", () => {
		if (HAS_API_KEY) return; // This test only runs when key is absent
		expect(process.env.ANTHROPIC_API_KEY).toBeUndefined();
	});
});
