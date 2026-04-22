import { describe, it, expect } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { resolve } from "node:path";

/**
 * Smoke test: spawn the compiled stdio server as a subprocess and verify
 * that initialize + tools/list work end-to-end. Requires `pnpm build` first.
 */
describe("stdio MCP server smoke", () => {
	it("lists all 4 registered tools over stdio", async () => {
		const serverPath = resolve(__dirname, "..", "dist", "server.js");

		const transport = new StdioClientTransport({
			command: process.execPath,
			args: [serverPath],
		});

		const client = new Client({ name: "smoke-client", version: "0.0.0" });
		await client.connect(transport);

		try {
			const { tools } = await client.listTools();
			const names = tools.map((t) => t.name).sort();
			expect(names).toEqual([
				"compare_metrics",
				"record_metrics",
				"run_quality_gate",
				"validate_patch",
			]);
		} finally {
			await client.close();
		}
	}, 15_000);
});
