/**
 * MonitorCollector — Aggregates InnerEvents into real-time metrics.
 * Tracks per-turn, per-tool, and per-session metrics.
 */

import type {
	InnerEvent,
	TokenUsage,
	ToolMetrics,
	TurnMetrics,
	MonitorSnapshot,
} from "@agentweave/types";
import { createEmptyTokenUsage } from "@agentweave/types";

export class MonitorCollector {
	private sessionId = "";
	private startTime = 0;
	private totalUsage: TokenUsage = createEmptyTokenUsage();
	private turnMetrics: TurnMetrics[] = [];
	private toolMetrics = new Map<string, ToolMetrics>();
	private errorCount = 0;
	private permissionDeniedCount = 0;
	private turnCount = 0;

	// Tracking current turn
	private currentTurnStart = 0;
	private currentTurnIndex = 0;
	private currentTurnTokens = { input: 0, output: 0 };
	private currentTurnCost = 0;
	private currentTurnToolCalls = 0;
	private currentTurnModel = "";

	setSessionId(sessionId: string): void {
		this.sessionId = sessionId;
		this.startTime = Date.now();
	}

	collect(event: InnerEvent): void {
		switch (event.type) {
			case "turn:start":
				this.currentTurnStart = event.timestamp;
				this.currentTurnIndex = event.turnIndex;
				this.currentTurnTokens = { input: 0, output: 0 };
				this.currentTurnCost = 0;
				this.currentTurnToolCalls = 0;
				this.turnCount = event.turnIndex;
				break;

			case "llm:stream_end":
				this.totalUsage = { ...event.usage };
				this.currentTurnTokens.input += event.usage.inputTokens;
				this.currentTurnTokens.output += event.usage.outputTokens;
				this.currentTurnCost = event.usage.totalCost;
				this.currentTurnModel = event.stopReason; // will be overwritten
				break;

			case "llm:request_start":
				this.currentTurnModel = event.model;
				break;

			case "tool:completed":
				this.currentTurnToolCalls++;
				this.updateToolMetrics(event.toolUseId, event.durationMs, false);
				break;

			case "tool:failed":
				this.currentTurnToolCalls++;
				this.errorCount++;
				this.updateToolMetrics(event.toolUseId, event.durationMs, true);
				break;

			case "tool:requested":
				this.ensureToolEntry(event.toolName);
				// Tag the toolUseId -> toolName for later lookup
				this.toolUseIdMap.set(event.toolUseId, event.toolName);
				break;

			case "permission:denied":
				this.permissionDeniedCount++;
				break;

			case "turn:end":
				this.turnMetrics.push({
					turnIndex: this.currentTurnIndex,
					durationMs: event.timestamp - this.currentTurnStart,
					inputTokens: this.currentTurnTokens.input,
					outputTokens: this.currentTurnTokens.output,
					cost: this.currentTurnCost,
					toolCallCount: this.currentTurnToolCalls,
					model: this.currentTurnModel,
				});
				break;

			case "error":
				this.errorCount++;
				break;
		}
	}

	getSnapshot(): MonitorSnapshot {
		return {
			sessionId: this.sessionId,
			timestamp: Date.now(),
			turnCount: this.turnCount,
			totalUsage: { ...this.totalUsage },
			turnMetrics: [...this.turnMetrics],
			toolMetrics: new Map(this.toolMetrics),
			errorCount: this.errorCount,
			permissionDeniedCount: this.permissionDeniedCount,
			sessionDurationMs: this.startTime > 0 ? Date.now() - this.startTime : 0,
		};
	}

	getTurnCount(): number {
		return this.turnCount;
	}

	getErrorCount(): number {
		return this.errorCount;
	}

	getToolMetrics(toolName: string): ToolMetrics | undefined {
		return this.toolMetrics.get(toolName);
	}

	getAllToolMetrics(): Map<string, ToolMetrics> {
		return new Map(this.toolMetrics);
	}

	reset(): void {
		this.totalUsage = createEmptyTokenUsage();
		this.turnMetrics = [];
		this.toolMetrics.clear();
		this.toolUseIdMap.clear();
		this.errorCount = 0;
		this.permissionDeniedCount = 0;
		this.turnCount = 0;
		this.startTime = Date.now();
	}

	// ─── Internal ────────────────────────────────────────────────

	private toolUseIdMap = new Map<string, string>(); // toolUseId -> toolName

	private ensureToolEntry(toolName: string): void {
		if (!this.toolMetrics.has(toolName)) {
			this.toolMetrics.set(toolName, {
				toolName,
				callCount: 0,
				successCount: 0,
				errorCount: 0,
				totalDurationMs: 0,
				avgDurationMs: 0,
			});
		}
	}

	private updateToolMetrics(
		toolUseId: string,
		durationMs: number,
		isError: boolean,
	): void {
		const toolName = this.toolUseIdMap.get(toolUseId);
		if (!toolName) return;

		this.ensureToolEntry(toolName);
		const metrics = this.toolMetrics.get(toolName)!;
		metrics.callCount++;
		metrics.totalDurationMs += durationMs;
		metrics.avgDurationMs = metrics.totalDurationMs / metrics.callCount;
		if (isError) {
			metrics.errorCount++;
		} else {
			metrics.successCount++;
		}
	}
}
