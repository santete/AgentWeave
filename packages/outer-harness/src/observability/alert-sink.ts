/**
 * AlertSink — pluggable alert delivery target.
 *
 * Sinks receive AlertEvents from AlertEngine via fire-and-forget dispatch.
 * Contract: `publish()` MUST NOT throw — failures are the sink's problem,
 * never the caller's. Slow sinks must not stall the event loop.
 */

import type { AlertEvent, AlertSeverity } from "@agentweave/types";
import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { fetchWithRetry } from "../shared/http-retry";

export interface AlertSink {
	readonly name: string;
	publish(alert: AlertEvent): Promise<void>;
	close?(): Promise<void>;
}

// ─── StdoutSink ────────────────────────────────────────────────────

export interface StdoutSinkOptions {
	/** Filter by severity. Default: accept all. */
	severityFilter?: AlertSeverity[];
	/** Output stream. Default: process.stderr so alerts don't pollute stdout pipes. */
	stream?: NodeJS.WritableStream;
}

export class StdoutSink implements AlertSink {
	readonly name = "stdout";
	private readonly filter?: Set<AlertSeverity>;
	private readonly stream: NodeJS.WritableStream;

	constructor(opts: StdoutSinkOptions = {}) {
		this.filter = opts.severityFilter ? new Set(opts.severityFilter) : undefined;
		this.stream = opts.stream ?? process.stderr;
	}

	async publish(alert: AlertEvent): Promise<void> {
		if (this.filter && !this.filter.has(alert.severity)) return;
		const line = `[${alert.severity.toUpperCase()}] ${alert.ruleName}: ${alert.message} (session=${alert.sessionId})\n`;
		this.stream.write(line);
	}
}

// ─── FileSink ──────────────────────────────────────────────────────

export interface FileSinkOptions {
	/** Absolute or relative path. Parent dirs are created on first publish. */
	path: string;
	/** Filter by severity. Default: accept all. */
	severityFilter?: AlertSeverity[];
}

export class FileSink implements AlertSink {
	readonly name = "file";
	private readonly path: string;
	private readonly filter?: Set<AlertSeverity>;
	private dirEnsured = false;

	constructor(opts: FileSinkOptions) {
		this.path = opts.path;
		this.filter = opts.severityFilter ? new Set(opts.severityFilter) : undefined;
	}

	async publish(alert: AlertEvent): Promise<void> {
		if (this.filter && !this.filter.has(alert.severity)) return;
		try {
			if (!this.dirEnsured) {
				await mkdir(dirname(this.path), { recursive: true });
				this.dirEnsured = true;
			}
			// Serialize without the full snapshot to keep lines compact.
			const line = JSON.stringify({
				ruleId: alert.ruleId,
				ruleName: alert.ruleName,
				severity: alert.severity,
				message: alert.message,
				timestamp: alert.timestamp,
				sessionId: alert.sessionId,
				cost: alert.snapshot.totalUsage.totalCost,
				turns: alert.snapshot.turnCount,
			}) + "\n";
			await appendFile(this.path, line, "utf8");
		} catch {
			// Swallow — publish() MUST NOT throw. Disk errors logged elsewhere.
		}
	}
}

// ─── WebhookSink ───────────────────────────────────────────────────

export interface WebhookSinkOptions {
	url: string;
	method?: "POST" | "PUT";
	headers?: Record<string, string>;
	/** Retry attempts AFTER the initial request. Default 3. */
	maxRetries?: number;
	/** Per-attempt timeout. Default 5000. */
	timeoutMs?: number;
	/** Filter by severity. Default: warning + critical. */
	severityFilter?: AlertSeverity[];
}

export class WebhookSink implements AlertSink {
	readonly name = "webhook";
	private readonly opts: WebhookSinkOptions;
	private readonly filter: Set<AlertSeverity>;

	constructor(opts: WebhookSinkOptions) {
		this.opts = opts;
		this.filter = new Set(opts.severityFilter ?? ["warning", "critical"]);
	}

	async publish(alert: AlertEvent): Promise<void> {
		if (!this.filter.has(alert.severity)) return;

		const body = JSON.stringify({
			ruleId: alert.ruleId,
			ruleName: alert.ruleName,
			severity: alert.severity,
			message: alert.message,
			timestamp: alert.timestamp,
			sessionId: alert.sessionId,
		});

		try {
			await fetchWithRetry(
				this.opts.url,
				{
					method: this.opts.method ?? "POST",
					headers: {
						"Content-Type": "application/json",
						...(this.opts.headers ?? {}),
					},
					body,
				},
				{
					maxRetries: this.opts.maxRetries ?? 3,
					timeoutMs: this.opts.timeoutMs ?? 5000,
				},
			);
		} catch {
			// publish() MUST NOT throw — network errors are the sink's to own.
		}
	}
}
