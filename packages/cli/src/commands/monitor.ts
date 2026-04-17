/**
 * 'monitor' command — Connect to Gateway REST API and display live metrics.
 *
 * Usage: agentweave monitor --gateway http://localhost:9101
 */

import http from "node:http";

export interface MonitorArgs {
	gateway: string; // REST API base URL
	interval?: number; // Poll interval in ms (default 2000)
}

export async function monitorCommand(args: MonitorArgs): Promise<void> {
	const interval = args.interval ?? 2000;
	console.log(`\n  Monitoring gateway: ${args.gateway}`);
	console.log(`  Polling every ${interval / 1000}s. Press Ctrl+C to stop.\n`);

	const poll = async () => {
		try {
			const health = await fetchJson(`${args.gateway}/api/health`);
			const timestamp = new Date().toLocaleTimeString();

			console.log(`  [${timestamp}] Clients: ${health.clients ?? "?"} | Status: ${health.status ?? "unknown"}`);
		} catch {
			console.log(`  [${new Date().toLocaleTimeString()}] Gateway unreachable`);
		}
	};

	await poll();
	const timer = setInterval(poll, interval);

	// Keep running until Ctrl+C
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
		http.get({ hostname: parsed.hostname, port: parsed.port, path: parsed.pathname }, (res) => {
			const chunks: Buffer[] = [];
			res.on("data", (c: Buffer) => chunks.push(c));
			res.on("end", () => {
				try {
					resolve(JSON.parse(Buffer.concat(chunks).toString("utf-8")) as Record<string, unknown>);
				} catch { reject(new Error("Invalid JSON")); }
			});
		}).on("error", reject);
	});
}
