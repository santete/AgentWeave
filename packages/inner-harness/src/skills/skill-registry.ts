/**
 * SkillRegistry — phát hiện, kiểm tra và nạp skill.
 *
 * Ba phạm vi, hẹp hơn thắng khi trùng tên:
 *   .agentweave/skills/       (dự án)
 *   ~/.agentweave/skills/     (người dùng)
 *   <gói bàn giao>/skills/    (tổ chức — đóng băng lúc đóng gói)
 *
 * Registry chỉ giữ SIÊU DỮ LIỆU trong bộ nhớ. Nội dung SKILL.md đọc từ đĩa
 * đúng lúc `loadContent()` được gọi, để không tốn context khi chưa cần.
 */

import { readFile, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, relative, resolve } from "node:path";
import { CUA_SO_CUC_BO } from "../context-manager";
import { chuanHoa, laVoDieuKien, taoBoKhop } from "../rules/khop-duong-dan";
import { quetDuAn } from "./quet-du-an";
import {
	DEFAULT_MAX_CONTENT_BYTES,
	DEFAULT_MAX_SKILLS_PER_SCOPE,
	MAX_LISTING_DESC_CHARS,
	MIN_DESC_LENGTH,
	SCOPE_PRECEDENCE,
	SKILLS_DIR_SEGMENTS,
	SKILL_CONTENT_FILE,
	SKILL_MANIFEST_FILE,
	type ScopeScan,
	type ShadowedSkill,
	type Skill,
	type SkillDiscoveryReport,
	SkillManifestSchema,
	type SkillProblem,
	type SkillScope,
	WHEN_TO_USE_SOFT_LIMIT,
	nganSachChiMuc,
} from "./types";

/** Tên tool nạp skill. Khai một chỗ để chỉ mục và tool không bao giờ lệch nhau. */
export const LOAD_SKILL_TOOL_NAME = "LoadSkill";

/** Tên mục trong system prompt, dùng với `setSystemPromptSection`. */
export const SKILL_INDEX_SECTION = "skills";

export interface SkillRegistryOptions {
	/** Gốc dự án. Skill nằm ở `<projectDir>/.agentweave/skills`. Mặc định: cwd. */
	projectDir?: string | null;
	/** Mặc định `~/.agentweave/skills`. Truyền `null` để bỏ qua phạm vi này. */
	userSkillsDir?: string | null;
	/** Mặc định lấy từ biến môi trường `AGENTWEAVE_ORG_SKILLS`. */
	orgSkillsDir?: string | null;
	/** Trần khuyến nghị mỗi phạm vi. Vượt thì cảnh báo, không loại bỏ. */
	maxSkillsPerScope?: number;
	/** Trần byte nạp từ một SKILL.md. Dài hơn thì cắt kèm thông báo rõ ràng. */
	maxContentBytes?: number;
	/**
	 * Cửa sổ ngữ cảnh THẬT của model, dùng để tính ngân sách chỉ mục (1%).
	 * Mặc định 64K — cửa sổ của model cục bộ, không phải 200K của đám mây.
	 */
	contextWindow?: number;
}

function scopeDirs(
	options: SkillRegistryOptions,
): Array<{ scope: SkillScope; dir: string | null }> {
	const project =
		options.projectDir === null
			? null
			: join(options.projectDir ?? process.cwd(), ...SKILLS_DIR_SEGMENTS);

	const user =
		options.userSkillsDir === null
			? null
			: (options.userSkillsDir ?? join(homedir(), ...SKILLS_DIR_SEGMENTS));

	const org =
		options.orgSkillsDir === null
			? null
			: (options.orgSkillsDir ?? process.env.AGENTWEAVE_ORG_SKILLS ?? null);

	return [
		{ scope: "project", dir: project },
		{ scope: "user", dir: user },
		{ scope: "org", dir: org },
	];
}

export class SkillRegistry {
	private readonly options: SkillRegistryOptions;
	private readonly maxContentBytes: number;
	private readonly maxSkillsPerScope: number;
	private readonly nganSach: number;
	/** Bộ khớp `paths:` của skill có điều kiện, khoá theo tên skill. */
	private boKhop = new Map<string, (duongTuongDoi: string) => boolean>();

	private skills = new Map<string, Skill>();
	private report: SkillDiscoveryReport = {
		skills: [],
		problems: [],
		shadowed: [],
		scopes: [],
		indexBytes: 0,
		nganSach: 0,
		soCoDieuKien: 0,
	};
	/** Đếm số lần nạp từng skill — phục vụ kiểm toán và đo lãng phí context. */
	private loads = new Map<string, number>();

	constructor(options: SkillRegistryOptions = {}) {
		this.options = options;
		this.maxContentBytes = options.maxContentBytes ?? DEFAULT_MAX_CONTENT_BYTES;
		this.maxSkillsPerScope = options.maxSkillsPerScope ?? DEFAULT_MAX_SKILLS_PER_SCOPE;
		this.nganSach = nganSachChiMuc(options.contextWindow ?? CUA_SO_CUC_BO);
	}

	/** Quét cả ba phạm vi. Gọi lại được — mỗi lần quét thay thế kết quả cũ. */
	async discover(): Promise<SkillDiscoveryReport> {
		const problems: SkillProblem[] = [];
		const shadowed: ShadowedSkill[] = [];
		const scopes: ScopeScan[] = [];
		const chosen = new Map<string, Skill>();
		this.boKhop.clear();

		for (const scope of SCOPE_PRECEDENCE) {
			const dir = scopeDirs(this.options).find((s) => s.scope === scope)?.dir ?? null;

			if (dir === null) {
				scopes.push({ scope, dir: null, exists: false, found: 0 });
				continue;
			}

			const found = await this.scanScope(scope, dir, problems);
			scopes.push({ scope, dir, exists: found !== null, found: found?.length ?? 0 });

			if (found === null) continue;

			if (found.length > this.maxSkillsPerScope) {
				problems.push({
					kind: "over_scope_limit",
					scope,
					path: dir,
					detail: `co ${found.length} skill, vuot tran khuyen nghi ${this.maxSkillsPerScope}. Chi muc se an vao context danh cho code.`,
					fatal: false,
				});
			}

			for (const skill of found) {
				const existing = chosen.get(skill.manifest.name);
				if (existing) {
					// Phạm vi hẹp hơn đã chiếm chỗ (duyệt theo SCOPE_PRECEDENCE).
					shadowed.push({
						name: skill.manifest.name,
						winner: existing.scope,
						loser: skill.scope,
						loserDir: skill.dir,
					});
					continue;
				}
				chosen.set(skill.manifest.name, skill);
			}
		}

		const skills = [...chosen.values()].sort((a, b) =>
			a.manifest.name.localeCompare(b.manifest.name),
		);

		this.skills = chosen;

		// ── Dò stack: một lượt quét chung cho MỌI skill có điều kiện ──
		// Skill mà dự án đã có sẵn tệp khớp thì stack đó đang được dùng thật, nên
		// quy ước phải có mặt từ lượt 1 chứ không đợi model chạm tệp.
		const canQuet = skills
			.filter((sk) => sk.coDieuKien)
			.map((sk) => ({ khoa: sk.manifest.name, khop: this.boKhop.get(sk.manifest.name) }))
			.filter((x): x is { khoa: string; khop: (d: string) => boolean } => x.khop !== undefined);

		if (canQuet.length > 0 && this.options.projectDir !== null) {
			const trung = await quetDuAn(this.options.projectDir ?? process.cwd(), canQuet);
			for (const sk of skills) {
				if (trung.has(sk.manifest.name)) sk.coTrongDuAn = true;
			}
		}

		const nen = skills.filter((sk) => !sk.coDieuKien || sk.coTrongDuAn);
		const chiMuc = renderSkillIndex(nen, this.nganSach);
		const indexBytes = Buffer.byteLength(chiMuc, "utf-8");

		// Vượt ngân sách sau khi đã xuống thang hết mức nghĩa là riêng phần
		// KHÔNG CẮT ĐƯỢC (khung + skill org) đã quá chỗ. Không im lặng: người vận
		// hành phải biết chỉ mục đang ăn vào phần context dành cho code.
		if (chiMuc.length > this.nganSach) {
			problems.push({
				kind: "chi_muc_vuot_ngan_sach",
				scope: "org",
				path: "(chi muc)",
				detail: `chi muc ${chiMuc.length} ky tu, vuot ngan sach ${this.nganSach} — bot skill org hoac rut ngan whenToUse`,
				fatal: false,
			});
		}

		this.report = {
			skills,
			problems,
			shadowed,
			scopes,
			indexBytes,
			nganSach: this.nganSach,
			soCoDieuKien: skills.length - nen.length,
		};
		return this.report;
	}

	/**
	 * Quét một thư mục phạm vi.
	 * @returns danh sách skill hợp lệ, hoặc `null` nếu thư mục không tồn tại.
	 */
	private async scanScope(
		scope: SkillScope,
		dir: string,
		problems: SkillProblem[],
	): Promise<Skill[] | null> {
		let entries: string[];
		try {
			const dirents = await readdir(dir, { withFileTypes: true });
			entries = dirents.filter((d) => d.isDirectory()).map((d) => d.name);
		} catch (err) {
			const code = (err as NodeJS.ErrnoException).code;
			// Thư mục không tồn tại là chuyện bình thường — không phải lỗi.
			if (code === "ENOENT") return null;
			problems.push({
				kind: "scan_failed",
				scope,
				path: dir,
				detail: `khong doc duoc thu muc: ${(err as Error).message}`,
				fatal: true,
			});
			return null;
		}

		const skills: Skill[] = [];
		const seen = new Set<string>();

		for (const entry of entries.sort()) {
			const skillDir = join(dir, entry);
			const skill = await this.readSkill(scope, skillDir, entry, problems);
			if (!skill) continue;

			if (seen.has(skill.manifest.name)) {
				problems.push({
					kind: "duplicate_name",
					scope,
					path: skillDir,
					detail: `ten "${skill.manifest.name}" da ton tai trong cung pham vi`,
					fatal: true,
				});
				continue;
			}
			seen.add(skill.manifest.name);
			skills.push(skill);
		}

		return skills;
	}

	private async readSkill(
		scope: SkillScope,
		skillDir: string,
		dirName: string,
		problems: SkillProblem[],
	): Promise<Skill | null> {
		const manifestPath = join(skillDir, SKILL_MANIFEST_FILE);
		const contentPath = join(skillDir, SKILL_CONTENT_FILE);

		let raw: string;
		try {
			raw = await readFile(manifestPath, "utf-8");
		} catch {
			problems.push({
				kind: "manifest_missing",
				scope,
				path: skillDir,
				detail: `thieu ${SKILL_MANIFEST_FILE}`,
				fatal: true,
			});
			return null;
		}

		let parsed: unknown;
		try {
			parsed = JSON.parse(raw);
		} catch (err) {
			problems.push({
				kind: "manifest_invalid",
				scope,
				path: manifestPath,
				detail: `JSON hong: ${(err as Error).message}`,
				fatal: true,
			});
			return null;
		}

		const result = SkillManifestSchema.safeParse(parsed);
		if (!result.success) {
			const detail = result.error.issues
				.map((i) => `${i.path.join(".") || "(goc)"}: ${i.message}`)
				.join("; ");
			problems.push({ kind: "manifest_invalid", scope, path: manifestPath, detail, fatal: true });
			return null;
		}

		const manifest = result.data;

		// Tên trong manifest phải trùng tên thư mục. Lệch nhau thì `LoadSkill`
		// tìm theo tên manifest còn người vận hành lại sửa nhầm thư mục khác.
		if (manifest.name !== dirName) {
			problems.push({
				kind: "name_mismatch",
				scope,
				path: manifestPath,
				detail: `name="${manifest.name}" khac ten thu muc "${dirName}"`,
				fatal: true,
			});
			return null;
		}

		let contentBytes: number;
		try {
			const st = await stat(contentPath);
			contentBytes = st.size;
		} catch {
			problems.push({
				kind: "content_missing",
				scope,
				path: skillDir,
				detail: `thieu ${SKILL_CONTENT_FILE} — chi muc se quang cao mot ky nang rong`,
				fatal: true,
			});
			return null;
		}

		if (contentBytes === 0) {
			problems.push({
				kind: "content_empty",
				scope,
				path: contentPath,
				detail: `${SKILL_CONTENT_FILE} rong`,
				fatal: true,
			});
			return null;
		}

		if (Buffer.byteLength(manifest.whenToUse, "utf-8") > WHEN_TO_USE_SOFT_LIMIT) {
			problems.push({
				kind: "when_to_use_too_long",
				scope,
				path: manifestPath,
				detail: `whenToUse dai ${Buffer.byteLength(manifest.whenToUse, "utf-8")} byte, nen duoi ${WHEN_TO_USE_SOFT_LIMIT} — chi muc nam thuong truc trong system prompt`,
				fatal: false,
			});
		}

		if (contentBytes > this.maxContentBytes) {
			problems.push({
				kind: "content_too_large",
				scope,
				path: contentPath,
				detail: `${contentBytes} byte, vuot tran ${this.maxContentBytes} — se bi cat khi nap`,
				fatal: false,
			});
		}

		// `paths:` — skill có điều kiện. Cùng bộ khớp với rule (cú pháp gitignore),
		// vì người viết đã quen một cú pháp thì đừng bắt học cú pháp thứ hai.
		const paths = manifest.paths?.trim();
		const coDieuKien = paths !== undefined && paths !== "" && !laVoDieuKien(paths);
		if (coDieuKien) {
			const khop = taoBoKhop(paths!);
			if (!khop) {
				problems.push({
					kind: "paths_khong_hop_le",
					scope,
					path: manifestPath,
					detail: `paths: "${paths}" khong tao duoc mau nao — skill se khong bao gio duoc gioi thieu`,
					fatal: true,
				});
				return null;
			}
			this.boKhop.set(manifest.name, khop);
		}

		return {
			manifest,
			scope,
			coDieuKien,
			// Đặt ở discover() sau khi quét dự án một lượt — readSkill() không tự
			// quét được, mà quét lại cho từng skill thì nhân chi phí lên N lần.
			coTrongDuAn: false,
			gocKhop: resolve(this.options.projectDir ?? process.cwd()),
			dir: skillDir,
			contentPath,
			contentBytes,
		};
	}

	// ─── Truy vấn ────────────────────────────────────────────────────

	list(): ReadonlyArray<Skill> {
		return this.report.skills;
	}

	get(name: string): Skill | undefined {
		return this.skills.get(name);
	}

	names(): string[] {
		return this.report.skills.map((s) => s.manifest.name);
	}

	getReport(): SkillDiscoveryReport {
		return this.report;
	}

	/**
	 * Chỉ mục nền chèn vào system prompt — CHỈ skill vô điều kiện.
	 *
	 * Skill có điều kiện cố tình vắng mặt ở đây; xem `khopFile()`.
	 */
	renderIndex(): string {
		return renderSkillIndex(
			this.report.skills.filter((sk) => !sk.coDieuKien || sk.coTrongDuAn),
			this.nganSach,
		);
	}

	/** Ngân sách ký tự đang áp dụng cho chỉ mục. */
	getNganSach(): number {
		return this.nganSach;
	}

	/**
	 * Skill có điều kiện khớp một file model vừa chạm.
	 *
	 * Trả về siêu dữ liệu thôi — nội dung SKILL.md vẫn chỉ đọc khi model gọi
	 * `LoadSkill`. Giới thiệu một dòng rồi để model quyết vẫn rẻ hơn nhiều so
	 * với tự động nhồi cả tệp vào ngữ cảnh.
	 */
	khopFile(duongTuyetDoi: string): Skill[] {
		const ra: Skill[] = [];
		for (const sk of this.report.skills) {
			// Đã nằm trong chỉ mục nền thì giới thiệu lại là bơm thừa.
			if (!sk.coDieuKien || sk.coTrongDuAn) continue;
			const khop = this.boKhop.get(sk.manifest.name);
			if (!khop) continue;
			const tuongDoi = chuanHoa(relative(sk.gocKhop, duongTuyetDoi));
			if (tuongDoi === "" || tuongDoi.startsWith("../") || tuongDoi.startsWith("/")) continue;
			if (khop(tuongDoi)) ra.push(sk);
		}
		return ra;
	}

	/** Số lần từng skill đã được nạp trong phiên — dùng để kiểm toán. */
	loadStats(): ReadonlyMap<string, number> {
		return new Map(this.loads);
	}

	/**
	 * Đọc SKILL.md. Ném lỗi nếu tên không có trong chỉ mục — không bao giờ ghép
	 * chuỗi thành đường dẫn, nên `../` trong tên chỉ đơn giản là không khớp.
	 */
	async loadContent(name: string): Promise<string> {
		const skill = this.skills.get(name);
		if (!skill) {
			throw new UnknownSkillError(name, this.names());
		}

		const buf = await readFile(skill.contentPath);
		this.loads.set(name, (this.loads.get(name) ?? 0) + 1);

		if (buf.byteLength <= this.maxContentBytes) {
			return buf.toString("utf-8");
		}

		// Cắt theo byte rồi bỏ dòng cuối — tránh để lại ký tự UTF-8 dở dang.
		const cut = buf.subarray(0, this.maxContentBytes).toString("utf-8");
		const lastNewline = cut.lastIndexOf("\n");
		const safe = lastNewline > 0 ? cut.slice(0, lastNewline + 1) : cut;

		return (
			safe +
			`\n[TRUNCATED] ${SKILL_CONTENT_FILE} is ${buf.byteLength} bytes; only the first ` +
			`${Buffer.byteLength(safe, "utf-8")} bytes were loaded. Ask the operator to shorten this skill.\n`
		);
	}
}

export class UnknownSkillError extends Error {
	constructor(
		readonly requested: string,
		readonly available: string[],
	) {
		super(
			available.length === 0
				? `Unknown skill "${requested}". No skills are installed.`
				: `Unknown skill "${requested}". Available: ${available.join(", ")}`,
		);
		this.name = "UnknownSkillError";
	}
}

/** Khung cố định của chỉ mục — không bao giờ bị cắt. */
const KHUNG_CHI_MUC =
	`Skills: procedures written by your team, stored on disk.\n` +
	`If the task matches a line below, you MUST call ${LOAD_SKILL_TOOL_NAME} with that ` +
	`name and follow it before answering. Do not answer from memory instead. ` +
	`If nothing matches, ignore this list.\n`;
// Câu dẫn viết ở thể mệnh lệnh và đặt điều kiện TRƯỚC hành động. Bản đầu viết
// "call X, but only when ..." thì qwen3-coder:30b bỏ qua hẳn — model 30B bám
// vế đầu câu, vế nhượng bộ đứng sau làm loãng chỉ thị.

/**
 * Kết xuất chỉ mục, xuống thang 3 nấc khi không vừa ngân sách.
 *
 *   ① vừa            → mô tả đầy đủ
 *   ② không vừa      → chia phần còn lại đều cho skill KHÔNG phải org, cắt mô tả
 *   ③ phần chia < 20 → skill thường chỉ còn `- tên`, skill org giữ nguyên mô tả
 *
 * Vì sao ƯU TIÊN CÓ PHÂN TẦNG chứ không cắt đều: dưới sức ép phải biết thứ gì
 * hy sinh trước. Skill org là chính sách đóng băng trong gói bàn giao — nếu nó
 * bị cắt thì trong khu cô lập không ai sửa lại được. Skill dự án thì người viết
 * đang ngồi ngay đó.
 *
 * @param nganSach trần ký tự. Bỏ trống = không cắt (dùng cho kiểm thử và cho
 *   nơi gọi tự lo ngân sách).
 */
export function renderSkillIndex(skills: ReadonlyArray<Skill>, nganSach?: number): string {
	if (skills.length === 0) return "";

	const capNhat = (s: Skill, moTa: string | null) =>
		moTa === null ? `- ${s.manifest.name}` : `- ${s.manifest.name}: ${moTa}`;
	const cat = (x: string, n: number) => (x.length <= n ? x : `${x.slice(0, Math.max(0, n - 1))}…`);

	// Trần cứng mỗi dòng áp dụng cả khi ngân sách còn dư: một mô tả 300 ký tự
	// giữa chỉ mục làm model khó quét, chứ không chỉ tốn chỗ.
	const day = skills.map((s) => capNhat(s, cat(s.manifest.whenToUse, MAX_LISTING_DESC_CHARS)));
	const nac1 = KHUNG_CHI_MUC + day.join("\n");
	if (nganSach === undefined || nac1.length <= nganSach) return nac1;

	// ── Nấc 2 và 3: org không bị đụng tới ──
	const giuNguyen = skills.filter((s) => s.scope === "org");
	const catDuoc = skills.filter((s) => s.scope !== "org");

	const chiPhiCoDinh =
		KHUNG_CHI_MUC.length +
		giuNguyen.reduce(
			(t, s) => t + capNhat(s, cat(s.manifest.whenToUse, MAX_LISTING_DESC_CHARS)).length + 1,
			0,
		) +
		// `- tên` của skill thường vẫn phải giữ, cộng dấu xuống dòng và ": ".
		catDuoc.reduce((t, s) => t + s.manifest.name.length + 4, 0);

	const conLai = nganSach - chiPhiCoDinh;
	const moiCai = catDuoc.length > 0 ? Math.floor(conLai / catDuoc.length) : 0;

	const dong = skills.map((s) => {
		if (s.scope === "org") return capNhat(s, cat(s.manifest.whenToUse, MAX_LISTING_DESC_CHARS));
		// Nấc 3: mô tả ngắn hơn sàn thì bỏ hẳn, chỉ còn tên. Mô tả cụt 8 ký tự
		// không giúp model chọn đúng, mà vẫn phải trả tiền cho nó.
		if (moiCai < MIN_DESC_LENGTH) return capNhat(s, null);
		return capNhat(s, cat(s.manifest.whenToUse, Math.min(moiCai, MAX_LISTING_DESC_CHARS)));
	});

	return KHUNG_CHI_MUC + dong.join("\n");
}

/** Đường dẫn thư mục skill của một gốc dự án — tiện cho kịch bản đóng gói. */
export function projectSkillsDir(projectDir: string): string {
	return resolve(projectDir, ...SKILLS_DIR_SEGMENTS);
}
