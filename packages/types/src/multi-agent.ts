/**
 * Multi-agent types: orchestration, lifecycle, messaging, budget inheritance.
 * Used by MultiAgentOrchestrator in outer-harness.
 */

import type { PermissionMode, PermissionRule } from "./permissions";

// ─── Agent Lifecycle ────────────────────────────────────────────

export type AgentState =
	| "pending" // Spawned, resources not yet ready
	| "running" // Actively executing
	| "completed" // Finished successfully
	| "failed" // Error or unrecoverable failure
	| "aborted"; // Explicitly aborted

// ─── Agent Configuration ────────────────────────────────────────

export interface AgentSpawnConfig {
	/** Unique name for this agent (used in messages). */
	name: string;
	/** Prompt to execute. */
	prompt: string;
	/** LLM model override. */
	model?: string;
	/** Max turns before auto-stop. */
	maxTurns?: number;
	/** Budget in USD allocated to this agent. */
	budgetUsd?: number;
	/** Timeout for the entire agent run (ms). */
	timeoutMs?: number;
	/** Permission scope — cannot exceed parent. */
	permissions?: {
		mode?: PermissionMode;
		rules?: PermissionRule[];
	};
	/** Tool names this agent can use. */
	tools?: string[];
	/** Agent ID to send results to. */
	reportTo?: string;
	/** Share conversation history with parent (default false). */
	shareContext?: boolean;
}

// ─── Agent Info (tracked by orchestrator) ───────────────────────

export interface AgentInfo {
	id: string;
	name: string;
	parentId: string | null;
	state: AgentState;
	model: string;
	budgetAllocated: number;
	budgetUsed: number;
	startedAt?: number;
	completedAt?: number;
	result?: unknown;
	error?: string;
}

// ─── Inter-Agent Messaging ──────────────────────────────────────

export type AgentMessageType = "instruction" | "result" | "status" | "error";

export interface AgentMessage {
	id: string;
	from: string;
	to: string;
	type: AgentMessageType;
	payload: unknown;
	timestamp: number;
}

// ─── Multi-Agent Configuration ──────────────────────────────────

export interface MultiAgentConfig {
	/** Max agents running concurrently. */
	maxConcurrentAgents: number;
	/** Total budget across all agents (USD). */
	totalBudgetUsd: number;
	/** File conflict strategy (MVP: sequential only). */
	conflictStrategy: "sequential";
}

// ─── Agent Lifecycle Events ─────────────────────────────────────

export type AgentLifecycleEvent =
	| { type: "spawned"; agent: AgentInfo }
	| { type: "running"; agentId: string }
	| { type: "completed"; agentId: string; result?: unknown }
	| { type: "failed"; agentId: string; error: string }
	| { type: "aborted"; agentId: string }
	| { type: "message"; message: AgentMessage };
