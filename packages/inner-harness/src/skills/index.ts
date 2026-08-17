/**
 * Hệ thống Skill — điểm vào duy nhất.
 *
 * Dùng `installSkills(harness)` để nối trọn gói: quét đĩa, chèn chỉ mục vào
 * system prompt, đăng ký tool LoadSkill. Làm thủ công từng bước rất dễ quên
 * một bước rồi tưởng đã xong — đúng loại lỗi "báo xanh mà sai" mà air-gap
 * không tha thứ.
 */

import type { ToolDefinition } from "@agentweave/types";
import { createLoadSkillTool } from "../built-in-tools/load-skill";
import {
	LOAD_SKILL_TOOL_NAME,
	SKILL_INDEX_SECTION,
	SkillRegistry,
	UnknownSkillError,
	projectSkillsDir,
	renderSkillIndex,
	type SkillRegistryOptions,
} from "./skill-registry";
import type { SkillDiscoveryReport } from "./types";

export {
	SkillRegistry,
	UnknownSkillError,
	renderSkillIndex,
	projectSkillsDir,
	LOAD_SKILL_TOOL_NAME,
	SKILL_INDEX_SECTION,
};
export type { SkillRegistryOptions };
export { createLoadSkillTool };
export {
	SkillManifestSchema,
	SKILL_NAME_PATTERN,
	SKILL_MANIFEST_FILE,
	SKILL_CONTENT_FILE,
	DEFAULT_MAX_SKILLS_PER_SCOPE,
	DEFAULT_MAX_CONTENT_BYTES,
	WHEN_TO_USE_SOFT_LIMIT,
} from "./types";
export type {
	Skill,
	SkillManifest,
	SkillScope,
	SkillProblem,
	SkillProblemKind,
	SkillDiscoveryReport,
	ShadowedSkill,
	ScopeScan,
} from "./types";

/** Phần tối thiểu của harness mà hệ thống skill cần. */
export interface SkillHost {
	registerTool(tool: ToolDefinition): void;
	setSystemPromptSection(name: string, content: string | null): void;
	/** Có cả hai thì `installSkills` gọi lại được (vd: quét lại sau khi thêm skill). */
	unregisterTool?(name: string): void;
	getTools?(): ReadonlyArray<ToolDefinition>;
}

export interface InstallSkillsOptions extends SkillRegistryOptions {
	/** Tắt cảnh báo ra console. Mặc định false — im lặng là nguy hiểm. */
	quiet?: boolean;
}

export interface InstallSkillsResult {
	registry: SkillRegistry;
	report: SkillDiscoveryReport;
}

/**
 * Quét skill, chèn chỉ mục vào system prompt và đăng ký tool LoadSkill.
 *
 * Tool LoadSkill vẫn được đăng ký kể cả khi chưa có skill nào — để `.agentweave/skills`
 * thêm vào sau này là dùng được ngay sau lần quét kế tiếp. Chỉ mục thì ngược lại:
 * không có skill thì không chèn gì, tránh tốn context vô ích.
 */
export async function installSkills(
	host: SkillHost,
	options: InstallSkillsOptions = {},
): Promise<InstallSkillsResult> {
	const registry = new SkillRegistry(options);
	const report = await registry.discover();

	const index = registry.renderIndex();
	host.setSystemPromptSection(SKILL_INDEX_SECTION, index === "" ? null : index);
	// Gỡ bản cũ trước: tool phải trỏ tới registry vừa quét, và ToolRegistry
	// từ chối cả đăng ký trùng tên lẫn gỡ tool chưa có.
	const daCo = host.getTools?.().some((t) => t.name === LOAD_SKILL_TOOL_NAME) ?? false;
	if (daCo) host.unregisterTool?.(LOAD_SKILL_TOOL_NAME);
	host.registerTool(createLoadSkillTool(registry) as ToolDefinition);

	if (!options.quiet) {
		for (const p of report.problems) {
			const tag = p.fatal ? "BO QUA SKILL" : "canh bao";
			console.warn(`[AgentWeave:skills] ${tag} (${p.scope}) ${p.path}: ${p.detail}`);
		}
		for (const s of report.shadowed) {
			console.warn(
				`[AgentWeave:skills] "${s.name}" o pham vi ${s.loser} bi che boi ban ${s.winner} (${s.loserDir})`,
			);
		}
	}

	return { registry, report };
}

/** Tóm tắt một dòng cho bộ tự kiểm tra lúc bàn giao. */
export function summarizeSkillReport(report: SkillDiscoveryReport): string {
	const fatal = report.problems.filter((p) => p.fatal).length;
	const warn = report.problems.length - fatal;
	return (
		`${report.skills.length} skill · chi muc ${report.indexBytes} byte · ` +
		`${fatal} loi nghiem trong · ${warn} canh bao · ${report.shadowed.length} bi che`
	);
}
