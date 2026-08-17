import { describe, it, expect, vi } from "vitest";
import { z } from "zod";
import { createControlPlane } from "@agentweave/control-plane";
import type { ToolDefinition, InnerEvent } from "@agentweave/types";
import { AgentLoop } from "../src/agent-loop";
import { createMockLLMCaller, MockScenarios } from "../src/mock-llm";

function makeReadTool(name: string): ToolDefinition {
	return {
		name,
		description: `Read tool: ${name}`,
		parameters: z.object({}).passthrough(),
		execute: async () => `content of ${name}`,
		metadata: {
			isReadOnly: true,
			isDestructive: false,
			isConcurrencySafe: true,
			category: "file",
		},
	};
}

async function collectEvents(
	gen: AsyncGenerator<InnerEvent, unknown, void>,
): Promise<InnerEvent[]> {
	const events: InnerEvent[] = [];
	for await (const event of gen) {
		events.push(event);
	}
	return events;
}

describe("AgentLoop", () => {
	it("should complete with no tools when LLM returns text only", async () => {
		const cp = createControlPlane({ failMode: "open" });
		const loop = new AgentLoop({ controlPlane: cp, model: "mock" });
		loop.setLLMCaller(createMockLLMCaller(MockScenarios.simpleResponse));

		const events = await collectEvents(loop.run("Hello"));

		const terminal = events.find((e) => e.type === "terminal");
		expect(terminal).toBeDefined();
		expect(terminal!.type === "terminal" && terminal!.reason).toBe("completed");

		expect(loop.getState().status).toBe("completed");
	});

	it("gọi LLM hỏng phải kết thúc bằng reason 'error', KHÔNG phải 'completed'", async () => {
		// Bản trước nuốt lỗi và trả kết quả rỗng, nên endpoint sai vẫn báo
		// "completed" với 0 token — nhìn y hệt một câu trả lời rỗng hợp lệ.
		// Trong air-gap thì đây là kiểu lỗi tốn cả ngày mới truy ra.
		const loop = new AgentLoop({ model: "mock" });
		loop.setLLMCaller(async () => {
			throw new Error("Failed to parse URL from 127.0.0.1:11434/v1/chat/completions");
		});

		const events = await collectEvents(loop.run("Hello"));

		const terminal = events.find((e) => e.type === "terminal");
		expect(terminal!.type === "terminal" && terminal!.reason).toBe("error");

		const err = events.find((e) => e.type === "error");
		expect(err).toBeDefined();
		expect(err!.type === "error" && err!.error).toContain("Failed to parse URL");
	});

	it("should execute tool calls and loop back to LLM", async () => {
		const cp = createControlPlane({ failMode: "open" });
		const loop = new AgentLoop({
			controlPlane: cp,
			model: "mock",
			tools: [makeReadTool("FileRead")],
		});
		loop.setLLMCaller(createMockLLMCaller(MockScenarios.readThenRespond));

		const events = await collectEvents(loop.run("Read test.ts"));

		// Should have: turn:start, llm events, tool:requested, permission:allowed,
		// tool:completed, tool_result, turn:end, then second turn with terminal
		const toolCompleted = events.find((e) => e.type === "tool:completed");
		expect(toolCompleted).toBeDefined();

		const terminal = events.find((e) => e.type === "terminal");
		expect(terminal!.type === "terminal" && terminal!.reason).toBe("completed");

		// Should have 2 turns
		const turnStarts = events.filter((e) => e.type === "turn:start");
		expect(turnStarts).toHaveLength(2);
	});

	it("should deny tool via control plane interceptor", async () => {
		const cp = createControlPlane();
		// Register deny interceptor
		cp.registerInterceptor("tool_request", async (req) => ({
			behavior: "deny" as const,
			reason: "Blocked by test",
			source: "test",
		}));

		const loop = new AgentLoop({
			controlPlane: cp,
			model: "mock",
			tools: [makeReadTool("FileRead")],
		});
		loop.setLLMCaller(createMockLLMCaller(MockScenarios.readThenRespond));

		const events = await collectEvents(loop.run("Read test.ts"));

		const denied = events.find((e) => e.type === "permission:denied");
		expect(denied).toBeDefined();
		if (denied?.type === "permission:denied") {
			expect(denied.reason).toBe("Blocked by test");
		}
	});

	it("should track token usage across turns", async () => {
		const cp = createControlPlane({ failMode: "open" });
		const loop = new AgentLoop({
			controlPlane: cp,
			model: "mock",
			tools: [makeReadTool("FileRead")],
		});
		loop.setLLMCaller(createMockLLMCaller(MockScenarios.readThenRespond));

		await collectEvents(loop.run("Read file"));

		const usage = loop.getUsage();
		// Mock returns 100 input + 50 output per call, 2 calls
		expect(usage.inputTokens).toBe(200);
		expect(usage.outputTokens).toBe(100);
	});

	it("should stop at max turns", async () => {
		const cp = createControlPlane({ failMode: "open" });
		const loop = new AgentLoop({
			controlPlane: cp,
			model: "mock",
			maxTurns: 2,
			tools: [makeReadTool("FileRead")],
		});

		// LLM always requests tools — will never terminate naturally
		const infiniteResponses = Array.from({ length: 10 }, () => ({
			toolCalls: [{ toolName: "FileRead", toolInput: { path: "x.ts" } }],
		}));
		loop.setLLMCaller(createMockLLMCaller(infiniteResponses));

		const events = await collectEvents(loop.run("Loop forever"));

		const terminal = events.find((e) => e.type === "terminal");
		expect(terminal).toBeDefined();
		if (terminal?.type === "terminal") {
			expect(terminal.reason).toBe("max_turns");
		}
	});

	it("should abort when abort() is called", async () => {
		const cp = createControlPlane({ failMode: "open" });
		const loop = new AgentLoop({
			controlPlane: cp,
			model: "mock",
			tools: [makeReadTool("FileRead")],
		});

		// Slow LLM — gives time to abort
		loop.setLLMCaller(async () => {
			await new Promise((r) => setTimeout(r, 100));
			return {
				toolCalls: [{ toolUseId: "t1", toolName: "FileRead", toolInput: {} }],
				stopReason: "tool_use",
			};
		});

		// Abort after 50ms
		setTimeout(() => loop.abort("test abort"), 50);

		const events = await collectEvents(loop.run("Do something"));

		expect(loop.getState().status).toBe("aborted");
	});

	it("should handle pause/resume via commands", async () => {
		const cp = createControlPlane({ failMode: "open" });
		const loop = new AgentLoop({ controlPlane: cp, model: "mock" });
		loop.setLLMCaller(createMockLLMCaller(MockScenarios.simpleResponse));

		// Test command handler
		const pauseAck = await cp.sendCommand({ type: "pause" });
		expect(pauseAck.accepted).toBe(true);
		expect(loop.getState().status).toBe("paused");

		const resumeAck = await cp.sendCommand({ type: "resume" });
		expect(resumeAck.accepted).toBe(true);
		expect(loop.getState().status).toBe("running");
	});

	it("should reject input via input gate", async () => {
		const cp = createControlPlane();
		cp.registerInterceptor("input_received", async () => ({
			action: "reject" as const,
			reason: "Input rejected by test",
		}));

		const loop = new AgentLoop({ controlPlane: cp, model: "mock" });
		loop.setLLMCaller(createMockLLMCaller(MockScenarios.simpleResponse));

		const gen = loop.run("bad input");
		const events: InnerEvent[] = [];
		let result: unknown;
		while (true) {
			const { value, done } = await gen.next();
			if (done) {
				result = value;
				break;
			}
			events.push(value);
		}

		expect(result).toEqual({ reason: "input_rejected" });
	});

	it("should throw if run() is called twice", async () => {
		const cp = createControlPlane({ failMode: "open" });
		const loop = new AgentLoop({ controlPlane: cp, model: "mock" });
		loop.setLLMCaller(createMockLLMCaller(MockScenarios.simpleResponse));

		await collectEvents(loop.run("First run"));

		// Second run should throw with helpful message
		await expect(async () => {
			await collectEvents(loop.run("Second run"));
		}).rejects.toThrow("createHarness()");
	});

	it("should stop when budget is exceeded", async () => {
		const cp = createControlPlane({ failMode: "open" });
		const loop = new AgentLoop({
			controlPlane: cp,
			model: "mock",
			tools: [makeReadTool("FileRead")],
		});

		// Each call: 100 input + 50 output tokens
		// Sonnet default pricing: ~$3/M input + $15/M output
		// To trigger budget, use a very low budget
		const manyToolCalls = Array.from({ length: 10 }, () => ({
			toolCalls: [{ toolName: "FileRead", toolInput: { path: "x.ts" } }],
		}));
		loop.setLLMCaller(createMockLLMCaller(manyToolCalls));

		const events = await collectEvents(
			loop.run("Do lots of work", { maxBudgetUsd: 0.0001 }),
		);

		const terminal = events.find((e) => e.type === "terminal");
		expect(terminal).toBeDefined();
		if (terminal?.type === "terminal") {
			expect(terminal.reason).toBe("budget_exceeded");
		}
	});
});
