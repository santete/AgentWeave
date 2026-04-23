#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createAgentWeaveMcpServer } from "./server-factory";

async function main(): Promise<void> {
	// Recursion guard for any child process the tools might spawn.
	// Must be set BEFORE connect so handshake/initialization can't race the flag.
	process.env.AGENTWEAVE_MCP_MODE = "1";
	const server = createAgentWeaveMcpServer();
	const transport = new StdioServerTransport();
	await server.connect(transport);
}

main().catch((err) => {
	// MCP stdout is reserved for JSON-RPC, logs go to stderr only.
	process.stderr.write(`[agentweave-mcp] fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
	process.exit(1);
});
