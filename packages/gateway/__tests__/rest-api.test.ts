import { describe, it, expect, afterEach } from "vitest";
import http from "node:http";
import { GatewayServer, issueToken } from "../src/index";

const TEST_SECRET = "rest-api-test-secret";
let nextPort = 19200;

function allocPorts() {
	const ws = nextPort;
	const rest = nextPort + 1;
	nextPort += 2;
	return { ws, rest };
}

function makeGateway(ports: { ws: number; rest: number }) {
	return new GatewayServer({
		port: ports.ws,
		restPort: ports.rest,
		auth: { secret: TEST_SECRET, legacyToken: "legacy" },
		permissions: {
			mode: "default",
			rules: [
				{ pattern: "Bash(rm *)", behavior: "deny", source: "policy", priority: 100 },
			],
			failMode: "closed",
			timeoutMs: 5000,
			askTimeoutMs: 60000,
		},
	});
}

function apiFetch(port: number, path: string, opts: { method?: string; body?: string; token?: string } = {}): Promise<{ status: number; data: Record<string, unknown> }> {
	return new Promise((resolve, reject) => {
		const req = http.request({
			hostname: "127.0.0.1",
			port,
			path,
			method: opts.method ?? "GET",
			headers: {
				"Content-Type": "application/json",
				...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}),
			},
		}, (res) => {
			const chunks: Buffer[] = [];
			res.on("data", (c: Buffer) => chunks.push(c));
			res.on("end", () => {
				const body = Buffer.concat(chunks).toString("utf-8");
				resolve({ status: res.statusCode ?? 0, data: JSON.parse(body) as Record<string, unknown> });
			});
		});
		req.on("error", reject);
		if (opts.body) req.write(opts.body);
		req.end();
	});
}

describe("REST API", () => {
	let gw: GatewayServer;
	const adminToken = issueToken("admin-user", "admin", TEST_SECRET);
	const devToken = issueToken("dev-user", "developer", TEST_SECRET);

	afterEach(async () => {
		await gw?.stop();
	});

	it("GET /api/health — no auth required", async () => {
		const p = allocPorts();
		gw = makeGateway(p);
		await gw.start();
		const { status, data } = await apiFetch(p.rest, "/api/health");
		expect(status).toBe(200);
		expect(data.status).toBe("ok");
	});

	it("GET /api/rules — requires auth", async () => {
		const p = allocPorts();
		gw = makeGateway(p);
		await gw.start();
		const { status } = await apiFetch(p.rest, "/api/rules");
		expect(status).toBe(401);
	});

	it("GET /api/rules — returns rules with valid JWT", async () => {
		const p = allocPorts();
		gw = makeGateway(p);
		await gw.start();
		const { status, data } = await apiFetch(p.rest, "/api/rules", { token: devToken });
		expect(status).toBe(200);
		expect(Array.isArray(data.rules)).toBe(true);
	});

	it("POST /api/rules — developer role rejected (403)", async () => {
		const p = allocPorts();
		gw = makeGateway(p);
		await gw.start();
		const { status } = await apiFetch(p.rest, "/api/rules", {
			method: "POST",
			token: devToken,
			body: JSON.stringify({ pattern: "Test(*)", behavior: "allow" }),
		});
		expect(status).toBe(403);
	});

	it("POST /api/rules — admin role accepted", async () => {
		const p = allocPorts();
		gw = makeGateway(p);
		await gw.start();
		const { status, data } = await apiFetch(p.rest, "/api/rules", {
			method: "POST",
			token: adminToken,
			body: JSON.stringify({ pattern: "FileRead(*)", behavior: "allow" }),
		});
		expect(status).toBe(201);
		expect(data.ok).toBe(true);
	});

	it("POST /api/rules — invalid behavior rejected", async () => {
		const p = allocPorts();
		gw = makeGateway(p);
		await gw.start();
		const { status, data } = await apiFetch(p.rest, "/api/rules", {
			method: "POST",
			token: adminToken,
			body: JSON.stringify({ pattern: "Bash(*)", behavior: "YOLO" }),
		});
		expect(status).toBe(400);
		expect(data.error).toContain("behavior");
	});

	it("GET /api/clients — returns client list", async () => {
		const p = allocPorts();
		gw = makeGateway(p);
		await gw.start();
		const { status, data } = await apiFetch(p.rest, "/api/clients", { token: adminToken });
		expect(status).toBe(200);
		expect(data.count).toBe(0);
	});

	it("GET /api/metrics — returns snapshot", async () => {
		const p = allocPorts();
		gw = makeGateway(p);
		await gw.start();
		const { status, data } = await apiFetch(p.rest, "/api/metrics", { token: adminToken });
		expect(status).toBe(200);
		expect(data.snapshot).toBeDefined();
	});

	it("404 for unknown routes", async () => {
		const p = allocPorts();
		gw = makeGateway(p);
		await gw.start();
		const { status } = await apiFetch(p.rest, "/api/unknown", { token: adminToken });
		expect(status).toBe(404);
	});
});
