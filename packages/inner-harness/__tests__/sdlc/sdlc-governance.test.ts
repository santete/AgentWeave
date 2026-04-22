import { describe, it, expect, vi } from "vitest";
import { SDLCOrchestrator } from "../../src/sdlc/sdlc-orchestrator";
import { createEmptyTokenUsage } from "@agentweave/types";
import type {
	ContentBlock,
	ControlPlane,
	GovernanceHandle,
	InnerEvent,
	InnerHarnessProvider,
	Message,
	RunOptions,
	SDLCModule,
	SDLCModuleContext,
	SDLCStageName,
	SessionInfo,
	TerminalResult,
} from "@agentweave/types";

// ─── Shared helpers ──────────────────────────────────────────────

function createMockProvider(output = "mock output"): InnerHarnessProvider {
	const usage = { ...createEmptyTokenUsage(), totalCost: 0.01 };
	const messages: Message[] = [];
	return {
		run(_p: string | ContentBlock[], _o?: RunOptions): AsyncGenerator<InnerEvent, TerminalResult, void> {
			return (async function* () {
				yield {
					id: "e1", timestamp: Date.now(), sessionId: "ses_mock", agentId: "agent_mock",
					type: "message:assistant", content: [{ type: "text", text: output }],
				} as InnerEvent;
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

function createSpyGovernance(): {
	handle: GovernanceHandle;
	events: InnerEvent[];
	sessionStart: SessionInfo[];
	sessionEnd: Array<{ session: SessionInfo; result: TerminalResult }>;
} {
	const events: InnerEvent[] = [];
	const sessionStart: SessionInfo[] = [];
	const sessionEnd: Array<{ session: SessionInfo; result: TerminalResult }> = [];
	return {
		handle: {
			onEvent: (e) => { events.push(e); },
			onSessionStart: async (s) => { sessionStart.push(s); },
			onSessionEnd: async (s, r) => { sessionEnd.push({ session: s, result: r }); },
		},
		events,
		sessionStart,
		sessionEnd,
	};
}

async function collect(orch: SDLCOrchestrator, prompt = "Fix login bug"): Promise<{ events: InnerEvent[]; result: TerminalResult }> {
	const events: InnerEvent[] = [];
	const gen = orch.run(prompt);
	for (;;) {
		const { value, done } = await gen.next();
		if (done) return { events, result: value };
		events.push(value);
	}
}

const ALL_ENABLED = {
	taskNormalizer: { enabled: true },
	contextBuilder: { enabled: false }, // contextBuilder needs real fs; skip to keep test hermetic
	planGenerator: { enabled: true },
	executionBridge: { enabled: true },
	patchValidator: { enabled: true },
	qualityGate: { enabled: false }, // shells out — skip
	retryEngine: { enabled: true },
	outputStandardizer: { enabled: true },
} as const;

// ─── Tests ───────────────────────────────────────────────────────

describe("SDLCOrchestrator — governance wiring", () => {
	it("emits sdlc:stage_start + sdlc:stage_end for each enabled stage", async () => {
		const spy = createSpyGovernance();
		const orch = new SDLCOrchestrator({
			sdlcConfig: { modules: ALL_ENABLED, execution: { mode: "agent-loop" } },
			governance: spy.handle,
		});
		orch.setExecutionProvider(createMockProvider());

		await collect(orch);

		const starts = spy.events.filter((e) => e.type === "sdlc:stage_start");
		const ends = spy.events.filter((e) => e.type === "sdlc:stage_end");

		// taskNormalizer, planGenerator, executionBridge, patchValidator, outputStandardizer (5 enabled)
		// contextBuilder, qualityGate disabled — skipped entirely.
		// retryEngine only fires when validation fails; mock patch passes so it's skipped.
		const enabledStages: SDLCStageName[] = [
			"taskNormalizer",
			"planGenerator",
			"executionBridge",
			"patchValidator",
			"outputStandardizer",
		];
		expect(starts.map((e) => (e as unknown as { stage: string }).stage)).toEqual(enabledStages);
		expect(ends.map((e) => (e as unknown as { stage: string }).stage)).toEqual(enabledStages);
	});

	it("skipped stages emit no events", async () => {
		const spy = createSpyGovernance();
		const orch = new SDLCOrchestrator({
			sdlcConfig: {
				modules: { ...ALL_ENABLED, outputStandardizer: { enabled: false } },
				execution: { mode: "agent-loop" },
			},
			governance: spy.handle,
		});
		orch.setExecutionProvider(createMockProvider());

		await collect(orch);

		const stages = spy.events
			.filter((e) => e.type === "sdlc:stage_start" || e.type === "sdlc:stage_end")
			.map((e) => (e as unknown as { stage: string }).stage);
		expect(stages).not.toContain("outputStandardizer");
	});

	it("stage_end captures numeric durationMs and status: success", async () => {
		const spy = createSpyGovernance();
		const orch = new SDLCOrchestrator({
			sdlcConfig: {
				modules: { ...ALL_ENABLED, outputStandardizer: { enabled: false } },
				execution: { mode: "agent-loop" },
			},
			governance: spy.handle,
		});
		orch.setExecutionProvider(createMockProvider());

		await collect(orch);

		const ends = spy.events.filter((e) => e.type === "sdlc:stage_end") as unknown as Array<{ durationMs: number; status: string; stage: string }>;
		expect(ends.length).toBeGreaterThan(0);
		for (const e of ends) {
			expect(typeof e.durationMs).toBe("number");
			expect(e.durationMs).toBeGreaterThanOrEqual(0);
			expect(e.status).toBe("success");
		}
	});

	it("stage failure emits status: failure before error is surfaced", async () => {
		const spy = createSpyGovernance();

		// Use a custom module file that throws — module-runner loads it, execute() throws,
		// module-runner emits stage_end with failure BEFORE throwing ModuleError.
		const throwingModule: SDLCModule<unknown, unknown> = {
			name: "taskNormalizer",
			async execute() {
				throw new Error("boom");
			},
		};

		// Patch the orchestrator's taskNormalizer instance — simplest path to inject a
		// throwing implementation without touching the custom-module loader.
		const orch = new SDLCOrchestrator({
			sdlcConfig: {
				modules: { ...ALL_ENABLED, outputStandardizer: { enabled: false } },
				execution: { mode: "agent-loop" },
			},
			governance: spy.handle,
		});
		(orch as unknown as { taskNormalizer: SDLCModule<unknown, unknown> }).taskNormalizer = throwingModule;
		orch.setExecutionProvider(createMockProvider());

		const { result } = await collect(orch);

		expect(result.reason).toBe("error");
		const failEnds = spy.events.filter(
			(e) => e.type === "sdlc:stage_end" && (e as unknown as { status: string }).status === "failure",
		);
		expect(failEnds.length).toBe(1);
		expect((failEnds[0] as unknown as { stage: string }).stage).toBe("taskNormalizer");
	});

	it("calls onSessionStart once with the active sessionId", async () => {
		const spy = createSpyGovernance();
		const orch = new SDLCOrchestrator({
			sdlcConfig: {
				modules: { ...ALL_ENABLED, outputStandardizer: { enabled: false } },
				execution: { mode: "agent-loop" },
			},
			governance: spy.handle,
		});
		orch.setExecutionProvider(createMockProvider());

		await collect(orch);

		expect(spy.sessionStart.length).toBe(1);
		expect(spy.sessionStart[0]!.sessionId).toMatch(/^ses_/);
		expect(spy.sessionStart[0]!.model).toContain("sdlc:");
	});

	it("calls onSessionEnd once with the final TerminalResult", async () => {
		const spy = createSpyGovernance();
		const orch = new SDLCOrchestrator({
			sdlcConfig: {
				modules: { ...ALL_ENABLED, outputStandardizer: { enabled: false } },
				execution: { mode: "agent-loop" },
			},
			governance: spy.handle,
		});
		orch.setExecutionProvider(createMockProvider());

		await collect(orch);

		expect(spy.sessionEnd.length).toBe(1);
		expect(spy.sessionEnd[0]!.result.reason).toBe("completed");
		expect(spy.sessionEnd[0]!.session.sessionId).toBe(spy.sessionStart[0]!.sessionId);
	});

	it("propagates controlPlane into SDLCModuleContext of every stage", async () => {
		// Minimal fake ControlPlane — only identity matters; we just assert the
		// same reference flows down.
		const fakeCP = { __tag: "fake-cp" } as unknown as ControlPlane;

		const seenControlPlanes: Array<ControlPlane | undefined> = [];
		const spyModule: SDLCModule<unknown, unknown> = {
			name: "patchValidator",
			async execute(_input, ctx: SDLCModuleContext) {
				seenControlPlanes.push(ctx.controlPlane);
				return { passed: true, checks: [] };
			},
		};

		const orch = new SDLCOrchestrator({
			sdlcConfig: {
				modules: {
					taskNormalizer: { enabled: false },
					contextBuilder: { enabled: false },
					planGenerator: { enabled: false },
					executionBridge: { enabled: true },
					patchValidator: { enabled: true },
					qualityGate: { enabled: false },
					retryEngine: { enabled: false },
					outputStandardizer: { enabled: false },
				},
				execution: { mode: "agent-loop" },
			},
			controlPlane: fakeCP,
		});
		(orch as unknown as { patchValidator: SDLCModule<unknown, unknown> }).patchValidator = spyModule;
		orch.setExecutionProvider(createMockProvider());

		await collect(orch);

		expect(seenControlPlanes.length).toBe(1);
		expect(seenControlPlanes[0]).toBe(fakeCP);
	});

	it("backward compatible — no governance option → pipeline runs unchanged", async () => {
		const orch = new SDLCOrchestrator({
			sdlcConfig: {
				modules: { ...ALL_ENABLED, outputStandardizer: { enabled: false } },
				execution: { mode: "agent-loop" },
			},
			// no governance, no controlPlane
		});
		orch.setExecutionProvider(createMockProvider());

		const { result } = await collect(orch);

		expect(result.reason).toBe("completed");
	});

	it("onEvent observer throwing does not break the pipeline", async () => {
		const handle: GovernanceHandle = {
			onEvent: vi.fn(() => { throw new Error("observer crash"); }),
			onSessionStart: async () => {},
			onSessionEnd: async () => {},
		};

		const orch = new SDLCOrchestrator({
			sdlcConfig: {
				modules: { ...ALL_ENABLED, outputStandardizer: { enabled: false } },
				execution: { mode: "agent-loop" },
			},
			governance: handle,
		});
		orch.setExecutionProvider(createMockProvider());

		const { result } = await collect(orch);

		expect(result.reason).toBe("completed");
		expect((handle.onEvent as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(0);
	});
});
