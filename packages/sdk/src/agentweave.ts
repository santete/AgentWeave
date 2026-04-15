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
} from "@agentweave/types";
import { createControlPlane } from "@agentweave/control-plane";
import { AgentLoop } from "@agentweave/inner-harness";
import type { LLMCallResult } from "@agentweave/inner-harness";
import { OuterHarness } from "@agentweave/outer-harness";
import type { OuterHarnessConfig } from "@agentweave/outer-harness";

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

	/** Access inner components for advanced usage. */
	inner: AgentLoop;
	outer: OuterHarness;
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

	// 5. Build the instance
	const instance: HarnessInstance = {
		async run(prompt, runOpts) {
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

		stream(prompt, runOpts) {
			return inner.run(prompt, {
				maxTurns: runOpts?.maxTurns,
				maxBudgetUsd: runOpts?.maxBudgetUsd,
				signal: runOpts?.signal,
			});
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
			inner.setLLMCaller(caller);
		},

		inner,
		outer,
	};

	return instance;
}
