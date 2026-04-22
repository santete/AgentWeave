/**
 * BudgetManager — Tracks spending and enforces budget limits.
 *
 * Product-grade features:
 * - Per-session and per-day limits with warning thresholds
 * - Per-tool and per-model cost breakdown tracking
 * - Cost estimation (pre-check before LLM call)
 * - File-based persistence (daily costs survive restarts)
 * - Event emission on threshold crossings (warning, exceeded)
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type {
	BudgetConfig,
	BudgetStatus,
	CostBreakdown,
	CostEstimate,
	CostMetadata,
	BudgetEvent,
} from "@agentweave/types";

// Re-export types for backward compatibility
export type { BudgetConfig, BudgetStatus } from "@agentweave/types";

// ─── Persisted State ────────────────────────────────────────────

interface PersistedState {
	dailyCost: number;
	dailyDate: string; // "YYYY-MM-DD"
	costByTool: Record<string, number>;
	costByModel: Record<string, number>;
}

// ─── BudgetManager ──────────────────────────────────────────────

const FLUSH_DEBOUNCE_MS = 5_000;

export class BudgetManager {
	private sessionCost = 0;
	private dailyCost = 0;
	private config: BudgetConfig;

	// Cost breakdown
	private costByTool = new Map<string, number>();
	private costByModel = new Map<string, number>();

	// Session-only breakdown (reset on resetSession)
	private sessionCostByTool = new Map<string, number>();
	private sessionCostByModel = new Map<string, number>();

	// Event listeners
	private listeners: Array<(event: BudgetEvent) => void> = [];
	private wasWarning = false;
	private wasExceeded = false;

	// Persistence
	private flushTimer: ReturnType<typeof setTimeout> | null = null;
	private persistDirty = false;

	constructor(config: BudgetConfig) {
		this.config = config;
	}

	/** Record cost from a turn/tool execution. */
	addCost(usd: number, metadata?: CostMetadata): void {
		if (usd <= 0 || !Number.isFinite(usd)) return;

		this.sessionCost += usd;
		this.dailyCost += usd;

		// Track breakdown
		if (metadata?.toolName) {
			this.costByTool.set(metadata.toolName, (this.costByTool.get(metadata.toolName) ?? 0) + usd);
			this.sessionCostByTool.set(metadata.toolName, (this.sessionCostByTool.get(metadata.toolName) ?? 0) + usd);
		}
		if (metadata?.model) {
			this.costByModel.set(metadata.model, (this.costByModel.get(metadata.model) ?? 0) + usd);
			this.sessionCostByModel.set(metadata.model, (this.sessionCostByModel.get(metadata.model) ?? 0) + usd);
		}

		// Emit cost_added
		this.emitEvent({ type: "budget:cost_added", delta: usd, toolName: metadata?.toolName, model: metadata?.model });

		// Threshold crossing events (emit only on transition)
		if (!this.wasWarning && this.isWarning()) {
			this.wasWarning = true;
			this.emitEvent({ type: "budget:warning" });
		}
		if (!this.wasExceeded && this.isExceeded()) {
			this.wasExceeded = true;
			this.emitEvent({ type: "budget:exceeded" });
		}

		// Schedule persistence flush
		if (this.config.persistPath) {
			this.schedulePersistFlush();
		}
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

	/** Get full budget status with breakdown. */
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
			breakdown: this.getBreakdown(),
		};
	}

	// ─── Cost Breakdown ─────────────────────────────────────────

	getBreakdown(): CostBreakdown {
		return {
			byTool: Object.fromEntries(this.costByTool),
			byModel: Object.fromEntries(this.costByModel),
		};
	}

	// ─── Cost Estimation ────────────────────────────────────────

	/** Pre-check: would spending this amount exceed any limit? */
	estimateCost(estimatedUsd: number): CostEstimate {
		const afterSession = this.sessionCost + estimatedUsd;
		const afterDaily = this.dailyCost + estimatedUsd;

		return {
			estimatedCost: estimatedUsd,
			wouldExceedSession:
				this.config.maxPerSession !== undefined && afterSession > this.config.maxPerSession,
			wouldExceedDaily:
				this.config.maxPerDay !== undefined && afterDaily > this.config.maxPerDay,
			remainingAfter: {
				session: this.config.maxPerSession !== undefined
					? Math.max(0, this.config.maxPerSession - afterSession)
					: undefined,
				daily: this.config.maxPerDay !== undefined
					? Math.max(0, this.config.maxPerDay - afterDaily)
					: undefined,
			},
		};
	}

	// ─── Event Emission ─────────────────────────────────────────

	/** Subscribe to budget events. Returns unsubscribe function. */
	onBudgetEvent(listener: (event: BudgetEvent) => void): () => void {
		this.listeners.push(listener);
		return () => {
			const idx = this.listeners.indexOf(listener);
			if (idx >= 0) this.listeners.splice(idx, 1);
		};
	}

	// ─── Persistence ────────────────────────────────────────────

	/** Load persisted daily state from disk. Auto-resets if date changed. */
	loadPersistedState(): void {
		if (!this.config.persistPath) return;

		try {
			const raw = readFileSync(this.config.persistPath, "utf-8");
			const state: PersistedState = JSON.parse(raw);
			const today = todayString();

			if (state.dailyDate === today) {
				this.dailyCost = state.dailyCost ?? 0;
				for (const [k, v] of Object.entries(state.costByTool ?? {})) {
					this.costByTool.set(k, v);
				}
				for (const [k, v] of Object.entries(state.costByModel ?? {})) {
					this.costByModel.set(k, v);
				}
			}
			// Different date → daily costs stay at 0 (auto-reset)
		} catch {
			// File doesn't exist or is corrupted — start fresh
		}
	}

	/** Flush current state to disk immediately. */
	flush(): void {
		if (!this.config.persistPath) return;

		const state: PersistedState = {
			dailyCost: this.dailyCost,
			dailyDate: todayString(),
			costByTool: Object.fromEntries(this.costByTool),
			costByModel: Object.fromEntries(this.costByModel),
		};

		try {
			mkdirSync(dirname(this.config.persistPath), { recursive: true });
			writeFileSync(this.config.persistPath, JSON.stringify(state, null, 2), "utf-8");
		} catch {
			// Best-effort persistence — don't crash the agent
		}

		this.persistDirty = false;
		if (this.flushTimer) {
			clearTimeout(this.flushTimer);
			this.flushTimer = null;
		}
	}

	/** Check if daily date rolled over and reset if needed. Returns true if reset. */
	checkDayRollover(): boolean {
		if (!this.config.persistPath) return false;

		try {
			const raw = readFileSync(this.config.persistPath, "utf-8");
			const state: PersistedState = JSON.parse(raw);
			if (state.dailyDate !== todayString()) {
				this.resetDaily();
				return true;
			}
		} catch {
			// No file or corrupted — no rollover needed
		}
		return false;
	}

	// ─── Resets ─────────────────────────────────────────────────

	/** Reset session cost (new session). */
	resetSession(): void {
		this.sessionCost = 0;
		this.sessionCostByTool.clear();
		this.sessionCostByModel.clear();
		this.wasWarning = false;
		this.wasExceeded = false;
	}

	/** Reset daily cost (new day). */
	resetDaily(): void {
		this.dailyCost = 0;
		this.costByTool.clear();
		this.costByModel.clear();
		this.wasWarning = false;
		this.wasExceeded = false;
	}

	getSessionCost(): number {
		return this.sessionCost;
	}

	getDailyCost(): number {
		return this.dailyCost;
	}

	// ─── Internal ───────────────────────────────────────────────

	private emitEvent(partial: Omit<BudgetEvent, "sessionCost" | "dailyCost" | "timestamp"> & Partial<BudgetEvent>): void {
		const event: BudgetEvent = {
			sessionCost: this.sessionCost,
			dailyCost: this.dailyCost,
			timestamp: Date.now(),
			...partial,
		};

		for (const listener of this.listeners) {
			try {
				listener(event);
			} catch {
				// Non-blocking
			}
		}
	}

	private schedulePersistFlush(): void {
		this.persistDirty = true;
		if (this.flushTimer) return; // Already scheduled

		this.flushTimer = setTimeout(() => {
			this.flushTimer = null;
			if (this.persistDirty) this.flush();
		}, FLUSH_DEBOUNCE_MS);
	}
}

function todayString(): string {
	return new Date().toISOString().slice(0, 10);
}
