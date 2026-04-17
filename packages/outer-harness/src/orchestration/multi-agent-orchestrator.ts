/**
 * MultiAgentOrchestrator — Manages agent lifecycle, messaging, and budget
 * for multi-agent coordination. Does NOT create InnerHarness instances
 * (that's the SDK's responsibility via the dependency graph constraint).
 */

import { randomUUID } from "node:crypto";
import type {
	AgentSpawnConfig,
	AgentInfo,
	AgentMessage,
	AgentLifecycleEvent,
	MultiAgentConfig,
} from "@agentweave/types";
import { LockManager } from "./lock-manager";

export class MultiAgentOrchestrator {
	private agents = new Map<string, AgentInfo>();
	private messageQueues = new Map<string, AgentMessage[]>();
	private listeners: Array<{
		agentId: string | "*";
		handler: (event: AgentLifecycleEvent) => void;
	}> = [];
	private lockManager: LockManager;
	private config: MultiAgentConfig;

	constructor(config: MultiAgentConfig) {
		this.config = config;
		this.lockManager = new LockManager();
	}

	// ─── Spawn ───────────────────────────────────────────────────

	/**
	 * Register a new agent. Validates budget and concurrency limits.
	 * Returns the AgentInfo with a generated ID. The caller (SDK) is
	 * responsible for creating the actual InnerHarness and running it.
	 */
	spawn(config: AgentSpawnConfig, parentId?: string): AgentInfo {
		// Validate concurrent limit
		const runningCount = this.getRunningCount();
		if (runningCount >= this.config.maxConcurrentAgents) {
			throw new Error(
				`Max concurrent agents (${this.config.maxConcurrentAgents}) reached`,
			);
		}

		// Validate budget (clamp negative to 0)
		const requestedBudget = Math.max(0, config.budgetUsd ?? 0);
		const totalAllocated = this.getTotalAllocatedBudget();
		if (totalAllocated + requestedBudget > this.config.totalBudgetUsd) {
			throw new Error(
				`Budget overflow: requesting $${requestedBudget}, ` +
					`already allocated $${totalAllocated} of $${this.config.totalBudgetUsd} total`,
			);
		}

		// If parent specified, validate child budget fits within parent remaining
		if (parentId) {
			const parent = this.agents.get(parentId);
			if (parent) {
				const parentRemaining =
					parent.budgetAllocated - parent.budgetUsed - this.getChildrenAllocated(parentId);
				if (requestedBudget > parentRemaining) {
					throw new Error(
						`Child budget $${requestedBudget} exceeds parent remaining $${parentRemaining}`,
					);
				}
			}
		}

		const agent: AgentInfo = {
			id: `agent_${randomUUID().slice(0, 8)}`,
			name: config.name,
			parentId: parentId ?? null,
			state: "pending",
			model: config.model ?? "claude-sonnet-4-6",
			budgetAllocated: requestedBudget,
			budgetUsed: 0,
		};

		this.agents.set(agent.id, agent);
		this.messageQueues.set(agent.id, []);
		this.emit({ type: "spawned", agent: { ...agent } });

		return { ...agent };
	}

	// ─── Lifecycle State Machine ─────────────────────────────────

	markRunning(agentId: string): void {
		const agent = this.requireAgent(agentId);
		if (agent.state !== "pending") {
			throw new Error(`Cannot mark ${agent.state} agent as running`);
		}
		agent.state = "running";
		agent.startedAt = Date.now();
		this.emit({ type: "running", agentId });
	}

	markCompleted(agentId: string, result?: unknown): void {
		const agent = this.requireAgent(agentId);
		if (agent.state !== "running") {
			throw new Error(`Cannot mark ${agent.state} agent as completed`);
		}
		agent.state = "completed";
		agent.completedAt = Date.now();
		agent.result = result;
		this.lockManager.releaseAll(agentId);
		this.emit({ type: "completed", agentId, result });
	}

	markFailed(agentId: string, error: string): void {
		const agent = this.requireAgent(agentId);
		if (agent.state !== "pending" && agent.state !== "running") {
			throw new Error(`Cannot mark ${agent.state} agent as failed`);
		}
		agent.state = "failed";
		agent.completedAt = Date.now();
		agent.error = error;
		this.lockManager.releaseAll(agentId);
		this.emit({ type: "failed", agentId, error });
	}

	markAborted(agentId: string): void {
		const agent = this.requireAgent(agentId);
		if (agent.state !== "pending" && agent.state !== "running") {
			throw new Error(`Cannot mark ${agent.state} agent as aborted`);
		}
		agent.state = "aborted";
		agent.completedAt = Date.now();
		this.lockManager.releaseAll(agentId);
		this.emit({ type: "aborted", agentId });
	}

	// ─── Messaging ───────────────────────────────────────────────

	/** Send a message to an agent's queue. */
	send(from: string, to: string, type: AgentMessage["type"], payload: unknown): void {
		const queue = this.messageQueues.get(to);
		if (!queue) {
			throw new Error(`Unknown agent: ${to}`);
		}

		const message: AgentMessage = {
			id: randomUUID(),
			from,
			to,
			type,
			payload,
			timestamp: Date.now(),
		};

		queue.push(message);
		this.emit({ type: "message", message: { ...message } });
	}

	/** Drain and return all pending messages for an agent. */
	receive(agentId: string): AgentMessage[] {
		const queue = this.messageQueues.get(agentId);
		if (!queue) return [];
		const messages = [...queue];
		queue.length = 0;
		return messages;
	}

	/** Peek at pending messages without consuming them. */
	peek(agentId: string): ReadonlyArray<AgentMessage> {
		return this.messageQueues.get(agentId) ?? [];
	}

	// ─── Budget ──────────────────────────────────────────────────

	/** Record cost spent by an agent. Ignores negative/NaN values. */
	addCost(agentId: string, cost: number): void {
		if (cost < 0 || !Number.isFinite(cost)) return;
		const agent = this.requireAgent(agentId);
		agent.budgetUsed += cost;
	}

	/** Check if agent can still spend. */
	canSpend(agentId: string): boolean {
		const agent = this.agents.get(agentId);
		if (!agent) return false;
		if (agent.budgetAllocated === 0) return true; // no limit
		return agent.budgetUsed < agent.budgetAllocated;
	}

	/** Get remaining budget for an agent. */
	getRemainingBudget(agentId: string): number {
		const agent = this.agents.get(agentId);
		if (!agent) return 0;
		if (agent.budgetAllocated === 0) return Infinity;
		return Math.max(0, agent.budgetAllocated - agent.budgetUsed);
	}

	/** Get total allocated budget across all agents. */
	getTotalAllocatedBudget(): number {
		let total = 0;
		for (const agent of this.agents.values()) {
			total += agent.budgetAllocated;
		}
		return total;
	}

	/** Get total spent across all agents. */
	getTotalSpent(): number {
		let total = 0;
		for (const agent of this.agents.values()) {
			total += agent.budgetUsed;
		}
		return total;
	}

	// ─── Queries ─────────────────────────────────────────────────

	getAgent(agentId: string): AgentInfo | undefined {
		const agent = this.agents.get(agentId);
		return agent ? { ...agent } : undefined;
	}

	getAgents(): AgentInfo[] {
		return [...this.agents.values()].map((a) => ({ ...a }));
	}

	getChildren(parentId: string): AgentInfo[] {
		return [...this.agents.values()]
			.filter((a) => a.parentId === parentId)
			.map((a) => ({ ...a }));
	}

	getRunningCount(): number {
		let count = 0;
		for (const agent of this.agents.values()) {
			if (agent.state === "pending" || agent.state === "running") count++;
		}
		return count;
	}

	// ─── Events ──────────────────────────────────────────────────

	/** Subscribe to agent lifecycle events. Use '*' for all agents. */
	onAgentEvent(
		agentId: string | "*",
		handler: (event: AgentLifecycleEvent) => void,
	): () => void {
		const entry = { agentId, handler };
		this.listeners.push(entry);
		return () => {
			const idx = this.listeners.indexOf(entry);
			if (idx >= 0) this.listeners.splice(idx, 1);
		};
	}

	// ─── Lock Manager ────────────────────────────────────────────

	getLockManager(): LockManager {
		return this.lockManager;
	}

	// ─── Cleanup ─────────────────────────────────────────────────

	destroy(): void {
		this.lockManager.destroy();
		this.listeners.length = 0;
		this.messageQueues.clear();
		this.agents.clear();
	}

	// ─── Internal ────────────────────────────────────────────────

	private requireAgent(agentId: string): AgentInfo {
		const agent = this.agents.get(agentId);
		if (!agent) throw new Error(`Unknown agent: ${agentId}`);
		return agent;
	}

	private getChildrenAllocated(parentId: string): number {
		let total = 0;
		for (const agent of this.agents.values()) {
			if (agent.parentId === parentId) total += agent.budgetAllocated;
		}
		return total;
	}

	private emit(event: AgentLifecycleEvent): void {
		const agentId =
			event.type === "spawned"
				? event.agent.id
				: event.type === "message"
					? event.message.to
					: event.agentId;

		for (const listener of this.listeners) {
			if (listener.agentId === "*" || listener.agentId === agentId) {
				try {
					listener.handler(event);
				} catch {
					// Non-blocking: never throw from event dispatch
				}
			}
		}
	}
}
