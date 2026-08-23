/**
 * Built-in tools — 6 standard tools for AI agent file/shell operations.
 */

import type { ToolDefinition } from "@agentweave/types";
import { BashTool, taoBashTool } from "./bash";
import { FileEditTool } from "./file-edit";
import { FileReadTool } from "./file-read";
import { FileWriteTool } from "./file-write";
import { GlobTool } from "./glob";
import { GrepTool } from "./grep";

export { BashTool, FileReadTool, FileWriteTool, FileEditTool, GrepTool, GlobTool };
export { taoBashTool, TIMEOUT_MAC_DINH_MS, DAU_MA_THOAT, DAU_BI_GIET } from "./bash";

/**
 * LoadSkill KHÔNG nằm trong BUILT_IN_TOOLS: nó cần một SkillRegistry đã quét đĩa,
 * nên phải dựng bằng factory. Dùng `installSkills()` trong `../skills` để nối
 * cả chỉ mục lẫn tool trong một bước.
 */
export { createLoadSkillTool } from "./load-skill";

export interface TuyChonBoTool {
	/**
	 * Hạn giờ mặc định cho Bash, mili-giây. Lấy từ `.agentweave/agent.json` —
	 * mỗi dự án một cỡ build khác nhau, một con số cứng không vừa cho tất cả.
	 */
	bashTimeoutMs?: number;
}

/** Dựng bộ 6 tool chuẩn, có tham số theo dự án. */
export function boToolMacDinh(t: TuyChonBoTool = {}): ToolDefinition[] {
	return [
		t.bashTimeoutMs ? taoBashTool(t.bashTimeoutMs) : BashTool,
		FileReadTool,
		FileWriteTool,
		FileEditTool,
		GrepTool,
		GlobTool,
	];
}

/** All 6 built-in tools as an array — register all at once. */
export const BUILT_IN_TOOLS: ToolDefinition[] = boToolMacDinh();

/** Get a built-in tool by name. */
export function getBuiltInTool(name: string): ToolDefinition | undefined {
	return BUILT_IN_TOOLS.find((t) => t.name === name);
}
