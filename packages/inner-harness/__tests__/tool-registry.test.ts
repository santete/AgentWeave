import { describe, it, expect } from "vitest";
import { z } from "zod";
import { ToolRegistry } from "../src/tool-registry";
import type { ToolDefinition } from "@agentweave/types";

function makeTool(name: string, readOnly = true): ToolDefinition {
	return {
		name,
		description: `Test tool: ${name}`,
		parameters: z.object({ input: z.string() }),
		execute: async (input) => input,
		metadata: {
			isReadOnly: readOnly,
			isDestructive: false,
			isConcurrencySafe: readOnly,
			category: "custom",
		},
	};
}

describe("ToolRegistry", () => {
	it("should register and retrieve a tool", () => {
		const reg = new ToolRegistry();
		const tool = makeTool("TestTool");
		reg.register(tool);

		expect(reg.has("TestTool")).toBe(true);
		expect(reg.get("TestTool")).toBe(tool);
		expect(reg.size()).toBe(1);
	});

	it("should reject duplicate registration", () => {
		const reg = new ToolRegistry();
		reg.register(makeTool("TestTool"));

		expect(() => reg.register(makeTool("TestTool"))).toThrow(
			'Tool "TestTool" is already registered',
		);
	});

	it("should unregister a tool", () => {
		const reg = new ToolRegistry();
		reg.register(makeTool("TestTool"));
		reg.unregister("TestTool");

		expect(reg.has("TestTool")).toBe(false);
		expect(reg.size()).toBe(0);
	});

	it("should reject unregistering non-existent tool", () => {
		const reg = new ToolRegistry();
		expect(() => reg.unregister("Ghost")).toThrow('Tool "Ghost" is not registered');
	});

	it("should list all tools", () => {
		const reg = new ToolRegistry();
		reg.register(makeTool("A"));
		reg.register(makeTool("B"));
		reg.register(makeTool("C"));

		expect(reg.names()).toEqual(["A", "B", "C"]);
		expect(reg.getAll()).toHaveLength(3);
	});

	it("should clear all tools", () => {
		const reg = new ToolRegistry();
		reg.register(makeTool("A"));
		reg.register(makeTool("B"));
		reg.clear();

		expect(reg.size()).toBe(0);
	});
});
