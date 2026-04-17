/**
 * Glob — Find files matching a glob pattern.
 */

import { exec } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";
import type { ToolDefinition } from "@agentweave/types";

const execAsync = promisify(exec);

export const GlobTool: ToolDefinition<{ pattern: string; path?: string }, string> = {
	name: "Glob",
	description: "Find files matching a glob pattern (e.g. 'src/**/*.ts').",
	parameters: z.object({
		pattern: z.string().describe("Glob pattern to match files"),
		path: z.string().optional().describe("Base directory (default: cwd)"),
	}),
	execute: async ({ pattern, path }, context) => {
		const searchPath = path ?? ".";

		// Use find on Unix, dir on Windows
		const isWindows = process.platform === "win32";
		const cmd = isWindows
			? `dir /S /B "${searchPath}\\${pattern}" 2>NUL`
			: `find ${searchPath} -path '${pattern}' -type f 2>/dev/null | head -500`;

		try {
			const { stdout } = await execAsync(cmd, {
				cwd: context.cwd,
				timeout: 15_000,
				signal: context.signal,
			});
			const files = stdout.trim().split("\n").filter(Boolean);
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
