import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
		run(
			_p: string | ContentBlock[],
			_o?: RunOptions,
		): AsyncGenerator<InnerEvent, TerminalResult, void> {
			return (async function* () {
				yield {
					id: "e1",
					timestamp: Date.now(),
					sessionId: "ses_mock",
					agentId: "agent_mock",
					type: "message:assistant",
					content: [{ type: "text", text: "done" }],
				} as InnerEvent;
				return { reason: "completed", usage } satisfies TerminalResult;
			})();
		},
		abort() {},
		getState() {
			return {
				status: "completed" as const,
				turnIndex: 1,
				model: "mock",
				usage,
				contextUsage: { usedTokens: 0, maxTokens: 200000, pct: 0, compactionCount: 0 },
				activeTool: null,
				messageCount: 0,
				recoveryAttempts: 0,
			};
		},
		getMessages() {
			return messages;
		},
		getContextUsage() {
			return { usedTokens: 0, maxTokens: 200000, pct: 0, compactionCount: 0 };
		},
		getUsage() {
			return usage;
		},
		getTools() {
			return [];
		},
		registerTool() {},
		unregisterTool() {},
		injectMessage() {},
		setSystemPromptSection() {},
		setModel() {},
		getConfig() {
			return { model: "mock", maxTurns: 1, thinkingEnabled: false, tools: [] };
		},
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

async function drain(
	orch: ReturnType<typeof createSDLCPipeline>,
	prompt = "Fix login bug",
): Promise<TerminalResult> {
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

	it("threads onAsk into the OuterHarness so ask decisions resolve via handler (P2.1)", async () => {
		let askCalls = 0;
		const { controlPlane } = createSdlcGovernance({
			sessionId: "s_ask",
			onAsk: async () => {
				askCalls++;
				return { allow: true };
			},
			config: {
				permissions: {
					mode: "default",
					failMode: "closed",
					timeoutMs: 5_000,
					askTimeoutMs: 60_000,
					rules: [{ pattern: "Bash(*)", behavior: "ask", source: "policy", priority: 100 }],
				},
			},
		});

		const decision = await controlPlane.intercept("tool_request", {
			toolName: "Bash",
			toolInput: { command: "echo hi" },
			toolUseId: "t_ask",
			turnIndex: 0,
			isReadOnly: false,
			isDestructive: false,
		} as ToolRequest);

		expect(askCalls).toBe(1);
		expect(decision.behavior).toBe("allow");
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
					rules: [{ pattern: "Bash(*)", behavior: "deny", source: "policy", priority: 100 }],
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
					rules: [{ pattern: "Bash(*)", behavior: "deny", source: "policy", priority: 100 }],
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

describe("createSdlcGovernance — Prometheus scrape (P1.1 end-to-end)", () => {
	it("pipeline run → exporter.render() yields ≥ 5 data series with configured instance", async () => {
		const gov = createSdlcGovernance({
			sessionId: "s_prom",
			config: {
				monitoring: {
					prometheus: { enabled: true, instance: "ci-scrape" },
				},
			},
		});
		const pipeline = createSDLCPipeline({
			execution: { mode: "agent-loop", agentLoop: { model: "mock", maxTurns: 1 } },
			modules: SAFE_MODULES,
			governance: gov.outer,
			controlPlane: gov.controlPlane,
		});
		pipeline.setExecutionProvider(createMockProvider());

		await drain(pipeline);

		const exporter = gov.outer.getPrometheusExporter();
		expect(exporter).not.toBeNull();

		const text = exporter!.render();

		expect(text).toContain("# HELP agentweave_turns_total");
		expect(text).toContain("# TYPE agentweave_turns_total counter");
		expect(text).toContain('instance="ci-scrape"');

		const dataLines = text.split("\n").filter((l) => l.length > 0 && !l.startsWith("#"));
		expect(dataLines.length).toBeGreaterThanOrEqual(5);
	});

	it("omits exporter by default (zero-regression: monitoring config is opt-in)", () => {
		const gov = createSdlcGovernance({ sessionId: "s_no_prom" });
		expect(gov.outer.getPrometheusExporter()).toBeNull();
	});
});

describe("createSdlcGovernance — policy cascade wiring (P3.1 step 8)", () => {
	it("config.policy.paths loads a 3-file cascade and enforces an immutable deny", async () => {
		const tmp = mkdtempSync(join(tmpdir(), "aw-pol-wire-"));
		try {
			const orgPath = join(tmp, "policy.org.yaml");
			const userPath = join(tmp, "policy.user.yaml");
			writeFileSync(
				orgPath,
				JSON.stringify({
					version: 1,
					rules: [{ pattern: "Bash(rm *)", behavior: "deny", priority: 100, immutable: true }],
				}),
			);
			writeFileSync(
				userPath,
				JSON.stringify({
					version: 1,
					rules: [{ pattern: "Bash(rm *)", behavior: "allow", priority: 200 }],
				}),
			);

			const { outer, controlPlane } = createSdlcGovernance({
				sessionId: "s_pol",
				config: {
					policy: { paths: { org: orgPath, user: userPath } },
				},
			});

			const decision = await controlPlane.intercept("tool_request", {
				toolName: "Bash",
				toolInput: { command: "rm -rf /" },
				toolUseId: "t_pol",
				turnIndex: 0,
				isReadOnly: false,
				isDestructive: true,
			} as ToolRequest);

			expect(decision.behavior).toBe("deny"); // org immutable wins over user allow

			const audit = outer.getAuditLogger();
			const loaded = audit.getEntriesByAction("policy_loaded");
			expect(loaded.length).toBe(2); // org + user
			const levels = loaded.map((e) => (e.details as Record<string, unknown>).level).sort();
			expect(levels).toEqual(["org", "user"]);

			const overrideBlocked = audit.getEntriesByAction("immutable_override_blocked");
			expect(overrideBlocked.length).toBe(1);
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});

	it("policy.requireAll throws when a configured path is unresolvable", () => {
		expect(() =>
			createSdlcGovernance({
				sessionId: "s_pol_req",
				config: {
					policy: {
						paths: { org: "/does/not/exist/policy.org.yaml" },
						requireAll: true,
					},
				},
			}),
		).toThrow(/requireAll/);
	});
});
