/**
 * LoadSkill — nạp hướng dẫn chi tiết của một kỹ năng vào hội thoại.
 *
 * Vì sao là tool chứ không tự động nạp theo từ khoá:
 *   ① Tự động dễ nạp nhầm, mà mỗi lần nạp nhầm mất cả context lẫn tốc độ
 *   ② Để model chủ động gọi thì lệnh gọi nằm trong event stream → kiểm toán được
 *
 * Tool này không cần sandbox: nó chỉ đọc, và đọc theo đường dẫn đã ghi trong
 * chỉ mục chứ không ghép chuỗi từ tham số của model.
 */

import type { ToolDefinition } from "@agentweave/types";
import { z } from "zod";
import { LOAD_SKILL_TOOL_NAME, type SkillRegistry } from "../skills/skill-registry";
import { DEFAULT_MAX_CONTENT_BYTES } from "../skills/types";

export function createLoadSkillTool(
	registry: SkillRegistry,
): ToolDefinition<{ name: string }, string> {
	return {
		name: LOAD_SKILL_TOOL_NAME,
		description:
			"Load the full instructions for one skill from the skills index. " +
			"When a skill matches the task, this is a BLOCKING REQUIREMENT: call this tool " +
			"BEFORE writing any other response about that task. Never mention a skill by name " +
			"without actually calling this tool — answering from memory instead means you are " +
			"guessing at a procedure your team already wrote down, and you will get it wrong. " +
			"If a '--- SKILL: <name> ---' block for that skill is already in this conversation, " +
			"it is ALREADY loaded: follow it directly instead of calling this tool again. " +
			"Read-only: it returns text and changes nothing.",
		parameters: z.object({
			name: z.string().describe("Skill name, exactly as written in the skills index"),
		}),
		execute: async ({ name }) => {
			const key = name.trim();
			// loadContent ném UnknownSkillError kèm danh sách tên hợp lệ, nên model
			// tự sửa được ở lượt sau thay vì đoán mò.
			const content = await registry.loadContent(key);
			const skill = registry.get(key);
			const version = skill?.manifest.version ? ` v${skill.manifest.version}` : "";
			return `--- SKILL: ${key}${version} (${skill?.scope} scope) ---\n${content}`;
		},
		metadata: {
			isReadOnly: true,
			isDestructive: false,
			isConcurrencySafe: true,
			category: "custom",
			maxOutputSize: DEFAULT_MAX_CONTENT_BYTES + 512,
		},
	};
}
