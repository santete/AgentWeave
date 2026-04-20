/**
 * Grep — Search for a regex pattern in files recursively.
 *
 * SECURITY: Uses execFile (no shell) to prevent injection via pattern/path.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";
import type { ToolDefinition } from "@agentweave/types";

const execFileAsync = promisify(execFile);

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

		try {
			if (process.platform === "win32") {
				const { stdout } = await execFileAsync(
					"findstr",
					["/S", "/N", "/R", pattern, `${searchPath}\\*`],
					{ cwd: context.cwd, timeout: 30_000, signal: context.signal },
				);
				return stdout.slice(0, 100_000) || "No matches found";
			}

			const args = ["-rn"];
			if (include) args.push(`--include=${include}`);
			args.push(pattern, searchPath);

			const { stdout } = await execFileAsync("grep", args, {
				cwd: context.cwd,
				timeout: 30_000,
				signal: context.signal,
			});
			// Limit output
			const lines = stdout.split("\n").slice(0, 200).join("\n");
			return lines.slice(0, 100_000) || "No matches found";
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
