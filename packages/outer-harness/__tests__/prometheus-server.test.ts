import { describe, it, expect, afterEach } from "vitest";
import { PrometheusServer } from "../src/observability/prometheus-server";
import { PrometheusExporter } from "../src/observability/prometheus-exporter";
import { MonitorCollector } from "../src/observability/monitor-collector";
import { AlertEngine } from "../src/observability/alert-engine";

function buildExporter(): PrometheusExporter {
	const collector = new MonitorCollector();
	collector.setSessionId("ses_srv");
	return new PrometheusExporter(collector, new AlertEngine());
}

describe("PrometheusServer", () => {
	let server: PrometheusServer | null = null;

	afterEach(async () => {
		await server?.stop();
		server = null;
	});

	it("serves /metrics with Prometheus content type", async () => {
		server = new PrometheusServer(buildExporter(), { port: 0 });
		await server.start();

		const { host, port } = server.address!;
		const res = await fetch(`http://${host}:${port}/metrics`);

		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toContain("text/plain");
		expect(res.headers.get("content-type")).toContain("version=0.0.4");

		const body = await res.text();
		expect(body).toContain("# HELP agentweave_turns_total");
		expect(body).toContain("# TYPE agentweave_turns_total counter");
	});

	it("returns 404 for unknown paths", async () => {
		server = new PrometheusServer(buildExporter(), { port: 0 });
		await server.start();

		const { host, port } = server.address!;
		const res = await fetch(`http://${host}:${port}/healthz`);
		expect(res.status).toBe(404);
	});

	it("returns 404 for non-GET methods on /metrics", async () => {
		server = new PrometheusServer(buildExporter(), { port: 0 });
		await server.start();

		const { host, port } = server.address!;
		const res = await fetch(`http://${host}:${port}/metrics`, { method: "POST" });
		expect(res.status).toBe(404);
	});

	it("honors custom path option", async () => {
		server = new PrometheusServer(buildExporter(), { port: 0, path: "/x/metrics" });
		await server.start();

		const { host, port } = server.address!;
		const ok = await fetch(`http://${host}:${port}/x/metrics`);
		expect(ok.status).toBe(200);

		const miss = await fetch(`http://${host}:${port}/metrics`);
		expect(miss.status).toBe(404);
	});

	it("stop() releases the port so a new server can bind", async () => {
		const first = new PrometheusServer(buildExporter(), { port: 0 });
		await first.start();
		const firstPort = first.address!.port;
		await first.stop();

		// Re-bind explicitly to the same port — if stop() didn't release it,
		// this throws EADDRINUSE.
		const second = new PrometheusServer(buildExporter(), { port: firstPort });
		server = second;
		await expect(second.start()).resolves.toBeUndefined();
	});

	it("handles 50 concurrent scrapes consistently", async () => {
		server = new PrometheusServer(buildExporter(), { port: 0 });
		await server.start();

		const { host, port } = server.address!;
		const results = await Promise.all(
			Array.from({ length: 50 }, () => fetch(`http://${host}:${port}/metrics`).then((r) => r.text())),
		);

		// Every response should contain the full HELP+TYPE prelude.
		for (const body of results) {
			expect(body).toContain("agentweave_turns_total");
			expect(body).toContain("agentweave_cost_usd_total");
		}
	}, 15_000);

	it("defaults to host 127.0.0.1", async () => {
		server = new PrometheusServer(buildExporter(), { port: 0 });
		await server.start();
		expect(server.address?.host).toBe("127.0.0.1");
	});
});
