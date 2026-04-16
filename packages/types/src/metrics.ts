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

// ─── Monitoring Metrics (Phase 2) ────────────────────────────────

export interface ToolMetrics {
	toolName: string;
	callCount: number;
	successCount: number;
	errorCount: number;
	totalDurationMs: number;
	avgDurationMs: number;
}

export interface TurnMetrics {
	turnIndex: number;
	durationMs: number;
	inputTokens: number;
	outputTokens: number;
	cost: number;
	toolCallCount: number;
	model: string;
}

export interface MonitorSnapshot {
	sessionId: string;
	timestamp: number;
	turnCount: number;
	totalUsage: TokenUsage;
	turnMetrics: TurnMetrics[];
	toolMetrics: Map<string, ToolMetrics>;
	errorCount: number;
	permissionDeniedCount: number;
	sessionDurationMs: number;
}

// ─── Alert Types (Phase 2) ──────────────────────────────────────

export type AlertSeverity = "info" | "warning" | "critical";

export interface AlertRule {
	name: string;
	severity: AlertSeverity;
	/** Cooldown in ms — don't fire again within this window */
	cooldownMs: number;
	/** Check function receives the current snapshot */
	check: (snapshot: MonitorSnapshot) => boolean;
	message?: string;
}

export interface AlertEvent {
	ruleId: string;
	ruleName: string;
	severity: AlertSeverity;
	message: string;
	timestamp: number;
	sessionId: string;
	snapshot: MonitorSnapshot;
}
