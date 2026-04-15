/**
 * OutputPipeline — Dual-mode (streaming/batch) output processing.
 *
 * Streaming mode: stateless regex filters per-buffer, post-stream validate.
 * Batch mode: full 6-stage pipeline (intercept -> validate -> filter -> transform -> review -> deliver).
 *
 * MVP implements: filter stage (secrets, PII regex) for both modes.
 */

import type {
	RawOutput,
	OutputDecision,
	OutputStageResult,
	OutputFilter,
} from "@agentweave/types";

// ─── Built-in Secret Patterns ────────────────────────────────────

const BUILT_IN_SECRET_PATTERNS = [
	/sk-[a-zA-Z0-9]{20,}/, // OpenAI keys
	/AKIA[A-Z0-9]{16}/, // AWS access keys
	/ghp_[a-zA-Z0-9]{36}/, // GitHub personal tokens
	/gho_[a-zA-Z0-9]{36}/, // GitHub OAuth tokens
	/github_pat_[a-zA-Z0-9_]{80,}/, // GitHub fine-grained tokens
	/xoxb-[0-9]+-[a-zA-Z0-9]+/, // Slack bot tokens
	/eyJ[a-zA-Z0-9_-]{20,}\.eyJ[a-zA-Z0-9_-]{20,}/, // JWT tokens
];

const BUILT_IN_PII_PATTERNS = [
	/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/, // Email
	/\b\d{3}-\d{2}-\d{4}\b/, // SSN (US)
	/\b\d{3}[-.]?\d{3}[-.]?\d{4}\b/, // Phone (US)
	/\b(?:\d[ -]*?){13,16}\b/, // Credit card (loose)
];

export interface OutputPipelineConfig {
	gateMode: "streaming" | "batch" | "auto";
	filters: OutputFilter[];
	streaming?: {
		postStreamFailure?: "warn" | "flag" | "alert" | "retract";
	};
}

export class OutputPipeline {
	private filters: CompiledFilter[];
	private gateMode: "streaming" | "batch" | "auto";

	constructor(config: OutputPipelineConfig) {
		this.gateMode = config.gateMode;
		this.filters = config.filters.map(compileFilter);
	}

	/** Process output through the pipeline (batch mode). */
	async process(output: RawOutput): Promise<OutputDecision> {
		const stages: OutputStageResult[] = [];
		let text = output.text;

		// Stage 2: Validate (no-op for MVP — auto-pass)
		stages.push({ stage: "validate", passed: true, details: "Skipped (MVP)" });

		// Stage 3: Filter
		const filterResult = this.applyFilters(text);
		text = filterResult.text;
		stages.push({
			stage: "filter",
			passed: true,
			details:
				filterResult.redactionCount > 0
					? `${filterResult.redactionCount} redactions applied`
					: undefined,
		});

		// Stage 4: Transform (no-op for MVP)
		stages.push({ stage: "transform", passed: true, details: "Skipped (MVP)" });

		// Stage 5: Review (no-op for MVP — auto-approve)
		stages.push({ stage: "review", passed: true, details: "Skipped (MVP)" });

		return {
			action: "approve",
			modifiedContent: text !== output.text ? text : undefined,
			stages,
		};
	}

	/** Filter a text buffer (used by both streaming and batch modes). */
	applyFilters(text: string): { text: string; redactionCount: number } {
		let result = text;
		let redactionCount = 0;

		for (const filter of this.filters) {
			for (const pattern of filter.patterns) {
				pattern.lastIndex = 0; // reset stateful g-flag regex
				const before = result;
				result = result.replace(pattern, filter.replacement);
				if (result !== before) redactionCount++;
			}
		}

		return { text: result, redactionCount };
	}

	/** Filter for streaming mode — works on a buffer chunk. */
	filterStreamBuffer(buffer: string): { text: string; redacted: boolean } {
		const { text, redactionCount } = this.applyFilters(buffer);
		return { text, redacted: redactionCount > 0 };
	}

	getGateMode(): string {
		return this.gateMode;
	}
}

// ─── Internal: Compile OutputFilter config to regex ──────────────

interface CompiledFilter {
	name: string;
	patterns: RegExp[];
	replacement: string;
}

function tryCompileRegex(source: string, flags: string, filterName: string): RegExp | null {
	try {
		return new RegExp(source, flags);
	} catch {
		// Invalid regex in config — skip this pattern, don't crash
		console.warn(`[OutputPipeline] Invalid regex pattern "${source}" in filter "${filterName}" — skipped`);
		return null;
	}
}

function compileFilter(filter: OutputFilter): CompiledFilter {
	const patterns: RegExp[] = [];
	const replacement = filter.replacement ?? "[REDACTED]";

	switch (filter.type) {
		case "secret":
			for (const p of filter.patterns) {
				const re = tryCompileRegex(p, "g", filter.name);
				if (re) patterns.push(re);
			}
			patterns.push(
				...BUILT_IN_SECRET_PATTERNS.map((p) => new RegExp(p.source, "g")),
			);
			break;

		case "pii":
			for (const entity of filter.entities) {
				switch (entity) {
					case "email":
						patterns.push(new RegExp(BUILT_IN_PII_PATTERNS[0]!.source, "g"));
						break;
					case "ssn":
						patterns.push(new RegExp(BUILT_IN_PII_PATTERNS[1]!.source, "g"));
						break;
					case "phone":
						patterns.push(new RegExp(BUILT_IN_PII_PATTERNS[2]!.source, "g"));
						break;
					case "credit_card":
						patterns.push(new RegExp(BUILT_IN_PII_PATTERNS[3]!.source, "g"));
						break;
				}
			}
			break;

		case "regex": {
			const re = tryCompileRegex(filter.pattern, "g", filter.name);
			if (re) patterns.push(re);
			break;
		}

		case "denylist":
			for (const word of filter.words) {
				const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
				patterns.push(new RegExp(`\\b${escaped}\\b`, "gi"));
			}
			break;
	}

	return { name: filter.name, patterns, replacement };
}
