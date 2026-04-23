import { randomUUID } from "node:crypto";
import type { SDLCModuleContext, SDLCConfig } from "@agentweave/types";
import { MetricsCollector, getDefaultSDLCConfig } from "@agentweave/inner-harness";

export interface BuildContextOptions {
	/**
	 * Abort signal — required so that MCP client cancellations propagate into
	 * long-running module work (spawned processes, validation loops). Callers
	 * thread `extra.signal` from the MCP tool handler.
	 */
	signal: AbortSignal;
	cwd?: string;
	configOverrides?: Partial<SDLCConfig["modules"]>;
}

/**
 * Build a minimal SDLCModuleContext suitable for invoking individual
 * verification modules from the MCP server. Not tied to any orchestrator
 * run — each MCP tool call gets its own fresh context + MetricsCollector.
 */
export function buildStandaloneContext(opts: BuildContextOptions): {
	context: SDLCModuleContext;
	collector: MetricsCollector;
} {
	const baseConfig = getDefaultSDLCConfig();
	const config: SDLCConfig = {
		...baseConfig,
		modules: { ...baseConfig.modules, ...opts.configOverrides },
	};

	const collector = new MetricsCollector(`mcp-${randomUUID()}`);
	const context: SDLCModuleContext = {
		sessionId: `mcp-${randomUUID()}`,
		cwd: opts.cwd ?? process.cwd(),
		signal: opts.signal,
		config,
		metrics: collector.createHandle(),
	};
	return { context, collector };
}
