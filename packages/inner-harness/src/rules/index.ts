/**
 * Hệ Rule — điểm vào duy nhất.
 *
 * `installRules(host)` làm trọn gói: quét bốn tầng, đặt rule vô điều kiện vào
 * system prompt, và trả về registry để vòng lặp hỏi rule có điều kiện mỗi khi
 * model chạm file. Làm thủ công từng bước rất dễ quên bước cuối rồi tưởng đã
 * xong — đúng loại lỗi "báo xanh mà sai" mà air-gap không tha thứ.
 */

import type { NguonNhac, Nhac } from "../attachments/index";
import {
	RULE_SECTION,
	RuleRegistry,
	type RuleRegistryOptions,
	renderRuleTheoDuongDan,
} from "./rule-registry";
import type { RuleDiscoveryReport } from "./types";

export {
	RuleRegistry,
	RULE_SECTION,
	CAU_DAN_RULE,
	renderRules,
	renderRuleTheoDuongDan,
} from "./rule-registry";
export type { RuleRegistryOptions } from "./rule-registry";
export { tachFrontmatter } from "./frontmatter";
export { taoBoKhop, laVoDieuKien, chuanHoa } from "./khop-duong-dan";
export { moRongInclude, boChuThichHtml } from "./include";
export {
	MAX_INCLUDE_DEPTH,
	MAX_KY_TU_MOT_RULE,
	NHAN_NGUON,
	RULES_DIR_SEGMENTS,
	TEP_RULE_DU_AN,
	TEP_RULE_LOCAL,
} from "./types";
export type {
	Rule,
	RuleScope,
	RuleProblem,
	RuleProblemKind,
	RuleDiscoveryReport,
} from "./types";

/** Phần tối thiểu của harness mà hệ rule cần. */
export interface RuleHost {
	setSystemPromptSection(name: string, content: string | null): void;
}

export interface InstallRulesOptions extends RuleRegistryOptions {
	/** Tắt cảnh báo ra console. Mặc định false — im lặng là nguy hiểm. */
	quiet?: boolean;
}

export interface InstallRulesResult {
	registry: RuleRegistry;
	report: RuleDiscoveryReport;
}

export async function installRules(
	host: RuleHost,
	options: InstallRulesOptions = {},
): Promise<InstallRulesResult> {
	const registry = new RuleRegistry(options);
	const report = await registry.discover();

	const muc = registry.renderSection();
	// Không có rule vô điều kiện thì KHÔNG chèn gì. Một mục rỗng vẫn tốn vài
	// chục token mỗi lượt và không nói với model điều gì.
	host.setSystemPromptSection(RULE_SECTION, muc === "" ? null : muc);

	if (!options.quiet) {
		for (const p of report.problems) {
			const tag = p.fatal ? "BO QUA RULE" : "canh bao";
			console.warn(`[AgentWeave:rules] ${tag} (${p.scope}) ${p.duong}: ${p.detail}`);
		}
	}

	return { registry, report };
}

/**
 * Nguồn nhắc bơm rule có điều kiện khi model chạm file khớp.
 *
 * Khoá theo `duong` của rule chứ không theo cặp (rule, file): một rule cho
 * `src/api/**` chỉ cần nói MỘT LẦN, dù model có sửa hai chục file trong đó.
 * Khoá theo cặp thì mỗi file mới lại bơm lại toàn bộ rule — đúng thứ lãng phí
 * mà cơ chế có điều kiện sinh ra để tránh.
 */
export function nguonRuleTheoDuongDan(registry: RuleRegistry): NguonNhac {
	return {
		ten: "rule-theo-duong-dan",
		async thu(ctx): Promise<Nhac[]> {
			const ra: Nhac[] = [];
			const daCo = new Set<string>();
			for (const f of ctx.fileVuaCham) {
				for (const r of registry.khopFile(f)) {
					if (daCo.has(r.duong)) continue;
					daCo.add(r.duong);
					ra.push({
						loai: "luat-theo-duong-dan",
						noiDung: renderRuleTheoDuongDan(r, f),
						khoa: `rule:${r.duong}`,
					});
				}
			}
			return ra;
		},
	};
}

/** Tóm tắt một dòng cho bộ tự kiểm tra lúc bàn giao. */
export function summarizeRuleReport(report: RuleDiscoveryReport): string {
	const fatal = report.problems.filter((p) => p.fatal).length;
	const warn = report.problems.length - fatal;
	return (
		`${report.rules.length} rule (${report.soCoDieuKien} co dieu kien) · ` +
		`prompt ${report.promptBytes} byte · ${fatal} loi nghiem trong · ${warn} canh bao`
	);
}
