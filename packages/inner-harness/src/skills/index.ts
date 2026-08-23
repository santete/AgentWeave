/**
 * Hệ thống Skill — điểm vào duy nhất.
 *
 * Dùng `installSkills(harness)` để nối trọn gói: quét đĩa, chèn chỉ mục vào
 * system prompt, đăng ký tool LoadSkill. Làm thủ công từng bước rất dễ quên
 * một bước rồi tưởng đã xong — đúng loại lỗi "báo xanh mà sai" mà air-gap
 * không tha thứ.
 */

import type { ToolDefinition } from "@agentweave/types";
import type { NguonNhac, Nhac } from "../attachments/index";
import { createLoadSkillTool } from "../built-in-tools/load-skill";
import {
	LOAD_SKILL_TOOL_NAME,
	SKILL_INDEX_SECTION,
	SkillRegistry,
	type SkillRegistryOptions,
	UnknownSkillError,
	projectSkillsDir,
	renderSkillIndex,
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
export { quetDuAn, MAX_TEP_QUET as MAX_TEP_QUET_DU_AN, MAX_SAU_QUET, THU_MUC_BO_QUA } from "./quet-du-an";
export {
	SkillManifestSchema,
	SKILL_NAME_PATTERN,
	SKILL_MANIFEST_FILE,
	SKILL_CONTENT_FILE,
	DEFAULT_MAX_SKILLS_PER_SCOPE,
	DEFAULT_MAX_CONTENT_BYTES,
	WHEN_TO_USE_SOFT_LIMIT,
	SKILL_BUDGET_CONTEXT_PERCENT,
	CHARS_PER_TOKEN,
	MAX_LISTING_DESC_CHARS,
	MIN_DESC_LENGTH,
	nganSachChiMuc,
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

/**
 * Nguồn nhắc giới thiệu skill CÓ ĐIỀU KIỆN khi model chạm file khớp `paths:`.
 *
 * Chỉ giới thiệu MỘT DÒNG (tên + whenToUse), không nạp nội dung: quyết định
 * nạp hay không vẫn thuộc về model, và lệnh gọi `LoadSkill` nằm trong dòng sự
 * kiện nên kiểm toán được. Tự động nhồi cả SKILL.md vì "đoán là model sẽ cần"
 * đúng là thứ thiết kế ban đầu đã cố tránh.
 */
export function nguonSkillTheoDuongDan(registry: SkillRegistry): NguonNhac {
	return {
		ten: "skill-theo-duong-dan",
		async thu(ctx): Promise<Nhac[]> {
			const gap = new Map<string, { ten: string; whenToUse: string; file: string }>();
			for (const f of ctx.fileVuaCham) {
				for (const sk of registry.khopFile(f)) {
					if (!gap.has(sk.manifest.name)) {
						gap.set(sk.manifest.name, {
							ten: sk.manifest.name,
							whenToUse: sk.manifest.whenToUse,
							file: f,
						});
					}
				}
			}
			if (gap.size === 0) return [];

			// Gộp thành MỘT nhắc nhưng khoá theo từng tên: lần sau chạm thêm file
			// khác chỉ giới thiệu skill CHƯA từng giới thiệu.
			return [...gap.values()].map((g) => ({
				loai: "skill-theo-duong-dan",
				noiDung:
					`This file matches a skill your team wrote for it: you just worked on ${g.file}.\n` +
					`- ${g.ten}: ${g.whenToUse}\n` +
					`If it applies, call ${LOAD_SKILL_TOOL_NAME} with that name before continuing.`,
				khoa: `skill:${g.ten}`,
			}));
		},
	};
}

/** Tóm tắt một dòng cho bộ tự kiểm tra lúc bàn giao. */
export function summarizeSkillReport(report: SkillDiscoveryReport): string {
	const fatal = report.problems.filter((p) => p.fatal).length;
	const warn = report.problems.length - fatal;
	return (
		`${report.skills.length} skill (${report.soCoDieuKien} co dieu kien) · ` +
		`chi muc ${report.indexBytes}/${report.nganSach} byte · ` +
		`${fatal} loi nghiem trong · ${warn} canh bao · ${report.shadowed.length} bi che`
	);
}
