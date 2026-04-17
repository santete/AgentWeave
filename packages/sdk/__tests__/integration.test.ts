/**
 * Integration tests — cross-module flows that exercise Inner + Outer + ControlPlane together.
 * These go beyond unit tests by verifying the full wiring works end-to-end.
 */

import { describe, it, expect } from "vitest";
import { z } from "zod";
import { createHarness, createMockLLMCaller } from "../src/index";
import type { ToolDefinition, InnerEvent, PluginManifest } from "@agentweave/types";

// ─── Test Helpers ───────────────────────────────────────────────

function makeTool(name: string, opts?: Partial<ToolDefinition["metadata"]>): ToolDefinition {
	return {
		name,
		description: `Tool: ${name}`,
		parameters: z.object({}).passthrough(),
		execute: async () => `result from ${name}`,
		metadata: {
			isReadOnly: opts?.isReadOnly ?? true,
			isDestructive: opts?.isDestructive ?? false,
			isConcurrencySafe: true,
			category: opts?.category ?? "file",
		},
	};
}

// ─── Integration Tests ──────────────────────────────────────────

describe("Integration: Full Flow", () => {
	it("prompt → tool call → permission allow → tool execute → output → complete", async () => {
		const harness = createHarness({
			model: "mock",
			tools: [makeTool("FileRead")],
			permissions: {
				mode: "default",
				rules: [
					{ pattern: "FileRead(*)", behavior: "allow", source: "project", priority: 50 },
				],
				failMode: "closed",
			},
			budget: { maxPerSession: 10 },
		});

		harness.setLLMCaller(createMockLLMCaller([
			{ toolCalls: [{ toolName: "FileRead", toolInput: { path: "test.ts" } }] },
			{ text: "File contents look good." },
		]));

		const { result, events } = await harness.run("Read the file");

		expect(result.reason).toBe("completed");

		// Verify full event sequence
		const types = events.map((e) => e.type);
		expect(types).toContain("turn:start");
		expect(types).toContain("tool:requested");
		expect(types).toContain("permission:allowed");
		expect(types).toContain("tool:completed");
		expect(types).toContain("message:assistant");
		expect(types).toContain("terminal");

		// Verify token tracking
		expect(harness.getUsage().inputTokens).toBeGreaterThan(0);

		// Verify audit log
		expect(harness.outer.getAuditLogger().size()).toBeGreaterThan(0);
	});

	it("prompt → tool call → permission DENY → error fed back → agent retries", async () => {
		const harness = createHarness({
			model: "mock",
			tools: [makeTool("Bash", { isDestructive: true }), makeTool("FileRead")],
			permissions: {
				mode: "default",
				rules: [
					{ pattern: "Bash(rm *)", behavior: "deny", source: "policy", priority: 100 },
					{ pattern: "FileRead(*)", behavior: "allow", source: "project", priority: 50 },
				],
				failMode: "closed",
			},
		});

		harness.setLLMCaller(createMockLLMCaller([
			// Turn 1: agent tries dangerous command → denied
			{ toolCalls: [{ toolName: "Bash", toolInput: { command: "rm -rf /" } }] },
			// Turn 2: agent retries with safe approach
			{ toolCalls: [{ toolName: "FileRead", toolInput: { path: "logs/" } }] },
			// Turn 3: done
			{ text: "Found the logs via FileRead instead." },
		]));

		const { result, events } = await harness.run("Delete the logs");

		expect(result.reason).toBe("completed");

		const denied = events.filter((e) => e.type === "permission:denied");
		expect(denied).toHaveLength(1);

		const allowed = events.filter((e) => e.type === "permission:allowed");
		expect(allowed).toHaveLength(1);
	});

	it("budget exceeded mid-session → terminal with budget_exceeded", async () => {
		const harness = createHarness({
			model: "mock",
			tools: [makeTool("FileRead")],
			permissions: { mode: "permissive" },
		});

		// Mock returns high token usage to blow budget
		harness.setLLMCaller(async () => ({
			toolCalls: [{ toolUseId: "t1", toolName: "FileRead", toolInput: {} }],
			stopReason: "tool_use",
			usage: { inputTokens: 50000, outputTokens: 20000 },
		}));

		// maxBudgetUsd is checked by AgentLoop's TokenCounter after each turn
		const { result } = await harness.run("Expensive task", { maxBudgetUsd: 0.001 });

		expect(result.reason).toBe("budget_exceeded");
	});
});

describe("Integration: Multi-Agent", () => {
	it("coordinator spawns worker → worker runs → messages exchanged", async () => {
		const harness = createHarness({
			model: "mock",
			multiAgent: { maxConcurrentAgents: 3, totalBudgetUsd: 20 },
			permissions: { mode: "permissive" },
		});
		harness.setLLMCaller(createMockLLMCaller([{ text: "Worker done." }]));

		// Spawn child
		const child = harness.spawnAgent({
			name: "research-worker",
			prompt: "Research auth patterns",
			budgetUsd: 5,
		});

		// Send instruction to child
		child.send("coordinator", "instruction", { task: "research" });
		const messages = child.receive();
		expect(messages).toHaveLength(1);
		expect(messages[0]!.type).toBe("instruction");

		// Run child
		const { result } = await child.run();
		expect(result.reason).toBe("completed");

		// Verify orchestrator state
		const orch = harness.getOrchestrator()!;
		expect(orch.getAgent(child.id)!.state).toBe("completed");
		expect(orch.getAgents()).toHaveLength(1);
	});

	it("two workers run in parallel with independent budgets", async () => {
		const harness = createHarness({
			model: "mock",
			multiAgent: { maxConcurrentAgents: 3, totalBudgetUsd: 20 },
			permissions: { mode: "permissive" },
		});

		const mockCaller = createMockLLMCaller([{ text: "Done." }]);

		const w1 = harness.spawnAgent({ name: "w1", prompt: "task 1", budgetUsd: 5 });
		const w2 = harness.spawnAgent({ name: "w2", prompt: "task 2", budgetUsd: 5 });

		w1.setLLMCaller(mockCaller);
		w2.setLLMCaller(createMockLLMCaller([{ text: "Also done." }]));

		// Run in parallel
		const [r1, r2] = await Promise.all([w1.run(), w2.run()]);

		expect(r1.result.reason).toBe("completed");
		expect(r2.result.reason).toBe("completed");

		const orch = harness.getOrchestrator()!;
		expect(orch.getAgents().filter((a) => a.state === "completed")).toHaveLength(2);
	});
});

describe("Integration: Plugin + Agent", () => {
	it("plugin tool is usable by agent in full flow", async () => {
		const customTool: ToolDefinition = {
			name: "Lint",
			description: "Run linter",
			parameters: z.object({}).passthrough(),
			execute: async () => "0 errors, 0 warnings",
			metadata: { isReadOnly: true, isDestructive: false, isConcurrencySafe: true, category: "custom" },
		};

		const plugin: PluginManifest = {
			name: "lint-plugin",
			version: "1.0.0",
			description: "Adds Lint tool",
			permissions: { tools: { register: ["Lint"] } },
			activate: async () => ({ tools: [customTool] }),
		};

		const harness = createHarness({
			model: "mock",
			permissions: {
				mode: "permissive",
				rules: [
					{ pattern: "Lint(*)", behavior: "allow", source: "project", priority: 50 },
				],
			},
			plugins: [plugin],
		});

		harness.setLLMCaller(createMockLLMCaller([
			{ toolCalls: [{ toolName: "Lint", toolInput: {} }] },
			{ text: "Lint passed with 0 errors." },
		]));

		const { result, events } = await harness.run("Run the linter");

		expect(result.reason).toBe("completed");
		const toolDone = events.find(
			(e) => e.type === "tool:completed",
		);
		expect(toolDone).toBeDefined();
	});
});
