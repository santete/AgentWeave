/**
 * BudgetManager — Tracks spending and enforces budget limits.
 * Supports per-session and per-day limits with warning thresholds.
 */

export interface BudgetConfig {
	maxPerSession?: number; // USD
	maxPerDay?: number; // USD
	warningThreshold: number; // 0.0 - 1.0 (e.g. 0.8 = warn at 80%)
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
}

export class BudgetManager {
	private sessionCost = 0;
	private dailyCost = 0;
	private config: BudgetConfig;

	constructor(config: BudgetConfig) {
		this.config = config;
	}

	/** Record cost from a turn/tool execution. */
	addCost(usd: number): void {
		this.sessionCost += usd;
		this.dailyCost += usd;
	}

	/** Check if the agent can proceed (not exceeded). */
	canProceed(): boolean {
		if (
			this.config.maxPerSession !== undefined &&
			this.sessionCost >= this.config.maxPerSession
		) {
			return false;
		}
		if (
			this.config.maxPerDay !== undefined &&
			this.dailyCost >= this.config.maxPerDay
		) {
			return false;
		}
		return true;
	}

	/** Check if we're in warning territory. */
	isWarning(): boolean {
		if (this.config.maxPerSession !== undefined) {
			const pct = this.sessionCost / this.config.maxPerSession;
			if (pct >= this.config.warningThreshold) return true;
		}
		if (this.config.maxPerDay !== undefined) {
			const pct = this.dailyCost / this.config.maxPerDay;
			if (pct >= this.config.warningThreshold) return true;
		}
		return false;
	}

	/** Check if budget is exceeded. */
	isExceeded(): boolean {
		return !this.canProceed();
	}

	/** Get full budget status. */
	getStatus(): BudgetStatus {
		return {
			sessionCost: this.sessionCost,
			dailyCost: this.dailyCost,
			sessionLimit: this.config.maxPerSession,
			dailyLimit: this.config.maxPerDay,
			isWarning: this.isWarning(),
			isExceeded: this.isExceeded(),
			remainingSession:
				this.config.maxPerSession !== undefined
					? Math.max(0, this.config.maxPerSession - this.sessionCost)
					: undefined,
			remainingDaily:
				this.config.maxPerDay !== undefined
					? Math.max(0, this.config.maxPerDay - this.dailyCost)
					: undefined,
		};
	}

	/** Reset session cost (new session). */
	resetSession(): void {
		this.sessionCost = 0;
	}

	/** Reset daily cost (new day). */
	resetDaily(): void {
		this.dailyCost = 0;
	}

	getSessionCost(): number {
		return this.sessionCost;
	}

	getDailyCost(): number {
		return this.dailyCost;
	}
}
