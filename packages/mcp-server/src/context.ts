import { randomUUID } from "node:crypto";
import type { SDLCModuleContext, SDLCConfig } from "@agentweave/types";
import { MetricsCollector, getDefaultSDLCConfig } from "@agentweave/inner-harness";

export interface BuildContextOptions {
	cwd?: string;
	signal?: AbortSignal;
	configOverrides?: Partial<SDLCConfig["modules"]>;
}

/**
 * Build a minimal SDLCModuleContext suitable for invoking individual
 * verification modules from the MCP server. Not tied to any orchestrator
 * run — each MCP tool call gets its own fresh context + MetricsCollector.
 */
export function buildStandaloneContext(opts: BuildContextOptions = {}): {
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
		signal: opts.signal ?? new AbortController().signal,
		config,
		metrics: collector.createHandle(),
	};
	return { context, collector };
}
