/**
 * REFERENCE IMPLEMENTATION — not production path (post-pivot 2026-04-22).
 * Production agents ship their own grep tool; AgentWeave governs them via
 * hooks + adapters. Kept for the reference agent-loop + tests.
 * See product-spec/POSITIONING.md.
 *
 * ---
 *
 * Grep — Search for a regex pattern in files recursively.
 *
 * SECURITY: Uses execFile (no shell) to prevent injection via pattern/path.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ToolDefinition } from "@agentweave/types";
import { z } from "zod";
import { chuanHoaDuongDan } from "./duong-dan";

const execFileAsync = promisify(execFile);

export const GrepTool: ToolDefinition<
	{
		pattern: string;
		path?: string;
		paths?: string | string[];
		files?: string | string[];
		include?: string;
	},
	string
> = {
	name: "Grep",
	description:
		"Search for a regex pattern in files. Returns matching lines with file paths and line numbers.",
	parameters: z.object({
		pattern: z.string().describe("Regex pattern to search for"),
		path: z.string().optional().describe("Directory to search in (default: cwd)"),
		// Model hay gọi nhầm "paths" (số nhiều / mảng) — chấp nhận làm alias thay vì
		// lờ lặng lẽ rồi quét nhầm cả cwd.
		paths: z.union([z.string(), z.array(z.string())]).optional(),
		files: z.union([z.string(), z.array(z.string())]).optional(),
		include: z.string().optional().describe("File glob to filter (e.g. '*.ts')"),
	}),
	execute: async ({ pattern, path, paths, files, include }, context) => {
		if (!path && paths) path = Array.isArray(paths) ? paths[0] : paths;
		// "files":"*.md" — model coi đây là glob lọc file; map vào include/path.
		if (files) {
			const f0 = Array.isArray(files) ? files[0] : files;
			if (f0 && /^[*?]/.test(f0)) include = include ?? f0;
			else if (f0 && !path) path = f0;
		}
		// Model hay truyền GLOB làm path ("**/*.cs", "src/**/*.cs") trong khi tool
		// coi path là THƯ MỤC → grep vào thư mục không tồn tại → "No matches found"
		// mãi → model retry biến thể → loop (đo thật: 5 lần Grep class.*Ticket).
		// Chịu lỗi thay vì trừng phạt: tách phần thư mục thật + đuôi glob làm include.
		const tho = path ? chuanHoaDuongDan(path) : ".";
		let searchPath = tho;
		let includeTuPath: string | undefined;
		if (/[*?]/.test(tho)) {
			const phan = tho.split("/");
			const truoc: string[] = [];
			for (const seg of phan) {
				if (/[*?]/.test(seg)) break;
				truoc.push(seg);
			}
			searchPath = truoc.join("/") || ".";
			const cuoi = phan[phan.length - 1] ?? "";
			if (/[*?]/.test(cuoi) && cuoi.includes(".")) includeTuPath = cuoi;
		}
		const includeHieuLuc = include ?? includeTuPath;

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
			// Smart-case như ripgrep: mẫu toàn chữ thường → không phân biệt hoa
			// thường. Đo thật: model tìm "phase 2" trong khi file ghi "Phase 2" —
			// 3 lần No matches rồi bỏ cuộc, chỉ vì một chữ P.
			if (pattern === pattern.toLowerCase()) args.push("-i");
			// Bỏ thư mục sinh ra + phiên làm việc của chính agent — quét vào
			// .agentweave/sessions là grep dính transcript cũ, model đọc lại hội
			// thoại của chính nó tưởng là code (đã thấy thật khi lái phiên).
			for (const d of [".git", "node_modules", "obj", "bin", "dist", ".agentweave"])
				args.push(`--exclude-dir=${d}`);
			if (includeHieuLuc) args.push(`--include=${includeHieuLuc}`);
			args.push(pattern, searchPath);

			const { stdout } = await execFileAsync("grep", args, {
				cwd: context.cwd,
				timeout: 30_000,
				signal: context.signal,
			});
			// Limit output
			const lines = stdout.split("\n").slice(0, 200).join("\n");
			return (
				lines.slice(0, 100_000) ||
				`No matches for /${pattern}/ under "${searchPath}"${includeHieuLuc ? ` (files: ${includeHieuLuc})` : ""}. Do NOT retry the same search — broaden the pattern, or list files with Glob/Bash ls first.`
			);
		} catch {
			return `No matches for /${pattern}/ under "${searchPath}"${includeHieuLuc ? ` (files: ${includeHieuLuc})` : ""}. Do NOT retry the same search — broaden the pattern, or list files with Glob/Bash ls first.`;
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
