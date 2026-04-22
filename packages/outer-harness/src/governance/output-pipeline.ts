/**
 * OutputPipeline — Dual-mode (streaming/batch) output processing.
 *
 * Product-grade 4-stage pipeline:
 * 1. Validate: safety keywords, length limits, JSON schema
 * 2. Filter: secrets, PII, custom regex, denylist (existing)
 * 3. Transform: template headers/footers
 * 4. Review: auto-approve (stub for future human-in-the-loop)
 *
 * Pipeline metrics: per-stage timing, redaction/rejection counts.
 */

import type {
	RawOutput,
	OutputDecision,
	OutputStageResult,
	OutputFilter,
	OutputValidationRule,
	OutputTransform,
	PipelineMetrics,
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

// ─── Built-in Safety Keywords ────────────────────────────────────

const BUILT_IN_SAFETY_PATTERNS = [
	/\b(how to (make|build|create) (a )?(bomb|explosive|weapon))\b/i,
	/\b(synthesize|manufacture)\s+(drugs?|methamphetamine|fentanyl)\b/i,
	/\b(hack\s+into|exploit\s+vulnerability|bypass\s+security)\b/i,
	/\b(steal\s+(identity|credentials|credit\s+card))\b/i,
];

export interface OutputPipelineConfig {
	gateMode: "streaming" | "batch" | "auto";
	filters: OutputFilter[];
	validate?: { enabled: boolean; rules: OutputValidationRule[] };
	transform?: { enabled: boolean; transforms: OutputTransform[] };
	streaming?: {
		postStreamFailure?: "warn" | "flag" | "alert" | "retract";
	};
}

export class OutputPipeline {
	private filters: CompiledFilter[];
	private gateMode: "streaming" | "batch" | "auto";
	private validationRules: OutputValidationRule[];
	private transforms: OutputTransform[];

	// Metrics
	private metrics: PipelineMetrics = {
		totalProcessed: 0,
		totalRedactions: 0,
		totalRejections: 0,
		stageTiming: {},
		filterRedactionCounts: {},
	};

	constructor(config: OutputPipelineConfig) {
		this.gateMode = config.gateMode;
		this.filters = config.filters.map(compileFilter);
		this.validationRules = config.validate?.enabled ? (config.validate.rules ?? []) : [];
		this.transforms = config.transform?.enabled ? (config.transform.transforms ?? []) : [];
	}

	/** Process output through the full pipeline (batch mode). */
	async process(output: RawOutput): Promise<OutputDecision> {
		const stages: OutputStageResult[] = [];
		let text = output.text;
		this.metrics.totalProcessed++;

		// Stage 1: Validate
		const validateStart = performance.now();
		const validateResult = this.runValidation(text);
		this.recordTiming("validate", performance.now() - validateStart);
		stages.push(validateResult.stage);

		if (validateResult.decision) {
			this.metrics.totalRejections++;
			return {
				action: validateResult.decision.action!,
				reason: validateResult.decision.reason,
				retryPrompt: validateResult.decision.retryPrompt,
				stages,
			};
		}

		// Stage 2: Filter
		const filterStart = performance.now();
		const filterResult = this.applyFilters(text);
		text = filterResult.text;
		this.recordTiming("filter", performance.now() - filterStart);
		stages.push({
			stage: "filter",
			passed: true,
			details:
				filterResult.redactionCount > 0
					? `${filterResult.redactionCount} redactions applied`
					: undefined,
		});
		this.metrics.totalRedactions += filterResult.redactionCount;

		// Stage 3: Transform
		const transformStart = performance.now();
		const transformResult = this.runTransforms(text);
		text = transformResult.text;
		this.recordTiming("transform", performance.now() - transformStart);
		stages.push({
			stage: "transform",
			passed: true,
			details: transformResult.applied > 0
				? `${transformResult.applied} transforms applied`
				: undefined,
		});

		// Stage 4: Review (auto-approve for now)
		stages.push({ stage: "review", passed: true });

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
				if (result !== before) {
					redactionCount++;
					this.metrics.filterRedactionCounts[filter.name] =
						(this.metrics.filterRedactionCounts[filter.name] ?? 0) + 1;
				}
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

	getMetrics(): PipelineMetrics {
		return { ...this.metrics };
	}

	// ─── Validate Stage ─────────────────────────────────────────

	private runValidation(text: string): { stage: OutputStageResult; decision?: Partial<OutputDecision> } {
		for (const rule of this.validationRules) {
			const result = this.evaluateValidationRule(rule, text);
			if (result) {
				return {
					stage: { stage: "validate", passed: false, details: result.reason },
					decision: {
						action: rule.action === "retry" ? "retry" : "reject",
						reason: result.reason,
						retryPrompt: rule.action === "retry" ? rule.retryPrompt : undefined,
					},
				};
			}
		}

		return { stage: { stage: "validate", passed: true } };
	}

	private evaluateValidationRule(rule: OutputValidationRule, text: string): { reason: string } | null {
		switch (rule.type) {
			case "safety": {
				for (const pattern of BUILT_IN_SAFETY_PATTERNS) {
					if (pattern.test(text)) {
						return { reason: `Safety violation detected (rule: ${rule.name})` };
					}
				}
				return null;
			}

			case "length": {
				const maxChars = rule.maxChars ?? 100_000;
				if (text.length > maxChars) {
					return { reason: `Output exceeds max length: ${text.length} > ${maxChars} (rule: ${rule.name})` };
				}
				return null;
			}

			case "schema": {
				if (!rule.schema) return null;
				try {
					const parsed = JSON.parse(text);
					const schema = JSON.parse(rule.schema);
					const error = validateJsonSchema(parsed, schema);
					if (error) {
						return { reason: `Schema validation failed: ${error} (rule: ${rule.name})` };
					}
				} catch {
					return { reason: `Output is not valid JSON (rule: ${rule.name})` };
				}
				return null;
			}

			case "custom":
				// Custom validators require external function loading — skip for now
				return null;
		}
	}

	// ─── Transform Stage ────────────────────────────────────────

	private runTransforms(text: string): { text: string; applied: number } {
		let result = text;
		let applied = 0;

		for (const transform of this.transforms) {
			if (transform.type === "template") {
				if (transform.position === "header") {
					result = transform.content + "\n" + result;
					applied++;
				} else if (transform.position === "footer") {
					result = result + "\n" + transform.content;
					applied++;
				}
			}
			// code_format, summarize, custom — skip
		}

		return { text: result, applied };
	}

	// ─── Metrics ────────────────────────────────────────────────

	private recordTiming(stage: string, ms: number): void {
		const existing = this.metrics.stageTiming[stage];
		if (existing) {
			existing.totalMs += ms;
			existing.count++;
			existing.avgMs = existing.totalMs / existing.count;
		} else {
			this.metrics.stageTiming[stage] = { totalMs: ms, count: 1, avgMs: ms };
		}
	}
}

// ─── JSON Schema Validation (basic, no external deps) ───────────

function validateJsonSchema(data: unknown, schema: Record<string, unknown>): string | null {
	if (typeof data !== "object" || data === null || Array.isArray(data)) {
		if (schema.type === "object") return "Expected object";
		if (schema.type === "array" && !Array.isArray(data)) return "Expected array";
	}

	// Check required fields
	if (schema.required && Array.isArray(schema.required) && typeof data === "object" && data !== null) {
		for (const field of schema.required) {
			if (!(field as string in (data as Record<string, unknown>))) {
				return `Missing required field: ${field}`;
			}
		}
	}

	// Check property types
	if (schema.properties && typeof data === "object" && data !== null) {
		const props = schema.properties as Record<string, { type?: string }>;
		const obj = data as Record<string, unknown>;
		for (const [key, propSchema] of Object.entries(props)) {
			if (key in obj && propSchema.type) {
				const val = obj[key];
				if (propSchema.type === "string" && typeof val !== "string") return `Field "${key}" must be string`;
				if (propSchema.type === "number" && typeof val !== "number") return `Field "${key}" must be number`;
				if (propSchema.type === "boolean" && typeof val !== "boolean") return `Field "${key}" must be boolean`;
				if (propSchema.type === "array" && !Array.isArray(val)) return `Field "${key}" must be array`;
			}
		}
	}

	return null;
}

// ─── Internal: Compile OutputFilter config to regex ──────────────

interface CompiledFilter {
	name: string;
	patterns: RegExp[];
	replacement: string;
}

function tryCompileRegex(source: string, flags: string, _filterName: string): RegExp | null {
	// SECURITY: reject patterns with nested quantifiers (ReDoS risk)
	if (/(\+|\*|\{[^}]+\})\s*(\+|\*|\{[^}]+\}|\)[\+\*])/.test(source)) {
		return null;
	}
	try {
		return new RegExp(source, flags);
	} catch {
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
