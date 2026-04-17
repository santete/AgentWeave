import { describe, it, expect, afterEach } from "vitest";
import WebSocket from "ws";
import { GatewayServer } from "../src/gateway";
import { AWOCPClient } from "@agentweave/protocol";
import type { InnerEvent } from "@agentweave/types";
import type { AWOCPMessage } from "@agentweave/protocol";

const TEST_TOKEN = "test-secret-token";
const TEST_PORT = 19100; // High port to avoid conflicts

function makeGateway(port = TEST_PORT) {
	return new GatewayServer({
		port,
		auth: { token: TEST_TOKEN },
		permissions: {
			mode: "default",
			rules: [
				{
					pattern: "Bash(rm -rf *)",
					behavior: "deny",
					source: "policy",
					priority: 100,
					message: "Destructive deletion blocked",
				},
				{
					pattern: "FileRead(*)",
					behavior: "allow",
					source: "project",
					priority: 50,
				},
			],
			failMode: "closed",
			timeoutMs: 5000,
			askTimeoutMs: 60000,
		},
	});
}

function makeClient(port = TEST_PORT) {
	return new AWOCPClient({
		url: `ws://127.0.0.1:${port}/awocp/v1`,
		token: TEST_TOKEN,
		sessionId: "ses_test",
		agentId: "agent_test",
		userId: "user_test",
		reconnect: false,
		pingIntervalMs: 60_000, // Long interval — don't ping during short tests
		interceptTimeoutMs: 3000,
	});
}

describe("GatewayServer", () => {
	let gw: GatewayServer;
	let client: AWOCPClient;

	afterEach(async () => {
		client?.disconnect();
		await gw?.stop();
	});

	// ─── Connection + Auth ───────────────────────────────────────

	it("should accept client with valid token", async () => {
		gw = makeGateway(19101);
		await gw.start();

		client = makeClient(19101);
		const authResponse = await client.connect();

		expect(authResponse.status).toBe("ok");
		expect(authResponse.serverId).toBeDefined();
		expect(client.isConnected()).toBe(true);
		expect(gw.getClientCount()).toBe(1);
	});

	it("should reject client with invalid token", async () => {
		gw = makeGateway(19102);
		await gw.start();

		client = new AWOCPClient({
			url: `ws://127.0.0.1:19102/awocp/v1`,
			token: "wrong-token",
			sessionId: "ses_test",
			agentId: "agent_test",
			userId: "user_test",
			reconnect: false,
		});

		await expect(client.connect()).rejects.toThrow("Invalid token");
	});

	// ─── Tool Intercept ─────────────────────────────────────────

	it("should deny tool matching deny rule via shared PermissionEngine", async () => {
		gw = makeGateway(19103);
		await gw.start();

		client = makeClient(19103);
		await client.connect();

		const decision = await client.interceptTool({
			toolName: "Bash",
			toolInput: { command: "rm -rf /" },
			toolUseId: "tu_1",
			turnIndex: 1,
			isReadOnly: false,
			isDestructive: true,
		});

		expect(decision.behavior).toBe("deny");
		expect(decision.reason).toContain("Destructive deletion");
	});

	it("should allow tool matching allow rule", async () => {
		gw = makeGateway(19104);
		await gw.start();

		client = makeClient(19104);
		await client.connect();

		const decision = await client.interceptTool({
			toolName: "FileRead",
			toolInput: { path: "src/index.ts" },
			toolUseId: "tu_2",
			turnIndex: 1,
			isReadOnly: true,
			isDestructive: false,
		});

		expect(decision.behavior).toBe("allow");
	});

	it("should deny unmatched tool in closed failMode", async () => {
		gw = makeGateway(19105);
		await gw.start();

		client = makeClient(19105);
		await client.connect();

		const decision = await client.interceptTool({
			toolName: "UnknownTool",
			toolInput: {},
			toolUseId: "tu_3",
			turnIndex: 1,
			isReadOnly: false,
			isDestructive: false,
		});

		// Default mode + closed failMode → deny for unmatched
		expect(decision.behavior).toBe("deny");
	});

	// ─── Event Forwarding ───────────────────────────────────────

	it("should receive forwarded events", async () => {
		gw = makeGateway(19106);
		await gw.start();

		client = makeClient(19106);
		await client.connect();

		const event: InnerEvent = {
			id: "evt_1",
			timestamp: Date.now(),
			sessionId: "ses_test",
			agentId: "agent_test",
			type: "turn:start",
			turnIndex: 1,
		};
		client.sendEvent(event);

		// Give time for message to arrive
		await new Promise((r) => setTimeout(r, 100));

		expect(gw.getEventLog().length).toBeGreaterThanOrEqual(1);
		expect(gw.getEventLog()[0]!.type).toBe("turn:start");
	});

	// ─── Client Disconnect ──────────────────────────────────────

	it("should track client disconnect", async () => {
		gw = makeGateway(19107);
		await gw.start();

		client = makeClient(19107);
		await client.connect();
		expect(gw.getClientCount()).toBe(1);

		client.disconnect();
		// Give time for close event
		await new Promise((r) => setTimeout(r, 100));

		expect(gw.getClientCount()).toBe(0);
	});

	// ─── Multiple Clients ───────────────────────────────────────

	it("should support multiple concurrent clients", async () => {
		gw = makeGateway(19108);
		await gw.start();

		const c1 = makeClient(19108);
		const c2 = new AWOCPClient({
			url: `ws://127.0.0.1:19108/awocp/v1`,
			token: TEST_TOKEN,
			sessionId: "ses_2",
			agentId: "agent_2",
			userId: "user_2",
			reconnect: false,
			pingIntervalMs: 60_000,
		});

		await c1.connect();
		await c2.connect();

		expect(gw.getClientCount()).toBe(2);

		// Both can intercept independently
		const d1 = await c1.interceptTool({
			toolName: "FileRead",
			toolInput: { path: "a.ts" },
			toolUseId: "tu_a",
			turnIndex: 1,
			isReadOnly: true,
			isDestructive: false,
		});
		const d2 = await c2.interceptTool({
			toolName: "Bash",
			toolInput: { command: "rm -rf /tmp" },
			toolUseId: "tu_b",
			turnIndex: 1,
			isReadOnly: false,
			isDestructive: true,
		});

		expect(d1.behavior).toBe("allow");
		expect(d2.behavior).toBe("deny");

		c1.disconnect();
		c2.disconnect();
		client = c1; // for afterEach
	});

	// ─── Edge Cases (from review round 8) ───────────────────────

	it("should not crash on malformed JSON message", async () => {
		gw = makeGateway(19109);
		await gw.start();

		// Raw WebSocket — send garbage after auth
		const ws = new WebSocket(`ws://127.0.0.1:19109/awocp/v1`);
		await new Promise<void>((resolve) => ws.on("open", resolve));

		// Send valid auth first
		const authMsg: AWOCPMessage = {
			id: "a1", ts: new Date().toISOString(), type: "auth:request",
			sessionId: "s1", agentId: "ag1",
			payload: {
				token: TEST_TOKEN, clientVersion: "0.4.0",
				sessionInfo: { sessionId: "s1", userId: "u1", model: "mock" },
			},
		};
		ws.send(JSON.stringify(authMsg));
		await new Promise((r) => setTimeout(r, 100));

		// Send garbage — server should not crash
		ws.send("NOT JSON {{{");
		ws.send(JSON.stringify({ broken: true })); // valid JSON but missing fields
		await new Promise((r) => setTimeout(r, 100));

		// Server still alive — new client can connect
		client = makeClient(19109);
		const auth = await client.connect();
		expect(auth.status).toBe("ok");

		ws.close();
	});

	it("should return error response when interceptHandler throws", async () => {
		// Create gateway with a permission config that will work
		gw = makeGateway(19110);
		await gw.start();

		// Override the intercept handler to throw
		gw.getServer().onIntercept(async () => {
			throw new Error("handler boom");
		});

		client = makeClient(19110);
		await client.connect();

		// Client should get a deny response (not timeout)
		const decision = await client.interceptTool({
			toolName: "Bash", toolInput: { command: "echo hi" },
			toolUseId: "tu_err", turnIndex: 1, isReadOnly: false, isDestructive: false,
		});

		expect(decision.behavior).toBe("deny");
		expect(decision.reason).toBe("Gateway error");
	});

	it("should handle intercept timeout when server is slow", async () => {
		gw = makeGateway(19111);
		await gw.start();

		// Override with a very slow handler
		gw.getServer().onIntercept(async () => {
			await new Promise((r) => setTimeout(r, 10_000)); // 10s
			return { behavior: "allow" as const, reason: "late", source: "test" };
		});

		client = new AWOCPClient({
			url: `ws://127.0.0.1:19111/awocp/v1`,
			token: TEST_TOKEN,
			sessionId: "ses_test", agentId: "agent_test", userId: "user_test",
			reconnect: false, pingIntervalMs: 60_000,
			interceptTimeoutMs: 200, // Very short timeout
		});
		await client.connect();

		await expect(
			client.interceptTool({
				toolName: "Bash", toolInput: {}, toolUseId: "tu_slow",
				turnIndex: 1, isReadOnly: false, isDestructive: false,
			}),
		).rejects.toThrow("Intercept timeout");
	});
});
