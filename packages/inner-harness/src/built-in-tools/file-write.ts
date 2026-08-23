/**
 * REFERENCE IMPLEMENTATION — not production path (post-pivot 2026-04-22).
 * Production agents ship their own file-write tool; AgentWeave governs them
 * via hooks + adapters. Kept for the reference agent-loop + tests.
 * See product-spec/POSITIONING.md.
 *
 * FileWrite — Write content to a file (create or overwrite).
 */

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { ToolDefinition } from "@agentweave/types";
import { z } from "zod";
import { ghiNhanDaGhi, kiemTraTruocKhiGhi } from "../file-access-tracker";
import { boiLoiTep } from "./loi-tep";
import { chuanHoaDuongDan } from "./duong-dan";

export const FileWriteTool: ToolDefinition<
	{ path?: string; file?: string; file_path?: string; filename?: string; content: string },
	string
> = {
	name: "FileWrite",
	description: "Write content to a file. Creates parent directories if needed.",
	parameters: z
		.object({
			path: z.string().optional().describe("File path to write"),
			file: z.string().optional(),
			file_path: z.string().optional(),
			filename: z.string().optional(),
			content: z.string().describe("Content to write"),
		})
		.refine((v) => v.path || v.file || v.file_path || v.filename, {
			message: "path is required",
		}),
	execute: async ({ path, file, file_path, filename, content }, context) => {
		path = path ?? file ?? file_path ?? filename ?? "";
		const absPath = resolve(context.cwd, chuanHoaDuongDan(path));
		// Đè lên file có sẵn mà chưa đọc — hoặc mới đọc được một phần — là ghi mù.
		// Tạo file mới thì không chặn.
		await kiemTraTruocKhiGhi(context.sessionId, absPath, path, true);
		await mkdir(dirname(absPath), { recursive: true });
		await boiLoiTep(path, () => writeFile(absPath, content, "utf-8"));
		// Nội dung mới do chính agent cung cấp trọn vẹn nên nó biết hết file.
		await ghiNhanDaGhi(context.sessionId, absPath, true);
		return `Written ${content.length} bytes to ${path}`;
	},
	metadata: {
		isReadOnly: false,
		isDestructive: false,
		isConcurrencySafe: false,
		category: "file",
	},
};
