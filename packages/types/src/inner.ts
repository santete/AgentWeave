/**
 * Inner Harness Provider interface.
 * Any Inner Harness (custom, Claude Code adapter, etc.) MUST implement this.
 * Outer Harness only knows Inner through this contract.
 */

import type { ContentBlock, InjectableMessage, Message } from "./messages";
import type { InnerEvent, TerminalResult } from "./events";
import type { ToolDefinition } from "./tools";
import type { ContextUsage, TokenUsage } from "./metrics";

export interface InnerHarnessProvider {
	/** Run the agent. Yields events for the Control Plane. */
	run(
		prompt: string | ContentBlock[],
		options?: RunOptions,
	): AsyncGenerator<InnerEvent, TerminalResult, void>;

	/** Abort the agent loop immediately. */
	abort(reason?: string): void;

	/** Read-only state queries. */
	getState(): InnerState;
	getMessages(): ReadonlyArray<Message>;
	getContextUsage(): ContextUsage;
	getUsage(): TokenUsage;
	getTools(): ReadonlyArray<ToolDefinition>;

	/** Runtime modifications. */
	registerTool(tool: ToolDefinition): void;
	unregisterTool(name: string): void;
	injectMessage(message: InjectableMessage): void;
	setSystemPromptSection(name: string, content: string | null): void;
	setModel(model: string): void;
	getConfig(): InnerConfig;
}

export interface RunOptions {
	model?: string;
	maxTurns?: number;
	maxBudgetUsd?: number;
	maxTokens?: number;
	timeoutMs?: number;
	initialMessages?: Message[];
	signal?: AbortSignal;
}

export interface InnerState {
	status: "idle" | "running" | "paused" | "completed" | "aborted" | "error";
	turnIndex: number;
	model: string;
	usage: TokenUsage;
	contextUsage: ContextUsage;
	activeTool: { name: string; toolUseId: string } | null;
	messageCount: number;
	recoveryAttempts: number;
}

export interface InnerConfig {
	model: string;
	fallbackModel?: string;
	maxTurns: number;
	thinkingEnabled: boolean;
	tools: string[];
}
