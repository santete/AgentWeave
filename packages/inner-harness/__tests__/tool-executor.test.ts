import { describe, it, expect } from "vitest";
import { z } from "zod";
import { ToolRegistry } from "../src/tool-registry";
import { ToolExecutor, partitionToolCalls } from "../src/tool-executor";
import type { ToolCall } from "../src/tool-executor";
import type { ToolDefinition, ToolContext } from "@agentweave/types";

function makeTool(
	name: string,
	opts: { readOnly?: boolean; concurrencySafe?: boolean; handler?: (input: unknown) => Promise<unknown> } = {},
): ToolDefinition {
	return {
		name,
		description: `Tool: ${name}`,
		parameters: z.object({}).passthrough(),
		execute: opts.handler ?? (async (input) => `${name} executed`),
		metadata: {
			isReadOnly: opts.readOnly ?? true,
			isDestructive: false,
			isConcurrencySafe: opts.concurrencySafe ?? opts.readOnly ?? true,
			category: "custom",
		},
	};
}

const mockContext: ToolContext = {
	sessionId: "ses_1",
	agentId: "agent_1",
	cwd: "/tmp",
	signal: new AbortController().signal,
};

describe("partitionToolCalls", () => {
	it("should group concurrent-safe calls together", () => {
		const reg = new ToolRegistry();
		reg.register(makeTool("ReadA", { concurrencySafe: true }));
		reg.register(makeTool("ReadB", { concurrencySafe: true }));

		const calls: ToolCall[] = [
			{ toolUseId: "t1", toolName: "ReadA", toolInput: {} },
			{ toolUseId: "t2", toolName: "ReadB", toolInput: {} },
		];

		const batches = partitionToolCalls(calls, reg);
		expect(batches).toHaveLength(1);
		expect(batches[0]!.concurrent).toBe(true);
		expect(batches[0]!.calls).toHaveLength(2);
	});

	it("should separate write tools into serial batches", () => {
		const reg = new ToolRegistry();
		reg.register(makeTool("Read", { concurrencySafe: true }));
		reg.register(makeTool("Write", { concurrencySafe: false }));

		const calls: ToolCall[] = [
			{ toolUseId: "t1", toolName: "Read", toolInput: {} },
			{ toolUseId: "t2", toolName: "Write", toolInput: {} },
			{ toolUseId: "t3", toolName: "Read", toolInput: {} },
		];

		const batches = partitionToolCalls(calls, reg);
		expect(batches).toHaveLength(3);
		expect(batches[0]!.concurrent).toBe(true);
		expect(batches[1]!.concurrent).toBe(false);
		expect(batches[2]!.concurrent).toBe(true);
	});
});

describe("ToolExecutor", () => {
	it("should execute a single tool call", async () => {
		const reg = new ToolRegistry();
		reg.register(makeTool("Echo", {
			handler: async (input) => "echoed",
		}));

		const executor = new ToolExecutor(reg, mockContext);
		const results = await executor.execute([
			{ toolUseId: "t1", toolName: "Echo", toolInput: {} },
		]);

		expect(results).toHaveLength(1);
		expect(results[0]!.isError).toBe(false);
		expect(results[0]!.result).toBe("echoed");
		expect(results[0]!.durationMs).toBeGreaterThanOrEqual(0);
	});

	it("should return error for unknown tool", async () => {
		const reg = new ToolRegistry();
		const executor = new ToolExecutor(reg, mockContext);

		const results = await executor.execute([
			{ toolUseId: "t1", toolName: "Ghost", toolInput: {} },
		]);

		expect(results[0]!.isError).toBe(true);
		expect(results[0]!.result).toContain("not found");
	});

	it("should catch tool execution errors", async () => {
		const reg = new ToolRegistry();
		reg.register(makeTool("Fail", {
			handler: async () => { throw new Error("tool crashed"); },
		}));

		const executor = new ToolExecutor(reg, mockContext);
		const results = await executor.execute([
			{ toolUseId: "t1", toolName: "Fail", toolInput: {} },
		]);

		expect(results[0]!.isError).toBe(true);
		expect(results[0]!.result).toBe("tool crashed");
	});

	it("should execute concurrent-safe tools in parallel", async () => {
		const reg = new ToolRegistry();
		const order: string[] = [];

		reg.register(makeTool("A", {
			concurrencySafe: true,
			handler: async () => { order.push("A"); return "A done"; },
		}));
		reg.register(makeTool("B", {
			concurrencySafe: true,
			handler: async () => { order.push("B"); return "B done"; },
		}));

		const executor = new ToolExecutor(reg, mockContext);
		const results = await executor.execute([
			{ toolUseId: "t1", toolName: "A", toolInput: {} },
			{ toolUseId: "t2", toolName: "B", toolInput: {} },
		]);

		expect(results).toHaveLength(2);
		expect(results.every((r) => !r.isError)).toBe(true);
	});
});
