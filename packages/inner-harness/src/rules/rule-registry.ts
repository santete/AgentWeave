/**
 * RuleRegistry — quét, kiểm tra và phân phát rule.
 *
 * Hai đường ra khác hẳn nhau:
 *   · rule VÔ ĐIỀU KIỆN  → một mục system prompt, thường trực cả phiên
 *   · rule CÓ ĐIỀU KIỆN  → nằm im trên đĩa, chỉ thành attachment khi model
 *     chạm một file khớp `paths:`
 *
 * Registry chỉ giữ nội dung đã mở rộng trong bộ nhớ (rule vốn nhỏ và phải sẵn
 * sàng ngay lúc khớp — khác Skill, thứ đọc từ đĩa lúc `loadContent()`).
 */

import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { tachFrontmatter } from "./frontmatter";
import { boChuThichHtml, moRongInclude } from "./include";
import { chuanHoa, laVoDieuKien, taoBoKhop } from "./khop-duong-dan";
import {
	MAX_KY_TU_MOT_RULE,
	MAX_TANG_DI_NGUOC,
	NHAN_NGUON,
	RULES_DIR_SEGMENTS,
	type Rule,
	type RuleDiscoveryReport,
	type RuleProblem,
	type RuleScope,
	TEP_RULE_DU_AN,
	TEP_RULE_LOCAL,
} from "./types";

/** Tên mục system prompt cho rule vô điều kiện. */
export const RULE_SECTION = "rules";

/**
 * Câu đóng gói, chép nguyên tinh thần bản gốc.
 *
 * Chữ "OVERRIDE" và "exactly as written" không phải để trang trí: không có
 * chúng thì model coi rule ngang hàng với gợi ý trong system prompt của chính
 * nó, và khi hai bên mâu thuẫn thì nó chọn bên quen thuộc hơn — tức là bỏ rule.
 */
export const CAU_DAN_RULE =
	"Codebase and user instructions are shown below. Be sure to adhere to these instructions. " +
	"IMPORTANT: These instructions OVERRIDE any default behavior and you MUST follow them exactly as written.";

export interface RuleRegistryOptions {
	/** Gốc dự án. Mặc định cwd. `null` để bỏ hẳn phạm vi project và local. */
	projectDir?: string | null;
	/** Mặc định `~/.agentweave/rules`. `null` để bỏ qua. */
	userRulesDir?: string | null;
	/** Mặc định lấy từ biến môi trường `AGENTWEAVE_ORG_RULES`. */
	orgRulesDir?: string | null;
	/** Cho phép @include đọc tệp ngoài gốc dự án. Mặc định KHÔNG. */
	chophepIncludeNgoaiDuAn?: boolean;
}

export class RuleRegistry {
	private report: RuleDiscoveryReport = {
		rules: [],
		problems: [],
		promptBytes: 0,
		soCoDieuKien: 0,
	};
	/** Bộ khớp của từng rule có điều kiện, khoá theo `duong`. */
	private boKhop = new Map<string, (duongTuongDoi: string) => boolean>();

	constructor(private readonly options: RuleRegistryOptions = {}) {}

	/** Quét cả bốn tầng. Gọi lại được — mỗi lần thay thế kết quả cũ. */
	async discover(): Promise<RuleDiscoveryReport> {
		const problems: RuleProblem[] = [];
		const rules: Rule[] = [];
		this.boKhop.clear();

		const projectDir =
			this.options.projectDir === null ? null : resolve(this.options.projectDir ?? process.cwd());

		// ── org ──
		const orgDir =
			this.options.orgRulesDir === null
				? null
				: (this.options.orgRulesDir ?? process.env.AGENTWEAVE_ORG_RULES ?? null);
		if (orgDir) {
			await this.napThuMuc("org", resolve(orgDir), projectDir ?? resolve(orgDir), rules, problems);
		}

		// ── user ──
		const userDir =
			this.options.userRulesDir === null
				? null
				: (this.options.userRulesDir ?? join(homedir(), ...RULES_DIR_SEGMENTS));
		if (userDir) {
			await this.napThuMuc(
				"user",
				resolve(userDir),
				projectDir ?? resolve(userDir),
				rules,
				problems,
			);
		}

		if (projectDir) {
			// ── project: đi từ GỐC repo xuống cwd ──
			// Thứ tự này là quy ước ngầm về trọng số: tệp gần cwd hơn nạp sau, nằm
			// gần cuối prompt, và được model chú ý hơn tệp ở gốc monorepo.
			for (const d of this.cacTangDuAn(projectDir)) {
				await this.napTep("project", join(d, TEP_RULE_DU_AN), d, rules, problems, true);
				await this.napThuMuc("project", join(d, ...RULES_DIR_SEGMENTS), d, rules, problems);
			}

			// ── local: nạp SAU CÙNG, ưu tiên cao nhất ──
			await this.napTep(
				"local",
				join(projectDir, TEP_RULE_LOCAL),
				projectDir,
				rules,
				problems,
				true,
			);
		}

		const voDieuKien = rules.filter((r) => !r.coDieuKien);
		this.report = {
			rules,
			problems,
			promptBytes: Buffer.byteLength(renderRules(voDieuKien), "utf-8"),
			soCoDieuKien: rules.length - voDieuKien.length,
		};
		return this.report;
	}

	/**
	 * Các thư mục từ gốc dự án xuống `projectDir`.
	 *
	 * Gốc = thư mục gần nhất đi ngược lên có `.git`. Không tìm thấy thì chỉ lấy
	 * chính `projectDir` — quét lên tận `/` sẽ nạp nhầm rule của dự án khác.
	 */
	private cacTangDuAn(projectDir: string): string[] {
		const duong: string[] = [projectDir];
		let hienTai = projectDir;
		for (let i = 0; i < MAX_TANG_DI_NGUOC; i++) {
			const cha = dirname(hienTai);
			if (cha === hienTai) break;
			duong.push(cha);
			hienTai = cha;
		}

		// Tìm gốc git bằng cách thử từ ngoài vào; không có thì chỉ dùng projectDir.
		const goc = duong.find((d) => existsSync(join(d, ".git")));
		if (!goc) return [projectDir];

		const ra: string[] = [];
		for (const d of duong) {
			ra.push(d);
			if (d === goc) break;
		}
		return ra.reverse();
	}

	private async napThuMuc(
		scope: RuleScope,
		dir: string,
		gocKhop: string,
		rules: Rule[],
		problems: RuleProblem[],
	): Promise<void> {
		let ten: string[];
		try {
			const ds = await readdir(dir, { withFileTypes: true });
			ten = ds
				.filter((d) => d.isFile() && d.name.toLowerCase().endsWith(".md"))
				.map((d) => d.name)
				.sort();
		} catch (err) {
			// Thư mục không tồn tại là chuyện bình thường — không phải lỗi.
			if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
			problems.push({
				kind: "doc_that_bai",
				scope,
				duong: dir,
				detail: `khong doc duoc thu muc: ${(err as Error).message}`,
				fatal: true,
			});
			return;
		}

		for (const t of ten) {
			await this.napTep(scope, join(dir, t), gocKhop, rules, problems, false);
		}
	}

	private async napTep(
		scope: RuleScope,
		duong: string,
		gocKhop: string,
		rules: Rule[],
		problems: RuleProblem[],
		imLangNeuThieu: boolean,
	): Promise<void> {
		let raw: string;
		try {
			raw = await readFile(duong, "utf-8");
		} catch (err) {
			if (!imLangNeuThieu || (err as NodeJS.ErrnoException).code !== "ENOENT") {
				problems.push({
					kind: "doc_that_bai",
					scope,
					duong,
					detail: `khong doc duoc: ${(err as Error).message}`,
					fatal: true,
				});
			}
			return;
		}

		const { truong, than } = tachFrontmatter(raw);
		const sachChuThich = boChuThichHtml(than);

		const projectDir = this.options.projectDir ?? process.cwd();
		const { noiDung, problems: loiInclude } = await moRongInclude(sachChuThich, {
			thuMuc: dirname(duong),
			gocDuAn: resolve(projectDir),
			chophepNgoaiDuAn: this.options.chophepIncludeNgoaiDuAn,
			scope,
		});
		problems.push(...loiInclude);

		const than2 = noiDung.trim();
		if (than2 === "") return; // tệp rỗng: không có gì để nói, cũng không phải lỗi

		if (than2.length > MAX_KY_TU_MOT_RULE) {
			problems.push({
				kind: "rule_qua_lon",
				scope,
				duong,
				detail: `${than2.length} ky tu (sau @include), vuot nguong canh bao ${MAX_KY_TU_MOT_RULE} — nam thuong truc moi luot`,
				fatal: false,
			});
		}

		const paths = truong.paths?.trim();
		const coDieuKien = paths !== undefined && paths !== "" && !laVoDieuKien(paths);

		if (coDieuKien) {
			const khop = taoBoKhop(paths!);
			if (!khop) {
				problems.push({
					kind: "paths_khong_hop_le",
					scope,
					duong,
					detail: `paths: "${paths}" khong tao duoc mau nao — rule bi bo qua`,
					fatal: true,
				});
				return;
			}
			this.boKhop.set(duong, khop);
		}

		rules.push({
			scope,
			duong,
			noiDung: than2,
			paths,
			coDieuKien,
			gocKhop: resolve(gocKhop),
			bytes: Buffer.byteLength(than2, "utf-8"),
		});
	}

	// ─── Truy vấn ────────────────────────────────────────────────────

	list(): ReadonlyArray<Rule> {
		return this.report.rules;
	}

	getReport(): RuleDiscoveryReport {
		return this.report;
	}

	/** Rule vô điều kiện, đã đóng gói sẵn để đặt vào system prompt. */
	renderSection(): string {
		return renderRules(this.report.rules.filter((r) => !r.coDieuKien));
	}

	/**
	 * Rule có điều kiện khớp một file.
	 *
	 * @param duongTuyetDoi đường dẫn tuyệt đối của file model vừa chạm
	 */
	khopFile(duongTuyetDoi: string): Rule[] {
		const ra: Rule[] = [];
		for (const r of this.report.rules) {
			if (!r.coDieuKien) continue;
			const khop = this.boKhop.get(r.duong);
			if (!khop) continue;

			const tuongDoi = chuanHoa(relative(r.gocKhop, duongTuyetDoi));
			// Rỗng, đi ngược ra ngoài, hoặc vẫn tuyệt đối → nằm ngoài phạm vi của
			// rule này, không mẫu nào khớp được. Chặn sớm cho rõ ý.
			if (tuongDoi === "" || tuongDoi.startsWith("../") || tuongDoi.startsWith("/")) continue;
			if (khop(tuongDoi)) ra.push(r);
		}
		return ra;
	}
}

/**
 * Đóng gói danh sách rule thành một khối chữ.
 *
 * Mỗi tệp kèm đường dẫn và nhãn nguồn. Không có nhãn thì model không phân biệt
 * được "chính sách tổ chức" với "ghi chú cá nhân của một lập trình viên", và
 * khi hai bên mâu thuẫn nó chọn bừa.
 */
export function renderRules(rules: ReadonlyArray<Rule>): string {
	if (rules.length === 0) return "";

	const khoi = rules.map((r) => `Contents of ${r.duong} (${NHAN_NGUON[r.scope]}):\n\n${r.noiDung}`);
	return `${CAU_DAN_RULE}\n\n${khoi.join("\n\n")}`;
}

/**
 * Đóng gói một rule có điều kiện thành nội dung attachment.
 *
 * Nêu RÕ vì sao nó xuất hiện lúc này ("bạn vừa chạm file X"). Không nói thì
 * model coi đây là chỉ dẫn từ trên trời rơi xuống và dễ bỏ qua — hoặc tệ hơn,
 * quay ra hỏi người dùng về nó.
 */
export function renderRuleTheoDuongDan(rule: Rule, fileVuaCham: string): string {
	return (
		`${CAU_DAN_RULE}\n\n` +
		`Contents of ${rule.duong} (${NHAN_NGUON[rule.scope]}) — this rule declares ` +
		`paths: "${rule.paths}" and you just worked on ${fileVuaCham}. ` +
		`It applies for the rest of this task.\n\n${rule.noiDung}`
	);
}
