/**
 * REFERENCE IMPLEMENTATION — not production path (post-pivot 2026-04-22).
 * Production agents ship their own file-edit tool; AgentWeave governs them
 * via hooks + adapters. Kept for the reference agent-loop + tests.
 * See product-spec/POSITIONING.md.
 *
 * FileEdit — Replace a string in a file (exact match).
 */

import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { z } from "zod";
import type { ToolDefinition } from "@agentweave/types";
import { ghiNhanDaGhi } from "../file-access-tracker";

export const FileEditTool: ToolDefinition<{ path: string; old_string: string; new_string: string }, string> = {
	name: "FileEdit",
	description: "Replace an exact string in a file. old_string must be unique in the file.",
	parameters: z.object({
		path: z.string().describe("File path"),
		old_string: z.string().describe("Exact string to find (must be unique in file)"),
		new_string: z.string().describe("Replacement string"),
	}),
	execute: async ({ path, old_string, new_string }, context) => {
		const absPath = resolve(context.cwd, path);
		const content = await readFile(absPath, "utf-8");

		const count = content.split(old_string).length - 1;
		if (count === 0) {
			throw new Error(`String not found in ${path}`);
		}
		if (count > 1) {
			throw new Error(`String found ${count} times in ${path} — must be unique`);
		}

		const updated = content.replace(old_string, new_string);
		await writeFile(absPath, updated, "utf-8");
		// FileEdit tự đọc lại và đòi old_string khớp DUY NHẤT, nên nó không cần
		// bắt buộc đọc trước như FileWrite. Vẫn ghi dấu để lượt FileWrite sau
		// không bị chặn oan.
		await ghiNhanDaGhi(context.sessionId, absPath);
		return `Edited ${path}: replaced ${old_string.length} chars with ${new_string.length} chars`;
	},
	metadata: {
		isReadOnly: false,
		isDestructive: false,
		isConcurrencySafe: false,
		category: "file",
	},
};
