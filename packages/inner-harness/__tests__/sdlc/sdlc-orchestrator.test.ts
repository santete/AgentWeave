import { describe, it, expect } from "vitest";
import { SDLCOrchestrator } from "../../src/sdlc/sdlc-orchestrator";
import { createEmptyTokenUsage } from "@agentweave/types";
import type { InnerEvent, InnerHarnessProvider, Message, TerminalResult, RunOptions, ContentBlock, InjectableMessage } from "@agentweave/types";

// ─── Mock Provider (simulates AgentLoop/ProcessAdapter) ──────────

function createMockProvider(output = "mock output", changedFiles: string[] = ["src/app.ts"]): InnerHarnessProvider {
	const usage = { ...createEmptyTokenUsage(), totalCost: 0.03 };
	const messages: Message[] = [];

	return {
		run(_prompt: string | ContentBlock[], _options?: RunOptions): AsyncGenerator<InnerEvent, TerminalResult, void> {
			return (async function* () {
				yield {
					id: "e1", timestamp: Date.now(), sessionId: "ses_mock", agentId: "agent_mock",
					type: "message:assistant", content: [{ type: "text", text: output }],
				} as InnerEvent;

				for (const file of changedFiles) {
					yield {
						id: "e2", timestamp: Date.now(), sessionId: "ses_mock", agentId: "agent_mock",
						type: "tool:completed", toolName: "FileWrite", toolInput: { path: file }, toolUseId: "tu_1",
					} as unknown as InnerEvent;
				}

				return { reason: "completed", usage } satisfies TerminalResult;
			})();
		},
		abort() {},
		getState() {
			return { status: "completed" as const, turnIndex: 1, model: "mock", usage, contextUsage: { usedTokens: 0, maxTokens: 200000, pct: 0, compactionCount: 0 }, activeTool: null, messageCount: 0, recoveryAttempts: 0 };
		},
		getMessages() { return messages; },
		getContextUsage() { return { usedTokens: 0, maxTokens: 200000, pct: 0, compactionCount: 0 }; },
		getUsage() { return usage; },
		getTools() { return []; },
		registerTool() {},
		unregisterTool() {},
		injectMessage() {},
		setSystemPromptSection() {},
		setModel() {},
		getConfig() { return { model: "mock", maxTurns: 1, thinkingEnabled: false, tools: [] }; },
	};
}

async function collectRun(orchestrator: SDLCOrchestrator, prompt = "Fix login bug"): Promise<{ events: InnerEvent[]; result: TerminalResult }> {
	const events: InnerEvent[] = [];
	const gen = orchestrator.run(prompt);
	for (;;) {
		const { value, done } = await gen.next();
		if (done) return { events, result: value };
		events.push(value);
	}
}

// ─── Tests ───────────────────────────────────────────────────────

describe("SDLCOrchestrator", () => {
	it("should complete full pipeline with all modules enabled", async () => {
		const orch = new SDLCOrchestrator({
			sdlcConfig: {
				modules: {
					taskNormalizer: { enabled: true },
					contextBuilder: { enabled: false }, // skip for speed
					planGenerator: { enabled: true },
					executionBridge: { enabled: true },
					patchValidator: { enabled: true },
					qualityGate: { enabled: false }, // skip shell commands in test
					retryEngine: { enabled: true },
					outputStandardizer: { enabled: false },
				},
				execution: { mode: "agent-loop" },
			},
		});

		orch.setExecutionProvider(createMockProvider());
		const { events, result } = await collectRun(orch);

		expect(result.reason).toBe("completed");
		expect(events.length).toBeGreaterThan(0);
		expect(orch.getState().status).toBe("completed");
	});

	it("should work with all modules disabled (passthrough)", async () => {
		const orch = new SDLCOrchestrator({
			sdlcConfig: {
				modules: {
					taskNormalizer: { enabled: false },
					contextBuilder: { enabled: false },
					planGenerator: { enabled: false },
					executionBridge: { enabled: true },
					patchValidator: { enabled: false },
					qualityGate: { enabled: false },
					retryEngine: { enabled: false },
					outputStandardizer: { enabled: false },
				},
				execution: { mode: "agent-loop" },
			},
		});

		orch.setExecutionProvider(createMockProvider());
		const { result } = await collectRun(orch);

		expect(result.reason).toBe("completed");
	});

	it("should collect metrics after run", async () => {
		const orch = new SDLCOrchestrator({
			sdlcConfig: {
				modules: {
					taskNormalizer: { enabled: true },
					contextBuilder: { enabled: false },
					planGenerator: { enabled: true },
					executionBridge: { enabled: true },
					patchValidator: { enabled: true },
					qualityGate: { enabled: false },
					retryEngine: { enabled: false },
					outputStandardizer: { enabled: false },
				},
				execution: { mode: "agent-loop" },
				metrics: { enabled: true, baseline: false },
			},
		});

		orch.setExecutionProvider(createMockProvider());
		await collectRun(orch);

		const metrics = orch.getLastMetrics();
		expect(metrics).not.toBeNull();
		expect(metrics!.m5_costUsd).toBe(0.03);
		expect(metrics!.m6_timeToCompletionMs).toBeGreaterThanOrEqual(0);
	});

	it("should use LLM caller for meta tasks", async () => {
		let llmCallCount = 0;
		const mockLLM = async () => {
			llmCallCount++;
			return JSON.stringify({
				goal: "Fix login",
				context: [],
				constraints: [],
				definitionOfDone: ["tests pass"],
			});
		};

		const orch = new SDLCOrchestrator({
			sdlcConfig: {
				modules: {
					taskNormalizer: { enabled: true },
					contextBuilder: { enabled: false },
					planGenerator: { enabled: false },
					executionBridge: { enabled: true },
					patchValidator: { enabled: false },
					qualityGate: { enabled: false },
					retryEngine: { enabled: false },
					outputStandardizer: { enabled: false },
				},
				execution: { mode: "agent-loop" },
			},
			llmCaller: mockLLM,
		});

		orch.setExecutionProvider(createMockProvider());
		await collectRun(orch);

		expect(llmCallCount).toBeGreaterThanOrEqual(1);
	});

	it("should implement InnerHarnessProvider interface", () => {
		const orch = new SDLCOrchestrator();

		expect(orch.getState().status).toBe("idle");
		expect(orch.getMessages()).toEqual([]);
		expect(orch.getUsage().totalCost).toBe(0);
		expect(orch.getTools()).toEqual([]);
		expect(orch.getConfig().model).toContain("sdlc:");

		// No-ops should not throw
		orch.registerTool({ name: "test", description: "test", parameters: {} as any, execute: async () => ({ success: true }) } as any);
		orch.unregisterTool("test");
		orch.injectMessage({ role: "user", content: "test" });
		orch.setSystemPromptSection("test", "test");
		orch.setModel("test");
	});

	it("should prevent double run", async () => {
		const orch = new SDLCOrchestrator({
			sdlcConfig: {
				modules: {
					taskNormalizer: { enabled: false },
					contextBuilder: { enabled: false },
					planGenerator: { enabled: false },
					executionBridge: { enabled: true },
					patchValidator: { enabled: false },
					qualityGate: { enabled: false },
					retryEngine: { enabled: false },
					outputStandardizer: { enabled: false },
				},
				execution: { mode: "agent-loop" },
			},
		});

		orch.setExecutionProvider(createMockProvider());
		await collectRun(orch);

		expect(() => orch.run("second")).toThrow("only be run once");
	});

	it("should store messages after run", async () => {
		const orch = new SDLCOrchestrator({
			sdlcConfig: {
				modules: {
					taskNormalizer: { enabled: false },
					contextBuilder: { enabled: false },
					planGenerator: { enabled: false },
					executionBridge: { enabled: true },
					patchValidator: { enabled: false },
					qualityGate: { enabled: false },
					retryEngine: { enabled: false },
					outputStandardizer: { enabled: false },
				},
				execution: { mode: "agent-loop" },
			},
		});

		orch.setExecutionProvider(createMockProvider("hello world"));
		await collectRun(orch);

		const messages = orch.getMessages();
		expect(messages.length).toBeGreaterThanOrEqual(1);
		expect(messages[0]!.role).toBe("assistant");
	});

	it("should emit status events for each phase", async () => {
		const orch = new SDLCOrchestrator({
			sdlcConfig: {
				modules: {
					taskNormalizer: { enabled: true },
					contextBuilder: { enabled: false },
					planGenerator: { enabled: true },
					executionBridge: { enabled: true },
					patchValidator: { enabled: true },
					qualityGate: { enabled: false },
					retryEngine: { enabled: false },
					outputStandardizer: { enabled: false },
				},
				execution: { mode: "agent-loop" },
			},
		});

		orch.setExecutionProvider(createMockProvider());
		const { events } = await collectRun(orch);

		const statusEvents = events
			.filter((e) => e.type === "message:assistant")
			.map((e) => {
				const content = (e as unknown as Record<string, unknown>).content as Array<{ text: string }>;
				return content?.[0]?.text ?? "";
			})
			.filter((t) => t.startsWith("[SDLC]"));

		expect(statusEvents.some((s) => s.includes("Normalizing"))).toBe(true);
		expect(statusEvents.some((s) => s.includes("plan"))).toBe(true);
		expect(statusEvents.some((s) => s.includes("Executing"))).toBe(true);
	});

	it("should handle errors gracefully", async () => {
		const failProvider = createMockProvider();
		// Override run to throw
		failProvider.run = function* () {
			throw new Error("Provider crashed");
		} as any;

		const orch = new SDLCOrchestrator({
			sdlcConfig: {
				modules: {
					taskNormalizer: { enabled: false },
					contextBuilder: { enabled: false },
					planGenerator: { enabled: false },
					executionBridge: { enabled: true },
					patchValidator: { enabled: false },
					qualityGate: { enabled: false },
					retryEngine: { enabled: false },
					outputStandardizer: { enabled: false },
				},
				execution: { mode: "agent-loop" },
			},
		});

		orch.setExecutionProvider(failProvider);
		const { result } = await collectRun(orch);

		expect(result.reason).toBe("error");
		expect(orch.getState().status).toBe("error");
	});
});
