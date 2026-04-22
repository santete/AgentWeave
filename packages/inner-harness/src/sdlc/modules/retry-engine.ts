/**
 * RetryEngine — Classify errors and decide retry strategy.
 */

import type {
	SDLCModule,
	SDLCModuleContext,
	SDLCRetryDecision,
	SDLCExecutionResult,
	SDLCValidationResult,
	RetryStrategy,
} from "@agentweave/types";

export interface RetryInput {
	result: SDLCExecutionResult;
	validation: SDLCValidationResult;
	attempt: number;
}

export class RetryEngineModule implements SDLCModule<RetryInput, SDLCRetryDecision> {
	readonly name = "RetryEngine";

	async execute(input: RetryInput, context: SDLCModuleContext): Promise<SDLCRetryDecision> {
		const maxRetries = context.config.modules.retryEngine.maxRetries ?? 3;
		const strategies = context.config.modules.retryEngine.strategies ?? DEFAULT_STRATEGIES;

		if (input.attempt >= maxRetries) {
			return {
				shouldRetry: false,
				strategy: "escalate",
				maxRetries,
				currentAttempt: input.attempt,
			};
		}

		// Classify error from validation checks
		const errorType = classifyError(input.validation);
		const strategy = strategies.find((s) => s.errorType === errorType);

		if (!strategy) {
			return {
				shouldRetry: true,
				strategy: "fix_specific",
				fixInstructions: buildGenericFixPrompt(input.validation),
				maxRetries,
				currentAttempt: input.attempt,
			};
		}

		return {
			shouldRetry: true,
			strategy: strategy.action,
			fixInstructions: buildFixPrompt(strategy, input.validation),
			maxRetries,
			currentAttempt: input.attempt,
		};
	}
}

// ─── Error Classification ────────────────────────────────────────

function classifyError(validation: SDLCValidationResult): string {
	const failedChecks = validation.checks.filter((c) => !c.passed);
	if (failedChecks.length === 0) return "unknown";

	const first = failedChecks[0]!;
	switch (first.name) {
		case "compile":
		case "typecheck":
			return "compile_error";
		case "test":
			return "test_failure";
		case "lint":
			return "lint_warning";
		default:
			return first.message?.includes("scope") ? "scope_violation" : "unknown";
	}
}

function buildFixPrompt(strategy: RetryStrategy, validation: SDLCValidationResult): string {
	const errors = validation.checks
		.filter((c) => !c.passed)
		.map((c) => `[${c.name}] ${c.message ?? "failed"}`)
		.join("\n");

	switch (strategy.action) {
		case "fix_specific":
			return `Fix the following errors:\n${errors}`;
		case "regenerate":
			return `The previous attempt failed with:\n${errors}\nPlease regenerate the solution with a different approach.`;
		case "simplify":
			return `The previous attempt was too complex and failed:\n${errors}\nSimplify the approach.`;
		case "escalate":
			return `Cannot auto-fix:\n${errors}`;
	}
}

function buildGenericFixPrompt(validation: SDLCValidationResult): string {
	const errors = validation.checks
		.filter((c) => !c.passed)
		.map((c) => `[${c.name}] ${c.message ?? "failed"}`)
		.join("\n");
	return `Fix the following errors:\n${errors}`;
}

const DEFAULT_STRATEGIES: RetryStrategy[] = [
	{ errorType: "compile_error", action: "fix_specific" },
	{ errorType: "test_failure", action: "fix_specific" },
	{ errorType: "lint_warning", action: "fix_specific" },
	{ errorType: "scope_violation", action: "regenerate" },
];
