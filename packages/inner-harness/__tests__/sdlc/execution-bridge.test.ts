import { describe, it, expect } from "vitest";
import { ExecutionBridgeModule } from "../../src/sdlc/modules/execution-bridge";
import { MetricsCollector } from "../../src/sdlc/metrics-collector";
import { getDefaultSDLCConfig } from "../../src/sdlc/sdlc-config";
import { createEmptyTokenUsage } from "@agentweave/types";
import type {
	SDLCModuleContext,
	SDLCTask,
	SDLCPlan,
	InnerHarnessProvider,
	InnerEvent,
	TerminalResult,
	RunOptions,
	ContentBlock,
	Message,
} from "@agentweave/types";

function makeContext(overrides: Partial<SDLCModuleContext> = {}): SDLCModuleContext {
	const mc = new MetricsCollector("task_test");
	return {
		sessionId: "ses_test",
		cwd: process.cwd(),
		signal: new AbortController().signal,
		config: getDefaultSDLCConfig(),
		metrics: mc.createHandle(),
		...overrides,
	};
}

function makeTask(): SDLCTask {
	return {
		id: "task_1",
		rawInput: "Fix login bug",
		goal: "Fix the login bug",
		context: ["src/auth.ts"],
		constraints: ["No breaking changes"],
		definitionOfDone: ["Tests pass"],
		metadata: {},
	};
}

function makePlan(): SDLCPlan {
	return {
		taskId: "task_1",
		steps: [
			{ index: 0, description: "Read auth", type: "read", done: false },
			{ index: 1, description: "Fix bug", type: "write", done: false },
		],
		estimatedFiles: ["src/auth.ts"],
	};
}

function createMockProvider(output = "mock output", files: string[] = ["src/app.ts"]): InnerHarnessProvider {
	const usage = { ...createEmptyTokenUsage(), totalCost: 0.02 };
	return {
		run(_prompt: string | ContentBlock[], _options?: RunOptions): AsyncGenerator<InnerEvent, TerminalResult, void> {
			return (async function* () {
				yield {
					id: "e1", timestamp: Date.now(), sessionId: "ses_mock", agentId: "agent_mock",
					type: "message:assistant", content: [{ type: "text", text: output }],
				} as InnerEvent;
				for (const file of files) {
					yield {
						id: "e2", timestamp: Date.now(), sessionId: "ses_mock", agentId: "agent_mock",
						type: "tool:completed", toolName: "FileWrite", toolInput: { path: file }, toolUseId: "tu_1",
					} as unknown as InnerEvent;
				}
				return { reason: "completed", usage } satisfies TerminalResult;
			})();
		},
		abort() {},
		getState() { return { status: "completed" as const, turnIndex: 1, model: "mock", usage, contextUsage: { usedTokens: 0, maxTokens: 200000, pct: 0, compactionCount: 0 }, activeTool: null, messageCount: 0, recoveryAttempts: 0 }; },
		getMessages(): ReadonlyArray<Message> { return []; },
		getContextUsage() { return { usedTokens: 0, maxTokens: 200000, pct: 0, compactionCount: 0 }; },
		getUsage() { return usage; },
		getTools() { return []; },
		registerTool() {}, unregisterTool() {}, injectMessage() {},
		setSystemPromptSection() {}, setModel() {},
		getConfig() { return { model: "mock", maxTurns: 1, thinkingEnabled: false, tools: [] }; },
	};
}

describe("ExecutionBridgeModule", () => {
	it("should have correct name", () => {
		const mod = new ExecutionBridgeModule();
		expect(mod.name).toBe("ExecutionBridge");
	});

	it("should execute with pre-set provider and return result", async () => {
		const mod = new ExecutionBridgeModule();
		mod.setProvider(createMockProvider("fixed the bug", ["src/auth.ts"]));

		const result = await mod.execute(
			{ task: makeTask(), plan: makePlan() },
			makeContext(),
		);

		expect(result.success).toBe(true);
		expect(result.terminalReason).toBe("completed");
		expect(result.output).toContain("fixed the bug");
		expect(result.changedFiles).toContain("src/auth.ts");
	});

	it("should track changed files from FileWrite tool events", async () => {
		const mod = new ExecutionBridgeModule();
		mod.setProvider(createMockProvider("done", ["src/a.ts", "src/b.ts"]));

		const result = await mod.execute(
			{ task: makeTask() },
			makeContext(),
		);

		expect(result.changedFiles).toEqual(["src/a.ts", "src/b.ts"]);
	});

	it("should build prompt from task and plan", async () => {
		const mod = new ExecutionBridgeModule();
		let capturedPrompt = "";
		const mockProvider = createMockProvider();
		const origRun = mockProvider.run.bind(mockProvider);
		mockProvider.run = function(prompt: string | ContentBlock[], options?: RunOptions) {
			capturedPrompt = typeof prompt === "string" ? prompt : JSON.stringify(prompt);
			return origRun(prompt, options);
		};
		mod.setProvider(mockProvider);

		await mod.execute(
			{ task: makeTask(), plan: makePlan() },
			makeContext(),
		);

		expect(capturedPrompt).toContain("Fix the login bug");
		expect(capturedPrompt).toContain("No breaking changes");
		expect(capturedPrompt).toContain("src/auth.ts");
		expect(capturedPrompt).toContain("Read auth");
	});

	it("should build prompt without plan", async () => {
		const mod = new ExecutionBridgeModule();
		let capturedPrompt = "";
		const mockProvider = createMockProvider();
		const origRun = mockProvider.run.bind(mockProvider);
		mockProvider.run = function(prompt: string | ContentBlock[], options?: RunOptions) {
			capturedPrompt = typeof prompt === "string" ? prompt : JSON.stringify(prompt);
			return origRun(prompt, options);
		};
		mod.setProvider(mockProvider);

		await mod.execute({ task: makeTask() }, makeContext());

		expect(capturedPrompt).toContain("Fix the login bug");
		expect(capturedPrompt).not.toContain("Plan:");
	});

	it("should use api-direct mode with llmCaller", async () => {
		const mod = new ExecutionBridgeModule();
		let llmCalled = false;
		const ctx = makeContext({
			config: {
				...getDefaultSDLCConfig(),
				execution: { mode: "api-direct", apiDirect: { model: "test-model" } },
			},
			llmCaller: async (prompt) => {
				llmCalled = true;
				return "LLM response: fixed";
			},
		});

		const result = await mod.execute({ task: makeTask() }, ctx);

		expect(llmCalled).toBe(true);
		expect(result.success).toBe(true);
		expect(result.output).toContain("LLM response: fixed");
	});

	it("should fail api-direct mode without llmCaller", async () => {
		const mod = new ExecutionBridgeModule();
		const ctx = makeContext({
			config: {
				...getDefaultSDLCConfig(),
				execution: { mode: "api-direct", apiDirect: { model: "test" } },
			},
			// no llmCaller
		});

		const result = await mod.execute({ task: makeTask() }, ctx);

		expect(result.success).toBe(false);
		expect(result.output).toContain("No LLM caller");
	});

	it("should report error when provider run fails", async () => {
		const mod = new ExecutionBridgeModule();
		const failProvider = createMockProvider();
		failProvider.run = function*() {
			throw new Error("provider exploded");
		} as any;
		mod.setProvider(failProvider);

		// The error propagates up through the orchestrator's try/catch
		await expect(
			mod.execute({ task: makeTask() }, makeContext()),
		).rejects.toThrow("provider exploded");
	});

	it("should handle empty tool events (no files changed)", async () => {
		const mod = new ExecutionBridgeModule();
		mod.setProvider(createMockProvider("no changes made", []));

		const result = await mod.execute({ task: makeTask() }, makeContext());

		expect(result.changedFiles).toEqual([]);
		expect(result.success).toBe(true);
	});
});
