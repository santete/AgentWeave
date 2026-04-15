/**
 * TokenCounter — Tracks token usage and cost across the session.
 */

import type { TokenUsage } from "@agentweave/types";
import { createEmptyTokenUsage } from "@agentweave/types";

// Pricing per 1M tokens (USD) — Anthropic models
const MODEL_PRICING: Record<string, { input: number; output: number }> = {
	"claude-opus-4-6": { input: 15, output: 75 },
	"claude-sonnet-4-6": { input: 3, output: 15 },
	"claude-haiku-4-5": { input: 0.8, output: 4 },
};

const DEFAULT_PRICING = { input: 3, output: 15 }; // Default to Sonnet pricing

export class TokenCounter {
	private usage: TokenUsage = createEmptyTokenUsage();

	add(delta: {
		inputTokens?: number;
		outputTokens?: number;
		thinkingTokens?: number;
		cacheReadTokens?: number;
		cacheCreationTokens?: number;
	}): void {
		this.usage.inputTokens += delta.inputTokens ?? 0;
		this.usage.outputTokens += delta.outputTokens ?? 0;
		this.usage.thinkingTokens += delta.thinkingTokens ?? 0;
		this.usage.cacheReadTokens += delta.cacheReadTokens ?? 0;
		this.usage.cacheCreationTokens += delta.cacheCreationTokens ?? 0;
	}

	recalculateCost(model: string): void {
		const pricing = MODEL_PRICING[model] ?? DEFAULT_PRICING;
		const inputCost =
			((this.usage.inputTokens + this.usage.cacheCreationTokens) *
				pricing.input) /
			1_000_000;
		const outputCost =
			((this.usage.outputTokens + this.usage.thinkingTokens) *
				pricing.output) /
			1_000_000;
		// Cache reads are 10% of input price
		const cacheReadCost =
			(this.usage.cacheReadTokens * pricing.input * 0.1) / 1_000_000;
		this.usage.totalCost = inputCost + outputCost + cacheReadCost;
	}

	getUsage(): TokenUsage {
		return { ...this.usage };
	}

	reset(): void {
		this.usage = createEmptyTokenUsage();
	}
}
