/**
 * Budget management types: cost tracking, estimation, persistence, events.
 */

export interface BudgetConfig {
	maxPerSession?: number; // USD
	maxPerDay?: number; // USD
	warningThreshold: number; // 0.0 - 1.0 (e.g. 0.8 = warn at 80%)
	persistPath?: string; // File path for JSON persistence
}

export interface CostBreakdown {
	byTool: Record<string, number>; // toolName → USD
	byModel: Record<string, number>; // modelId → USD
}

export interface BudgetStatus {
	sessionCost: number;
	dailyCost: number;
	sessionLimit: number | undefined;
	dailyLimit: number | undefined;
	isWarning: boolean;
	isExceeded: boolean;
	remainingSession: number | undefined;
	remainingDaily: number | undefined;
	breakdown: CostBreakdown;
}

export interface CostEstimate {
	estimatedCost: number;
	wouldExceedSession: boolean;
	wouldExceedDaily: boolean;
	remainingAfter: {
		session: number | undefined;
		daily: number | undefined;
	};
}

export interface CostMetadata {
	toolName?: string;
	model?: string;
}

export type BudgetEventType = "budget:cost_added" | "budget:warning" | "budget:exceeded";

export interface BudgetEvent {
	type: BudgetEventType;
	sessionCost: number;
	dailyCost: number;
	delta?: number;
	toolName?: string;
	model?: string;
	timestamp: number;
}
