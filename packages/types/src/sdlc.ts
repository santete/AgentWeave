/**
 * SDLC Engine types — structured workflow for AI agents.
 *
 * 8 modules: TaskNormalizer, ContextBuilder, PlanGenerator, ExecutionBridge,
 * PatchValidator, QualityGate, RetryEngine, OutputStandardizer.
 *
 * 10 metrics (M1-M10) measured per task with baseline comparison.
 */

import type { ControlPlane } from "./control-plane";
import type { GovernanceHandle } from "./governance";
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

import type { BoGhiVetTich } from "./vet-tich";

export interface SDLCModuleContext {
	sessionId: string;
	cwd: string;
	signal: AbortSignal;
	config: SDLCConfig;
	metrics: MetricsHandle;
	llmCaller?: LLMCallerFn;
	/** Optional governance observer — stage audit + session lifecycle. */
	governance?: GovernanceHandle;
	/** Optional ControlPlane — propagated to AgentLoop for tool-call gating. */
	controlPlane?: ControlPlane;
	/** Nơi nhận vết tích, truyền tiếp xuống AgentLoop. Xem `types/vet-tich.ts`. */
	vetTich?: BoGhiVetTich;
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
	// null = KHÔNG đo được. Trước đây mặc định về 1 (100%) khi không có dữ liệu,
	// nên một lượt chạy không làm gì hiện ba thanh xanh 100% — đúng loại "báo
	// xanh mà sai" mà một sản phẩm bán bằng số đo không được phép mắc.
	m2_testPassRate: number | null; // 0.0 - 1.0, null = không chạy check nào
	m3_scopeAccuracy: number | null; // 0.0 - 1.0, null = không có kế hoạch/thay đổi để đối chiếu
	m4_retryCount: number;
	m5_costUsd: number;
	m6_timeToCompletionMs: number;
	m7_regressionDetected: boolean;
	m8_planAccuracy: number | null; // 0.0 - 1.0, null = không có kế hoạch nào
	m9_contextUtilization: number | null; // 0.0 - 1.0, null = not measured
	m10_codeQualityDelta: number | null; // positive = improved, null = not measured
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
		qualityGate: SDLCModuleConfig & {
			checks?: QualityGateCheck[];
			/** Run QA before execution to detect regressions (M7). Default false — doubles QA time. */
			detectRegression?: boolean;
		};
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
			/**
			 * Bốn trường dưới đây là những gì `chat`/`serve` vẫn truyền cho
			 * `AgentLoop` mà pipeline TRƯỚC NAY BỎ TRỐNG.
			 *
			 * Hệ quả đo được với model cục bộ: pipeline rơi về đường stream (mất
			 * đòn bẩy enum của giao thức có ràng buộc), cửa sổ ngữ cảnh là con số
			 * đoán 65.536 nên ngưỡng nén sai, và `num_ctx` không bao giờ tới
			 * Ollama. Cùng một model, cùng một việc, nhưng pipeline chạy tệ hơn
			 * chat mà không có gì báo.
			 */
			structuredProtocol?: boolean;
			contextWindow?: number;
			temperature?: number;
			topP?: number;
			repeatPenalty?: number;
			seed?: number;
		};
		processAdapter?: {
			command: string;
			args?: string[];
			cwd?: string;
			promptMode?: "stdin" | "arg";
			env?: Record<string, string>;
			/** Wall-clock timeout (ms) on the child process. Exceeds → SIGTERM+SIGKILL, reason="timeout". */
			processTimeoutMs?: number;
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
