/**
 * Grep — Search for a regex pattern in files recursively.
 */

import { exec } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";
import type { ToolDefinition } from "@agentweave/types";

const execAsync = promisify(exec);

export const GrepTool: ToolDefinition<{ pattern: string; path?: string; include?: string }, string> = {
	name: "Grep",
	description: "Search for a regex pattern in files. Returns matching lines with file paths and line numbers.",
	parameters: z.object({
		pattern: z.string().describe("Regex pattern to search for"),
		path: z.string().optional().describe("Directory to search in (default: cwd)"),
		include: z.string().optional().describe("File glob to filter (e.g. '*.ts')"),
	}),
	execute: async ({ pattern, path, include }, context) => {
		const searchPath = path ?? ".";
		const includeFlag = include ? `--include='${include}'` : "";

		// Use grep -rn for recursive search with line numbers
		// Fallback to findstr on Windows
		const isWindows = process.platform === "win32";
		const cmd = isWindows
			? `findstr /S /N /R "${pattern}" ${searchPath}\\*`
			: `grep -rn ${includeFlag} '${pattern}' ${searchPath} 2>/dev/null | head -200`;

		try {
			const { stdout } = await execAsync(cmd, {
				cwd: context.cwd,
				timeout: 30_000,
				signal: context.signal,
			});
			return stdout.slice(0, 100_000) || "No matches found";
		} catch {
			return "No matches found";
		}
	},
	metadata: {
		isReadOnly: true,
		isDestructive: false,
		isConcurrencySafe: true,
		category: "search",
		maxDurationMs: 30_000,
	},
};
