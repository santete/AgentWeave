#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createAgentWeaveMcpServer } from "./server-factory";

async function main(): Promise<void> {
	const server = createAgentWeaveMcpServer();
	const transport = new StdioServerTransport();
	await server.connect(transport);
	// Recursion guard for any child process the tools might spawn.
	process.env.AGENTWEAVE_MCP_MODE = "1";
}

main().catch((err) => {
	// MCP stdout is reserved for JSON-RPC, logs go to stderr only.
	process.stderr.write(`[agentweave-mcp] fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
	process.exit(1);
});
