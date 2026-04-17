/**
 * Bash — Execute shell commands with timeout and cwd support.
 */

import { exec } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";
import type { ToolDefinition } from "@agentweave/types";

const execAsync = promisify(exec);

export const BashTool: ToolDefinition<{ command: string; timeout?: number }, string> = {
	name: "Bash",
	description: "Execute a bash/shell command and return stdout + stderr.",
	parameters: z.object({
		command: z.string().describe("The shell command to execute"),
		timeout: z.number().positive().optional().describe("Timeout in ms (default 120000)"),
	}),
	execute: async ({ command, timeout }, context) => {
		const { stdout, stderr } = await execAsync(command, {
			cwd: context.cwd,
			timeout: timeout ?? 120_000,
			signal: context.signal,
		});
		const output = stdout + (stderr ? `\nstderr:\n${stderr}` : "");
		return output.slice(0, 100_000); // Cap output at 100KB
	},
	metadata: {
		isReadOnly: false,
		isDestructive: true,
		isConcurrencySafe: false,
		category: "shell",
		maxDurationMs: 120_000,
		maxOutputSize: 100_000,
	},
};
