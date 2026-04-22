import { describe, it, expect } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { registerValidatePatch } from "../src/tools/validate-patch";

async function setup() {
	const server = new McpServer({ name: "test", version: "0.0.0" });
	registerValidatePatch(server);
	const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
	const client = new Client({ name: "test-client", version: "0.0.0" });
	await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
	return { client };
}

function parseToolResult(result: unknown): Record<string, unknown> {
	const r = result as { content: Array<{ type: string; text: string }> };
	return JSON.parse(r.content[0]!.text) as Record<string, unknown>;
}

describe("validate_patch tool", () => {
	it("passes when changes are in scope", async () => {
		const { client } = await setup();
		const result = await client.callTool({
			name: "validate_patch",
			arguments: {
				changedFiles: ["src/auth.ts", "src/login.ts"],
				estimatedFiles: ["src/auth.ts", "src/login.ts"],
			},
		});
		const parsed = parseToolResult(result);
		expect(parsed.passed).toBe(true);
		expect(parsed.scopeAccuracy).toBe(1);
	});

	it("flags out-of-scope files as warning (scopeStrict=false)", async () => {
		const { client } = await setup();
		const result = await client.callTool({
			name: "validate_patch",
			arguments: {
				changedFiles: ["src/auth.ts", "src/unrelated.ts"],
				estimatedFiles: ["src/auth.ts"],
			},
		});
		const parsed = parseToolResult(result);
		expect(parsed.passed).toBe(true); // warnings don't fail
		expect(parsed.scopeAccuracy).toBe(0.5);
		const checks = parsed.checks as Array<{ name: string; passed: boolean; severity: string }>;
		const scopeCheck = checks.find((c) => c.name === "scope");
		expect(scopeCheck?.passed).toBe(false);
		expect(scopeCheck?.severity).toBe("warning");
	});

	it("fails when scopeStrict=true and out of scope", async () => {
		const { client } = await setup();
		const result = await client.callTool({
			name: "validate_patch",
			arguments: {
				changedFiles: ["src/auth.ts", "src/random.ts"],
				estimatedFiles: ["src/auth.ts"],
				scopeStrict: true,
			},
		});
		const parsed = parseToolResult(result);
		expect(parsed.passed).toBe(false);
	});

	it("fails when too many files changed under scopeStrict", async () => {
		const files = Array.from({ length: 40 }, (_, i) => `src/f${i}.ts`);
		const { client } = await setup();
		const result = await client.callTool({
			name: "validate_patch",
			arguments: {
				changedFiles: files,
				maxFilesChanged: 30,
				scopeStrict: true,
			},
		});
		const parsed = parseToolResult(result);
		expect(parsed.passed).toBe(false);
		const checks = parsed.checks as Array<{ name: string; passed: boolean }>;
		expect(checks.find((c) => c.name === "file_count")?.passed).toBe(false);
	});
});
