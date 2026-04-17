/**
 * ClaudeCodeAdapter — Wraps Claude Code CLI as InnerHarnessProvider.
 * Uses `claude --json --output-format stream-json` for structured output.
 *
 * Usage:
 *   const adapter = createClaudeCodeAdapter({ model: "sonnet" });
 *   const outer = new OuterHarness(config);
 *   // Wire adapter + outer via SDK
 */

import { ProcessAdapter } from "./process-adapter";
import type { ProcessAdapterConfig } from "./process-adapter";

export interface ClaudeCodeAdapterConfig {
	/** Claude Code model (default: "sonnet"). */
	model?: string;
	/** Working directory for the agent. */
	cwd?: string;
	/** Additional CLI flags. */
	extraArgs?: string[];
}

/**
 * Create a ProcessAdapter configured for Claude Code CLI.
 * Requires `claude` to be installed and in PATH.
 */
export function createClaudeCodeAdapter(config?: ClaudeCodeAdapterConfig): ProcessAdapter {
	const model = config?.model ?? "sonnet";
	const args = [
		"--print",
		"--output-format", "stream-json",
		"--model", model,
		...(config?.extraArgs ?? []),
	];

	const adapterConfig: ProcessAdapterConfig = {
		command: "claude",
		args,
		cwd: config?.cwd,
		promptMode: "arg",
		parseJson: true,
	};

	return new ProcessAdapter(adapterConfig);
}
