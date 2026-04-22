import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerValidatePatch } from "./tools/validate-patch";
import { registerRunQualityGate } from "./tools/run-quality-gate";
import { registerRecordMetrics } from "./tools/record-metrics";
import { registerCompareMetrics } from "./tools/compare-metrics";

/**
 * Create a configured AgentWeave MCP server with all Inner Harness
 * verification tools registered. Caller is responsible for connecting
 * a transport (stdio, http, etc.).
 */
export function createAgentWeaveMcpServer(): McpServer {
	const server = new McpServer({
		name: "agentweave-mcp",
		version: "0.1.0",
	});

	registerValidatePatch(server);
	registerRunQualityGate(server);
	registerRecordMetrics(server);
	registerCompareMetrics(server);

	return server;
}
