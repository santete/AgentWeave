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

/** Model chạy cục bộ — không tốn tiền. */
const MIEN_PHI = { input: 0, output: 0 };

/**
 * Model này có chạy cục bộ không?
 *
 * Vì sao cần: mặc định rơi về giá Sonnet ($3/$15) nên một phiên Ollama hoàn
 * toàn miễn phí báo $0,1322. Không chỉ sai hiển thị — con số này nuôi luôn
 * `--budget`, nên một lượt chạy cục bộ có thể bị cắt giữa chừng vì đã "tiêu"
 * hết ngân sách tưởng tượng.
 *
 * Nhận theo tiền tố tường minh trước, rồi tới họ model cục bộ phổ biến.
 */
export function laModelCucBo(model: string): boolean {
	const m = model.toLowerCase();
	if (m.startsWith("ollama/") || m.startsWith("local/") || m.startsWith("lmstudio/")) return true;
	if (process.env.AGENTWEAVE_DEFAULT_PROVIDER === "ollama") return true;
	return /^(qwen|llama|mistral|mixtral|gemma|phi|deepseek|codellama|glm|granite|starcoder)/.test(m);
}

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
		const pricing = MODEL_PRICING[model] ?? (laModelCucBo(model) ? MIEN_PHI : DEFAULT_PRICING);
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
