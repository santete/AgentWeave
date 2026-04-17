import { describe, it, expect, afterEach } from "vitest";
import { MultiAgentOrchestrator } from "../src/orchestration/multi-agent-orchestrator";
import type { AgentLifecycleEvent } from "@agentweave/types";

const DEFAULT_CONFIG = {
	maxConcurrentAgents: 3,
	totalBudgetUsd: 20,
	conflictStrategy: "sequential" as const,
};

describe("MultiAgentOrchestrator", () => {
	let orch: MultiAgentOrchestrator;

	afterEach(() => {
		orch?.destroy();
	});

	// ─── Spawn ───────────────────────────────────────────────────

	describe("spawn", () => {
		it("should create an agent with pending state", () => {
			orch = new MultiAgentOrchestrator(DEFAULT_CONFIG);
			const agent = orch.spawn({ name: "worker-1", prompt: "do stuff" });

			expect(agent.name).toBe("worker-1");
			expect(agent.state).toBe("pending");
			expect(agent.parentId).toBeNull();
			expect(agent.id).toMatch(/^agent_/);
		});

		it("should track parent-child relationship", () => {
			orch = new MultiAgentOrchestrator(DEFAULT_CONFIG);
			const parent = orch.spawn({
				name: "coordinator",
				prompt: "coordinate",
				budgetUsd: 10,
			});
			const child = orch.spawn(
				{ name: "worker", prompt: "work", budgetUsd: 3 },
				parent.id,
			);

			expect(child.parentId).toBe(parent.id);
			const children = orch.getChildren(parent.id);
			expect(children).toHaveLength(1);
			expect(children[0].name).toBe("worker");
		});

		it("should reject when max concurrent agents reached", () => {
			orch = new MultiAgentOrchestrator({
				...DEFAULT_CONFIG,
				maxConcurrentAgents: 2,
			});
			orch.spawn({ name: "a1", prompt: "p" });
			orch.spawn({ name: "a2", prompt: "p" });

			expect(() => orch.spawn({ name: "a3", prompt: "p" })).toThrow(
				"Max concurrent agents (2) reached",
			);
		});

		it("should reject when total budget exceeded", () => {
			orch = new MultiAgentOrchestrator({
				...DEFAULT_CONFIG,
				totalBudgetUsd: 10,
			});
			orch.spawn({ name: "a1", prompt: "p", budgetUsd: 8 });

			expect(() =>
				orch.spawn({ name: "a2", prompt: "p", budgetUsd: 5 }),
			).toThrow("Budget overflow");
		});

		it("should reject when child budget exceeds parent remaining", () => {
			orch = new MultiAgentOrchestrator(DEFAULT_CONFIG);
			const parent = orch.spawn({
				name: "coord",
				prompt: "p",
				budgetUsd: 5,
			});
			// Parent allocated 5, used 0, children allocated 0 → remaining 5
			orch.addCost(parent.id, 3); // used 3 → remaining 2

			expect(() =>
				orch.spawn(
					{ name: "child", prompt: "p", budgetUsd: 3 },
					parent.id,
				),
			).toThrow("Child budget $3 exceeds parent remaining $2");
		});

		it("should clamp negative budgetUsd to 0", () => {
			orch = new MultiAgentOrchestrator(DEFAULT_CONFIG);
			const agent = orch.spawn({
				name: "w",
				prompt: "p",
				budgetUsd: -10,
			});
			expect(orch.getAgent(agent.id)!.budgetAllocated).toBe(0);
		});

		it("should treat undefined budgetUsd as 0 (unlimited)", () => {
			orch = new MultiAgentOrchestrator(DEFAULT_CONFIG);
			const agent = orch.spawn({ name: "w", prompt: "p" });
			expect(orch.getAgent(agent.id)!.budgetAllocated).toBe(0);
			expect(orch.canSpend(agent.id)).toBe(true);
		});

		it("should allow spawn after completed agents free concurrency slots", () => {
			orch = new MultiAgentOrchestrator({
				...DEFAULT_CONFIG,
				maxConcurrentAgents: 2,
			});
			const a1 = orch.spawn({ name: "a1", prompt: "p" });
			orch.spawn({ name: "a2", prompt: "p" });

			// Complete a1 → frees a slot
			orch.markRunning(a1.id);
			orch.markCompleted(a1.id);

			// Now a3 should succeed
			const a3 = orch.spawn({ name: "a3", prompt: "p" });
			expect(a3.state).toBe("pending");
		});
	});

	// ─── Lifecycle ───────────────────────────────────────────────

	describe("lifecycle", () => {
		it("should transition pending → running → completed", () => {
			orch = new MultiAgentOrchestrator(DEFAULT_CONFIG);
			const agent = orch.spawn({ name: "w", prompt: "p" });

			orch.markRunning(agent.id);
			expect(orch.getAgent(agent.id)!.state).toBe("running");
			expect(orch.getAgent(agent.id)!.startedAt).toBeDefined();

			orch.markCompleted(agent.id, { summary: "done" });
			const completed = orch.getAgent(agent.id)!;
			expect(completed.state).toBe("completed");
			expect(completed.result).toEqual({ summary: "done" });
			expect(completed.completedAt).toBeDefined();
		});

		it("should transition pending → failed", () => {
			orch = new MultiAgentOrchestrator(DEFAULT_CONFIG);
			const agent = orch.spawn({ name: "w", prompt: "p" });

			orch.markFailed(agent.id, "timeout");
			const failed = orch.getAgent(agent.id)!;
			expect(failed.state).toBe("failed");
			expect(failed.error).toBe("timeout");
		});

		it("should transition running → aborted", () => {
			orch = new MultiAgentOrchestrator(DEFAULT_CONFIG);
			const agent = orch.spawn({ name: "w", prompt: "p" });
			orch.markRunning(agent.id);

			orch.markAborted(agent.id);
			expect(orch.getAgent(agent.id)!.state).toBe("aborted");
		});

		it("should reject invalid state transitions", () => {
			orch = new MultiAgentOrchestrator(DEFAULT_CONFIG);
			const agent = orch.spawn({ name: "w", prompt: "p" });
			orch.markRunning(agent.id);
			orch.markCompleted(agent.id);

			expect(() => orch.markRunning(agent.id)).toThrow(
				"Cannot mark completed agent as running",
			);
			expect(() => orch.markAborted(agent.id)).toThrow(
				"Cannot mark completed agent as aborted",
			);
		});

		it("should reject markFailed on already-failed agent", () => {
			orch = new MultiAgentOrchestrator(DEFAULT_CONFIG);
			const agent = orch.spawn({ name: "w", prompt: "p" });
			orch.markFailed(agent.id, "first error");

			expect(() => orch.markFailed(agent.id, "second error")).toThrow(
				"Cannot mark failed agent as failed",
			);
		});

		it("should release locks when agent completes", async () => {
			orch = new MultiAgentOrchestrator(DEFAULT_CONFIG);
			const agent = orch.spawn({ name: "w", prompt: "p" });
			orch.markRunning(agent.id);

			await orch.getLockManager().acquire("file.ts", agent.id);
			expect(orch.getLockManager().isLocked("file.ts")).toBe(true);

			orch.markCompleted(agent.id);
			expect(orch.getLockManager().isLocked("file.ts")).toBe(false);
		});
	});

	// ─── Messaging ───────────────────────────────────────────────

	describe("messaging", () => {
		it("should send and receive messages", () => {
			orch = new MultiAgentOrchestrator(DEFAULT_CONFIG);
			const a1 = orch.spawn({ name: "coord", prompt: "p" });
			const a2 = orch.spawn({ name: "worker", prompt: "p" });

			orch.send(a1.id, a2.id, "instruction", { task: "research" });

			const messages = orch.receive(a2.id);
			expect(messages).toHaveLength(1);
			expect(messages[0].from).toBe(a1.id);
			expect(messages[0].type).toBe("instruction");
			expect(messages[0].payload).toEqual({ task: "research" });
		});

		it("should drain queue on receive", () => {
			orch = new MultiAgentOrchestrator(DEFAULT_CONFIG);
			const a1 = orch.spawn({ name: "a1", prompt: "p" });
			const a2 = orch.spawn({ name: "a2", prompt: "p" });

			orch.send(a1.id, a2.id, "result", "data-1");
			orch.send(a1.id, a2.id, "result", "data-2");

			const first = orch.receive(a2.id);
			expect(first).toHaveLength(2);

			const second = orch.receive(a2.id);
			expect(second).toHaveLength(0);
		});

		it("should peek without consuming", () => {
			orch = new MultiAgentOrchestrator(DEFAULT_CONFIG);
			const a1 = orch.spawn({ name: "a1", prompt: "p" });
			const a2 = orch.spawn({ name: "a2", prompt: "p" });

			orch.send(a1.id, a2.id, "status", "alive");
			expect(orch.peek(a2.id)).toHaveLength(1);
			expect(orch.peek(a2.id)).toHaveLength(1); // still there
		});

		it("should throw when sending to unknown agent", () => {
			orch = new MultiAgentOrchestrator(DEFAULT_CONFIG);
			const a1 = orch.spawn({ name: "a1", prompt: "p" });

			expect(() =>
				orch.send(a1.id, "nonexistent", "result", {}),
			).toThrow("Unknown agent");
		});
	});

	// ─── Budget ──────────────────────────────────────────────────

	describe("budget", () => {
		it("should track per-agent cost", () => {
			orch = new MultiAgentOrchestrator(DEFAULT_CONFIG);
			const agent = orch.spawn({
				name: "w",
				prompt: "p",
				budgetUsd: 5,
			});

			orch.addCost(agent.id, 2.5);
			expect(orch.getRemainingBudget(agent.id)).toBe(2.5);
			expect(orch.canSpend(agent.id)).toBe(true);

			orch.addCost(agent.id, 2.5);
			expect(orch.getRemainingBudget(agent.id)).toBe(0);
			expect(orch.canSpend(agent.id)).toBe(false);
		});

		it("should track total allocated and spent", () => {
			orch = new MultiAgentOrchestrator(DEFAULT_CONFIG);
			orch.spawn({ name: "a1", prompt: "p", budgetUsd: 5 });
			const a2 = orch.spawn({ name: "a2", prompt: "p", budgetUsd: 3 });

			expect(orch.getTotalAllocatedBudget()).toBe(8);

			orch.addCost(a2.id, 1);
			expect(orch.getTotalSpent()).toBe(1);
		});

		it("should ignore negative cost in addCost", () => {
			orch = new MultiAgentOrchestrator(DEFAULT_CONFIG);
			const agent = orch.spawn({
				name: "w",
				prompt: "p",
				budgetUsd: 5,
			});

			orch.addCost(agent.id, 2);
			orch.addCost(agent.id, -3); // ignored
			expect(orch.getRemainingBudget(agent.id)).toBe(3); // 5 - 2 = 3
		});

		it("should ignore NaN and Infinity cost in addCost", () => {
			orch = new MultiAgentOrchestrator(DEFAULT_CONFIG);
			const agent = orch.spawn({
				name: "w",
				prompt: "p",
				budgetUsd: 5,
			});

			orch.addCost(agent.id, NaN);
			orch.addCost(agent.id, Infinity);
			expect(orch.getRemainingBudget(agent.id)).toBe(5); // unchanged
		});

		it("should allow unlimited spend when budgetUsd is 0", () => {
			orch = new MultiAgentOrchestrator(DEFAULT_CONFIG);
			const agent = orch.spawn({ name: "w", prompt: "p", budgetUsd: 0 });

			orch.addCost(agent.id, 100);
			expect(orch.canSpend(agent.id)).toBe(true);
			expect(orch.getRemainingBudget(agent.id)).toBe(Infinity);
		});
	});

	// ─── Events ──────────────────────────────────────────────────

	describe("events", () => {
		it("should fire lifecycle events", () => {
			orch = new MultiAgentOrchestrator(DEFAULT_CONFIG);
			const events: AgentLifecycleEvent[] = [];
			orch.onAgentEvent("*", (e) => events.push(e));

			const agent = orch.spawn({ name: "w", prompt: "p" });
			orch.markRunning(agent.id);
			orch.markCompleted(agent.id, "done");

			expect(events).toHaveLength(3);
			expect(events[0].type).toBe("spawned");
			expect(events[1].type).toBe("running");
			expect(events[2].type).toBe("completed");
		});

		it("should fire events only for subscribed agent", () => {
			orch = new MultiAgentOrchestrator(DEFAULT_CONFIG);
			const a1 = orch.spawn({ name: "a1", prompt: "p" });
			const a2 = orch.spawn({ name: "a2", prompt: "p" });

			const events: AgentLifecycleEvent[] = [];
			orch.onAgentEvent(a1.id, (e) => events.push(e));

			orch.markRunning(a1.id);
			orch.markRunning(a2.id); // should not fire

			// a1 subscription was registered after spawn, so only running event
			expect(events).toHaveLength(1);
			expect(events[0].type).toBe("running");
		});

		it("should unsubscribe via returned function", () => {
			orch = new MultiAgentOrchestrator(DEFAULT_CONFIG);
			const events: AgentLifecycleEvent[] = [];
			const unsub = orch.onAgentEvent("*", (e) => events.push(e));

			orch.spawn({ name: "a1", prompt: "p" });
			unsub();
			orch.spawn({ name: "a2", prompt: "p" });

			expect(events).toHaveLength(1); // only a1's spawned event
		});

		it("should fire message events", () => {
			orch = new MultiAgentOrchestrator(DEFAULT_CONFIG);
			const events: AgentLifecycleEvent[] = [];
			const a1 = orch.spawn({ name: "a1", prompt: "p" });
			const a2 = orch.spawn({ name: "a2", prompt: "p" });

			orch.onAgentEvent(a2.id, (e) => events.push(e));
			orch.send(a1.id, a2.id, "instruction", "go");

			expect(events).toHaveLength(1);
			expect(events[0].type).toBe("message");
		});

		it("should not throw when listener errors", () => {
			orch = new MultiAgentOrchestrator(DEFAULT_CONFIG);
			orch.onAgentEvent("*", () => {
				throw new Error("boom");
			});

			// Should not throw despite listener error
			expect(() =>
				orch.spawn({ name: "w", prompt: "p" }),
			).not.toThrow();
		});
	});

	// ─── Queries ─────────────────────────────────────────────────

	describe("queries", () => {
		it("should list all agents", () => {
			orch = new MultiAgentOrchestrator(DEFAULT_CONFIG);
			orch.spawn({ name: "a1", prompt: "p" });
			orch.spawn({ name: "a2", prompt: "p" });
			expect(orch.getAgents()).toHaveLength(2);
		});

		it("should return undefined for unknown agent", () => {
			orch = new MultiAgentOrchestrator(DEFAULT_CONFIG);
			expect(orch.getAgent("nonexistent")).toBeUndefined();
		});

		it("should return copies (not references)", () => {
			orch = new MultiAgentOrchestrator(DEFAULT_CONFIG);
			const agent = orch.spawn({ name: "w", prompt: "p" });
			const copy = orch.getAgent(agent.id)!;
			copy.state = "completed";
			expect(orch.getAgent(agent.id)!.state).toBe("pending"); // unchanged
		});

		it("should return empty array for agent with no children", () => {
			orch = new MultiAgentOrchestrator(DEFAULT_CONFIG);
			const agent = orch.spawn({ name: "lone", prompt: "p" });
			expect(orch.getChildren(agent.id)).toEqual([]);
		});

		it("should return empty agents list after destroy", () => {
			orch = new MultiAgentOrchestrator(DEFAULT_CONFIG);
			orch.spawn({ name: "a1", prompt: "p" });
			orch.destroy();
			expect(orch.getAgents()).toHaveLength(0);
			expect(orch.getAgent("anything")).toBeUndefined();
		});

		it("should count running agents (pending + running)", () => {
			orch = new MultiAgentOrchestrator(DEFAULT_CONFIG);
			const a1 = orch.spawn({ name: "a1", prompt: "p" });
			orch.spawn({ name: "a2", prompt: "p" });
			expect(orch.getRunningCount()).toBe(2); // both pending

			orch.markRunning(a1.id);
			orch.markCompleted(a1.id);
			expect(orch.getRunningCount()).toBe(1); // a2 still pending
		});
	});
});
