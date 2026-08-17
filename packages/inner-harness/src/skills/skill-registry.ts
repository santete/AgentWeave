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
import { join, resolve } from "node:path";
import {
	DEFAULT_MAX_CONTENT_BYTES,
	DEFAULT_MAX_SKILLS_PER_SCOPE,
	SCOPE_PRECEDENCE,
	SKILLS_DIR_SEGMENTS,
	SKILL_CONTENT_FILE,
	SKILL_MANIFEST_FILE,
	SkillManifestSchema,
	WHEN_TO_USE_SOFT_LIMIT,
	type ScopeScan,
	type ShadowedSkill,
	type Skill,
	type SkillDiscoveryReport,
	type SkillProblem,
	type SkillScope,
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
}

function scopeDirs(options: SkillRegistryOptions): Array<{ scope: SkillScope; dir: string | null }> {
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

	private skills = new Map<string, Skill>();
	private report: SkillDiscoveryReport = {
		skills: [],
		problems: [],
		shadowed: [],
		scopes: [],
		indexBytes: 0,
	};
	/** Đếm số lần nạp từng skill — phục vụ kiểm toán và đo lãng phí context. */
	private loads = new Map<string, number>();

	constructor(options: SkillRegistryOptions = {}) {
		this.options = options;
		this.maxContentBytes = options.maxContentBytes ?? DEFAULT_MAX_CONTENT_BYTES;
		this.maxSkillsPerScope = options.maxSkillsPerScope ?? DEFAULT_MAX_SKILLS_PER_SCOPE;
	}

	/** Quét cả ba phạm vi. Gọi lại được — mỗi lần quét thay thế kết quả cũ. */
	async discover(): Promise<SkillDiscoveryReport> {
		const problems: SkillProblem[] = [];
		const shadowed: ShadowedSkill[] = [];
		const scopes: ScopeScan[] = [];
		const chosen = new Map<string, Skill>();

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
		this.report = {
			skills,
			problems,
			shadowed,
			scopes,
			indexBytes: Buffer.byteLength(renderSkillIndex(skills), "utf-8"),
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

		return { manifest, scope, dir: skillDir, contentPath, contentBytes };
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

	/** Chỉ mục chèn vào system prompt. Chuỗi rỗng khi không có skill nào. */
	renderIndex(): string {
		return renderSkillIndex(this.report.skills);
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

/**
 * Kết xuất chỉ mục. Mỗi skill một dòng `- name: whenToUse` (~60-90 byte).
 * Phần khung viết bằng tiếng Anh cho đồng bộ với mô tả của 6 tool sẵn có.
 */
export function renderSkillIndex(skills: ReadonlyArray<Skill>): string {
	if (skills.length === 0) return "";

	const lines = skills.map((s) => `- ${s.manifest.name}: ${s.manifest.whenToUse}`);
	// Câu dẫn viết ở thể mệnh lệnh và đặt điều kiện TRƯỚC hành động. Bản đầu viết
	// "call X, but only when ..." thì qwen3-coder:30b bỏ qua hẳn — model 30B bám
	// vế đầu câu, vế nhượng bộ đứng sau làm loãng chỉ thị.
	return (
		`Skills: procedures written by your team, stored on disk.\n` +
		`If the task matches a line below, you MUST call ${LOAD_SKILL_TOOL_NAME} with that ` +
		`name and follow it before answering. Do not answer from memory instead. ` +
		`If nothing matches, ignore this list.\n` +
		lines.join("\n")
	);
}

/** Đường dẫn thư mục skill của một gốc dự án — tiện cho kịch bản đóng gói. */
export function projectSkillsDir(projectDir: string): string {
	return resolve(projectDir, ...SKILLS_DIR_SEGMENTS);
}
