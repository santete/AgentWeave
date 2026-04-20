/**
 * SDLC Config — defaults and validation.
 */

import { z } from "zod";
import type { SDLCConfig } from "@agentweave/types";

// ─── Defaults ────────────────────────────────────────────────────

export function getDefaultSDLCConfig(): SDLCConfig {
	return {
		modules: {
			taskNormalizer: { enabled: true },
			contextBuilder: { enabled: true, maxFiles: 20, maxTokens: 50_000 },
			planGenerator: { enabled: true, maxSteps: 15 },
			executionBridge: { enabled: true },
			patchValidator: { enabled: true, maxFilesChanged: 30, scopeStrict: false },
			qualityGate: { enabled: true, checks: [] },
			retryEngine: { enabled: true, maxRetries: 3 },
			outputStandardizer: { enabled: false },
		},
		execution: {
			mode: "agent-loop",
			agentLoop: { model: "claude-sonnet-4-6", maxTurns: 50 },
		},
		metrics: {
			enabled: true,
			baseline: false,
		},
	};
}

// ─── Zod Validation ──────────────────────────────────────────────

const ModuleConfigSchema = z.object({
	enabled: z.boolean(),
	custom: z.string().optional(),
}).passthrough();

const QualityGateCheckSchema = z.object({
	type: z.enum(["compile", "test", "lint", "typecheck", "custom"]),
	command: z.string(),
	required: z.boolean(),
});

const RetryStrategySchema = z.object({
	errorType: z.string(),
	action: z.enum(["fix_specific", "regenerate", "simplify", "escalate"]),
});

export const SDLCConfigSchema = z.object({
	modules: z.object({
		taskNormalizer: ModuleConfigSchema.extend({ model: z.string().optional() }),
		contextBuilder: ModuleConfigSchema.extend({
			maxFiles: z.number().optional(),
			maxTokens: z.number().optional(),
			includePatterns: z.array(z.string()).optional(),
			excludePatterns: z.array(z.string()).optional(),
		}),
		planGenerator: ModuleConfigSchema.extend({
			model: z.string().optional(),
			maxSteps: z.number().optional(),
		}),
		executionBridge: ModuleConfigSchema,
		patchValidator: ModuleConfigSchema.extend({
			maxFilesChanged: z.number().optional(),
			scopeStrict: z.boolean().optional(),
		}),
		qualityGate: ModuleConfigSchema.extend({
			checks: z.array(QualityGateCheckSchema).optional(),
		}),
		retryEngine: ModuleConfigSchema.extend({
			maxRetries: z.number().optional(),
			strategies: z.array(RetryStrategySchema).optional(),
		}),
		outputStandardizer: ModuleConfigSchema.extend({
			commitFormat: z.enum(["conventional", "freeform"]).optional(),
			prTemplate: z.string().optional(),
		}),
	}),
	execution: z.object({
		mode: z.enum(["agent-loop", "process-adapter", "api-direct"]),
		agentLoop: z.object({
			model: z.string(),
			fallbackModel: z.string().optional(),
			maxTurns: z.number().optional(),
			systemPrompt: z.string().optional(),
			tools: z.array(z.string()).optional(),
		}).optional(),
		processAdapter: z.object({
			command: z.string(),
			args: z.array(z.string()).optional(),
			cwd: z.string().optional(),
			promptMode: z.enum(["stdin", "arg"]).optional(),
		}).optional(),
		apiDirect: z.object({
			model: z.string(),
		}).optional(),
	}),
	metrics: z.object({
		enabled: z.boolean(),
		baseline: z.boolean(),
		persistPath: z.string().optional(),
	}),
});

/** Validate and return typed config. Throws on invalid. */
export function validateSDLCConfig(raw: unknown): SDLCConfig {
	return SDLCConfigSchema.parse(raw);
}
