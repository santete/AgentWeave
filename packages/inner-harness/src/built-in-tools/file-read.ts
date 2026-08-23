/**
 * REFERENCE IMPLEMENTATION — not production path (post-pivot 2026-04-22).
 * Production agents ship their own file-read tool; AgentWeave governs them
 * via hooks + adapters. Kept for the reference agent-loop + tests.
 * See product-spec/POSITIONING.md.
 *
 * FileRead — Read file contents with optional line range.
 */

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { ToolDefinition } from "@agentweave/types";
import { z } from "zod";
import { ghiNhanDaDoc } from "../file-access-tracker";
import { chuanHoaDuongDan } from "./duong-dan";

export const FileReadTool: ToolDefinition<
	{
		path?: string;
		file?: string;
		file_path?: string;
		filename?: string;
		offset?: number;
		limit?: number;
	},
	string
> = {
	name: "FileRead",
	description: "Read the contents of a file. Supports optional line offset and limit.",
	parameters: z
		.object({
			path: z.string().optional().describe("File path (relative to cwd or absolute)"),
			// Model cục bộ hay gọi nhầm tên tham số — chấp nhận alias thay vì trả
			// lỗi validate rồi để nó mò (đo thật: a3b gọi {"file":...} liên tục).
			file: z.string().optional(),
			file_path: z.string().optional(),
			filename: z.string().optional(),
			offset: z.number().int().min(0).optional().describe("Start from this line number (0-based)"),
			limit: z.number().int().positive().optional().describe("Max lines to read"),
		})
		.refine((v) => v.path || v.file || v.file_path || v.filename, {
			message: "path is required",
		}),
	execute: async ({ path, file, file_path, filename, offset, limit }, context) => {
		path = path ?? file ?? file_path ?? filename ?? "";
		const absPath = resolve(context.cwd, chuanHoaDuongDan(path));
		const content = await readFile(absPath, "utf-8");

		if (offset !== undefined || limit !== undefined) {
			const lines = content.split("\n");
			const start = Math.min(offset ?? 0, lines.length);
			const end = Math.min(limit ? start + limit : lines.length, lines.length);
			const than = lines
				.slice(start, end)
				.map((l, i) => `${start + i + 1}\t${l}`)
				.join("\n");

			// Đọc một khoảng dòng = KHÔNG nhìn thấy phần còn lại. Ghi dấu để
			// FileWrite không đè cả file dựa trên khoảng này.
			const thieu = start > 0 || end < lines.length;
			await ghiNhanDaDoc(context.sessionId, absPath, thieu);
			return thieu ? `${canhBao(`lines ${start + 1}-${end} of ${lines.length}`)}\n${than}` : than;
		}

		// Trần 200 KB để một file khổng lồ không nuốt sạch ngữ cảnh. Nhưng cắt IM
		// LẶNG thì model tưởng đã thấy hết rồi ghi đè — phần không thấy biến mất
		// mà không ai biết. Phải nói ra, và phải ghi dấu là đọc thiếu.
		if (content.length > TRAN) {
			await ghiNhanDaDoc(context.sessionId, absPath, true);
			return `${canhBao(`first ${TRAN} bytes of ${content.length}`)}\n${content.slice(0, TRAN)}`;
		}

		// Ghi dấu để FileEdit/FileWrite biết agent đã thật sự nhìn thấy cả file.
		await ghiNhanDaDoc(context.sessionId, absPath, false);
		return content;
	},
	metadata: {
		isReadOnly: true,
		isDestructive: false,
		isConcurrencySafe: true,
		category: "file",
		maxOutputSize: 200_000,
	},
};

const TRAN = 200_000;

/**
 * Cảnh báo đọc thiếu, đặt ở ĐẦU output.
 *
 * Cùng lý do như mã thoát trong Bash: model phải biết ngay dòng đầu rằng nó chỉ
 * đang nhìn một phần, chứ không phải tự suy ra từ chỗ nội dung đứt đột ngột.
 */
function canhBao(pham: string): string {
	return (
		`[PARTIAL READ — showing ${pham}. The rest of this file was NOT read. ` +
		`FileWrite on it is blocked until you have read all of it; use FileEdit instead.]`
	);
}
