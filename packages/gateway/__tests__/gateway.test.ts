import { describe, it, expect, afterEach } from "vitest";
import { GatewayServer } from "../src/gateway";
import { AWOCPClient } from "@agentweave/protocol";
import type { InnerEvent } from "@agentweave/types";

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
});
