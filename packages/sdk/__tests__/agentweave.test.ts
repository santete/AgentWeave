import { describe, it, expect } from "vitest";
import { z } from "zod";
import { createHarness, createMockLLMCaller, MockScenarios } from "../src/index";
import type { ToolDefinition, InnerEvent, AgentLifecycleEvent, PluginManifest } from "@agentweave/types";

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

	// ─── Multi-Agent ─────────────────────────────────────────────

	describe("spawnAgent", () => {
		it("should throw if multiAgent not configured", () => {
			const harness = createHarness({ model: "mock" });
			expect(() =>
				harness.spawnAgent({ name: "w", prompt: "p" }),
			).toThrow("multiAgent not configured");
		});

		it("should return null orchestrator when not configured", () => {
			const harness = createHarness({ model: "mock" });
			expect(harness.getOrchestrator()).toBeNull();
		});

		it("should return orchestrator when configured", () => {
			const harness = createHarness({
				model: "mock",
				multiAgent: { maxConcurrentAgents: 3, totalBudgetUsd: 20 },
			});
			expect(harness.getOrchestrator()).not.toBeNull();
		});

		it("should spawn and run a child agent to completion", async () => {
			const harness = createHarness({
				model: "mock",
				multiAgent: { maxConcurrentAgents: 3, totalBudgetUsd: 20 },
				permissions: { mode: "permissive" },
			});
			harness.setLLMCaller(createMockLLMCaller(MockScenarios.simpleResponse));

			const child = harness.spawnAgent({
				name: "worker-1",
				prompt: "Do something",
				budgetUsd: 5,
			});

			expect(child.id).toMatch(/^agent_/);
			expect(child.name).toBe("worker-1");

			// Child inherits parent LLM caller
			const { result } = await child.run();

			expect(result.reason).toBe("completed");

			// Orchestrator should track completion
			const info = child.getInfo();
			expect(info.state).toBe("completed");
		});

		it("should enforce budget overflow on spawn", () => {
			const harness = createHarness({
				model: "mock",
				multiAgent: { maxConcurrentAgents: 5, totalBudgetUsd: 10 },
			});

			harness.spawnAgent({ name: "a1", prompt: "p", budgetUsd: 8 });
			expect(() =>
				harness.spawnAgent({ name: "a2", prompt: "p", budgetUsd: 5 }),
			).toThrow("Budget overflow");
		});

		it("should enforce max concurrent agents", () => {
			const harness = createHarness({
				model: "mock",
				multiAgent: { maxConcurrentAgents: 1, totalBudgetUsd: 50 },
			});

			harness.spawnAgent({ name: "a1", prompt: "p" });
			expect(() =>
				harness.spawnAgent({ name: "a2", prompt: "p" }),
			).toThrow("Max concurrent agents");
		});

		it("should support send/receive messages between agents", () => {
			const harness = createHarness({
				model: "mock",
				multiAgent: { maxConcurrentAgents: 3, totalBudgetUsd: 20 },
			});

			const a1 = harness.spawnAgent({ name: "coord", prompt: "p" });
			const a2 = harness.spawnAgent({ name: "worker", prompt: "p" });

			a2.send(a1.id, "instruction", { task: "research" });
			const messages = a2.receive();

			expect(messages).toHaveLength(1);
			expect(messages[0].from).toBe(a1.id);
			expect(messages[0].payload).toEqual({ task: "research" });
		});

		it("should abort child agent", async () => {
			const harness = createHarness({
				model: "mock",
				tools: [makeReadTool("FileRead")],
				multiAgent: { maxConcurrentAgents: 3, totalBudgetUsd: 20 },
				permissions: { mode: "permissive" },
			});

			const child = harness.spawnAgent({
				name: "slow",
				prompt: "Do something slow",
			});

			// LLM caller that keeps returning tool calls (keeps loop alive)
			child.setLLMCaller(async () => {
				await new Promise((r) => setTimeout(r, 200));
				return {
					toolCalls: [{ toolUseId: "t1", toolName: "FileRead", toolInput: {} }],
					stopReason: "tool_use",
				};
			});

			// Abort after 50ms
			setTimeout(() => child.abort("test"), 50);

			const { result } = await child.run();
			expect(result.reason).toBe("aborted");
			expect(child.getInfo().state).toBe("aborted");
		});

		it("should track agent lifecycle events via orchestrator", async () => {
			const harness = createHarness({
				model: "mock",
				multiAgent: { maxConcurrentAgents: 3, totalBudgetUsd: 20 },
				permissions: { mode: "permissive" },
			});
			harness.setLLMCaller(createMockLLMCaller(MockScenarios.simpleResponse));

			const events: AgentLifecycleEvent[] = [];
			harness.getOrchestrator()!.onAgentEvent("*", (e) => events.push(e));

			const child = harness.spawnAgent({ name: "w", prompt: "p" });
			await child.run();

			const types = events.map((e) => e.type);
			expect(types).toContain("spawned");
			expect(types).toContain("running");
			expect(types).toContain("completed");
		});
	});

	// ─── Plugins ─────────────────────────────────────────────────

	describe("plugins", () => {
		it("should load plugin and register its tools before first run", async () => {
			const pluginTool = makeReadTool("PluginGrep");
			const plugin: PluginManifest = {
				name: "grep-plugin",
				version: "1.0.0",
				description: "Adds PluginGrep tool",
				permissions: { tools: { register: ["PluginGrep"] } },
				activate: async () => ({ tools: [pluginTool] }),
			};

			const harness = createHarness({
				model: "mock",
				permissions: { mode: "permissive" },
				plugins: [plugin],
			});
			harness.setLLMCaller(createMockLLMCaller(MockScenarios.simpleResponse));

			// run() awaits pluginsReady — tools are registered before execution
			await harness.run("trigger plugin load");

			const tools = harness.inner.getTools();
			const found = tools.find((t) => t.name === "PluginGrep");
			expect(found).toBeDefined();
		});

		it("should report loaded plugins via getPlugins() after run", async () => {
			const plugin: PluginManifest = {
				name: "info-plugin",
				version: "2.0.0",
				description: "Just info",
				activate: async () => ({}),
			};

			const harness = createHarness({
				model: "mock",
				permissions: { mode: "permissive" },
				plugins: [plugin],
			});
			harness.setLLMCaller(createMockLLMCaller(MockScenarios.simpleResponse));

			// run() awaits pluginsReady
			await harness.run("trigger");

			const loaded = harness.getPlugins();
			expect(loaded).toHaveLength(1);
			expect(loaded[0]!.manifest.name).toBe("info-plugin");
		});

		it("should run agent using plugin-registered tool", async () => {
			const pluginTool: ToolDefinition = {
				name: "EchoTool",
				description: "Echoes input",
				parameters: z.object({}).passthrough(),
				execute: async () => "echoed!",
				metadata: { isReadOnly: true, isDestructive: false, isConcurrencySafe: true, category: "custom" },
			};

			const plugin: PluginManifest = {
				name: "echo-plugin",
				version: "1.0.0",
				description: "Echo plugin",
				permissions: { tools: { register: ["EchoTool"] } },
				activate: async () => ({ tools: [pluginTool] }),
			};

			const harness = createHarness({
				model: "mock",
				tools: [],
				permissions: { mode: "permissive" },
				plugins: [plugin],
			});

			await new Promise((r) => setTimeout(r, 50));

			harness.setLLMCaller(createMockLLMCaller([
				{ toolCalls: [{ toolName: "EchoTool", toolInput: {} }] },
				{ text: "Done with echo." },
			]));

			const { result, events } = await harness.run("Use echo");
			expect(result.reason).toBe("completed");

			const completed = events.find((e) => e.type === "tool:completed");
			expect(completed).toBeDefined();
		});

		it("should work with no plugins configured", () => {
			const harness = createHarness({ model: "mock" });
			expect(harness.getPlugins()).toHaveLength(0);
		});
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
