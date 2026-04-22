/**
 * `agentweave mcp start` — launch the AgentWeave MCP server over stdio.
 *
 * Host tools (Claude Code, Cursor, etc.) spawn this command and speak
 * JSON-RPC over stdin/stdout. Logs go to stderr only — stdout is reserved
 * for the protocol.
 */

import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { resolve } from "node:path";

export interface McpStartOptions {
	/** Optional: override the resolved mcp-server entry path (for debugging). */
	entry?: string;
}

export async function mcpStartCommand(opts: McpStartOptions = {}): Promise<void> {
	const entry = opts.entry ?? resolveServerEntry();

	const child = spawn(process.execPath, [entry], {
		stdio: ["inherit", "inherit", "inherit"],
		env: { ...process.env, AGENTWEAVE_MCP_MODE: "1" },
	});

	child.on("exit", (code) => {
		process.exit(code ?? 0);
	});

	child.on("error", (err) => {
		process.stderr.write(`[agentweave mcp] failed to launch: ${err.message}\n`);
		process.exit(1);
	});
}

function resolveServerEntry(): string {
	try {
		const require_ = createRequire(import.meta.url);
		const pkgPath = require_.resolve("@agentweave/mcp-server/package.json");
		const pkgDir = resolve(pkgPath, "..");
		return resolve(pkgDir, "dist", "server.js");
	} catch (err) {
		throw new Error(
			`@agentweave/mcp-server is not installed. Build the workspace first (pnpm turbo build). Cause: ${
				err instanceof Error ? err.message : String(err)
			}`,
		);
	}
}

export function mcpPrintCommand(): void {
	const entry = resolveServerEntry();
	const template = {
		mcpServers: {
			agentweave: {
				command: process.execPath,
				args: [entry],
			},
		},
	};
	console.log(JSON.stringify(template, null, 2));
}
