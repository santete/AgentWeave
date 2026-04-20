/**
 * SDLC Engine types — structured workflow for AI agents.
 *
 * 8 modules: TaskNormalizer, ContextBuilder, PlanGenerator, ExecutionBridge,
 * PatchValidator, QualityGate, RetryEngine, OutputStandardizer.
 *
 * 10 metrics (M1-M10) measured per task with baseline comparison.
 */

import type { TokenUsage } from "./metrics";

// ─── Structured Task ────────────────────────────────────────────

export interface SDLCTask {
	id: string;
	rawInput: string;
	goal: string;
	context: string[]; // relevant file paths, schemas
	constraints: string[]; // "no breaking change", etc.
	definitionOfDone: string[]; // "tests pass", etc.
	metadata: Record<string, unknown>;
}

// ─── Plan ────────────────────────────────────────────────────────

export interface SDLCPlan {
	taskId: string;
	steps: SDLCPlanStep[];
	estimatedFiles: string[];
}

export interface SDLCPlanStep {
	index: number;
	description: string;
	type: "read" | "write" | "test" | "validate" | "shell";
	files?: string[];
	done: boolean;
}

// ─── Execution Result ────────────────────────────────────────────

export interface SDLCExecutionResult {
	success: boolean;
	changedFiles: string[];
	output: string;
	usage: TokenUsage;
	durationMs: number;
	terminalReason: string;
}

// ─── Validation Result ───────────────────────────────────────────

export interface SDLCValidationResult {
	passed: boolean;
	checks: SDLCCheck[];
	score?: number; // 0.0 - 1.0
}

export interface SDLCCheck {
	name: string;
	passed: boolean;
	message?: string;
	severity: "error" | "warning" | "info";
}

// ─── Retry Decision ──────────────────────────────────────────────

export interface SDLCRetryDecision {
	shouldRetry: boolean;
	strategy: "fix_specific" | "regenerate" | "simplify" | "escalate";
	fixInstructions?: string;
	maxRetries: number;
	currentAttempt: number;
}

// ─── Standardized Output ─────────────────────────────────────────

export interface SDLCOutput {
	commitMessage: string;
	prTitle: string;
	prDescription: string;
	summary: string;
	changedFiles: string[];
}

// ─── Module Interface (LEGO contract) ────────────────────────────

export interface SDLCModule<TInput = unknown, TOutput = unknown> {
	readonly name: string;
	execute(input: TInput, context: SDLCModuleContext): Promise<TOutput>;
}

export type LLMCallerFn = (prompt: string, model: string) => Promise<string>;

export interface SDLCModuleContext {
	sessionId: string;
	cwd: string;
	signal: AbortSignal;
	config: SDLCConfig;
	metrics: MetricsHandle;
	llmCaller?: LLMCallerFn;
}

export interface MetricsHandle {
	record(metric: string, value: number | boolean): void;
	startTimer(label: string): () => number; // returns stop fn → durationMs
}

// ─── Metrics ─────────────────────────────────────────────────────

export interface SDLCMetricsSnapshot {
	taskId: string;
	timestamp: number;
	m1_firstPassSuccess: boolean;
	m2_testPassRate: number; // 0.0 - 1.0
	m3_scopeAccuracy: number; // 0.0 - 1.0
	m4_retryCount: number;
	m5_costUsd: number;
	m6_timeToCompletionMs: number;
	m7_regressionDetected: boolean;
	m8_planAccuracy: number; // 0.0 - 1.0
	m9_contextUtilization: number; // 0.0 - 1.0
	m10_codeQualityDelta: number; // positive = improved
}

export interface SDLCBaselineComparison {
	current: SDLCMetricsSnapshot;
	baseline: SDLCMetricsSnapshot | null;
	deltas: Record<string, number>;
}

// ─── Config ──────────────────────────────────────────────────────

export interface SDLCModuleConfig {
	enabled: boolean;
	custom?: string; // path to custom module implementation
}

export interface QualityGateCheck {
	type: "compile" | "test" | "lint" | "typecheck" | "custom";
	command: string;
	required: boolean; // true = hard gate, false = warning only
}

export interface RetryStrategy {
	errorType: string; // "compile_error" | "test_failure" | "lint_warning" | "scope_violation"
	action: "fix_specific" | "regenerate" | "simplify" | "escalate";
}

export interface SDLCConfig {
	modules: {
		taskNormalizer: SDLCModuleConfig & { model?: string };
		contextBuilder: SDLCModuleConfig & {
			maxFiles?: number;
			maxTokens?: number;
			includePatterns?: string[];
			excludePatterns?: string[];
		};
		planGenerator: SDLCModuleConfig & { model?: string; maxSteps?: number };
		executionBridge: SDLCModuleConfig;
		patchValidator: SDLCModuleConfig & {
			maxFilesChanged?: number;
			scopeStrict?: boolean;
		};
		qualityGate: SDLCModuleConfig & { checks?: QualityGateCheck[] };
		retryEngine: SDLCModuleConfig & {
			maxRetries?: number;
			strategies?: RetryStrategy[];
		};
		outputStandardizer: SDLCModuleConfig & {
			commitFormat?: "conventional" | "freeform";
			prTemplate?: string;
		};
	};
	execution: {
		mode: "agent-loop" | "process-adapter" | "api-direct";
		agentLoop?: {
			model: string;
			fallbackModel?: string;
			maxTurns?: number;
			systemPrompt?: string;
			tools?: string[];
		};
		processAdapter?: {
			command: string;
			args?: string[];
			cwd?: string;
			promptMode?: "stdin" | "arg";
			env?: Record<string, string>;
		};
		apiDirect?: {
			model: string;
		};
	};
	metrics: {
		enabled: boolean;
		baseline: boolean;
		persistPath?: string;
	};
}
