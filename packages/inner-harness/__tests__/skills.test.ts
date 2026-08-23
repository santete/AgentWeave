/**
 * Test hệ thống Skill.
 *
 * Trọng tâm không phải "đường đi đẹp" mà là các trường hợp hệ thống có thể
 * BÁO XANH TRONG KHI SAI — trong air-gap không ai sửa được sau khi bàn giao:
 *   · manifest hỏng bị bỏ qua im lặng
 *   · SKILL.md thiếu nhưng chỉ mục vẫn quảng cáo kỹ năng đó
 *   · tên trong manifest lệch tên thư mục
 *   · chỉ mục phình vượt ngân sách context
 *   · tham số tên chứa "../" đọc được tệp ngoài thư mục skill
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ToolContext, ToolDefinition } from "@agentweave/types";
import {
	SkillRegistry,
	UnknownSkillError,
	installSkills,
	renderSkillIndex,
	summarizeSkillReport,
	LOAD_SKILL_TOOL_NAME,
	SKILL_INDEX_SECTION,
	nganSachChiMuc,
	nguonSkillTheoDuongDan,
	quetDuAn,
	type SkillManifest,
	type Skill,
	type SkillScope,
} from "../src/skills/index";
import { thuNhac } from "../src/attachments/index";
import { taoBoKhop } from "../src/rules/khop-duong-dan";
import { createLoadSkillTool } from "../src/built-in-tools/load-skill";
import { AgentLoop } from "../src/agent-loop";

const root = join(tmpdir(), `agentweave-skills-${Date.now()}`);
const projectDir = join(root, "duan");
const userSkills = join(root, "nguoi-dung", "skills");
const orgSkills = join(root, "to-chuc", "skills");

/** Tạo một thư mục skill. Truyền `manifest: null` để cố tình bỏ skill.json. */
async function makeSkill(
	baseDir: string,
	dirName: string,
	manifest: Partial<SkillManifest> | string | null,
	content: string | null = `# ${dirName}\nHuong dan chi tiet.`,
): Promise<string> {
	const dir = join(baseDir, dirName);
	await mkdir(dir, { recursive: true });
	if (manifest !== null) {
		const body =
			typeof manifest === "string"
				? manifest
				: JSON.stringify({ name: dirName, description: "mo ta", whenToUse: "khi can", ...manifest });
		await writeFile(join(dir, "skill.json"), body);
	}
	if (content !== null) await writeFile(join(dir, "SKILL.md"), content);
	return dir;
}

function ctx(): ToolContext {
	return { sessionId: "s1", agentId: "a1", cwd: root, signal: new AbortController().signal };
}

/** Registry trỏ vào ba thư mục tạm, không đụng tới ~/.agentweave của máy thật. */
function makeRegistry(overrides: Record<string, unknown> = {}) {
	return new SkillRegistry({
		projectDir,
		userSkillsDir: userSkills,
		orgSkillsDir: orgSkills,
		...overrides,
	});
}

const projectSkills = join(projectDir, ".agentweave", "skills");

beforeAll(async () => {
	await mkdir(projectSkills, { recursive: true });
	await mkdir(userSkills, { recursive: true });
	await mkdir(orgSkills, { recursive: true });
});

afterAll(async () => {
	await rm(root, { recursive: true, force: true });
});

describe("SkillRegistry — phát hiện và độ ưu tiên", () => {
	it("quét được cả ba phạm vi", async () => {
		await makeSkill(projectSkills, "review-pr", { whenToUse: "khi review code truoc khi merge" });
		await makeSkill(userSkills, "ghi-chu-ca-nhan", {});
		await makeSkill(orgSkills, "quy-uoc-dotnet", {});

		const report = await makeRegistry().discover();

		expect(report.skills.map((s) => s.manifest.name)).toEqual([
			"ghi-chu-ca-nhan",
			"quy-uoc-dotnet",
			"review-pr",
		]);
		expect(report.problems).toHaveLength(0);
	});

	it("phạm vi hẹp hơn thắng khi trùng tên, và bản bị che phải được ghi lại", async () => {
		await makeSkill(orgSkills, "trung-ten", {}, "# ban to chuc");
		await makeSkill(userSkills, "trung-ten", {}, "# ban nguoi dung");
		await makeSkill(projectSkills, "trung-ten", {}, "# ban du an");

		const reg = makeRegistry();
		await reg.discover();

		expect(reg.get("trung-ten")?.scope).toBe("project");
		expect(await reg.loadContent("trung-ten")).toContain("ban du an");

		const shadowed = reg.getReport().shadowed.filter((s) => s.name === "trung-ten");
		expect(shadowed.map((s) => s.loser).sort()).toEqual(["org", "user"]);
		expect(shadowed.every((s) => s.winner === "project")).toBe(true);
	});

	it("thư mục phạm vi không tồn tại không phải là lỗi", async () => {
		const reg = new SkillRegistry({
			projectDir: join(root, "khong-ton-tai"),
			userSkillsDir: null,
			orgSkillsDir: null,
		});
		const report = await reg.discover();

		expect(report.skills).toHaveLength(0);
		expect(report.problems).toHaveLength(0);
		expect(report.scopes.find((s) => s.scope === "project")?.exists).toBe(false);
	});

	it("quét lại thay thế kết quả cũ chứ không cộng dồn", async () => {
		const dir = join(root, "quet-lai", ".agentweave", "skills");
		await mkdir(dir, { recursive: true });
		await makeSkill(dir, "mot", {});

		const reg = new SkillRegistry({
			projectDir: join(root, "quet-lai"),
			userSkillsDir: null,
			orgSkillsDir: null,
		});
		await reg.discover();
		const second = await reg.discover();

		expect(second.skills).toHaveLength(1);
	});
});

describe("SkillRegistry — skill hỏng phải lộ ra, không im lặng", () => {
	const badDir = join(root, "hong", ".agentweave", "skills");
	const badRegistry = () =>
		new SkillRegistry({
			projectDir: join(root, "hong"),
			userSkillsDir: null,
			orgSkillsDir: null,
		});

	it("thiếu skill.json → báo manifest_missing và loại khỏi chỉ mục", async () => {
		await makeSkill(badDir, "thieu-manifest", null);
		const report = await badRegistry().discover();

		const p = report.problems.find((x) => x.kind === "manifest_missing");
		expect(p?.fatal).toBe(true);
		expect(report.skills.map((s) => s.manifest.name)).not.toContain("thieu-manifest");
	});

	it("JSON hỏng → báo manifest_invalid kèm lý do", async () => {
		await makeSkill(badDir, "json-hong", "{ khong phai json }");
		const report = await badRegistry().discover();

		const p = report.problems.find((x) => x.path.includes("json-hong"));
		expect(p?.kind).toBe("manifest_invalid");
		expect(p?.fatal).toBe(true);
	});

	it("thiếu trường bắt buộc → báo rõ trường nào", async () => {
		const dir = join(badDir, "thieu-truong");
		await mkdir(dir, { recursive: true });
		await writeFile(join(dir, "skill.json"), JSON.stringify({ name: "thieu-truong" }));
		await writeFile(join(dir, "SKILL.md"), "# noi dung");

		const report = await badRegistry().discover();
		const p = report.problems.find((x) => x.path.includes("thieu-truong"));
		expect(p?.kind).toBe("manifest_invalid");
		expect(p?.detail).toContain("whenToUse");
	});

	it("tên manifest lệch tên thư mục → loại bỏ", async () => {
		await makeSkill(badDir, "thu-muc-a", { name: "ten-khac" });
		const report = await badRegistry().discover();

		const p = report.problems.find((x) => x.kind === "name_mismatch");
		expect(p?.fatal).toBe(true);
		expect(report.skills.map((s) => s.manifest.name)).not.toContain("ten-khac");
	});

	it("tên không phải kebab-case → từ chối (tên cũng là tên thư mục)", async () => {
		await makeSkill(badDir, "Ten Co Dau/Cach", { name: "Ten Co Dau" }).catch(() => undefined);
		const dir = join(badDir, "TenHoa");
		await mkdir(dir, { recursive: true });
		await writeFile(
			join(dir, "skill.json"),
			JSON.stringify({ name: "TenHoa", description: "d", whenToUse: "w" }),
		);
		await writeFile(join(dir, "SKILL.md"), "# x");

		const report = await badRegistry().discover();
		const p = report.problems.find((x) => x.path.includes("TenHoa"));
		expect(p?.kind).toBe("manifest_invalid");
	});

	it("thiếu SKILL.md → loại bỏ, vì chỉ mục sẽ quảng cáo một kỹ năng rỗng", async () => {
		await makeSkill(badDir, "khong-noi-dung", {}, null);
		const report = await badRegistry().discover();

		const p = report.problems.find((x) => x.kind === "content_missing");
		expect(p?.fatal).toBe(true);
		expect(report.skills.map((s) => s.manifest.name)).not.toContain("khong-noi-dung");
	});

	it("SKILL.md rỗng → loại bỏ", async () => {
		await makeSkill(badDir, "rong", {}, "");
		const report = await badRegistry().discover();

		expect(report.problems.some((x) => x.kind === "content_empty")).toBe(true);
	});
});

describe("SkillRegistry — ngân sách context", () => {
	it("chỉ mục chỉ chứa name + whenToUse, không chứa description hay nội dung", async () => {
		const dir = join(root, "ngan-sach", ".agentweave", "skills");
		await mkdir(dir, { recursive: true });
		await makeSkill(
			dir,
			"viet-migration",
			{ description: "MO TA DAI KHONG DUOC VAO CHI MUC", whenToUse: "khi doi lugc do CSDL" },
			"# NOI DUNG DAY DU KHONG DUOC VAO CHI MUC",
		);

		const reg = new SkillRegistry({
			projectDir: join(root, "ngan-sach"),
			userSkillsDir: null,
			orgSkillsDir: null,
		});
		await reg.discover();
		const index = reg.renderIndex();

		expect(index).toContain("viet-migration: khi doi lugc do CSDL");
		expect(index).not.toContain("MO TA DAI");
		expect(index).not.toContain("NOI DUNG DAY DU");
		expect(index).toContain(LOAD_SKILL_TOOL_NAME);
	});

	it("không có skill nào thì chỉ mục là chuỗi rỗng — không tốn token", () => {
		expect(renderSkillIndex([])).toBe("");
	});

	it("50 skill vẫn nằm dưới 4 KB chỉ mục", async () => {
		const dir = join(root, "nam-muoi", ".agentweave", "skills");
		await mkdir(dir, { recursive: true });
		for (let i = 0; i < 50; i++) {
			const name = `ky-nang-so-${String(i).padStart(2, "0")}`;
			await makeSkill(dir, name, { whenToUse: "khi gap viec thuoc nhom nay va can quy trinh" });
		}

		const reg = new SkillRegistry({
			projectDir: join(root, "nam-muoi"),
			userSkillsDir: null,
			orgSkillsDir: null,
		});
		const report = await reg.discover();

		expect(report.skills).toHaveLength(50);
		expect(report.indexBytes).toBeLessThan(4096);
		expect(report.problems.filter((p) => p.kind === "over_scope_limit")).toHaveLength(0);
	});

	it("vượt trần mỗi phạm vi → cảnh báo nhưng không loại bỏ", async () => {
		const dir = join(root, "vuot-tran", ".agentweave", "skills");
		await mkdir(dir, { recursive: true });
		for (let i = 0; i < 4; i++) await makeSkill(dir, `sk-${i}`, {});

		const reg = new SkillRegistry({
			projectDir: join(root, "vuot-tran"),
			userSkillsDir: null,
			orgSkillsDir: null,
			maxSkillsPerScope: 3,
		});
		const report = await reg.discover();

		const p = report.problems.find((x) => x.kind === "over_scope_limit");
		expect(p?.fatal).toBe(false);
		expect(report.skills).toHaveLength(4);
	});

	it("whenToUse quá dài → cảnh báo, vì chỉ mục nằm thường trực trong prompt", async () => {
		const dir = join(root, "when-dai", ".agentweave", "skills");
		await mkdir(dir, { recursive: true });
		await makeSkill(dir, "dai-dong", { whenToUse: "x".repeat(150) });

		const reg = new SkillRegistry({
			projectDir: join(root, "when-dai"),
			userSkillsDir: null,
			orgSkillsDir: null,
		});
		const report = await reg.discover();

		const p = report.problems.find((x) => x.kind === "when_to_use_too_long");
		expect(p?.fatal).toBe(false);
		expect(report.skills).toHaveLength(1);
	});

	it("SKILL.md vượt trần thì bị cắt kèm thông báo, không cắt lặng lẽ", async () => {
		const dir = join(root, "cat-bot", ".agentweave", "skills");
		await mkdir(dir, { recursive: true });
		const long = Array.from({ length: 500 }, (_, i) => `dong ${i} voi mot it noi dung`).join("\n");
		await makeSkill(dir, "dai-qua", {}, long);

		const reg = new SkillRegistry({
			projectDir: join(root, "cat-bot"),
			userSkillsDir: null,
			orgSkillsDir: null,
			maxContentBytes: 1024,
		});
		const report = await reg.discover();
		const content = await reg.loadContent("dai-qua");

		expect(report.problems.some((p) => p.kind === "content_too_large")).toBe(true);
		expect(content).toContain("[TRUNCATED]");
		expect(content).not.toContain("dong 499");
		expect(content).not.toContain("�"); // không để lại ký tự UTF-8 dở dang
	});

	it("giữ nguyên tiếng Việt có dấu khi cắt", async () => {
		const dir = join(root, "cat-utf8", ".agentweave", "skills");
		await mkdir(dir, { recursive: true });
		const long = Array.from({ length: 200 }, () => "Quy ước đặt tên biến phải rõ ràng").join("\n");
		await makeSkill(dir, "co-dau", {}, long);

		const reg = new SkillRegistry({
			projectDir: join(root, "cat-utf8"),
			userSkillsDir: null,
			orgSkillsDir: null,
			maxContentBytes: 300,
		});
		await reg.discover();
		const content = await reg.loadContent("co-dau");

		expect(content).toContain("Quy ước đặt tên");
		expect(content).not.toContain("�");
	});
});

describe("Tool LoadSkill", () => {
	let tool: ToolDefinition<{ name: string }, string>;
	let reg: SkillRegistry;

	beforeAll(async () => {
		const dir = join(root, "tool", ".agentweave", "skills");
		await mkdir(dir, { recursive: true });
		await makeSkill(dir, "xu-ly-su-co", { version: "1.2.0" }, "# Xu ly su co\nB1. Doc log.");
		reg = new SkillRegistry({
			projectDir: join(root, "tool"),
			userSkillsDir: null,
			orgSkillsDir: null,
		});
		await reg.discover();
		tool = createLoadSkillTool(reg);
	});

	it("tên tool và metadata khớp quy ước của 6 tool sẵn có", () => {
		expect(tool.name).toBe("LoadSkill");
		expect(tool.metadata.isReadOnly).toBe(true);
		expect(tool.metadata.isDestructive).toBe(false);
	});

	it("trả về nội dung SKILL.md kèm tên, phiên bản và phạm vi", async () => {
		const out = await tool.execute({ name: "xu-ly-su-co" }, ctx());

		expect(out).toContain("SKILL: xu-ly-su-co v1.2.0");
		expect(out).toContain("project scope");
		expect(out).toContain("B1. Doc log.");
	});

	it("bỏ qua khoảng trắng thừa quanh tên", async () => {
		const out = await tool.execute({ name: "  xu-ly-su-co  " }, ctx());
		expect(out).toContain("B1. Doc log.");
	});

	it("tên lạ → lỗi kèm danh sách tên hợp lệ để model tự sửa", async () => {
		await expect(tool.execute({ name: "khong-co" }, ctx())).rejects.toThrow(
			/Unknown skill "khong-co".*xu-ly-su-co/s,
		);
	});

	it("tên chứa ../ không đọc được tệp ngoài thư mục skill", async () => {
		for (const evil of ["../../../etc/passwd", "/etc/passwd", "..", "./xu-ly-su-co"]) {
			await expect(tool.execute({ name: evil }, ctx())).rejects.toThrow(UnknownSkillError);
		}
	});

	it("đếm số lần nạp để kiểm toán lãng phí context", async () => {
		const fresh = new SkillRegistry({
			projectDir: join(root, "tool"),
			userSkillsDir: null,
			orgSkillsDir: null,
		});
		await fresh.discover();
		const t = createLoadSkillTool(fresh);

		await t.execute({ name: "xu-ly-su-co" }, ctx());
		await t.execute({ name: "xu-ly-su-co" }, ctx());

		expect(fresh.loadStats().get("xu-ly-su-co")).toBe(2);
	});
});

describe("installSkills — nối vào harness trong một bước", () => {
	it("chèn chỉ mục vào system prompt và đăng ký tool", async () => {
		const dir = join(root, "install", ".agentweave", "skills");
		await mkdir(dir, { recursive: true });
		await makeSkill(dir, "quy-uoc-java", { whenToUse: "khi lam viec voi Spring Boot" });

		const loop = new AgentLoop({ model: "qwen3-coder:30b", systemPrompt: "Ban la tro ly." });
		const { report } = await installSkills(loop, {
			projectDir: join(root, "install"),
			userSkillsDir: null,
			orgSkillsDir: null,
			quiet: true,
		});

		expect(report.skills).toHaveLength(1);
		expect(loop.getTools().map((t) => t.name)).toContain(LOAD_SKILL_TOOL_NAME);

		const prompt = loop.getSystemPrompt();
		expect(prompt).toContain("Ban la tro ly.");
		expect(prompt).toContain(`[${SKILL_INDEX_SECTION}]`);
		expect(prompt).toContain("quy-uoc-java: khi lam viec voi Spring Boot");
	});

	it("không có skill nào thì không chèn gì vào prompt, nhưng tool vẫn sẵn sàng", async () => {
		const loop = new AgentLoop({ model: "qwen3-coder:30b", systemPrompt: "Goc." });
		await installSkills(loop, {
			projectDir: join(root, "trong-rong"),
			userSkillsDir: null,
			orgSkillsDir: null,
			quiet: true,
		});

		expect(loop.getSystemPrompt()).toBe("Goc.");
		expect(loop.getTools().map((t) => t.name)).toContain(LOAD_SKILL_TOOL_NAME);
	});

	it("cài hai lần không làm chỉ mục bị lặp trong prompt", async () => {
		const dir = join(root, "install"); // dùng lại skill ở trên
		const loop = new AgentLoop({ model: "qwen3-coder:30b" });
		const opts = {
			projectDir: dir,
			userSkillsDir: null,
			orgSkillsDir: null,
			quiet: true,
		} as const;

		await installSkills(loop, opts);
		await installSkills(loop, opts);

		const occurrences = loop.getSystemPrompt().split("quy-uoc-java:").length - 1;
		expect(occurrences).toBe(1);
	});

	it("tóm tắt một dòng dùng được cho bộ tự kiểm tra", async () => {
		const reg = makeRegistry();
		const report = await reg.discover();
		expect(summarizeSkillReport(report)).toMatch(/\d+ skill \(\d+ co dieu kien\) · chi muc \d+\/\d+ byte/);
	});
});

// ─────────────────────────────────────────────────────────────────
// Nâng cấp theo bản distil harness: ngân sách theo % cửa sổ, skill có
// điều kiện, bơm delta. Trọng tâm vẫn là "báo xanh mà sai": chỉ mục
// phình quá ngân sách, hoặc skill có điều kiện lọt vào chỉ mục nền và
// mất sạch lợi ích context.
// ─────────────────────────────────────────────────────────────────

describe("ngan sach chi muc theo % cua so", () => {
	it("nganSachChiMuc = 1% x cua so x 4 ky tu", () => {
		expect(nganSachChiMuc(64_000)).toBe(2_560);
		expect(nganSachChiMuc(200_000)).toBe(8_000);
	});

	function skillGia(ten: string, scope: SkillScope, moTa: string): Skill {
		return {
			manifest: { name: ten, description: moTa, whenToUse: moTa },
			scope,
			coDieuKien: false,
			gocKhop: "/tmp",
			dir: `/tmp/${ten}`,
			contentPath: `/tmp/${ten}/SKILL.md`,
			contentBytes: 10,
		};
	}

	it("nac 1: vua ngan sach thi giu mo ta day du", () => {
		const ds = [skillGia("a", "project", "mo ta ngan gon cua skill a")];
		const ra = renderSkillIndex(ds, 5_000);
		expect(ra).toContain("- a: mo ta ngan gon cua skill a");
	});

	it("tran cung 250 ky tu moi dong ap dung ca khi con du ngan sach", () => {
		const dai = "x".repeat(300);
		const ra = renderSkillIndex([skillGia("a", "project", dai)], 100_000);
		const dong = ra.split("\n").find((d) => d.startsWith("- a:"))!;
		expect(dong.length).toBeLessThanOrEqual("- a: ".length + 250);
	});

	it("nac 2: chat ngan sach thi cat mo ta skill thuong, GIU NGUYEN skill org", () => {
		const moTa = "y".repeat(200);
		const ds = [
			skillGia("org-mot", "org", moTa),
			skillGia("du-an-mot", "project", moTa),
			skillGia("du-an-hai", "project", moTa),
		];
		const ra = renderSkillIndex(ds, 700);

		// Skill org la chinh sach dong bang trong goi ban giao — trong khu co lap
		// khong ai sua lai duoc, nen no la thu HY SINH SAU CUNG.
		expect(ra).toContain(`- org-mot: ${moTa}`);
		const dongDuAn = ra.split("\n").find((d) => d.startsWith("- du-an-mot:"))!;
		expect(dongDuAn.length).toBeLessThan(moTa.length);
	});

	it("nac 3: ngan sach qua chat thi skill thuong chi con TEN, org van du mo ta", () => {
		const moTa = "z".repeat(200);
		const ds = [
			skillGia("org-mot", "org", moTa),
			...Array.from({ length: 20 }, (_, i) => skillGia(`du-an-${i}`, "project", moTa)),
		];
		const ra = renderSkillIndex(ds, 420);

		expect(ra).toContain(`- org-mot: ${moTa}`);
		expect(ra).toContain("\n- du-an-0\n");
		expect(ra).not.toContain("- du-an-0:");
	});

	it("bao cao khi chi muc van vuot ngan sach sau khi da xuong thang het muc", async () => {
		const dir = join(root, "ngan-sach", ".agentweave", "skills");
		await mkdir(dir, { recursive: true });
		for (let i = 0; i < 6; i++) {
			await makeSkill(dir, `org-lon-${i}`, { whenToUse: "w".repeat(250) });
		}
		const reg = new SkillRegistry({
			projectDir: null,
			userSkillsDir: null,
			orgSkillsDir: dir,
			contextWindow: 8_000, // ngan sach 320 ky tu
		});
		const rp = await reg.discover();
		expect(rp.problems.some((p) => p.kind === "chi_muc_vuot_ngan_sach")).toBe(true);
	});
});

describe("skill co dieu kien theo paths:", () => {
	const goc = join(root, "co-dieu-kien");
	const skillsDir = join(goc, ".agentweave", "skills");

	it("KHONG vao chi muc nen, nhung van co trong danh sach", async () => {
		await makeSkill(skillsDir, "quy-uoc-sql", {
			paths: "**/*.sql",
			whenToUse: "khi sua migration SQL",
		});
		await makeSkill(skillsDir, "luon-dung", { whenToUse: "moi luc" });

		const reg = new SkillRegistry({ projectDir: goc, userSkillsDir: null, orgSkillsDir: null });
		const rp = await reg.discover();

		expect(rp.soCoDieuKien).toBe(1);
		expect(reg.renderIndex()).not.toContain("quy-uoc-sql");
		expect(reg.renderIndex()).toContain("luon-dung");
		// Van nap duoc bang ten neu model hoac nguoi dung goi thang.
		expect(reg.get("quy-uoc-sql")).toBeDefined();
	});

	it("khopFile tra skill khi cham file khop, khong tra khi lech", async () => {
		const reg = new SkillRegistry({ projectDir: goc, userSkillsDir: null, orgSkillsDir: null });
		await reg.discover();
		expect(reg.khopFile(join(goc, "db", "001.sql")).map((s) => s.manifest.name)).toEqual([
			"quy-uoc-sql",
		]);
		expect(reg.khopFile(join(goc, "src", "a.ts"))).toEqual([]);
	});

	it('paths: "**" duoc coi la vo dieu kien', async () => {
		const g2 = join(root, "moi-noi");
		await makeSkill(join(g2, ".agentweave", "skills"), "khap-noi", { paths: "**" });
		const reg = new SkillRegistry({ projectDir: g2, userSkillsDir: null, orgSkillsDir: null });
		const rp = await reg.discover();
		expect(rp.soCoDieuKien).toBe(0);
		expect(reg.renderIndex()).toContain("khap-noi");
	});

	it("paths: hong thi BO skill va bao loi nghiem trong", async () => {
		const g3 = join(root, "paths-hong");
		await makeSkill(join(g3, ".agentweave", "skills"), "hong", { paths: "/" });
		const reg = new SkillRegistry({ projectDir: g3, userSkillsDir: null, orgSkillsDir: null });
		const rp = await reg.discover();
		expect(rp.skills.map((s) => s.manifest.name)).not.toContain("hong");
		expect(rp.problems.some((p) => p.kind === "paths_khong_hop_le" && p.fatal)).toBe(true);
	});
});

describe("nguon nhac cua skill", () => {
	it("gioi thieu skill co dieu kien khi cham file, va chi mot lan", async () => {
		const goc = join(root, "co-dieu-kien");
		const reg = new SkillRegistry({ projectDir: goc, userSkillsDir: null, orgSkillsDir: null });
		await reg.discover();
		const nguon = nguonSkillTheoDuongDan(reg);

		const lan1 = await thuNhac([nguon], {
			luot: 2,
			fileVuaCham: [join(goc, "db", "a.sql"), join(goc, "db", "b.sql")],
			daBom: new Set(),
		});
		expect(lan1.nhac).toHaveLength(1);
		expect(lan1.nhac[0]?.noiDung).toContain("quy-uoc-sql");
		expect(lan1.nhac[0]?.noiDung).toContain(LOAD_SKILL_TOOL_NAME);

		const lan2 = await thuNhac([nguon], {
			luot: 3,
			fileVuaCham: [join(goc, "db", "c.sql")],
			daBom: new Set(["skill:quy-uoc-sql"]),
		});
		expect(lan2.nhac).toEqual([]);
	});

});

describe("mo ta LoadSkill", () => {
	it("neu HAU QUA chu khong chi ra lenh cam, va chong goi lai", () => {
		const reg = new SkillRegistry({ projectDir: null, userSkillsDir: null, orgSkillsDir: null });
		const tool = createLoadSkillTool(reg);
		// Model nho tuan theo cau neu hau qua tot hon han cau cam truu tuong.
		expect(tool.description).toContain("BLOCKING REQUIREMENT");
		expect(tool.description).toContain("you will get it wrong");
		expect(tool.description).toContain("ALREADY loaded");
	});
});

// ─────────────────────────────────────────────────────────────────
// Dò stack lúc khởi động.
//
// Vấn đề: skill quy ước gắn `paths:` chỉ xuất hiện SAU khi model chạm
// tệp khớp — tức là sau khi nó đã viết tệp .cs đầu tiên theo trí nhớ.
// Quy ước sinh ra để định hình chính lần viết đó.
// ─────────────────────────────────────────────────────────────────

describe("do stack luc khoi dong", () => {
	it("du an DA CO tep khop → skill vao thang chi muc nen, co mat tu luot 1", async () => {
		const goc = join(root, "du-an-dotnet");
		await mkdir(join(goc, "src"), { recursive: true });
		await writeFile(join(goc, "src", "Program.cs"), "class Program {}");
		await makeSkill(join(goc, ".agentweave", "skills"), "quy-uoc-dotnet", {
			paths: "**/*.cs, **/*.csproj",
			whenToUse: "khi viet code C#",
		});

		const reg = new SkillRegistry({ projectDir: goc, userSkillsDir: null, orgSkillsDir: null });
		const rp = await reg.discover();

		expect(reg.renderIndex()).toContain("quy-uoc-dotnet");
		expect(rp.skills[0]?.coTrongDuAn).toBe(true);
		// Van la skill co dieu kien, chi la dieu kien DA thoa.
		expect(rp.skills[0]?.coDieuKien).toBe(true);
	});

	it("du an KHONG co tep khop → skill nam im, khong ton mot dong chi muc nao", async () => {
		const goc = join(root, "du-an-python");
		await mkdir(join(goc, "src"), { recursive: true });
		await writeFile(join(goc, "src", "main.py"), "print(1)");
		await makeSkill(join(goc, ".agentweave", "skills"), "quy-uoc-dotnet", {
			paths: "**/*.cs, **/*.csproj",
			whenToUse: "khi viet code C#",
		});

		const reg = new SkillRegistry({ projectDir: goc, userSkillsDir: null, orgSkillsDir: null });
		const rp = await reg.discover();

		expect(reg.renderIndex()).not.toContain("quy-uoc-dotnet");
		expect(rp.soCoDieuKien).toBe(1);
		// Van kich hoat duoc theo duong dan neu ve sau model tao tep .cs.
		expect(reg.khopFile(join(goc, "src", "A.cs")).map((s) => s.manifest.name)).toEqual([
			"quy-uoc-dotnet",
		]);
	});

	it("skill da vao chi muc nen thi KHONG gioi thieu lai qua attachment", async () => {
		const goc = join(root, "du-an-dotnet");
		const reg = new SkillRegistry({ projectDir: goc, userSkillsDir: null, orgSkillsDir: null });
		await reg.discover();
		// Bom them mot dong gioi thieu cho thu model da thay trong chi muc la lang phi.
		expect(reg.khopFile(join(goc, "src", "Program.cs"))).toEqual([]);
	});

	it("tep trong node_modules KHONG duoc tinh — mot thu vien khong lam doi stack du an", async () => {
		const goc = join(root, "du-an-js");
		await mkdir(join(goc, "node_modules", "vai-thu-vien"), { recursive: true });
		await writeFile(join(goc, "node_modules", "vai-thu-vien", "Native.cs"), "// cua thu vien");
		await writeFile(join(goc, "index.js"), "1");
		await makeSkill(join(goc, ".agentweave", "skills"), "quy-uoc-dotnet", {
			paths: "**/*.cs",
			whenToUse: "khi viet code C#",
		});

		const reg = new SkillRegistry({ projectDir: goc, userSkillsDir: null, orgSkillsDir: null });
		await reg.discover();
		expect(reg.renderIndex()).not.toContain("quy-uoc-dotnet");
	});

	it("quetDuAn tra ve dung khoa da khop, bo qua thu muc build", async () => {
		const goc = join(root, "quet-thu");
		await mkdir(join(goc, "a", "b"), { recursive: true });
		await mkdir(join(goc, "dist"), { recursive: true });
		await writeFile(join(goc, "a", "b", "x.sql"), "select 1");
		await writeFile(join(goc, "dist", "y.rs"), "fn main(){}");

		const trung = await quetDuAn(goc, [
			{ khoa: "sql", khop: taoBoKhop("**/*.sql")! },
			{ khoa: "rust", khop: taoBoKhop("**/*.rs")! },
		]);
		expect([...trung]).toEqual(["sql"]);
	});

	it("khong co bo khop nao thi khong quet gi ca", async () => {
		expect(await quetDuAn(root, [])).toEqual(new Set());
	});
});
