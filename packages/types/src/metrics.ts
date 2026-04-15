/**
 * Token usage, cost tracking, and context utilization metrics.
 */

export interface TokenUsage {
	inputTokens: number;
	outputTokens: number;
	thinkingTokens: number;
	cacheReadTokens: number;
	cacheCreationTokens: number;
	totalCost: number; // USD
}

export interface ContextUsage {
	usedTokens: number;
	maxTokens: number;
	/** 0.0 - 1.0 */
	pct: number;
	compactionCount: number;
}

export interface SessionMetrics {
	sessionId: string;
	startTime: number;
	endTime?: number;
	turnCount: number;
	toolCallCount: number;
	totalUsage: TokenUsage;
	contextUsage: ContextUsage;
	errors: number;
}

export function createEmptyTokenUsage(): TokenUsage {
	return {
		inputTokens: 0,
		outputTokens: 0,
		thinkingTokens: 0,
		cacheReadTokens: 0,
		cacheCreationTokens: 0,
		totalCost: 0,
	};
}

export function createEmptyContextUsage(maxTokens: number): ContextUsage {
	return {
		usedTokens: 0,
		maxTokens,
		pct: 0,
		compactionCount: 0,
	};
}
