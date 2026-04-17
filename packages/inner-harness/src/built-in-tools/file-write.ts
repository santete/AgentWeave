/**
 * FileWrite — Write content to a file (create or overwrite).
 */

import { writeFile, mkdir } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { z } from "zod";
import type { ToolDefinition } from "@agentweave/types";

export const FileWriteTool: ToolDefinition<{ path: string; content: string }, string> = {
	name: "FileWrite",
	description: "Write content to a file. Creates parent directories if needed.",
	parameters: z.object({
		path: z.string().describe("File path to write"),
		content: z.string().describe("Content to write"),
	}),
	execute: async ({ path, content }, context) => {
		const absPath = resolve(context.cwd, path);
		await mkdir(dirname(absPath), { recursive: true });
		await writeFile(absPath, content, "utf-8");
		return `Written ${content.length} bytes to ${path}`;
	},
	metadata: {
		isReadOnly: false,
		isDestructive: false,
		isConcurrencySafe: false,
		category: "file",
	},
};
