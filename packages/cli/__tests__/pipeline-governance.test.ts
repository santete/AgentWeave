import { describe, it, expect } from "vitest";
import { createSDLCPipeline } from "@agentweave/inner-harness";
import { createEmptyTokenUsage } from "@agentweave/types";
import type {
	ContentBlock,
	InnerEvent,
	InnerHarnessProvider,
	Message,
	RunOptions,
	TerminalResult,
	ToolRequest,
} from "@agentweave/types";
import { createSdlcGovernance } from "../src/lib/sdlc-governance";

// Mock InnerHarnessProvider — zero tool calls, immediate completion.
function createMockProvider(): InnerHarnessProvider {
	const usage = { ...createEmptyTokenUsage(), totalCost: 0.01 };
	const messages: Message[] = [];
	return {
		run(_p: string | ContentBlock[], _o?: RunOptions): AsyncGenerator<InnerEvent, TerminalResult, void> {
			return (async function* () {
				yield {
					id: "e1", timestamp: Date.now(), sessionId: "ses_mock", agentId: "agent_mock",
					type: "message:assistant", content: [{ type: "text", text: "done" }],
				} as InnerEvent;
				return { reason: "completed", usage } satisfies TerminalResult;
			})();
		},
		abort() {},
		getState() { return { status: "completed" as const, turnIndex: 1, model: "mock", usage, contextUsage: { usedTokens: 0, maxTokens: 200000, pct: 0, compactionCount: 0 }, activeTool: null, messageCount: 0, recoveryAttempts: 0 }; },
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

const SAFE_MODULES = {
	taskNormalizer: { enabled: true },
	contextBuilder: { enabled: false },
	planGenerator: { enabled: true },
	executionBridge: { enabled: true },
	patchValidator: { enabled: true },
	qualityGate: { enabled: false },
	retryEngine: { enabled: true },
	outputStandardizer: { enabled: true },
} as const;

async function drain(orch: ReturnType<typeof createSDLCPipeline>, prompt = "Fix login bug"): Promise<TerminalResult> {
	const gen = orch.run(prompt);
	for (;;) {
		const { value, done } = await gen.next();
		if (done) return value;
	}
}

// ─── Tests ───────────────────────────────────────────────────────

describe("createSdlcGovernance — helper wiring", () => {
	it("returns an OuterHarness and a ControlPlane connected to it", () => {
		const { outer, controlPlane } = createSdlcGovernance({ sessionId: "s1" });
		expect(outer).toBeDefined();
		expect(controlPlane).toBeDefined();
		// Outer should expose an AuditLogger that we can inspect.
		expect(outer.getAuditLogger()).toBeDefined();
	});

	it("defaults to empty-rule permissions → tool_request allowed (observer mode)", async () => {
		const { controlPlane } = createSdlcGovernance({ sessionId: "s2" });
		const req: ToolRequest = {
			toolName: "Bash",
			toolInput: { command: "echo hi" },
			toolUseId: "t1",
			turnIndex: 0,
			isReadOnly: false,
			isDestructive: false,
		};
		const decision = await controlPlane.intercept("tool_request", req);
		expect(decision.behavior).toBe("allow");
	});

	it("deny rule blocks a matching tool_request through the ControlPlane", async () => {
		const { controlPlane } = createSdlcGovernance({
			sessionId: "s3",
			config: {
				permissions: {
					mode: "default",
					failMode: "closed",
					timeoutMs: 5_000,
					askTimeoutMs: 60_000,
					rules: [
						{ pattern: "Bash(*)", behavior: "deny", source: "policy", priority: 100 },
					],
				},
			},
		});

		const req: ToolRequest = {
			toolName: "Bash",
			toolInput: { command: "rm -rf /" },
			toolUseId: "t2",
			turnIndex: 0,
			isReadOnly: false,
			isDestructive: true,
		};
		const decision = await controlPlane.intercept("tool_request", req);
		expect(decision.behavior).toBe("deny");
	});

	it("deny rule's matching decision is captured in the audit log", async () => {
		const { outer, controlPlane } = createSdlcGovernance({
			sessionId: "s4",
			config: {
				permissions: {
					mode: "default",
					failMode: "closed",
					timeoutMs: 5_000,
					askTimeoutMs: 60_000,
					rules: [
						{ pattern: "Bash(*)", behavior: "deny", source: "policy", priority: 100 },
					],
				},
			},
		});

		const req: ToolRequest = {
			toolName: "Bash",
			toolInput: { command: "rm -rf /" },
			toolUseId: "t3",
			turnIndex: 0,
			isReadOnly: false,
			isDestructive: true,
		};
		await controlPlane.intercept("tool_request", req);

		const decisions = outer.getAuditLogger().getEntriesByAction("permission_decision");
		expect(decisions.length).toBeGreaterThan(0);
		const denyEntry = decisions.find((e) => e.details.behavior === "deny");
		expect(denyEntry).toBeDefined();
		expect(denyEntry!.details.tool).toBe("Bash");
	});
});

describe("createSdlcGovernance — SDLC pipeline stage audit (end-to-end)", () => {
	it("records sdlc:stage_start + sdlc:stage_end for every enabled stage", async () => {
		const gov = createSdlcGovernance({ sessionId: "s5" });
		const pipeline = createSDLCPipeline({
			execution: { mode: "agent-loop", agentLoop: { model: "mock", maxTurns: 1 } },
			modules: SAFE_MODULES,
			governance: gov.outer,
			controlPlane: gov.controlPlane,
		});
		pipeline.setExecutionProvider(createMockProvider());

		const result = await drain(pipeline);
		expect(result.reason).toBe("completed");

		const audit = gov.outer.getAuditLogger();
		const starts = audit.getEntriesByAction("sdlc:stage_start");
		const ends = audit.getEntriesByAction("sdlc:stage_end");

		// Enabled + executed: taskNormalizer, planGenerator, executionBridge,
		// patchValidator, outputStandardizer (5). retryEngine only fires on
		// validation failure; contextBuilder + qualityGate disabled.
		expect(starts.length).toBe(5);
		expect(ends.length).toBe(5);
	});

	it("records session_start + session_end lifecycle entries", async () => {
		const gov = createSdlcGovernance({ sessionId: "s6" });
		const pipeline = createSDLCPipeline({
			execution: { mode: "agent-loop", agentLoop: { model: "mock", maxTurns: 1 } },
			modules: { ...SAFE_MODULES, outputStandardizer: { enabled: false } },
			governance: gov.outer,
			controlPlane: gov.controlPlane,
		});
		pipeline.setExecutionProvider(createMockProvider());

		await drain(pipeline);

		const audit = gov.outer.getAuditLogger();
		expect(audit.getEntriesByAction("session_start").length).toBe(1);
		expect(audit.getEntriesByAction("session_end").length).toBe(1);
	});
});
