/**
 * REFERENCE IMPLEMENTATION — not production path (post-pivot 2026-04-22).
 * Production agents ship their own glob tool; AgentWeave governs them via
 * hooks + adapters. Kept for the reference agent-loop + tests.
 * See product-spec/POSITIONING.md.
 *
 * ---
 *
 * Glob — Find files matching a glob pattern.
 *
 * SECURITY: Uses execFile (no shell) to prevent injection via pattern/path.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";
import type { ToolDefinition } from "@agentweave/types";

const execFileAsync = promisify(execFile);

export const GlobTool: ToolDefinition<{ pattern: string; path?: string }, string> = {
	name: "Glob",
	description: "Find files matching a glob pattern (e.g. 'src/**/*.ts').",
	parameters: z.object({
		pattern: z.string().describe("Glob pattern to match files"),
		path: z.string().optional().describe("Base directory (default: cwd)"),
	}),
	execute: async ({ pattern, path }, context) => {
		const searchPath = path ?? ".";

		try {
			if (process.platform === "win32") {
				const { stdout } = await execFileAsync(
					"cmd.exe",
					["/c", "dir", "/S", "/B", `${searchPath}\\${pattern}`],
					{ cwd: context.cwd, timeout: 15_000, signal: context.signal },
				);
				const files = stdout.trim().split("\n").filter(Boolean).slice(0, 500);
				return files.length > 0 ? files.join("\n") : "No files found";
			}

			const { stdout } = await execFileAsync(
				"find",
				[searchPath, "-path", pattern, "-type", "f"],
				{ cwd: context.cwd, timeout: 15_000, signal: context.signal },
			);
			const files = stdout.trim().split("\n").filter(Boolean).slice(0, 500);
			return files.length > 0 ? files.join("\n") : "No files found";
		} catch {
			return "No files found";
		}
	},
	metadata: {
		isReadOnly: true,
		isDestructive: false,
		isConcurrencySafe: true,
		category: "search",
		maxDurationMs: 15_000,
	},
};
