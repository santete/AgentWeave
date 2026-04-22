/**
 * SDLC governance helper — assembles OuterHarness + ControlPlane for
 * `agentweave pipeline run`. This is the CLI-level assembly point that keeps
 * Inner Harness free of any outer-harness runtime import.
 *
 * Returns a bundle the CLI passes into createSDLCPipeline():
 *   - `outer` is consumed as `GovernanceHandle` (stage audit + session lifecycle)
 *   - `controlPlane` is consumed by AgentLoop inside ExecutionBridge for tool gating
 */

import { createControlPlane } from "@agentweave/control-plane";
import { OuterHarness } from "@agentweave/outer-harness";
import type { AskPersistenceConfig, OuterHarnessConfig } from "@agentweave/outer-harness";
import type { ControlPlane, PermissionConfig } from "@agentweave/types";

export interface SdlcGovernanceBundle {
	outer: OuterHarness;
	controlPlane: ControlPlane;
}

export interface CreateSdlcGovernanceOptions {
	/** Per-run session id used for audit tagging. */
	sessionId: string;
	/** Full OuterHarnessConfig. Required fields are filled with conservative defaults. */
	config?: Partial<OuterHarnessConfig>;
	/** Interactive resolver for `ask` decisions. Takes precedence over config.onAsk. */
	onAsk?: OuterHarnessConfig["onAsk"];
	/** Persist "always allow" decisions across runs. Takes precedence over config.askPersistence. */
	askPersistence?: AskPersistenceConfig;
}

// Default is `permissive`: with no configured rules, SDLC governance acts as
// a pure observer (audit + stage-event stream) instead of gating tool calls.
// Supplying rules via `options.config.permissions` switches to enforce mode
// — any matching deny/ask rule applies as usual.
const DEFAULT_PERMISSIONS: PermissionConfig = {
	mode: "permissive",
	rules: [],
	failMode: "closed",
	timeoutMs: 5_000,
	askTimeoutMs: 60_000,
};

const DEFAULT_OUTER_CONFIG: OuterHarnessConfig = {
	permissions: DEFAULT_PERMISSIONS,
	output: { gateMode: "streaming", filters: [] },
	budget: { warningThreshold: 0.8 },
};

/**
 * Build a ControlPlane + OuterHarness wired together. The caller is
 * responsible for calling `outer.onSessionEnd(...)` on pipeline completion
 * (the SDLCOrchestrator does this via the `GovernanceHandle` interface).
 */
export function createSdlcGovernance(
	options: CreateSdlcGovernanceOptions,
): SdlcGovernanceBundle {
	const merged: OuterHarnessConfig = {
		...DEFAULT_OUTER_CONFIG,
		...options.config,
		permissions: {
			...DEFAULT_PERMISSIONS,
			...(options.config?.permissions ?? {}),
		},
		onAsk: options.onAsk ?? options.config?.onAsk,
		askPersistence: options.askPersistence ?? options.config?.askPersistence,
	};

	const controlPlane = createControlPlane({
		failMode: merged.permissions.failMode,
	});
	const outer = new OuterHarness(merged);
	outer.connectToControlPlane(controlPlane);

	return { outer, controlPlane };
}
