/**
 * FileRead — Read file contents with optional line range.
 */

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { z } from "zod";
import type { ToolDefinition } from "@agentweave/types";

export const FileReadTool: ToolDefinition<{ path: string; offset?: number; limit?: number }, string> = {
	name: "FileRead",
	description: "Read the contents of a file. Supports optional line offset and limit.",
	parameters: z.object({
		path: z.string().describe("File path (relative to cwd or absolute)"),
		offset: z.number().int().min(0).optional().describe("Start from this line number (0-based)"),
		limit: z.number().int().positive().optional().describe("Max lines to read"),
	}),
	execute: async ({ path, offset, limit }, context) => {
		const absPath = resolve(context.cwd, path);
		const content = await readFile(absPath, "utf-8");

		if (offset !== undefined || limit !== undefined) {
			const lines = content.split("\n");
			const start = offset ?? 0;
			const end = limit ? start + limit : lines.length;
			return lines.slice(start, end).map((l, i) => `${start + i + 1}\t${l}`).join("\n");
		}

		return content.slice(0, 200_000); // 200KB cap
	},
	metadata: {
		isReadOnly: true,
		isDestructive: false,
		isConcurrencySafe: true,
		category: "file",
		maxOutputSize: 200_000,
	},
};
