/**
 * ToolExecutor — Executes tool calls with partition strategy.
 * Read-only tools run concurrently; write tools run serially.
 */

import type { ToolContext, ToolResult } from "@agentweave/types";
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
