/**
 * Framework configuration types.
 * 7-level hierarchy: Defaults < User < Project < Local < CLI < Env < Policy
 */

import type { PermissionConfig } from "./permissions";
import type { HookDefinition } from "./hooks";
import type { MultiAgentConfig } from "./multi-agent";
import type { PluginConfig } from "./plugin";

export interface HarnessConfig {
	// Inner
	inner: {
		model: string;
		fallbackModel?: string;
		maxTurns: number;
		thinkingEnabled: boolean;
		tools: string[]; // Built-in tool names to enable
	};

	// Outer - Permissions
	permissions: PermissionConfig;

	// Outer - Hooks
	hooks: Record<string, HookDefinition[]>;

	// Outer - Output pipeline
	output: {
		pipeline: {
			validate: { enabled: boolean; rules: OutputValidationRule[] };
			filter: { enabled: boolean; filters: OutputFilter[] };
			transform: { enabled: boolean; transforms: OutputTransform[] };
			review: {
				enabled: boolean;
				autoApproveCondition?: string;
				timeoutMs?: number;
			};
		};
		gateMode: "streaming" | "batch" | "auto";
		streaming?: {
			bufferSize?: number; // Tokens per buffer (20-100, default 50)
			contextWindow?: number; // Chars sliding context (default 100)
			postStreamFailure?: "warn" | "flag" | "alert" | "retract";
		};
	};

	// Outer - Budget
	budget: {
		maxPerSession?: number; // USD
		maxPerDay?: number;
		warningThreshold: number; // 0.0 - 1.0
	};

	// Outer - Monitoring
	monitoring: {
		enabled: boolean;
		traceEnabled: boolean;
		metricsExport?: { type: "otlp"; endpoint: string };
	};

	// Outer - Session
	session: {
		persistTranscript: boolean;
		transcriptDir: string;
		autoSave: boolean;
	};

	// Outer - Multi-Agent (optional)
	multiAgent?: MultiAgentConfig;

	// Plugins (optional)
	plugins?: PluginConfig[];
}

// ─── Output Validation Rules (discriminated union) ───────────────

interface BaseValidationRule {
	name: string;
	action: "reject" | "retry" | "flag";
	maxRetries?: number;
	retryPrompt?: string;
}

export type OutputValidationRule =
	| (BaseValidationRule & { type: "safety" })
	| (BaseValidationRule & { type: "schema"; schema?: string })
	| (BaseValidationRule & { type: "length"; maxChars?: number })
	| (BaseValidationRule & { type: "custom"; validator: string });

// ─── Output Filters (discriminated union) ────────────────────────

interface BaseFilter {
	name: string;
	replacement?: string;
	streamable?: boolean;
}

export type OutputFilter =
	| (BaseFilter & { type: "pii"; entities: string[] })
	| (BaseFilter & { type: "secret"; patterns: string[] })
	| (BaseFilter & { type: "regex"; pattern: string })
	| (BaseFilter & { type: "denylist"; words: string[] });

// ─── Output Transforms (discriminated union) ─────────────────────

interface BaseTransform {
	name: string;
	streamable?: boolean;
}

export type OutputTransform =
	| (BaseTransform & {
			type: "template";
			position: "header" | "footer";
			content: string;
	  })
	| (BaseTransform & {
			type: "code_format";
			languages?: Record<string, string>;
	  })
	| (BaseTransform & {
			type: "summarize";
			model?: string;
			targetLength?: number;
	  })
	| (BaseTransform & { type: "custom"; transformer: string });
