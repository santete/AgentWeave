/**
 * AiderAdapter — Wraps Aider CLI as InnerHarnessProvider.
 * Uses `aider --no-pretty --yes-always --no-git --message <prompt>` for
 * non-interactive, pipe-friendly output.
 *
 * Usage:
 *   const adapter = createAiderAdapter({ model: "sonnet" });
 *   const outer = new OuterHarness(config);
 *   // Wire adapter + outer via SDK
 */

import { ProcessAdapter } from "./process-adapter";
import type { ProcessAdapterConfig } from "./process-adapter";

export interface AiderAdapterConfig {
	/** Model passed to Aider via --model (e.g. "sonnet", "gpt-4o"). */
	model?: string;
	/** Working directory for the agent. */
	cwd?: string;
	/** Additional CLI flags inserted before --message. */
	extraArgs?: string[];
	/** Environment variables (API keys) merged with parent env. */
	env?: Record<string, string>;
}

/**
 * Build the ProcessAdapterConfig for Aider. Exposed for tests and
 * advanced users who want to compose a ProcessAdapter manually.
 *
 * Argument order matters: --message MUST be last so ProcessAdapter's
 * promptMode="arg" appends the prompt as the --message value.
 */
export function buildAiderAdapterConfig(config?: AiderAdapterConfig): ProcessAdapterConfig {
	const args: string[] = ["--no-pretty", "--yes-always", "--no-git"];

	if (config?.model) {
		args.push("--model", config.model);
	}

	if (config?.extraArgs && config.extraArgs.length > 0) {
		args.push(...config.extraArgs);
	}

	args.push("--message");

	return {
		command: "aider",
		args,
		cwd: config?.cwd,
		env: config?.env,
		promptMode: "arg",
		parseJson: false,
		stderr: { capture: true, asEvents: false },
	};
}

/**
 * Create a ProcessAdapter configured for Aider CLI.
 * Requires `aider` to be installed and in PATH (`pip install aider-chat`).
 */
export function createAiderAdapter(config?: AiderAdapterConfig): ProcessAdapter {
	return new ProcessAdapter(buildAiderAdapterConfig(config));
}
