import { describe, it, expect } from "vitest";
import { MonitorCollector } from "../src/observability/monitor-collector";
import type { InnerEvent } from "@agentweave/types";
import { createEmptyTokenUsage } from "@agentweave/types";

function makeEvent(type: string, extra: Record<string, unknown> = {}): InnerEvent {
	return {
		id: "e1",
		timestamp: Date.now(),
		sessionId: "ses_1",
		agentId: "a1",
		type,
		...extra,
	} as InnerEvent;
}

describe("MonitorCollector", () => {
	it("should start with zero metrics", () => {
		const mc = new MonitorCollector();
		mc.setSessionId("ses_1");
		const snap = mc.getSnapshot();
		expect(snap.turnCount).toBe(0);
		expect(snap.errorCount).toBe(0);
		expect(snap.totalUsage.totalCost).toBe(0);
	});

	it("should track turn count", () => {
		const mc = new MonitorCollector();
		mc.collect(makeEvent("turn:start", { turnIndex: 1 }));
		mc.collect(makeEvent("turn:end", { turnIndex: 1, stopReason: "continue" }));
		mc.collect(makeEvent("turn:start", { turnIndex: 2 }));
		mc.collect(makeEvent("turn:end", { turnIndex: 2, stopReason: "continue" }));

		expect(mc.getTurnCount()).toBe(2);
		expect(mc.getSnapshot().turnMetrics).toHaveLength(2);
	});

	it("should track tool metrics", () => {
		const mc = new MonitorCollector();
		mc.collect(makeEvent("tool:requested", { toolName: "Bash", toolInput: {}, toolUseId: "tu_1" }));
		mc.collect(makeEvent("tool:completed", { toolUseId: "tu_1", result: "ok", durationMs: 42 }));
		mc.collect(makeEvent("tool:requested", { toolName: "Bash", toolInput: {}, toolUseId: "tu_2" }));
		mc.collect(makeEvent("tool:failed", { toolUseId: "tu_2", error: "fail", durationMs: 10 }));

		const tools = mc.getToolMetrics("Bash");
		expect(tools).toBeDefined();
		expect(tools!.callCount).toBe(2);
		expect(tools!.successCount).toBe(1);
		expect(tools!.errorCount).toBe(1);
		expect(tools!.avgDurationMs).toBe(26); // (42 + 10) / 2
	});

	it("should track errors", () => {
		const mc = new MonitorCollector();
		mc.collect(makeEvent("error", { error: "boom", recoverable: false }));
		mc.collect(makeEvent("tool:requested", { toolName: "X", toolInput: {}, toolUseId: "tu_1" }));
		mc.collect(makeEvent("tool:failed", { toolUseId: "tu_1", error: "fail", durationMs: 5 }));

		expect(mc.getErrorCount()).toBe(2);
	});

	it("should track permission denials", () => {
		const mc = new MonitorCollector();
		mc.collect(makeEvent("permission:denied", { toolName: "Bash", toolUseId: "tu_1", reason: "no", source: "test" }));

		expect(mc.getSnapshot().permissionDeniedCount).toBe(1);
	});

	it("should track token usage from llm:stream_end", () => {
		const mc = new MonitorCollector();
		mc.collect(makeEvent("llm:stream_end", {
			usage: { ...createEmptyTokenUsage(), inputTokens: 100, outputTokens: 50, totalCost: 0.01 },
			stopReason: "end_turn",
		}));

		expect(mc.getSnapshot().totalUsage.inputTokens).toBe(100);
		expect(mc.getSnapshot().totalUsage.totalCost).toBe(0.01);
	});

	it("should track session duration", () => {
		const mc = new MonitorCollector();
		mc.setSessionId("ses_1");

		// Small delay to ensure duration > 0
		const snap = mc.getSnapshot();
		expect(snap.sessionDurationMs).toBeGreaterThanOrEqual(0);
		expect(snap.sessionId).toBe("ses_1");
	});

	it("should reset all metrics", () => {
		const mc = new MonitorCollector();
		mc.collect(makeEvent("turn:start", { turnIndex: 1 }));
		mc.collect(makeEvent("error", { error: "x", recoverable: true }));
		mc.reset();

		expect(mc.getTurnCount()).toBe(0);
		expect(mc.getErrorCount()).toBe(0);
		expect(mc.getAllToolMetrics().size).toBe(0);
	});
});
