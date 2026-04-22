import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { registerRunQualityGate } from "../src/tools/run-quality-gate";

let TMP: string;
let PASS_SCRIPT: string;
let FAIL_SCRIPT: string;

beforeAll(() => {
	TMP = mkdtempSync(join(tmpdir(), "aw-mcp-"));
	PASS_SCRIPT = join(TMP, "pass.js");
	FAIL_SCRIPT = join(TMP, "fail.js");
	writeFileSync(PASS_SCRIPT, "");
	writeFileSync(FAIL_SCRIPT, "process.exit(1);");
});

afterAll(() => {
	rmSync(TMP, { recursive: true, force: true });
});

async function setup() {
	const server = new McpServer({ name: "test", version: "0.0.0" });
	registerRunQualityGate(server);
	const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
	const client = new Client({ name: "test-client", version: "0.0.0" });
	await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
	return { client };
}

function parseToolResult(result: unknown): Record<string, unknown> {
	const r = result as { content: Array<{ type: string; text: string }> };
	return JSON.parse(r.content[0]!.text) as Record<string, unknown>;
}

describe("run_quality_gate tool", () => {
	it("passes when a 'test' check exits 0", async () => {
		const { client } = await setup();
		const result = await client.callTool({
			name: "run_quality_gate",
			arguments: {
				checks: [{ type: "test", command: `node ${PASS_SCRIPT}`, required: true }],
			},
		});
		const parsed = parseToolResult(result);
		expect(parsed.passed).toBe(true);
	});

	it("fails when a required check exits non-zero", async () => {
		const { client } = await setup();
		const result = await client.callTool({
			name: "run_quality_gate",
			arguments: {
				checks: [{ type: "test", command: `node ${FAIL_SCRIPT}`, required: true }],
			},
		});
		const parsed = parseToolResult(result);
		expect(parsed.passed).toBe(false);
		const checks = parsed.checks as Array<{ name: string; passed: boolean; severity: string }>;
		expect(checks[0]?.passed).toBe(false);
		expect(checks[0]?.severity).toBe("error");
	});

	it("non-required failure becomes warning (passed still true)", async () => {
		const { client } = await setup();
		const result = await client.callTool({
			name: "run_quality_gate",
			arguments: {
				checks: [{ type: "lint", command: `node ${FAIL_SCRIPT}`, required: false }],
			},
		});
		const parsed = parseToolResult(result);
		expect(parsed.passed).toBe(true);
		const checks = parsed.checks as Array<{ name: string; passed: boolean; severity: string }>;
		expect(checks[0]?.passed).toBe(false);
		expect(checks[0]?.severity).toBe("warning");
	});

	it("rejects command with shell metacharacters", async () => {
		const { client } = await setup();
		const result = await client.callTool({
			name: "run_quality_gate",
			arguments: {
				checks: [{ type: "custom", command: `node ${PASS_SCRIPT} ; rm -rf /`, required: true }],
			},
		});
		const parsed = parseToolResult(result);
		expect(parsed.passed).toBe(false);
		const checks = parsed.checks as Array<{ passed: boolean; message?: string }>;
		expect(checks[0]?.message).toMatch(/shell metacharacters/i);
	});

	it("rejects binary not in allowlist", async () => {
		const { client } = await setup();
		const result = await client.callTool({
			name: "run_quality_gate",
			arguments: {
				checks: [{ type: "custom", command: "curl http://example.com", required: true }],
			},
		});
		const parsed = parseToolResult(result);
		expect(parsed.passed).toBe(false);
		const checks = parsed.checks as Array<{ message?: string }>;
		expect(checks[0]?.message).toMatch(/safe allowlist/i);
	});

	it("returns passed=true for empty checks list", async () => {
		const { client } = await setup();
		const result = await client.callTool({
			name: "run_quality_gate",
			arguments: { checks: [] },
		});
		const parsed = parseToolResult(result);
		expect(parsed.passed).toBe(true);
	});
});
