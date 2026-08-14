/**
 * REFERENCE IMPLEMENTATION — not production path (post-pivot 2026-04-22).
 * Production agents ship their own file-write tool; AgentWeave governs them
 * via hooks + adapters. Kept for the reference agent-loop + tests.
 * See product-spec/POSITIONING.md.
 *
 * FileWrite — Write content to a file (create or overwrite).
 */

import { writeFile, mkdir } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { z } from "zod";
import type { ToolDefinition } from "@agentweave/types";
import { ghiNhanDaGhi, kiemTraTruocKhiGhi } from "../file-access-tracker";

export const FileWriteTool: ToolDefinition<{ path: string; content: string }, string> = {
	name: "FileWrite",
	description: "Write content to a file. Creates parent directories if needed.",
	parameters: z.object({
		path: z.string().describe("File path to write"),
		content: z.string().describe("Content to write"),
	}),
	execute: async ({ path, content }, context) => {
		const absPath = resolve(context.cwd, path);
		// Đè lên file có sẵn mà chưa đọc = ghi mù. Tạo file mới thì không chặn.
		await kiemTraTruocKhiGhi(context.sessionId, absPath, path);
		await mkdir(dirname(absPath), { recursive: true });
		await writeFile(absPath, content, "utf-8");
		await ghiNhanDaGhi(context.sessionId, absPath);
		return `Written ${content.length} bytes to ${path}`;
	},
	metadata: {
		isReadOnly: false,
		isDestructive: false,
		isConcurrencySafe: false,
		category: "file",
	},
};
