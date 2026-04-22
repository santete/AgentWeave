import { afterEach, beforeEach, describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createControlPlane } from "@agentweave/control-plane";
import { OuterHarness } from "../src/outer-harness";
import type { ToolRequest, RawOutput } from "@agentweave/types";
import { createEmptyTokenUsage } from "@agentweave/types";

function defaultConfig() {
	return {
		permissions: {
			mode: "default" as const,
			rules: [
				{ pattern: "Bash(git *)", behavior: "allow" as const, source: "project" as const, priority: 50 },
				{ pattern: "Bash(rm -rf *)", behavior: "deny" as const, source: "policy" as const, priority: 100, message: "Destructive!" },
			],
			failMode: "closed" as const,
			timeoutMs: 5000,
			askTimeoutMs: 60000,
		},
		output: {
			gateMode: "batch" as const,
			filters: [
				{ type: "secret" as const, name: "secrets", patterns: [] as string[], replacement: "[SECRET]" },
			],
		},
		budget: {
			maxPerSession: 10,
			warningThreshold: 0.8,
		},
	};
}

function makeToolRequest(toolName: string, input: Record<string, unknown>): ToolRequest {
	return {
		toolName,
		toolInput: input,
		toolUseId: "tu_1",
		turnIndex: 1,
		isReadOnly: true,
		isDestructive: false,
	};
}

describe("OuterHarness", () => {
	it("should allow matching allow rule", async () => {
		const outer = new OuterHarness(defaultConfig());
		const decision = await outer.onToolRequested(
			makeToolRequest("Bash", { command: "git status" }),
		);
		expect(decision.behavior).toBe("allow");
	});

	it("should deny matching deny rule", async () => {
		const outer = new OuterHarness(defaultConfig());
		const decision = await outer.onToolRequested(
			makeToolRequest("Bash", { command: "rm -rf /" }),
		);
		expect(decision.behavior).toBe("deny");
		expect(decision.reason).toBe("Destructive!");
	});

	it("should resolve ask to deny in closed failMode (MVP)", async () => {
		const outer = new OuterHarness(defaultConfig());
		// "echo hello" matches no rule -> ask in default mode -> resolved to deny (closed)
		const decision = await outer.onToolRequested(
			makeToolRequest("Bash", { command: "echo hello" }),
		);
		expect(decision.behavior).toBe("deny");
		expect(decision.resolvedFromAsk).toBe(true);
	});

	it("should deny when budget exceeded", async () => {
		const outer = new OuterHarness(defaultConfig());
		// Exhaust budget
		outer.getBudgetManager().addCost(10.01);

		const decision = await outer.onToolRequested(
			makeToolRequest("Bash", { command: "git status" }),
		);
		expect(decision.behavior).toBe("deny");
		expect(decision.source).toBe("budget");
	});

	it("should filter secrets in output", async () => {
		const outer = new OuterHarness(defaultConfig());
		const output: RawOutput = {
			text: "Your key is sk-1234567890abcdefghijklmnopqrstuvwx",
			contentBlocks: [],
			usage: createEmptyTokenUsage(),
			turnIndex: 1,
			toolCallCount: 0,
			model: "test",
		};

		const decision = await outer.onOutputReady(output);
		expect(decision.action).toBe("approve");
		expect(decision.modifiedContent).toContain("[SECRET]");
	});

	it("should connect to control plane as interceptor", async () => {
		const cp = createControlPlane();
		const outer = new OuterHarness(defaultConfig());
		outer.connectToControlPlane(cp);

		// Now intercepts go through OuterHarness
		const decision = await cp.intercept("tool_request", makeToolRequest("Bash", { command: "git push" }));
		expect(decision.behavior).toBe("allow");
	});

	it("should log audit entries", async () => {
		const outer = new OuterHarness(defaultConfig());
		await outer.onToolRequested(makeToolRequest("Bash", { command: "git status" }));

		const entries = outer.getAuditLogger().getEntries();
		expect(entries.length).toBeGreaterThan(0);

		const permEntry = entries.find((e) => e.action === "permission_decision");
		expect(permEntry).toBeDefined();
		expect(permEntry?.details.tool).toBe("Bash");
	});

	it("should passthrough input in MVP", async () => {
		const outer = new OuterHarness(defaultConfig());
		const decision = await outer.onInputReceived({
			text: "hello",
			sessionId: "ses_1",
			timestamp: Date.now(),
		});
		expect(decision.action).toBe("pass");
	});

	it("should track cost as delta, not cumulative", () => {
		const outer = new OuterHarness(defaultConfig());

		// Simulate 3 LLM turns with cumulative totalCost
		outer.onEvent({
			id: "e1", timestamp: Date.now(), sessionId: "s1", agentId: "a1",
			type: "llm:stream_end",
			usage: { inputTokens: 100, outputTokens: 50, thinkingTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, totalCost: 0.01 },
			stopReason: "end_turn",
		});
		outer.onEvent({
			id: "e2", timestamp: Date.now(), sessionId: "s1", agentId: "a1",
			type: "llm:stream_end",
			usage: { inputTokens: 200, outputTokens: 100, thinkingTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, totalCost: 0.02 },
			stopReason: "end_turn",
		});
		outer.onEvent({
			id: "e3", timestamp: Date.now(), sessionId: "s1", agentId: "a1",
			type: "llm:stream_end",
			usage: { inputTokens: 300, outputTokens: 150, thinkingTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, totalCost: 0.03 },
			stopReason: "end_turn",
		});

		// Budget should be 0.03 (sum of deltas: 0.01 + 0.01 + 0.01), NOT 0.06
		expect(outer.getBudgetManager().getSessionCost()).toBeCloseTo(0.03, 4);
	});

	it("should reset cost tracking on session start", async () => {
		const outer = new OuterHarness(defaultConfig());

		outer.onEvent({
			id: "e1", timestamp: Date.now(), sessionId: "s1", agentId: "a1",
			type: "llm:stream_end",
			usage: { inputTokens: 100, outputTokens: 50, thinkingTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, totalCost: 0.05 },
			stopReason: "end_turn",
		});

		await outer.onSessionStart({
			sessionId: "s2", agentId: "a1", model: "test", startTime: Date.now(), cwd: "/tmp",
		});

		// After session reset, new events should start from zero
		outer.onEvent({
			id: "e2", timestamp: Date.now(), sessionId: "s2", agentId: "a1",
			type: "llm:stream_end",
			usage: { inputTokens: 100, outputTokens: 50, thinkingTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, totalCost: 0.01 },
			stopReason: "end_turn",
		});

		expect(outer.getBudgetManager().getSessionCost()).toBeCloseTo(0.01, 4);
	});
});

describe("OuterHarness monitoring wiring", () => {
	it("omits PrometheusExporter when monitoring.prometheus is not enabled", () => {
		const outer = new OuterHarness(defaultConfig());
		expect(outer.getPrometheusExporter()).toBeNull();
	});

	it("exposes PrometheusExporter when monitoring.prometheus.enabled", () => {
		const outer = new OuterHarness({
			...defaultConfig(),
			monitoring: {
				prometheus: { enabled: true, instance: "test-x" },
			},
		});
		const exp = outer.getPrometheusExporter();
		expect(exp).not.toBeNull();
		expect(exp!.render()).toContain('instance="test-x"');
	});

	it("registers configured AlertSinks on the AlertEngine", () => {
		const outer = new OuterHarness({
			...defaultConfig(),
			monitoring: {
				alertSinks: [
					{ type: "stdout" },
					{ type: "webhook", url: "http://example/", severityFilter: ["critical"] },
				],
			},
		});
		const sinks = outer.getAlertEngine().getSinks();
		expect(sinks).toHaveLength(2);
		expect(sinks[0]!.name).toBe("stdout");
		expect(sinks[1]!.name).toBe("webhook");
	});
});

describe("OuterHarness ask persistence (P2.1)", () => {
	let workDir: string;
	beforeEach(() => {
		workDir = mkdtempSync(join(tmpdir(), "aw-askpersist-"));
	});
	afterEach(() => {
		rmSync(workDir, { recursive: true, force: true });
	});

	it("persists alwaysAllow across OuterHarness instances", async () => {
		const cfg = {
			...defaultConfig(),
			onAsk: async () => ({ allow: true, alwaysAllow: true }),
			askPersistence: { enabled: true, cwd: workDir },
		};

		// First instance: Echo triggers ask → handler picks alwaysAllow.
		const outer1 = new OuterHarness(cfg);
		const d1 = await outer1.onToolRequested(
			makeToolRequest("Echo", { text: "hi" }),
		);
		expect(d1.behavior).toBe("allow");
		expect(d1.resolvedFromAsk).toBe(true);

		// Second instance with no onAsk — loaded rule auto-allows.
		const cfg2 = { ...defaultConfig(), askPersistence: { enabled: true, cwd: workDir } };
		const outer2 = new OuterHarness(cfg2);
		const d2 = await outer2.onToolRequested(
			makeToolRequest("Echo", { text: "hi again" }),
		);
		expect(d2.behavior).toBe("allow");
		expect(d2.resolvedFromAsk).toBeUndefined();
	});

	it("is zero-behavior-change when askPersistence.enabled is false", async () => {
		const outer = new OuterHarness({
			...defaultConfig(),
			askPersistence: { enabled: false, cwd: workDir },
		});
		const decision = await outer.onToolRequested(
			makeToolRequest("Echo", { text: "hi" }),
		);
		// failMode closed + no onAsk → deny (same as baseline behavior).
		expect(decision.behavior).toBe("deny");
		expect(decision.resolvedFromAsk).toBe(true);
	});
});
