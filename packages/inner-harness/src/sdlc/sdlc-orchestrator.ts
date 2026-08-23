/**
 * SDLCOrchestrator — Wires SDLC modules into a pipeline based on config.
 * Implements InnerHarnessProvider so it's a drop-in replacement for AgentLoop.
 *
 * Flow: normalize → context → plan → execute → validate → QA → retry → output
 * Each step is optional (config-driven). Disabled modules are skipped.
 */

import { randomUUID } from "node:crypto";
import type {
	BoGhiVetTich,
	ContentBlock,
	ControlPlane,
	GovernanceHandle,
	InjectableMessage,
	InnerConfig,
	InnerEvent,
	InnerEventPayload,
	InnerHarnessProvider,
	InnerState,
	LLMCallerFn,
	Message,
	RunOptions,
	SDLCBaselineComparison,
	SDLCConfig,
	SDLCExecutionResult,
	SDLCMetricsSnapshot,
	SDLCModuleContext,
	SDLCPlan,
	SDLCTask,
	SDLCValidationResult,
	SessionInfo,
	TerminalResult,
	ToolDefinition,
} from "@agentweave/types";
import { createEmptyContextUsage, createEmptyTokenUsage } from "@agentweave/types";
import type { ContextUsage, TokenUsage } from "@agentweave/types";
import { MetricsCollector } from "./metrics-collector";
import { runModule } from "./module-runner";
import { ContextBuilderModule } from "./modules/context-builder";
import { ExecutionBridgeModule } from "./modules/execution-bridge";
import { OutputStandardizerModule } from "./modules/output-standardizer";
import { PatchValidatorModule } from "./modules/patch-validator";
import { PlanGeneratorModule } from "./modules/plan-generator";
import { QualityGateModule } from "./modules/quality-gate";
import { RetryEngineModule } from "./modules/retry-engine";
import { TaskNormalizerModule } from "./modules/task-normalizer";
import { getDefaultSDLCConfig } from "./sdlc-config";

export interface SDLCOrchestratorConfig {
	sdlcConfig?: Partial<SDLCConfig>;
	llmCaller?: LLMCallerFn;
	/** Optional governance observer — receives stage_* events + session lifecycle. */
	governance?: GovernanceHandle;
	/** Optional ControlPlane — propagated to AgentLoop for tool-call gating. */
	controlPlane?: ControlPlane;
	/** Nơi nhận vết tích — truyền tiếp xuống AgentLoop qua execution-bridge. */
	vetTich?: BoGhiVetTich;
}

export class SDLCOrchestrator implements InnerHarnessProvider {
	private config: SDLCConfig;
	private llmCaller?: LLMCallerFn;
	private governance?: GovernanceHandle;
	private controlPlane?: ControlPlane;
	private vetTich?: BoGhiVetTich;
	private state: InnerState;
	private sessionId = "";
	private agentId: string;
	private messages: Message[] = [];
	private usage: TokenUsage;

	// Module instances (created once, reused)
	private taskNormalizer = new TaskNormalizerModule();
	private contextBuilder = new ContextBuilderModule();
	private planGenerator = new PlanGeneratorModule();
	private executionBridge = new ExecutionBridgeModule();
	private patchValidator = new PatchValidatorModule();
	private qualityGate = new QualityGateModule();
	private retryEngine = new RetryEngineModule();
	private outputStandardizer = new OutputStandardizerModule();

	// Last run results (for queries)
	private lastMetrics: SDLCMetricsSnapshot | null = null;
	private lastComparison: SDLCBaselineComparison | null = null;

	constructor(config?: SDLCOrchestratorConfig) {
		const defaults = getDefaultSDLCConfig();
		this.config = config?.sdlcConfig ? mergeConfig(defaults, config.sdlcConfig) : defaults;
		this.llmCaller = config?.llmCaller;
		this.governance = config?.governance;
		this.controlPlane = config?.controlPlane;
		this.vetTich = config?.vetTich;
		this.agentId = `sdlc_${randomUUID().slice(0, 8)}`;
		this.usage = createEmptyTokenUsage();
		this.state = {
			status: "idle",
			turnIndex: 0,
			model: `sdlc:${this.config.execution.mode}`,
			usage: this.usage,
			contextUsage: createEmptyContextUsage(0),
			activeTool: null,
			messageCount: 0,
			recoveryAttempts: 0,
		};
	}

	// ─── InnerHarnessProvider ────────────────────────────────────

	run(
		prompt: string | ContentBlock[],
		options?: RunOptions,
	): AsyncGenerator<InnerEvent, TerminalResult, void> {
		if (this.state.status !== "idle") {
			throw new Error("SDLCOrchestrator can only be run once per instance");
		}
		this.state.status = "running";
		const text = typeof prompt === "string" ? prompt : JSON.stringify(prompt);
		return this.executePipeline(text, options);
	}

	abort(_reason?: string): void {
		this.state.status = "aborted";
	}

	getState(): InnerState {
		return { ...this.state };
	}
	getMessages(): ReadonlyArray<Message> {
		return [...this.messages];
	}
	getContextUsage(): ContextUsage {
		return createEmptyContextUsage(0);
	}
	getUsage(): TokenUsage {
		return { ...this.usage };
	}
	getTools(): ReadonlyArray<ToolDefinition> {
		return [];
	}
	registerTool(_tool: ToolDefinition): void {
		/* no-op */
	}
	unregisterTool(_name: string): void {
		/* no-op */
	}
	injectMessage(_message: InjectableMessage): void {
		/* no-op */
	}
	setSystemPromptSection(_name: string, _content: string | null): void {
		/* no-op */
	}
	setModel(_model: string): void {
		/* no-op */
	}
	getConfig(): InnerConfig {
		return {
			model: `sdlc:${this.config.execution.mode}`,
			maxTurns: 1,
			thinkingEnabled: false,
			tools: [],
		};
	}

	/** Get metrics from last run. */
	getLastMetrics(): SDLCMetricsSnapshot | null {
		return this.lastMetrics;
	}
	getLastComparison(): SDLCBaselineComparison | null {
		return this.lastComparison;
	}

	/** Allow setting a pre-constructed provider for ExecutionBridge. */
	setExecutionProvider(provider: InnerHarnessProvider): void {
		this.executionBridge.setProvider(provider);
	}

	// ─── Pipeline ───────────────────────────────────────────────

	private async *executePipeline(
		rawInput: string,
		options?: RunOptions,
	): AsyncGenerator<InnerEvent, TerminalResult, void> {
		this.sessionId = `ses_${randomUUID().slice(0, 12)}`;
		this.state.turnIndex = 1;
		const mc = new MetricsCollector(this.sessionId);
		const signal = options?.signal ?? new AbortController().signal;

		const ctx: SDLCModuleContext = {
			sessionId: this.sessionId,
			cwd: process.cwd(),
			signal,
			config: this.config,
			metrics: mc.createHandle(),
			llmCaller: this.llmCaller,
			governance: this.governance,
			controlPlane: this.controlPlane,
			vetTich: this.vetTich,
		};

		// Session lifecycle — observer-only, must not block the pipeline.
		await this.notifySessionStart();

		yield this.makeEvent({ type: "turn:start", turnIndex: 1 });

		let terminalForSession: TerminalResult = { reason: "error", usage: this.usage };
		try {
			// Phase 1: Normalize
			yield this.statusEvent("Normalizing task...");
			const { output: task } = await runModule({
				builtIn: this.taskNormalizer,
				config: this.config.modules.taskNormalizer,
				input: rawInput,
				context: ctx,
				defaultOutput: {
					id: `task_${randomUUID().slice(0, 8)}`,
					rawInput,
					goal: rawInput,
					context: [],
					constraints: [],
					definitionOfDone: [],
					metadata: {},
				} satisfies SDLCTask,
				stage: "taskNormalizer",
				phase: 1,
				agentId: this.agentId,
			});

			// Phase 2: Context
			yield this.statusEvent("Building context...");
			const { output: enrichedTask } = await runModule({
				builtIn: this.contextBuilder,
				config: this.config.modules.contextBuilder,
				input: task,
				context: ctx,
				defaultOutput: task,
				stage: "contextBuilder",
				phase: 2,
				agentId: this.agentId,
			});

			// Phase 3: Plan
			yield this.statusEvent("Generating plan...");
			const { output: plan } = await runModule({
				builtIn: this.planGenerator,
				config: this.config.modules.planGenerator,
				input: enrichedTask,
				context: ctx,
				defaultOutput: { taskId: task.id, steps: [], estimatedFiles: [] } satisfies SDLCPlan,
				stage: "planGenerator",
				phase: 3,
				agentId: this.agentId,
			});

			// Pre-execution QA snapshot — only when detectRegression is explicitly enabled (doubles QA time)
			const emptyExecResult: SDLCExecutionResult = {
				success: false,
				changedFiles: [],
				output: "",
				usage: createEmptyTokenUsage(),
				durationMs: 0,
				terminalReason: "skipped",
			};
			let preQaResult: SDLCValidationResult | null = null;
			if (
				this.config.modules.qualityGate.enabled &&
				this.config.modules.qualityGate.detectRegression === true
			) {
				preQaResult = (
					await runModule({
						builtIn: this.qualityGate,
						config: this.config.modules.qualityGate,
						input: emptyExecResult,
						context: ctx,
						defaultOutput: { passed: true, checks: [] },
						stage: "qualityGate",
						phase: 6,
						agentId: this.agentId,
					})
				).output;
			}

			// Phase 4: Execute
			yield this.statusEvent("Executing...");
			let execResult = (
				await runModule({
					builtIn: this.executionBridge,
					config: this.config.modules.executionBridge,
					input: { task: enrichedTask, plan },
					context: ctx,
					defaultOutput: {
						success: false,
						changedFiles: [],
						output: "ExecutionBridge disabled",
						usage: createEmptyTokenUsage(),
						durationMs: 0,
						terminalReason: "error",
					} satisfies SDLCExecutionResult,
					stage: "executionBridge",
					phase: 4,
					agentId: this.agentId,
				})
			).output;

			// Track usage
			this.usage = execResult.usage;
			this.state.usage = this.usage;

			// Phase 5: Patch Validate
			let patchResult: SDLCValidationResult | null = null;
			if (this.config.modules.patchValidator.enabled) {
				yield this.statusEvent("Validating patch...");
				patchResult = (
					await runModule({
						builtIn: this.patchValidator,
						config: this.config.modules.patchValidator,
						input: { result: execResult, estimatedFiles: plan.estimatedFiles },
						context: ctx,
						defaultOutput: { passed: true, checks: [] },
						stage: "patchValidator",
						phase: 5,
						agentId: this.agentId,
					})
				).output;
			}

			// Phase 6: Quality Gate
			let qaResult: SDLCValidationResult | null = null;
			if (this.config.modules.qualityGate.enabled) {
				yield this.statusEvent("Running quality gate...");
				qaResult = (
					await runModule({
						builtIn: this.qualityGate,
						config: this.config.modules.qualityGate,
						input: execResult,
						context: ctx,
						defaultOutput: { passed: true, checks: [] },
						stage: "qualityGate",
						phase: 6,
						agentId: this.agentId,
					})
				).output;

				// M7: regression = any check that passed pre-execution now fails post-execution
				if (preQaResult && qaResult) {
					const prePassedNames = new Set(
						preQaResult.checks.filter((c) => c.passed).map((c) => c.name),
					);
					const regression = qaResult.checks.some((c) => !c.passed && prePassedNames.has(c.name));
					mc.record("regressionDetected", regression);
				}
			}

			// Phase 7: Retry loop
			const needsRetry = (patchResult && !patchResult.passed) || (qaResult && !qaResult.passed);
			if (needsRetry && this.config.modules.retryEngine.enabled) {
				const maxRetries = this.config.modules.retryEngine.maxRetries ?? 3;
				const validation = qaResult ?? patchResult!;

				for (let attempt = 1; attempt <= maxRetries; attempt++) {
					yield this.statusEvent(`Retry attempt ${attempt}/${maxRetries}...`);
					mc.record("retryCount", attempt);
					this.state.recoveryAttempts = attempt;

					const decision = (
						await runModule({
							builtIn: this.retryEngine,
							config: this.config.modules.retryEngine,
							input: { result: execResult, validation, attempt },
							context: ctx,
							defaultOutput: {
								shouldRetry: false,
								strategy: "escalate" as const,
								maxRetries,
								currentAttempt: attempt,
							},
							stage: "retryEngine",
							phase: 7,
							agentId: this.agentId,
						})
					).output;

					if (!decision.shouldRetry) break;

					// Re-execute with fix instructions
					const retryInput = decision.fixInstructions
						? `${rawInput}\n\nPrevious attempt failed. ${decision.fixInstructions}`
						: rawInput;

					execResult = (
						await runModule({
							builtIn: this.executionBridge,
							config: this.config.modules.executionBridge,
							input: { task: { ...enrichedTask, rawInput: retryInput, goal: retryInput }, plan },
							context: ctx,
							defaultOutput: execResult,
							stage: "executionBridge",
							phase: 4,
							agentId: this.agentId,
						})
					).output;

					// Re-check QA
					if (this.config.modules.qualityGate.enabled) {
						qaResult = (
							await runModule({
								builtIn: this.qualityGate,
								config: this.config.modules.qualityGate,
								input: execResult,
								context: ctx,
								defaultOutput: { passed: true, checks: [] },
								stage: "qualityGate",
								phase: 6,
								agentId: this.agentId,
							})
						).output;

						if (qaResult.passed) break;
					} else {
						break;
					}
				}
			}

			// Phase 8: Output Standardize
			if (this.config.modules.outputStandardizer.enabled) {
				yield this.statusEvent("Standardizing output...");
				await runModule({
					builtIn: this.outputStandardizer,
					config: this.config.modules.outputStandardizer,
					input: execResult,
					context: ctx,
					defaultOutput: {
						commitMessage: "",
						prTitle: "",
						prDescription: "",
						summary: "",
						changedFiles: [],
					},
					stage: "outputStandardizer",
					phase: 8,
					agentId: this.agentId,
				});
			}

			// M7 final state: if retry resolved the regression, clear the flag
			if (qaResult?.passed) mc.record("regressionDetected", false);

			// Mark plan steps done only when execution succeeded and QA passed
			const allPassed = execResult.success && (!qaResult || qaResult.passed);
			for (const step of plan.steps) step.done = allPassed;

			// Finalize metrics
			this.lastMetrics = mc.finalize(execResult, plan, qaResult, patchResult);

			// Baseline comparison
			if (
				this.config.metrics.enabled &&
				this.config.metrics.baseline &&
				this.config.metrics.persistPath
			) {
				const baselinePath = `${this.config.metrics.persistPath}/baseline.json`;
				const baseline = MetricsCollector.loadBaseline(baselinePath);
				this.lastComparison = MetricsCollector.compare(this.lastMetrics, baseline);
				MetricsCollector.saveBaseline(baselinePath, this.lastMetrics);
			}

			// Store assistant message
			this.messages.push({
				role: "assistant",
				content: [{ type: "text", text: execResult.output }],
			});
			this.state.messageCount = this.messages.length;

			const reason = execResult.success ? "completed" : "error";
			this.state.status = reason === "completed" ? "completed" : "error";

			yield this.makeEvent({ type: "turn:end", turnIndex: 1, stopReason: reason });
			yield this.makeEvent({ type: "terminal", reason, usage: this.usage });

			terminalForSession = { reason, usage: this.usage };
			return terminalForSession;
		} catch (err) {
			this.state.status = "error";
			const msg = err instanceof Error ? err.message : String(err);
			yield this.makeEvent({ type: "error", error: msg, recoverable: false });
			yield this.makeEvent({ type: "terminal", reason: "error", usage: this.usage });
			terminalForSession = { reason: "error", usage: this.usage };
			return terminalForSession;
		} finally {
			await this.notifySessionEnd(terminalForSession);
		}
	}

	private async notifySessionStart(): Promise<void> {
		if (!this.governance) return;
		const session: SessionInfo = {
			sessionId: this.sessionId,
			agentId: this.agentId,
			model: `sdlc:${this.config.execution.mode}`,
			startTime: Date.now(),
			cwd: process.cwd(),
		};
		try {
			await this.governance.onSessionStart(session);
		} catch {
			// Observer failure must not break the pipeline.
		}
	}

	private async notifySessionEnd(result: TerminalResult): Promise<void> {
		if (!this.governance) return;
		const session: SessionInfo = {
			sessionId: this.sessionId,
			agentId: this.agentId,
			model: `sdlc:${this.config.execution.mode}`,
			startTime: Date.now(),
			cwd: process.cwd(),
		};
		try {
			await this.governance.onSessionEnd(session, result);
		} catch {
			// Observer failure must not break the pipeline.
		}
	}

	// ─── Helpers ─────────────────────────────────────────────────

	private makeEvent(payload: InnerEventPayload): InnerEvent {
		return {
			id: randomUUID(),
			timestamp: Date.now(),
			sessionId: this.sessionId,
			agentId: this.agentId,
			...payload,
		} as InnerEvent;
	}

	private statusEvent(text: string): InnerEvent {
		return this.makeEvent({
			type: "message:assistant",
			content: [{ type: "text", text: `[SDLC] ${text}` }],
		});
	}
}

function mergeConfig(defaults: SDLCConfig, partial: Partial<SDLCConfig>): SDLCConfig {
	return {
		modules: {
			taskNormalizer: { ...defaults.modules.taskNormalizer, ...partial.modules?.taskNormalizer },
			contextBuilder: { ...defaults.modules.contextBuilder, ...partial.modules?.contextBuilder },
			planGenerator: { ...defaults.modules.planGenerator, ...partial.modules?.planGenerator },
			executionBridge: { ...defaults.modules.executionBridge, ...partial.modules?.executionBridge },
			patchValidator: { ...defaults.modules.patchValidator, ...partial.modules?.patchValidator },
			qualityGate: { ...defaults.modules.qualityGate, ...partial.modules?.qualityGate },
			retryEngine: { ...defaults.modules.retryEngine, ...partial.modules?.retryEngine },
			outputStandardizer: {
				...defaults.modules.outputStandardizer,
				...partial.modules?.outputStandardizer,
			},
		},
		execution: { ...defaults.execution, ...partial.execution },
		metrics: { ...defaults.metrics, ...partial.metrics },
	};
}
