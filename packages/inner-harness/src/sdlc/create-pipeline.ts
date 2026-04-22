/**
 * createSDLCPipeline — Standalone factory for the SDLC Engine.
 *
 * Usage (no control-plane or outer-harness required):
 *
 * ```ts
 * import { createSDLCPipeline } from "@agentweave/inner-harness";
 *
 * const pipeline = createSDLCPipeline({
 *   execution: { mode: "process-adapter", processAdapter: { command: "claude" } },
 *   modules: { qualityGate: { enabled: true, checks: [{ type: "test", command: "npm test", required: true }] } },
 * });
 *
 * const gen = pipeline.run("Fix the login bug");
 * for await (const event of gen) { console.log(event.type); }
 * ```
 */

import type { SDLCConfig, LLMCallerFn, GovernanceHandle, ControlPlane } from "@agentweave/types";
import { SDLCOrchestrator } from "./sdlc-orchestrator";
import type { SDLCOrchestratorConfig } from "./sdlc-orchestrator";

export interface CreateSDLCPipelineOptions {
	/** SDLC module configuration. Partially mergeable — missing fields use defaults. */
	modules?: Partial<SDLCConfig["modules"]>;
	/** Execution mode and target agent. */
	execution?: Partial<SDLCConfig["execution"]>;
	/** Metrics configuration. */
	metrics?: Partial<SDLCConfig["metrics"]>;
	/** LLM caller for meta tasks (planning, normalization). Optional. */
	llmCaller?: LLMCallerFn;
	/** Optional governance handle — stage audit + session lifecycle observer. */
	governance?: GovernanceHandle;
	/** Optional ControlPlane — propagated to AgentLoop for tool-call interception. */
	controlPlane?: ControlPlane;
}

/**
 * Create a standalone SDLC pipeline. No control-plane or outer-harness needed.
 * Returns an SDLCOrchestrator that implements InnerHarnessProvider.
 */
export function createSDLCPipeline(options?: CreateSDLCPipelineOptions): SDLCOrchestrator {
	const config: SDLCOrchestratorConfig = {
		llmCaller: options?.llmCaller,
		governance: options?.governance,
		controlPlane: options?.controlPlane,
	};

	if (options?.modules || options?.execution || options?.metrics) {
		config.sdlcConfig = {};
		if (options.modules) {
			config.sdlcConfig.modules = options.modules as SDLCConfig["modules"];
		}
		if (options.execution) {
			config.sdlcConfig.execution = options.execution as SDLCConfig["execution"];
		}
		if (options.metrics) {
			config.sdlcConfig.metrics = options.metrics as SDLCConfig["metrics"];
		}
	}

	return new SDLCOrchestrator(config);
}
