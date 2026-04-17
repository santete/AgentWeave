/**
 * createHarness() — Main entry point for AgentWeave SDK.
 * Wires Inner Harness + Control Plane + Outer Harness into a single governed agent.
 */

import type {
	InnerEvent,
	TerminalResult,
	ToolDefinition,
	PermissionRule,
	OutputFilter,
	TokenUsage,
	InnerState,
	Message,
	AgentSpawnConfig,
	AgentInfo,
	AgentMessage,
	AgentMessageType,
	PluginManifest,
	PluginContext,
} from "@agentweave/types";
import { createControlPlane } from "@agentweave/control-plane";
import { AgentLoop } from "@agentweave/inner-harness";
import type { LLMCallResult } from "@agentweave/inner-harness";
import { OuterHarness, MultiAgentOrchestrator, PluginLoader } from "@agentweave/outer-harness";
import type { OuterHarnessConfig, LoadedPlugin } from "@agentweave/outer-harness";

// ─── Public Config (simplified for SDK consumers) ────────────────

export interface CreateHarnessOptions {
	/** LLM model to use (e.g. "claude-sonnet-4-6") */
	model: string;
	/** Fallback model if primary fails */
	fallbackModel?: string;
	/** System prompt for the agent */
	systemPrompt?: string;
	/** Max turns before auto-stop (default 100) */
	maxTurns?: number;
	/** Enable thinking/reasoning tokens (default true) */
	thinkingEnabled?: boolean;

	/** Tools to register */
	tools?: ToolDefinition[];

	/** Permission rules */
	permissions?: {
		mode?: "default" | "strict" | "permissive" | "plan";
		rules?: PermissionRule[];
		failMode?: "open" | "closed";
	};

	/** Output filtering */
	output?: {
		filters?: OutputFilter[];
		gateMode?: "streaming" | "batch" | "auto";
	};

	/** Budget limits */
	budget?: {
		maxPerSession?: number;
		maxPerDay?: number;
		warningThreshold?: number;
	};

	/** Multi-agent orchestration */
	multiAgent?: {
		maxConcurrentAgents?: number;
		totalBudgetUsd?: number;
	};

	/** Plugins — inline manifests for direct registration. */
	plugins?: PluginManifest[];
}

// ─── Harness Instance ────────────────────────────────────────────

export interface HarnessInstance {
	/** Run the agent with a prompt. Returns collected events + terminal result. */
	run(prompt: string, options?: RunInstanceOptions): Promise<RunResult>;

	/** Stream events from the agent in real-time. */
	stream(
		prompt: string,
		options?: RunInstanceOptions,
	): AsyncGenerator<InnerEvent, TerminalResult, void>;

	/** Abort the current run. */
	abort(reason?: string): void;

	/** Get current agent state. */
	getState(): InnerState;

	/** Get accumulated token usage. */
	getUsage(): TokenUsage;

	/** Set a custom LLM caller (for testing or custom providers). */
	setLLMCaller(
		caller: (
			messages: ReadonlyArray<Message>,
			model: string,
		) => Promise<LLMCallResult>,
	): void;

	/** Spawn a child agent (requires multiAgent config). */
	spawnAgent(config: AgentSpawnConfig): AgentHandle;

	/** Get the multi-agent orchestrator (null if not configured). */
	getOrchestrator(): MultiAgentOrchestrator | null;

	/** Get loaded plugins. */
	getPlugins(): ReadonlyArray<LoadedPlugin>;

	/** Access inner components for advanced usage. */
	inner: AgentLoop;
	outer: OuterHarness;
}

// ─── Agent Handle (child agent) ─────────────────────────────────

export interface AgentHandle {
	/** Agent ID from orchestrator. */
	readonly id: string;
	/** Agent name. */
	readonly name: string;
	/** Run the child agent to completion. */
	run(options?: RunInstanceOptions): Promise<RunResult>;
	/** Stream events from the child agent. */
	stream(options?: RunInstanceOptions): AsyncGenerator<InnerEvent, TerminalResult, void>;
	/** Abort the child agent. */
	abort(reason?: string): void;
	/** Get agent info snapshot from orchestrator. */
	getInfo(): AgentInfo;
	/** Send a message to this agent's queue. */
	send(from: string, type: AgentMessageType, payload: unknown): void;
	/** Drain pending messages for this agent. */
	receive(): AgentMessage[];
	/** Set a custom LLM caller for this child. */
	setLLMCaller(
		caller: (
			messages: ReadonlyArray<Message>,
			model: string,
		) => Promise<LLMCallResult>,
	): void;
	/** The child's inner AgentLoop (advanced). */
	inner: AgentLoop;
}

export interface RunInstanceOptions {
	maxTurns?: number;
	maxBudgetUsd?: number;
	signal?: AbortSignal;
}

export interface RunResult {
	result: TerminalResult;
	events: InnerEvent[];
}

// ─── Factory ─────────────────────────────────────────────────────

export function createHarness(options: CreateHarnessOptions): HarnessInstance {
	// 1. Create Control Plane
	const failMode = options.permissions?.failMode ?? "closed";
	const controlPlane = createControlPlane({ failMode });

	// 2. Build Outer Harness config
	const outerConfig: OuterHarnessConfig = {
		permissions: {
			mode: options.permissions?.mode ?? "default",
			rules: options.permissions?.rules ?? [],
			failMode,
			timeoutMs: 5000,
			askTimeoutMs: 60000,
		},
		output: {
			gateMode: options.output?.gateMode ?? "auto",
			filters: options.output?.filters ?? [],
		},
		budget: {
			maxPerSession: options.budget?.maxPerSession,
			maxPerDay: options.budget?.maxPerDay,
			warningThreshold: options.budget?.warningThreshold ?? 0.8,
		},
		multiAgent: options.multiAgent
			? {
					maxConcurrentAgents: options.multiAgent.maxConcurrentAgents ?? 5,
					totalBudgetUsd: options.multiAgent.totalBudgetUsd ?? 50,
					conflictStrategy: "sequential",
				}
			: undefined,
	};

	// 3. Create Outer Harness and connect to Control Plane
	const outer = new OuterHarness(outerConfig);
	outer.connectToControlPlane(controlPlane);

	// 4. Create Inner Harness (AgentLoop)
	const inner = new AgentLoop({
		controlPlane,
		model: options.model,
		fallbackModel: options.fallbackModel,
		tools: options.tools,
		systemPrompt: options.systemPrompt,
		maxTurns: options.maxTurns,
		thinkingEnabled: options.thinkingEnabled,
	});

	// Track the current LLM caller so children can inherit it
	let currentLLMCaller:
		| ((messages: ReadonlyArray<Message>, model: string) => Promise<LLMCallResult>)
		| null = null;

	// 5. Load plugins (sync: inline manifests only — path-based is async via activateAll)
	const pluginLoader = new PluginLoader();
	const pluginContext: PluginContext = {
		version: "0.5.1",
		projectRoot: process.cwd(),
		dataDir: "",
	};

	/** Load and activate all inline plugins. Registers tools + hooks. */
	async function loadPlugins(): Promise<void> {
		if (!options.plugins) return;
		for (const manifest of options.plugins) {
			const loaded = await pluginLoader.loadFromManifest(manifest, pluginContext);
			if (loaded.registration.tools) {
				for (const tool of loaded.registration.tools) {
					inner.registerTool(tool);
				}
			}
			if (loaded.registration.hooks) {
				for (const hook of loaded.registration.hooks) {
					outer.getHookEngine().addHook(hook.event, hook.definition);
				}
			}
		}
	}

	// Kick off plugin loading — awaited before first run()/stream()
	const pluginsReady = loadPlugins();

	// 6. Build the instance
	const instance: HarnessInstance = {
		async run(prompt, runOpts) {
			await pluginsReady; // Ensure plugins loaded before execution
			const events: InnerEvent[] = [];
			let terminalResult: TerminalResult = { reason: "completed" };

			const gen = inner.run(prompt, {
				maxTurns: runOpts?.maxTurns,
				maxBudgetUsd: runOpts?.maxBudgetUsd,
				signal: runOpts?.signal,
			});

			for (;;) {
				const { value, done } = await gen.next();
				if (done) {
					terminalResult = value;
					break;
				}
				events.push(value);
			}

			return { result: terminalResult, events };
		},

		async *stream(prompt, runOpts) {
			await pluginsReady; // Ensure plugins loaded before execution
			const gen = inner.run(prompt, {
				maxTurns: runOpts?.maxTurns,
				maxBudgetUsd: runOpts?.maxBudgetUsd,
				signal: runOpts?.signal,
			});
			for (;;) {
				const { value, done } = await gen.next();
				if (done) return value;
				yield value;
			}
		},

		abort(reason) {
			inner.abort(reason);
		},

		getState() {
			return inner.getState();
		},

		getUsage() {
			return inner.getUsage();
		},

		setLLMCaller(caller) {
			currentLLMCaller = caller;
			inner.setLLMCaller(caller);
		},

		spawnAgent(config) {
			return createAgentHandle(config, {
				orchestrator: outer.getOrchestrator(),
				parentOptions: options,
				outerConfig,
				failMode,
				currentLLMCaller,
			});
		},

		getOrchestrator() {
			return outer.getOrchestrator();
		},

		getPlugins() {
			return pluginLoader.getLoaded();
		},

		inner,
		outer,
	};

	return instance;
}

// ─── Child Agent Factory ────────────────────────────────────────

interface SpawnContext {
	orchestrator: MultiAgentOrchestrator | null;
	parentOptions: CreateHarnessOptions;
	outerConfig: OuterHarnessConfig;
	failMode: "open" | "closed";
	currentLLMCaller:
		| ((messages: ReadonlyArray<Message>, model: string) => Promise<LLMCallResult>)
		| null;
}

function createAgentHandle(
	config: AgentSpawnConfig,
	ctx: SpawnContext,
): AgentHandle {
	const { orchestrator, parentOptions, failMode } = ctx;

	if (!orchestrator) {
		throw new Error(
			"multiAgent not configured. Pass multiAgent option to createHarness().",
		);
	}

	// Register with orchestrator (validates budget + concurrency)
	const agentInfo = orchestrator.spawn(config);

	// Create child ControlPlane
	const childCP = createControlPlane({ failMode });

	// Create child OuterHarness — inherits parent output config, uses child permissions/budget
	const childOuter = new OuterHarness({
		permissions: {
			mode: config.permissions?.mode ?? ctx.outerConfig.permissions.mode,
			rules: config.permissions?.rules ?? ctx.outerConfig.permissions.rules,
			failMode,
			timeoutMs: 5000,
			askTimeoutMs: 60000,
		},
		output: ctx.outerConfig.output,
		budget: {
			maxPerSession: config.budgetUsd,
			warningThreshold: 0.8,
		},
	});
	childOuter.connectToControlPlane(childCP);

	// Create child AgentLoop
	const childInner = new AgentLoop({
		controlPlane: childCP,
		model: config.model ?? parentOptions.model,
		tools: parentOptions.tools,
		systemPrompt: parentOptions.systemPrompt,
		maxTurns: config.maxTurns,
	});

	// Inherit parent LLM caller
	if (ctx.currentLLMCaller) {
		childInner.setLLMCaller(ctx.currentLLMCaller);
	}

	// Timeout management
	let timeoutTimer: ReturnType<typeof setTimeout> | undefined;

	const handle: AgentHandle = {
		id: agentInfo.id,
		name: agentInfo.name,

		async run(runOpts) {
			orchestrator.markRunning(agentInfo.id);

			if (config.timeoutMs) {
				timeoutTimer = setTimeout(() => {
					childInner.abort("timeout");
				}, config.timeoutMs);
			}

			try {
				const events: InnerEvent[] = [];
				let terminalResult: TerminalResult = { reason: "completed" };

				const gen = childInner.run(config.prompt, {
					maxTurns: runOpts?.maxTurns ?? config.maxTurns,
					maxBudgetUsd: config.budgetUsd,
					signal: runOpts?.signal,
				});

				for (;;) {
					const { value, done } = await gen.next();
					if (done) {
						terminalResult = value;
						break;
					}
					events.push(value);

					// Track cost delta in orchestrator
					if (value.type === "llm:stream_end" && value.usage) {
						const cost = value.usage.totalCost;
						if (cost > 0) {
							orchestrator.addCost(agentInfo.id, cost);
						}
					}
				}

				if (!isTerminal(orchestrator.getAgent(agentInfo.id))) {
					if (terminalResult.reason === "aborted") {
						orchestrator.markAborted(agentInfo.id);
					} else {
						orchestrator.markCompleted(agentInfo.id, terminalResult);
					}
				}
				return { result: terminalResult, events };
			} catch (err) {
				if (!isTerminal(orchestrator.getAgent(agentInfo.id))) {
					orchestrator.markFailed(agentInfo.id, err instanceof Error ? err.message : String(err));
				}
				throw err;
			} finally {
				if (timeoutTimer) clearTimeout(timeoutTimer);
			}
		},

		async *stream(runOpts) {
			orchestrator.markRunning(agentInfo.id);

			if (config.timeoutMs) {
				timeoutTimer = setTimeout(() => {
					childInner.abort("timeout");
				}, config.timeoutMs);
			}

			try {
				const gen = childInner.run(config.prompt, {
					maxTurns: runOpts?.maxTurns ?? config.maxTurns,
					maxBudgetUsd: config.budgetUsd,
					signal: runOpts?.signal,
				});

				for (;;) {
					const { value, done } = await gen.next();
					if (done) {
						if (!isTerminal(orchestrator.getAgent(agentInfo.id))) {
							if (value.reason === "aborted") {
								orchestrator.markAborted(agentInfo.id);
							} else {
								orchestrator.markCompleted(agentInfo.id, value);
							}
						}
						return value;
					}

					if (value.type === "llm:stream_end" && value.usage) {
						const cost = value.usage.totalCost;
						if (cost > 0) {
							orchestrator.addCost(agentInfo.id, cost);
						}
					}

					yield value;
				}
			} catch (err) {
				if (!isTerminal(orchestrator.getAgent(agentInfo.id))) {
					orchestrator.markFailed(agentInfo.id, err instanceof Error ? err.message : String(err));
				}
				throw err;
			} finally {
				if (timeoutTimer) clearTimeout(timeoutTimer);
			}
		},

		abort(reason) {
			childInner.abort(reason);
			try {
				orchestrator.markAborted(agentInfo.id);
			} catch {
				// Already in terminal state — ignore
			}
		},

		getInfo() {
			return orchestrator.getAgent(agentInfo.id)!;
		},

		send(from, type, payload) {
			orchestrator.send(from, agentInfo.id, type, payload);
		},

		receive() {
			return orchestrator.receive(agentInfo.id);
		},

		setLLMCaller(caller) {
			childInner.setLLMCaller(caller);
		},

		inner: childInner,
	};

	return handle;
}

function isTerminal(agent: AgentInfo | undefined): boolean {
	if (!agent) return true;
	return agent.state === "completed" || agent.state === "failed" || agent.state === "aborted";
}
