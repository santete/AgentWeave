/**
 * ToolExecutor — Executes tool calls with partition strategy.
 * Read-only tools run concurrently; write tools run serially.
 */

import { resolve, normalize } from "node:path";
import type { ToolContext, ToolResult, SandboxConfig } from "@agentweave/types";
import { ToolRegistry } from "./tool-registry";

export interface ToolCall {
	toolUseId: string;
	toolName: string;
	toolInput: Record<string, unknown>;
}

export interface ToolCallResult {
	toolUseId: string;
	toolName: string;
	result: unknown;
	isError: boolean;
	durationMs: number;
}

interface Batch {
	concurrent: boolean;
	calls: ToolCall[];
}

/** Partition tool calls into batches: concurrent for read-only, serial for writes. */
export function partitionToolCalls(
	calls: ToolCall[],
	registry: ToolRegistry,
): Batch[] {
	const batches: Batch[] = [];

	for (const call of calls) {
		const tool = registry.get(call.toolName);
		const isSafe = tool?.metadata.isConcurrencySafe ?? false;

		const lastBatch = batches.at(-1);
		if (lastBatch && lastBatch.concurrent === isSafe) {
			lastBatch.calls.push(call);
		} else {
			batches.push({ concurrent: isSafe, calls: [call] });
		}
	}

	return batches;
}

export class ToolExecutor {
	constructor(
		private registry: ToolRegistry,
		private context: ToolContext,
	) {}

	async execute(calls: ToolCall[]): Promise<ToolCallResult[]> {
		const batches = partitionToolCalls(calls, this.registry);
		const results: ToolCallResult[] = [];

		for (const batch of batches) {
			if (batch.concurrent) {
				const batchResults = await Promise.all(
					batch.calls.map((call) => this.executeSingle(call)),
				);
				results.push(...batchResults);
			} else {
				for (const call of batch.calls) {
					const result = await this.executeSingle(call);
					results.push(result);
				}
			}
		}

		return results;
	}

	private async executeSingle(call: ToolCall): Promise<ToolCallResult> {
		const tool = this.registry.get(call.toolName);
		const start = performance.now();

		if (!tool) {
			return {
				toolUseId: call.toolUseId,
				toolName: call.toolName,
				result: `Error: Tool "${call.toolName}" not found`,
				isError: true,
				durationMs: performance.now() - start,
			};
		}

		try {
			// Sandbox: check file paths in tool input against allowed/denied
			if (this.context.sandbox) {
				const violation = checkSandbox(call.toolInput, this.context.sandbox, this.context.cwd);
				if (violation) {
					return {
						toolUseId: call.toolUseId,
						toolName: call.toolName,
						result: `Sandbox violation: ${violation}`,
						isError: true,
						durationMs: performance.now() - start,
					};
				}
			}

			const parsed = tool.parameters.parse(call.toolInput);
			const result = await tool.execute(parsed, this.context);
			return {
				toolUseId: call.toolUseId,
				toolName: call.toolName,
				result: typeof result === "object" && result !== null && "data" in result
					? (result as ToolResult).data
					: result,
				isError: false,
				durationMs: performance.now() - start,
			};
		} catch (err) {
			return {
				toolUseId: call.toolUseId,
				toolName: call.toolName,
				result: err instanceof Error ? err.message : "Unknown tool error",
				isError: true,
				durationMs: performance.now() - start,
			};
		}
	}
}

// ─── Sandbox Path Checking ──────────────────────────────────────

const DEFAULT_DENIED = ["/etc", "/var", "/root", "/sys", "/proc"];
const SENSITIVE_GLOBS = [".env", ".ssh", ".aws", ".gnupg", "credentials"];

function checkSandbox(
	input: Record<string, unknown>,
	sandbox: SandboxConfig,
	cwd: string,
): string | null {
	// Extract file paths from common tool input fields
	const paths: string[] = [];
	for (const key of ["path", "file_path", "filePath", "file", "directory", "command"]) {
		const val = input[key];
		if (typeof val === "string") {
			// For commands, extract paths heuristically
			if (key === "command") {
				// Extract file-like args from shell commands
				const tokens = val.split(/\s+/);
				for (const t of tokens) {
					if (t.startsWith("/") || t.startsWith("./") || t.startsWith("../") || t.includes(".env")) {
						paths.push(t);
					}
				}
			} else {
				paths.push(val);
			}
		}
	}

	if (paths.length === 0) return null;

	for (const p of paths) {
		const abs = resolve(cwd, normalize(p));

		// Check denied paths (explicit + defaults)
		const denied = [...DEFAULT_DENIED, ...(sandbox.deniedPaths ?? [])];
		for (const d of denied) {
			if (abs.startsWith(resolve(d)) || abs.startsWith(resolve(cwd, d))) {
				return `Access denied to "${p}" (matches denied path "${d}")`;
			}
		}

		// Check sensitive file patterns
		for (const s of SENSITIVE_GLOBS) {
			if (abs.includes(s)) {
				return `Access denied to "${p}" (sensitive pattern "${s}")`;
			}
		}

		// Check allowed paths (if specified, only these are permitted)
		if (sandbox.allowedPaths && sandbox.allowedPaths.length > 0) {
			const allowed = sandbox.allowedPaths.some((a) =>
				abs.startsWith(resolve(cwd, a)) || abs.startsWith(resolve(a)),
			);
			if (!allowed) {
				return `Access denied to "${p}" (not in allowed paths)`;
			}
		}
	}

	return null;
}
