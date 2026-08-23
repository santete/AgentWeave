/**
 * REFERENCE IMPLEMENTATION — not production path (post-pivot 2026-04-22).
 * Production agents ship their own file-edit tool; AgentWeave governs them
 * via hooks + adapters. Kept for the reference agent-loop + tests.
 * See product-spec/POSITIONING.md.
 *
 * FileEdit — Replace a string in a file (exact match).
 */

import { readFile, writeFile } from "node:fs/promises";
import { boiLoiTep } from "./loi-tep";
import { resolve } from "node:path";
import type { ToolDefinition } from "@agentweave/types";
import { z } from "zod";
import { ghiNhanDaGhi } from "../file-access-tracker";
import { chuanHoaDuongDan } from "./duong-dan";

export const FileEditTool: ToolDefinition<
	{ path?: string; file?: string; file_path?: string; old_string: string; new_string: string },
	string
> = {
	name: "FileEdit",
	description: "Replace an exact string in a file. old_string must be unique in the file.",
	parameters: z
		.object({
			path: z.string().optional().describe("File path"),
			file: z.string().optional(),
			file_path: z.string().optional(),
			old_string: z.string().describe("Exact string to find (must be unique in file)"),
			new_string: z.string().describe("Replacement string"),
		})
		.refine((v) => v.path || v.file || v.file_path, { message: "path is required" }),
	execute: async ({ path, file, file_path, old_string, new_string }, context) => {
		path = path ?? file ?? file_path ?? "";
		const absPath = resolve(context.cwd, chuanHoaDuongDan(path));
		const content = await boiLoiTep(path, () => readFile(absPath, "utf-8"));

		const count = content.split(old_string).length - 1;
		if (count === 0) {
			throw new Error(`String not found in ${path}`);
		}
		if (count > 1) {
			throw new Error(`String found ${count} times in ${path} — must be unique`);
		}

		const updated = content.replace(old_string, new_string);
		await boiLoiTep(path, () => writeFile(absPath, updated, "utf-8"));
		// FileEdit tự đọc lại và đòi old_string khớp DUY NHẤT, nên nó không cần
		// bắt buộc đọc trước như FileWrite. Ghi dấu mtime mới để lượt sửa tiếp
		// theo không bị chặn oan — nhưng KHÔNG xoá cờ đọc-thiếu, vì thay một đoạn
		// không làm agent nhìn thấy phần còn lại của file.
		await ghiNhanDaGhi(context.sessionId, absPath, false);
		return `Edited ${path}: replaced ${old_string.length} chars with ${new_string.length} chars`;
	},
	metadata: {
		isReadOnly: false,
		isDestructive: false,
		isConcurrencySafe: false,
		category: "file",
	},
};
