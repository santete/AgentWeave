/**
 * 'monitor' command — three modes:
 *
 *   agentweave monitor                             — legacy gateway poller
 *   agentweave monitor export [--instance <n>]     — print Prometheus text to stdout
 *   agentweave monitor serve [--port <p>]          — run /metrics HTTP server
 *
 * The `export` / `serve` subcommands build a standalone MonitorCollector +
 * AlertEngine + PrometheusExporter so operators can smoke-test wiring without
 * a live pipeline. Real metrics come from a running OuterHarness (wired via
 * `monitoring.prometheus.enabled: true` in OuterHarnessConfig).
 */

import http from "node:http";
import {
	AlertEngine,
	MonitorCollector,
	PrometheusExporter,
	PrometheusServer,
} from "@agentweave/outer-harness";

// ─── Legacy gateway poller (unchanged behavior) ─────────────────

export interface MonitorArgs {
	gateway: string;
	interval?: number;
}

export async function monitorCommand(args: MonitorArgs): Promise<void> {
	const interval = args.interval ?? 2000;
	console.log(`\n  Monitoring gateway: ${args.gateway}`);
	console.log(`  Polling every ${interval / 1000}s. Press Ctrl+C to stop.\n`);

	const poll = async () => {
		try {
			const health = await fetchJson(`${args.gateway}/api/health`);
			const timestamp = new Date().toLocaleTimeString();
			console.log(
				`  [${timestamp}] Clients: ${health.clients ?? "?"} | Status: ${health.status ?? "unknown"}`,
			);
		} catch {
			console.log(`  [${new Date().toLocaleTimeString()}] Gateway unreachable`);
		}
	};

	await poll();
	const timer = setInterval(poll, interval);

	await new Promise<void>((resolve) => {
		process.on("SIGINT", () => {
			clearInterval(timer);
			console.log("\n  Monitor stopped.");
			resolve();
		});
	});
}

function fetchJson(url: string): Promise<Record<string, unknown>> {
	return new Promise((resolve, reject) => {
		const parsed = new URL(url);
		http
			.get({ hostname: parsed.hostname, port: parsed.port, path: parsed.pathname }, (res) => {
				const chunks: Buffer[] = [];
				res.on("data", (c: Buffer) => chunks.push(c));
				res.on("end", () => {
					try {
						resolve(JSON.parse(Buffer.concat(chunks).toString("utf-8")) as Record<string, unknown>);
					} catch {
						reject(new Error("Invalid JSON"));
					}
				});
			})
			.on("error", reject);
	});
}

// ─── Prometheus export / serve ──────────────────────────────────

export interface MonitorExportArgs {
	instance?: string;
	includeSessionLabel?: boolean;
	/** Writable to receive the exposition (defaults to process.stdout). Test hook. */
	out?: NodeJS.WritableStream;
}

export function monitorExportCommand(args: MonitorExportArgs = {}): void {
	const monitor = new MonitorCollector();
	const alerts = new AlertEngine();
	const exporter = new PrometheusExporter(monitor, alerts, {
		instance: args.instance,
		includeSessionLabel: args.includeSessionLabel,
	});
	(args.out ?? process.stdout).write(exporter.render());
}

export interface MonitorServeArgs {
	port: number;
	host?: string;
	instance?: string;
	includeSessionLabel?: boolean;
	/** Resolved when server is listening. Test hook. */
	onReady?: (addr: { host: string; port: number }) => void;
	/** If provided, server stops when aborted instead of waiting for SIGINT. Test hook. */
	signal?: AbortSignal;
	/** Writable for log lines (defaults to process.stdout). Test hook. */
	log?: NodeJS.WritableStream;
}

export async function monitorServeCommand(args: MonitorServeArgs): Promise<void> {
	const log = args.log ?? process.stdout;
	const monitor = new MonitorCollector();
	const alerts = new AlertEngine();
	const exporter = new PrometheusExporter(monitor, alerts, {
		instance: args.instance,
		includeSessionLabel: args.includeSessionLabel,
	});
	const server = new PrometheusServer(exporter, {
		port: args.port,
		host: args.host,
	});

	await server.start();
	const addr = server.address!;
	log.write(`  AgentWeave Prometheus metrics at http://${addr.host}:${addr.port}/metrics\n`);
	log.write(`  Press Ctrl+C to stop.\n`);
	args.onReady?.(addr);

	await new Promise<void>((resolve) => {
		const stop = async () => {
			await server.stop().catch(() => {});
			log.write("\n  Monitor stopped.\n");
			resolve();
		};
		if (args.signal) {
			if (args.signal.aborted) void stop();
			else args.signal.addEventListener("abort", () => void stop(), { once: true });
		} else {
			process.once("SIGINT", () => void stop());
			process.once("SIGTERM", () => void stop());
		}
	});
}
