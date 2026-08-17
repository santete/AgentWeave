/**
 * REFERENCE IMPLEMENTATION — not production path (post-pivot 2026-04-22).
 * Production agents ship their own glob tool; AgentWeave governs them via
 * hooks + adapters. Kept for the reference agent-loop + tests.
 * See product-spec/POSITIONING.md.
 *
 * ---
 *
 * Glob — Find files matching a glob pattern.
 *
 * Dùng `fs.glob` của Node 22 thay vì gọi `find`. Bản trước chạy
 * `find <path> -path <pattern> -type f`, sai ngữ nghĩa ở hai chỗ:
 *   ① `find -path` so khớp CẢ đường dẫn, mà đường dẫn bắt đầu bằng "./" nên
 *      mẫu chuẩn "test/**\/*.js" không bao giờ khớp
 *   ② `**` không có nghĩa đặc biệt với `find`; `*` vốn đã vượt qua "/"
 * Hậu quả đo được: mẫu mọi agent đều sinh ra trả về "No files found" trong khi
 * tệp tồn tại — model kết luận "không có tệp test" rồi đi tiếp.
 *
 * Thêm nữa, bản cũ `catch { return "No files found" }` nuốt cả lỗi thật.
 */

import { glob } from "node:fs/promises";
import { resolve } from "node:path";
import { z } from "zod";
import type { ToolDefinition } from "@agentweave/types";

const TRAN_KET_QUA = 500;

/** Thư mục luôn bỏ qua — nếu không, trần 500 kết quả đầy ắp node_modules. */
const BO_QUA = ["node_modules", ".git", "dist", ".turbo"];

export const GlobTool: ToolDefinition<{ pattern: string; path?: string }, string> = {
	name: "Glob",
	description:
		"Find files matching a glob pattern (e.g. 'src/**/*.ts'). " +
		"Skips node_modules, .git, dist and .turbo.",
	parameters: z.object({
		pattern: z.string().describe("Glob pattern to match files"),
		path: z.string().optional().describe("Base directory (default: cwd)"),
	}),
	execute: async ({ pattern, path }, context) => {
		const goc = path ? resolve(context.cwd, path) : context.cwd;

		const ketQua: string[] = [];
		let bicat = false;

		// Lỗi thật (thư mục gốc không tồn tại…) được ném lên để model thấy,
		// KHÔNG biến thành "No files found".
		for await (const muc of glob(pattern, {
			cwd: goc,
			withFileTypes: true,
			exclude: (d) => BO_QUA.includes(typeof d === "string" ? d : d.name),
		})) {
			if (!muc.isFile()) continue;
			if (ketQua.length >= TRAN_KET_QUA) {
				bicat = true;
				break;
			}
			// parentPath + name → đường dẫn tương đối so với goc
			const day = resolve(muc.parentPath ?? goc, muc.name);
			ketQua.push(day.startsWith(`${goc}/`) ? day.slice(goc.length + 1) : day);
		}

		if (ketQua.length === 0) return "No files found";

		ketQua.sort();
		return bicat
			? `${ketQua.join("\n")}\n… [chỉ hiện ${TRAN_KET_QUA} kết quả đầu, còn nữa]`
			: ketQua.join("\n");
	},
	metadata: {
		isReadOnly: true,
		isDestructive: false,
		isConcurrencySafe: true,
		category: "search",
		maxDurationMs: 15_000,
	},
};
