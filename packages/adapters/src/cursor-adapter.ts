/**
 * CursorAdapter — Wraps the Cursor headless CLI (`cursor-agent -p`) as an
 * InnerHarnessProvider via ProcessAdapter.
 *
 * Usage:
 *   const adapter = createCursorAdapter({ model: "sonnet-4" });
 *   const outer = new OuterHarness(config);
 *   // Wire adapter + outer via SDK
 *
 * See docs/adapters/cursor-integration.md for the spike that picked this surface.
 */

import { ProcessAdapter } from "./process-adapter";
import type { ProcessAdapterConfig } from "./process-adapter";

export interface CursorAdapterConfig {
	/** Model passed to Cursor via `-m` (e.g. "sonnet-4", "gpt-5"). */
	model?: string;
	/** Working directory for the agent. */
	cwd?: string;
	/** Additional CLI flags inserted before `-p`. */
	extraArgs?: string[];
	/** Environment variables (e.g. CURSOR_API_KEY) merged with parent env. */
	env?: Record<string, string>;
	/** Skip workspace-trust / MCP-confirmation prompts. Default: true (non-interactive). */
	force?: boolean;
}

/**
 * Build the ProcessAdapterConfig for Cursor. Exposed for tests and advanced
 * users who want to compose a ProcessAdapter manually.
 *
 * Argument order matters: `-p` MUST be last so ProcessAdapter's
 * promptMode="arg" appends the prompt as the `-p` value.
 */
export function buildCursorAdapterConfig(config?: CursorAdapterConfig): ProcessAdapterConfig {
	const args: string[] = [];

	// Default to non-interactive unless caller explicitly opts out.
	if (config?.force !== false) {
		args.push("--force");
	}

	if (config?.model) {
		args.push("-m", config.model);
	}

	if (config?.extraArgs && config.extraArgs.length > 0) {
		args.push(...config.extraArgs);
	}

	args.push("-p");

	return {
		command: "cursor-agent",
		args,
		cwd: config?.cwd,
		env: config?.env,
		promptMode: "arg",
		parseJson: false,
		stderr: { capture: true, asEvents: false },
	};
}

/**
 * Create a ProcessAdapter configured for the Cursor headless CLI.
 * Requires `cursor-agent` on PATH and a valid Cursor session or CURSOR_API_KEY.
 */
export function createCursorAdapter(config?: CursorAdapterConfig): ProcessAdapter {
	return new ProcessAdapter(buildCursorAdapterConfig(config));
}
