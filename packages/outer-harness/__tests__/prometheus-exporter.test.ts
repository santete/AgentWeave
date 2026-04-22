import { describe, it, expect } from "vitest";
import { PrometheusExporter } from "../src/observability/prometheus-exporter";
import { MonitorCollector } from "../src/observability/monitor-collector";
import { AlertEngine } from "../src/observability/alert-engine";
import type { InnerEvent } from "@agentweave/types";

function primeCollector(c: MonitorCollector, sessionId = "ses_p"): void {
	c.setSessionId(sessionId);
	const base = { sessionId, agentId: "a", timestamp: Date.now() };

	c.collect({ ...base, type: "turn:start", id: "e1", turnIndex: 1 } as InnerEvent);

	c.collect({
		...base,
		type: "llm:stream_end",
		id: "e2",
		usage: {
			inputTokens: 100, outputTokens: 50, thinkingTokens: 0,
			cacheReadTokens: 0, cacheCreationTokens: 0, totalCost: 0.05,
		},
		model: "m",
	} as InnerEvent);

	c.collect({
		...base, type: "tool:requested", id: "e3",
		toolName: "Bash", toolInput: {}, toolUseId: "t1",
	} as InnerEvent);
	c.collect({
		...base, type: "tool:completed", id: "e4",
		toolName: "Bash", toolUseId: "t1", durationMs: 42, result: "ok",
	} as InnerEvent);

	c.collect({
		...base, type: "tool:requested", id: "e5",
		toolName: "Read", toolInput: {}, toolUseId: "t2",
	} as InnerEvent);
	c.collect({
		...base, type: "tool:failed", id: "e6",
		toolName: "Read", toolUseId: "t2", durationMs: 12, error: "boom",
	} as InnerEvent);

	c.collect({ ...base, type: "turn:end", id: "e7", turnIndex: 1, stopReason: "end_turn" } as InnerEvent);
}

describe("PrometheusExporter.render", () => {
	it("emits HELP + TYPE for all 10 metric names", () => {
		const c = new MonitorCollector();
		const a = new AlertEngine();
		primeCollector(c);

		const text = new PrometheusExporter(c, a).render();

		const expectedNames = [
			"agentweave_turns_total",
			"agentweave_session_duration_ms",
			"agentweave_input_tokens_total",
			"agentweave_output_tokens_total",
			"agentweave_cost_usd_total",
			"agentweave_errors_total",
			"agentweave_permission_denied_total",
			"agentweave_alerts_fired_total",
			"agentweave_tool_calls_total",
			"agentweave_tool_errors_total",
			"agentweave_tool_duration_ms_avg",
		];

		for (const name of expectedNames) {
			expect(text).toContain(`# HELP ${name}`);
			expect(text).toContain(`# TYPE ${name}`);
		}
	});

	it("emits ≥ 5 series after a real session", () => {
		const c = new MonitorCollector();
		primeCollector(c);

		const text = new PrometheusExporter(c, new AlertEngine()).render();

		const dataLines = text
			.split("\n")
			.filter((l) => l.length > 0 && !l.startsWith("#"));

		expect(dataLines.length).toBeGreaterThanOrEqual(5);
	});

	it("defaults to instance=\"agentweave\" and omits session_id label", () => {
		const c = new MonitorCollector();
		primeCollector(c, "ses_secret");

		const text = new PrometheusExporter(c, new AlertEngine()).render();

		expect(text).toContain('instance="agentweave"');
		expect(text).not.toContain("session_id=");
		expect(text).not.toContain("ses_secret");
	});

	it("includes session_id label only when opted in", () => {
		const c = new MonitorCollector();
		primeCollector(c, "ses_opt");

		const text = new PrometheusExporter(c, new AlertEngine(), {
			instance: "ci-1",
			includeSessionLabel: true,
		}).render();

		expect(text).toContain('instance="ci-1"');
		expect(text).toContain('session_id="ses_opt"');
	});

	it("emits per-tool series with tool label", () => {
		const c = new MonitorCollector();
		primeCollector(c);

		const text = new PrometheusExporter(c, new AlertEngine()).render();

		// Per-tool tool_calls_total lines should have tool="Bash" and tool="Read"
		const calls = text.split("\n").filter((l) => l.startsWith("agentweave_tool_calls_total"));
		expect(calls.some((l) => l.includes('tool="Bash"'))).toBe(true);
		expect(calls.some((l) => l.includes('tool="Read"'))).toBe(true);

		// Bash call count = 1
		const bashLine = calls.find((l) => l.includes('tool="Bash"'))!;
		expect(bashLine.endsWith(" 1")).toBe(true);

		// Read errorCount = 1 (tool:end success:false)
		const errs = text
			.split("\n")
			.filter((l) => l.startsWith("agentweave_tool_errors_total") && l.includes('tool="Read"'));
		expect(errs).toHaveLength(1);
		expect(errs[0]!.endsWith(" 1")).toBe(true);
	});

	it("escapes double-quote and backslash inside label values", () => {
		const c = new MonitorCollector();
		c.setSessionId('ses"with\\quote');
		c.collect({
			sessionId: 'ses"with\\quote', agentId: "a", timestamp: Date.now(),
			id: "e1", type: "turn:start", turnIndex: 1,
		} as InnerEvent);

		const text = new PrometheusExporter(c, new AlertEngine(), {
			instance: "x",
			includeSessionLabel: true,
		}).render();

		expect(text).toContain('session_id="ses\\"with\\\\quote"');
	});

	it("renders the 8 session-level counters/gauges even with zero tool calls", () => {
		const c = new MonitorCollector();
		c.setSessionId("ses_empty");

		const text = new PrometheusExporter(c, new AlertEngine()).render();

		// Each session-level metric gets one data line; tool_* metrics are
		// HELP/TYPE-only with zero series. 7 monitor counters + 1 alerts counter.
		const dataLines = text
			.split("\n")
			.filter((l) => l.length > 0 && !l.startsWith("#"));
		expect(dataLines.length).toBe(8);
	});

	it("ends with a trailing newline (Prometheus spec)", () => {
		const c = new MonitorCollector();
		c.setSessionId("ses");

		const text = new PrometheusExporter(c, new AlertEngine()).render();
		expect(text.endsWith("\n")).toBe(true);
	});
});
