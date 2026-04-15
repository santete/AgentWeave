import { describe, it, expect, vi } from "vitest";
import { InterceptorRegistry } from "../src/interceptors";
import type { ToolRequest, ToolDecision, InputDecision } from "@agentweave/types";

const sampleToolRequest: ToolRequest = {
	toolName: "Bash",
	toolInput: { command: "ls" },
	toolUseId: "tu_1",
	turnIndex: 1,
	isReadOnly: true,
	isDestructive: false,
};

describe("InterceptorRegistry", () => {
	it("should return default deny when no handler (fail-closed)", async () => {
		const registry = new InterceptorRegistry();

		const result = await registry.intercept("tool_request", sampleToolRequest);

		expect(result.behavior).toBe("deny");
		expect(result.source).toBe("default");
	});

	it("should return default allow when no handler (fail-open)", async () => {
		const registry = new InterceptorRegistry();
		registry.setFailMode("open");

		const result = await registry.intercept("tool_request", sampleToolRequest);

		expect(result.behavior).toBe("allow");
	});

	it("should call registered handler for tool_request", async () => {
		const registry = new InterceptorRegistry();
		registry.registerInterceptor("tool_request", async (req) => {
			return {
				behavior: "allow" as const,
				reason: `Allowed ${req.toolName}`,
				source: "test",
			};
		});

		const result = await registry.intercept("tool_request", sampleToolRequest);

		expect(result.behavior).toBe("allow");
		expect(result.reason).toBe("Allowed Bash");
	});

	it("should call registered handler for input_received", async () => {
		const registry = new InterceptorRegistry();
		registry.registerInterceptor("input_received", async (req) => {
			return {
				action: "transform" as const,
				transformedInput: req.text.toUpperCase(),
			};
		});

		const result = await registry.intercept("input_received", {
			text: "hello",
			sessionId: "ses_1",
			timestamp: Date.now(),
		});

		expect(result.action).toBe("transform");
		expect((result as InputDecision).transformedInput).toBe("HELLO");
	});

	it("should return default on handler timeout", async () => {
		const registry = new InterceptorRegistry();
		registry.registerInterceptor("tool_request", async () => {
			await new Promise((resolve) => setTimeout(resolve, 5000));
			return { behavior: "allow" as const, reason: "late", source: "test" };
		});

		const result = await registry.intercept("tool_request", sampleToolRequest, {
			timeoutMs: 50,
		});

		// fail-closed default: deny
		expect(result.behavior).toBe("deny");
		expect(result.source).toBe("default");
	}, 2000);

	it("should return default on handler error", async () => {
		const registry = new InterceptorRegistry();
		registry.registerInterceptor("tool_request", async () => {
			throw new Error("interceptor crashed");
		});

		const result = await registry.intercept("tool_request", sampleToolRequest);

		// Fail-closed default: deny
		expect(result.behavior).toBe("deny");
	});

	it("should return approve for output_ready with no handler", async () => {
		const registry = new InterceptorRegistry();

		const result = await registry.intercept("output_ready", {
			text: "Hello",
			contentBlocks: [],
			usage: {
				inputTokens: 100,
				outputTokens: 50,
				thinkingTokens: 0,
				cacheReadTokens: 0,
				cacheCreationTokens: 0,
				totalCost: 0.01,
			},
			turnIndex: 1,
			toolCallCount: 0,
			model: "test",
		});

		expect(result.action).toBe("approve");
	});

	it("should report hasInterceptor correctly", () => {
		const registry = new InterceptorRegistry();
		expect(registry.hasInterceptor("tool_request")).toBe(false);

		registry.registerInterceptor("tool_request", async () => ({
			behavior: "allow" as const,
			reason: "ok",
			source: "test",
		}));

		expect(registry.hasInterceptor("tool_request")).toBe(true);
		expect(registry.hasInterceptor("output_ready")).toBe(false);
	});

	it("should clear all handlers on destroy", () => {
		const registry = new InterceptorRegistry();
		registry.registerInterceptor("tool_request", async () => ({
			behavior: "allow" as const,
			reason: "ok",
			source: "test",
		}));

		registry.destroy();

		expect(registry.hasInterceptor("tool_request")).toBe(false);
	});

	it("should get/set fail mode", () => {
		const registry = new InterceptorRegistry();
		expect(registry.getFailMode()).toBe("closed");

		registry.setFailMode("open");
		expect(registry.getFailMode()).toBe("open");
	});
});
