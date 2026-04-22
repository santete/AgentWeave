import { describe, it, expect } from "vitest";
import { Writable } from "node:stream";
import http from "node:http";
import { monitorExportCommand, monitorServeCommand } from "../src/commands/monitor";

function sinkStream(): { write: Writable; getText: () => string } {
	const chunks: Buffer[] = [];
	const write = new Writable({
		write(chunk: Buffer | string, _enc, cb) {
			chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
			cb();
		},
	});
	return { write, getText: () => Buffer.concat(chunks).toString("utf-8") };
}

function getText(url: string): Promise<{ status: number; body: string; contentType: string }> {
	return new Promise((resolve, reject) => {
		const u = new URL(url);
		http.get({ host: u.hostname, port: u.port, path: u.pathname }, (res) => {
			const bufs: Buffer[] = [];
			res.on("data", (b: Buffer) => bufs.push(b));
			res.on("end", () => resolve({
				status: res.statusCode ?? 0,
				body: Buffer.concat(bufs).toString("utf-8"),
				contentType: (res.headers["content-type"] ?? "").toString(),
			}));
		}).on("error", reject);
	});
}

describe("monitorExportCommand", () => {
	it("writes Prometheus text with HELP/TYPE headers", () => {
		const { write, getText } = sinkStream();
		monitorExportCommand({ out: write });
		const text = getText();
		expect(text).toContain("# HELP agentweave_turns_total");
		expect(text).toContain("# TYPE agentweave_turns_total counter");
		expect(text.endsWith("\n")).toBe(true);
	});

	it("applies --instance label override", () => {
		const { write, getText } = sinkStream();
		monitorExportCommand({ instance: "ci-runner-7", out: write });
		expect(getText()).toContain('instance="ci-runner-7"');
	});

	it("omits session_id label by default", () => {
		const { write, getText } = sinkStream();
		monitorExportCommand({ out: write });
		expect(getText()).not.toContain("session_id=");
	});
});

describe("monitorServeCommand", () => {
	it("serves /metrics on an ephemeral port and shuts down on abort", async () => {
		const ac = new AbortController();
		const { write: log } = sinkStream();

		let readyAddr: { host: string; port: number } | null = null;
		const done = monitorServeCommand({
			port: 0,
			instance: "test-serve",
			signal: ac.signal,
			log,
			onReady: (a) => { readyAddr = a; },
		});

		// Wait until onReady fires (polling — fast).
		for (let i = 0; i < 100 && !readyAddr; i++) {
			await new Promise((r) => setTimeout(r, 10));
		}
		expect(readyAddr).not.toBeNull();

		const addr = readyAddr!;
		const res = await getText(`http://127.0.0.1:${addr.port}/metrics`);
		expect(res.status).toBe(200);
		expect(res.contentType).toContain("text/plain");
		expect(res.body).toContain('instance="test-serve"');
		expect(res.body).toContain("# HELP agentweave_turns_total");

		ac.abort();
		await done;
	});

	it("returns 404 on non-metrics paths", async () => {
		const ac = new AbortController();
		const { write: log } = sinkStream();

		let readyAddr: { host: string; port: number } | null = null;
		const done = monitorServeCommand({
			port: 0,
			signal: ac.signal,
			log,
			onReady: (a) => { readyAddr = a; },
		});

		for (let i = 0; i < 100 && !readyAddr; i++) {
			await new Promise((r) => setTimeout(r, 10));
		}
		const addr = readyAddr!;
		const res = await getText(`http://127.0.0.1:${addr.port}/healthz`);
		expect(res.status).toBe(404);

		ac.abort();
		await done;
	});
});
