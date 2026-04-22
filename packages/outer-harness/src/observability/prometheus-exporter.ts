/**
 * PrometheusExporter — renders MonitorSnapshot as Prometheus text exposition.
 *
 * Pull model: `render()` calls `monitor.getSnapshot()` on every invocation.
 * No subscribe / no cache — the scraper drives the cost of collection so a
 * long-running exporter does not grow memory with per-tool cardinality.
 *
 * Follows text format version 0.0.4:
 *   https://prometheus.io/docs/instrumenting/exposition_formats/
 */

import type { MonitorCollector } from "./monitor-collector";
import type { AlertEngine } from "./alert-engine";

export interface PrometheusExporterOptions {
	/** `instance` label applied to every series. Defaults to "agentweave". */
	instance?: string;
	/**
	 * Opt-in: include `session_id` as a label. Defaults FALSE to prevent
	 * cardinality explosion in long-running processes where sessions cycle.
	 */
	includeSessionLabel?: boolean;
}

export class PrometheusExporter {
	private readonly instance: string;
	private readonly includeSessionLabel: boolean;

	constructor(
		private readonly monitor: MonitorCollector,
		private readonly _alerts: AlertEngine,
		opts: PrometheusExporterOptions = {},
	) {
		this.instance = opts.instance ?? "agentweave";
		this.includeSessionLabel = opts.includeSessionLabel ?? false;
	}

	/** Render current state as Prometheus text exposition. */
	render(): string {
		const snap = this.monitor.getSnapshot();
		const baseLabels = this.includeSessionLabel
			? { instance: this.instance, session_id: snap.sessionId }
			: { instance: this.instance };

		const out: string[] = [];

		out.push(...metric(
			"agentweave_turns_total",
			"counter",
			"Total LLM turns executed in the session.",
			[{ labels: baseLabels, value: snap.turnCount }],
		));

		out.push(...metric(
			"agentweave_session_duration_ms",
			"gauge",
			"Elapsed session wall-clock time in milliseconds.",
			[{ labels: baseLabels, value: snap.sessionDurationMs }],
		));

		out.push(...metric(
			"agentweave_input_tokens_total",
			"counter",
			"Total input tokens consumed by the session.",
			[{ labels: baseLabels, value: snap.totalUsage.inputTokens }],
		));

		out.push(...metric(
			"agentweave_output_tokens_total",
			"counter",
			"Total output tokens produced by the session.",
			[{ labels: baseLabels, value: snap.totalUsage.outputTokens }],
		));

		out.push(...metric(
			"agentweave_cost_usd_total",
			"counter",
			"Total session cost in USD.",
			[{ labels: baseLabels, value: snap.totalUsage.totalCost }],
		));

		out.push(...metric(
			"agentweave_errors_total",
			"counter",
			"Total errors surfaced during the session.",
			[{ labels: baseLabels, value: snap.errorCount }],
		));

		out.push(...metric(
			"agentweave_permission_denied_total",
			"counter",
			"Total tool calls denied by the permission engine.",
			[{ labels: baseLabels, value: snap.permissionDeniedCount }],
		));

		// Per-tool metrics
		const toolCalls: Series[] = [];
		const toolErrors: Series[] = [];
		const toolDuration: Series[] = [];

		for (const [toolName, tm] of snap.toolMetrics) {
			const toolLabels = { ...baseLabels, tool: toolName };
			toolCalls.push({ labels: toolLabels, value: tm.callCount });
			toolErrors.push({ labels: toolLabels, value: tm.errorCount });
			toolDuration.push({ labels: toolLabels, value: tm.avgDurationMs });
		}

		out.push(...metric(
			"agentweave_tool_calls_total",
			"counter",
			"Total tool invocations, by tool.",
			toolCalls,
		));

		out.push(...metric(
			"agentweave_tool_errors_total",
			"counter",
			"Total tool error results, by tool.",
			toolErrors,
		));

		out.push(...metric(
			"agentweave_tool_duration_ms_avg",
			"gauge",
			"Average tool execution duration in milliseconds, by tool.",
			toolDuration,
		));

		return out.join("\n") + "\n";
	}
}

// ─── Internal formatters ─────────────────────────────────────────

interface Series {
	labels: Record<string, string | number>;
	value: number;
}

function metric(name: string, type: "counter" | "gauge", help: string, series: Series[]): string[] {
	const lines = [
		`# HELP ${name} ${escapeHelp(help)}`,
		`# TYPE ${name} ${type}`,
	];
	for (const s of series) {
		lines.push(`${name}${renderLabels(s.labels)} ${formatValue(s.value)}`);
	}
	return lines;
}

function renderLabels(labels: Record<string, string | number>): string {
	const entries = Object.entries(labels);
	if (entries.length === 0) return "";
	const pairs = entries.map(([k, v]) => `${k}="${escapeLabelValue(String(v))}"`);
	return `{${pairs.join(",")}}`;
}

function escapeLabelValue(v: string): string {
	// Per exposition format: escape \, ", and newline in label values.
	return v.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}

function escapeHelp(h: string): string {
	// Per exposition format: escape \ and newline in HELP lines.
	return h.replace(/\\/g, "\\\\").replace(/\n/g, "\\n");
}

function formatValue(v: number): string {
	if (!Number.isFinite(v)) {
		if (Number.isNaN(v)) return "NaN";
		return v > 0 ? "+Inf" : "-Inf";
	}
	return String(v);
}
