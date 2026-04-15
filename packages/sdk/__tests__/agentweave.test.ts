import { describe, it, expect } from "vitest";
import { z } from "zod";
import { createHarness, createMockLLMCaller, MockScenarios } from "../src/index";
import type { ToolDefinition, InnerEvent } from "@agentweave/types";

function makeReadTool(name: string): ToolDefinition {
	return {
		name,
		description: `Read tool: ${name}`,
		parameters: z.object({}).passthrough(),
		execute: async () => `content of ${name}`,
		metadata: {
			isReadOnly: true,
			isDestructive: false,
			isConcurrencySafe: true,
			category: "file",
		},
	};
}

describe("createHarness", () => {
	it("should create a harness instance with all components", () => {
		const harness = createHarness({ model: "mock" });

		expect(harness.inner).toBeDefined();
		expect(harness.outer).toBeDefined();
		expect(harness.run).toBeDefined();
		expect(harness.stream).toBeDefined();
		expect(harness.abort).toBeDefined();
		expect(harness.getState).toBeDefined();
		expect(harness.getUsage).toBeDefined();
	});

	it("should run a simple prompt and return result", async () => {
		const harness = createHarness({
			model: "mock",
			permissions: { mode: "permissive" },
		});
		harness.setLLMCaller(createMockLLMCaller(MockScenarios.simpleResponse));

		const { result, events } = await harness.run("Hello");

		expect(result.reason).toBe("completed");
		expect(events.length).toBeGreaterThan(0);

		const terminal = events.find((e) => e.type === "terminal");
		expect(terminal).toBeDefined();
	});

	it("should execute tools with permission allow", async () => {
		const harness = createHarness({
			model: "mock",
			tools: [makeReadTool("FileRead")],
			permissions: {
				mode: "permissive",
				rules: [
					{ pattern: "FileRead(*)", behavior: "allow", source: "project", priority: 50 },
				],
			},
		});
		harness.setLLMCaller(createMockLLMCaller(MockScenarios.readThenRespond));

		const { result, events } = await harness.run("Read a file");

		expect(result.reason).toBe("completed");

		const toolCompleted = events.find((e) => e.type === "tool:completed");
		expect(toolCompleted).toBeDefined();
	});

	it("should deny tools matching deny rule", async () => {
		const harness = createHarness({
			model: "mock",
			tools: [makeReadTool("Bash")],
			permissions: {
				mode: "permissive",
				rules: [
					{ pattern: "Bash(rm -rf *)", behavior: "deny", source: "policy", priority: 100 },
				],
			},
		});
		harness.setLLMCaller(createMockLLMCaller([
			{ toolCalls: [{ toolName: "Bash", toolInput: { command: "rm -rf /" } }] },
			{ text: "Denied, done." },
		]));

		const { events } = await harness.run("Delete everything");

		const denied = events.find((e) => e.type === "permission:denied");
		expect(denied).toBeDefined();
	});

	it("should filter secrets from output", async () => {
		const harness = createHarness({
			model: "mock",
			output: {
				gateMode: "batch",
				filters: [
					{ type: "secret", name: "secrets", patterns: [], replacement: "[SECRET]" },
				],
			},
			permissions: { mode: "permissive" },
		});
		harness.setLLMCaller(createMockLLMCaller([
			{ text: "Your API key is sk-1234567890abcdefghijklmnop" },
		]));

		const { events } = await harness.run("Show my key");

		// Output pipeline runs on terminal — check that the pipeline filtered
		const pipeline = harness.outer.getOutputPipeline();
		const filtered = pipeline.applyFilters("sk-1234567890abcdefghijklmnop");
		expect(filtered.text).toContain("[SECRET]");
	});

	it("should track token usage across the run", async () => {
		const harness = createHarness({
			model: "mock",
			tools: [makeReadTool("FileRead")],
			permissions: { mode: "permissive" },
		});
		harness.setLLMCaller(createMockLLMCaller(MockScenarios.readThenRespond));

		await harness.run("Read file");

		const usage = harness.getUsage();
		expect(usage.inputTokens).toBeGreaterThan(0);
		expect(usage.outputTokens).toBeGreaterThan(0);
	});

	it("should stream events in real-time", async () => {
		const harness = createHarness({
			model: "mock",
			permissions: { mode: "permissive" },
		});
		harness.setLLMCaller(createMockLLMCaller(MockScenarios.simpleResponse));

		const events: InnerEvent[] = [];
		const gen = harness.stream("Hello");

		for (;;) {
			const { value, done } = await gen.next();
			if (done) break;
			events.push(value);
		}

		expect(events.length).toBeGreaterThan(0);
		expect(events[0]!.type).toBe("turn:start");
	});

	it("should abort a running session", async () => {
		const harness = createHarness({
			model: "mock",
			tools: [makeReadTool("FileRead")],
			permissions: { mode: "permissive" },
		});

		harness.setLLMCaller(async () => {
			await new Promise((r) => setTimeout(r, 200));
			return {
				toolCalls: [{ toolUseId: "t1", toolName: "FileRead", toolInput: {} }],
				stopReason: "tool_use",
			};
		});

		setTimeout(() => harness.abort("test"), 50);

		const { result } = await harness.run("Do something long");
		expect(result.reason).toBe("aborted");
	});

	it("E2E: full flow — prompt -> tool -> permission -> filter -> complete", async () => {
		const harness = createHarness({
			model: "mock",
			tools: [makeReadTool("FileRead")],
			permissions: {
				mode: "default",
				rules: [
					{ pattern: "FileRead(*)", behavior: "allow", source: "project", priority: 50 },
				],
				failMode: "closed",
			},
			output: {
				gateMode: "batch",
				filters: [
					{ type: "pii", name: "pii", entities: ["email"], replacement: "[EMAIL]" },
				],
			},
			budget: { maxPerSession: 10, warningThreshold: 0.8 },
		});

		harness.setLLMCaller(createMockLLMCaller([
			{ toolCalls: [{ toolName: "FileRead", toolInput: { path: "config.ts" } }] },
			{ text: "Config file read. Contact admin@company.com for help." },
		]));

		const { result, events } = await harness.run("Read the config");

		// Should complete successfully
		expect(result.reason).toBe("completed");

		// Should have permission allowed
		const allowed = events.find((e) => e.type === "permission:allowed");
		expect(allowed).toBeDefined();

		// Should have tool completed
		const completed = events.find((e) => e.type === "tool:completed");
		expect(completed).toBeDefined();

		// Output pipeline should have filtered email
		const pipeline = harness.outer.getOutputPipeline();
		const filtered = pipeline.applyFilters("admin@company.com");
		expect(filtered.text).toBe("[EMAIL]");

		// Should have tracked usage
		expect(harness.getUsage().inputTokens).toBeGreaterThan(0);

		// Audit log should have entries
		const auditSize = harness.outer.getAuditLogger().size();
		expect(auditSize).toBeGreaterThan(0);
	});
});
