/**
 * FileEdit — Replace a string in a file (exact match).
 */

import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { z } from "zod";
import type { ToolDefinition } from "@agentweave/types";

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
		return `Edited ${path}: replaced ${old_string.length} chars with ${new_string.length} chars`;
	},
	metadata: {
		isReadOnly: false,
		isDestructive: false,
		isConcurrencySafe: false,
		category: "file",
	},
};
