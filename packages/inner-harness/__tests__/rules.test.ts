/**
 * Test hệ Rule.
 *
 * Trọng tâm là các chỗ có thể BÁO XANH TRONG KHI SAI:
 *   · rule co dieu kien lot vao system prompt (mat het loi ich context)
 *   · rule vo dieu kien bi coi la co dieu kien (chinh sach mat hieu luc)
 *   · @include vong lap hoac doc ra ngoai du an
 *   · thu tu nap sai — tang uu tien cao nam truoc tang thap
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
	RuleRegistry,
	installRules,
	nguonRuleTheoDuongDan,
	summarizeRuleReport,
	taoBoKhop,
	laVoDieuKien,
	tachFrontmatter,
	boChuThichHtml,
	moRongInclude,
	RULE_SECTION,
	CAU_DAN_RULE,
	MAX_INCLUDE_DEPTH,
} from "../src/rules/index";
import { thuNhac } from "../src/attachments/index";

const root = join(tmpdir(), `agentweave-rules-${Date.now()}`);
const duAn = join(root, "duan");
const userRules = join(root, "nguoi-dung", "rules");
const orgRules = join(root, "to-chuc", "rules");

async function ghi(duong: string, noi: string): Promise<string> {
	await mkdir(join(duong, ".."), { recursive: true });
	await writeFile(duong, noi);
	return duong;
}

beforeAll(async () => {
	await mkdir(join(duAn, ".git"), { recursive: true });
	await mkdir(join(duAn, "src", "api"), { recursive: true });
	await mkdir(userRules, { recursive: true });
	await mkdir(orgRules, { recursive: true });
});

afterAll(async () => {
	await rm(root, { recursive: true, force: true });
});

describe("khop duong dan kieu gitignore", () => {
	it("mau khong co / thi khop TEN TEP o moi tang", () => {
		const k = taoBoKhop("*.sql")!;
		expect(k("a.sql")).toBe(true);
		expect(k("db/migrations/001.sql")).toBe(true);
		expect(k("a.ts")).toBe(false);
	});

	it("mau co / thi neo tu goc pham vi", () => {
		const k = taoBoKhop("src/api/**")!;
		expect(k("src/api/user.ts")).toBe(true);
		expect(k("src/api/v2/user.ts")).toBe(true);
		expect(k("src/api")).toBe(true);
		expect(k("lib/src/api/user.ts")).toBe(false);
	});

	it("* khong vuot qua dau /", () => {
		const k = taoBoKhop("src/*.ts")!;
		expect(k("src/a.ts")).toBe(true);
		expect(k("src/sub/a.ts")).toBe(false);
	});

	it("**/ khop ca truong hop khong co tang trung gian", () => {
		const k = taoBoKhop("src/**/a.ts")!;
		expect(k("src/a.ts")).toBe(true);
		expect(k("src/x/y/a.ts")).toBe(true);
	});

	it("nhieu mau ngan bang dau phay — khop mot la du", () => {
		const k = taoBoKhop("src/api/**, **/*.sql")!;
		expect(k("src/api/a.ts")).toBe(true);
		expect(k("db/x.sql")).toBe(true);
		expect(k("web/a.css")).toBe(false);
	});

	it("** don thuan duoc coi la VO DIEU KIEN", () => {
		expect(laVoDieuKien("**")).toBe(true);
		expect(laVoDieuKien("  ")).toBe(true);
		expect(laVoDieuKien("src/**")).toBe(false);
	});

	it("duong di nguoc ra ngoai goc khong bao gio khop", () => {
		const k = taoBoKhop("**/*.ts")!;
		expect(k("../ngoai/a.ts")).toBe(false);
	});
});

describe("frontmatter", () => {
	it("doc duoc key: value va tach than", () => {
		const r = tachFrontmatter('---\npaths: "src/**"\nghiChu: x\n---\nNoi dung');
		expect(r.truong.paths).toBe("src/**");
		expect(r.truong.ghiChu).toBe("x");
		expect(r.than.trim()).toBe("Noi dung");
	});

	it("frontmatter mo ma khong dong thi GIU NGUYEN ca tep", () => {
		const raw = "---\npaths: src/**\nkhong dong dau";
		const r = tachFrontmatter(raw);
		expect(r.coFrontmatter).toBe(false);
		expect(r.than).toBe(raw);
	});

	it("khong co frontmatter thi than = nguyen ban", () => {
		const r = tachFrontmatter("# Tieu de\nnoi dung");
		expect(r.coFrontmatter).toBe(false);
		expect(r.truong).toEqual({});
	});
});

describe("chu thich HTML", () => {
	it("bo chu thich ngoai khoi ma, GIU trong khoi ma", () => {
		const s = boChuThichHtml("a <!-- an --> b\n```\n<!-- giu -->\n```\n");
		expect(s).not.toContain("an");
		expect(s).toContain("<!-- giu -->");
	});

	it("chu thich chua dong thi giu nguyen — go nham khong duoc nuot ca tep", () => {
		const s = boChuThichHtml("truoc <!-- chua dong\nnoi dung quan trong");
		expect(s).toContain("noi dung quan trong");
	});
});

describe("@include", () => {
	it("nap duoc tep tuong doi va ghi ro nguon", async () => {
		await ghi(join(duAn, "docs", "chung.md"), "Quy uoc chung o day.");
		const r = await moRongInclude("Xem @./docs/chung.md de biet them.", {
			thuMuc: duAn,
			gocDuAn: duAn,
			scope: "project",
		});
		expect(r.noiDung).toContain("Quy uoc chung o day.");
		expect(r.noiDung).toContain("@./docs/chung.md");
		expect(r.problems).toEqual([]);
	});

	it("KHONG dung den @nhac trong van xuoi (khong co duoi tep)", async () => {
		const r = await moRongInclude("Hoi @nhom-backend nhe, mail @a.b", {
			thuMuc: duAn,
			gocDuAn: duAn,
			scope: "project",
		});
		expect(r.noiDung).toContain("@nhom-backend");
		expect(r.problems).toEqual([]);
	});

	it("bo qua @ trong ma noi tuyen va trong khoi ma", async () => {
		await ghi(join(duAn, "docs", "x.md"), "NOI DUNG BI NAP");
		const r = await moRongInclude(
			"chay `npm i @./docs/x.md` roi\n```\n@./docs/x.md\n```\n",
			{ thuMuc: duAn, gocDuAn: duAn, scope: "project" },
		);
		expect(r.noiDung).not.toContain("NOI DUNG BI NAP");
	});

	it("chan duoi tep khong nam trong danh sach trang", async () => {
		await ghi(join(duAn, "docs", "logo.png"), "GIA-LAM-NHI-PHAN");
		const r = await moRongInclude("@./docs/logo.png", {
			thuMuc: duAn,
			gocDuAn: duAn,
			scope: "project",
		});
		expect(r.noiDung).not.toContain("GIA-LAM-NHI-PHAN");
		expect(r.problems[0]?.kind).toBe("include_duoi_bi_chan");
	});

	it("chan vong lap A -> B -> A", async () => {
		await ghi(join(duAn, "docs", "a.md"), "A roi @./b.md");
		await ghi(join(duAn, "docs", "b.md"), "B roi @./a.md");
		const r = await moRongInclude("@./docs/a.md", {
			thuMuc: duAn,
			gocDuAn: duAn,
			scope: "project",
		});
		expect(r.problems.some((p) => p.kind === "include_vong_lap")).toBe(true);
	});

	it("chan do sau qua 5 tang", async () => {
		for (let i = 0; i <= 8; i++) {
			await ghi(join(duAn, "sau", `t${i}.md`), `tang ${i} @./t${i + 1}.md`);
		}
		const r = await moRongInclude("@./sau/t0.md", {
			thuMuc: duAn,
			gocDuAn: duAn,
			scope: "project",
		});
		expect(r.problems.some((p) => p.kind === "include_qua_sau")).toBe(true);
		expect(r.daNap.length).toBeLessThanOrEqual(MAX_INCLUDE_DEPTH);
	});

	it("chan include tro RA NGOAI goc du an theo mac dinh", async () => {
		await ghi(join(root, "ngoai.md"), "BI MAT NGOAI DU AN");
		const r = await moRongInclude("@../ngoai.md", {
			thuMuc: duAn,
			gocDuAn: duAn,
			scope: "project",
		});
		expect(r.noiDung).not.toContain("BI MAT NGOAI DU AN");
		expect(r.problems[0]?.kind).toBe("include_ngoai_du_an");
	});

	it("mo co thi nap duoc tep ngoai du an", async () => {
		const r = await moRongInclude("@../ngoai.md", {
			thuMuc: duAn,
			gocDuAn: duAn,
			chophepNgoaiDuAn: true,
			scope: "project",
		});
		expect(r.noiDung).toContain("BI MAT NGOAI DU AN");
	});
});

describe("RuleRegistry", () => {
	it("nap 4 tang theo dung thu tu uu tien tang dan", async () => {
		await ghi(join(orgRules, "chinh-sach.md"), "LUAT-TO-CHUC");
		await ghi(join(userRules, "ca-nhan.md"), "LUAT-NGUOI-DUNG");
		await ghi(join(duAn, "AGENTS.md"), "LUAT-DU-AN");
		await ghi(join(duAn, "AGENTS.local.md"), "LUAT-LOCAL");

		const reg = new RuleRegistry({ projectDir: duAn, userRulesDir: userRules, orgRulesDir: orgRules });
		await reg.discover();
		const s = reg.renderSection();

		expect(s.startsWith(CAU_DAN_RULE)).toBe(true);
		// Tang nap sau nam gan cuoi prompt = duoc model chu y nhat.
		expect(s.indexOf("LUAT-TO-CHUC")).toBeLessThan(s.indexOf("LUAT-NGUOI-DUNG"));
		expect(s.indexOf("LUAT-NGUOI-DUNG")).toBeLessThan(s.indexOf("LUAT-DU-AN"));
		expect(s.indexOf("LUAT-DU-AN")).toBeLessThan(s.indexOf("LUAT-LOCAL"));
		// Nhan nguon phai co, khong thi model khong phan biet duoc trong luong.
		expect(s).toContain("organization policy");
		expect(s).toContain("not checked in");
	});

	it("rule co dieu kien KHONG lot vao system prompt", async () => {
		await ghi(
			join(duAn, ".agentweave", "rules", "api.md"),
			'---\npaths: "src/api/**"\n---\nLUAT-API-CHI-KHI-CAN',
		);
		const reg = new RuleRegistry({ projectDir: duAn, userRulesDir: null, orgRulesDir: null });
		const rp = await reg.discover();

		expect(reg.renderSection()).not.toContain("LUAT-API-CHI-KHI-CAN");
		expect(rp.soCoDieuKien).toBeGreaterThanOrEqual(1);
	});

	it("khopFile tra dung rule khi cham file trong pham vi", async () => {
		const reg = new RuleRegistry({ projectDir: duAn, userRulesDir: null, orgRulesDir: null });
		await reg.discover();

		const trung = reg.khopFile(join(duAn, "src", "api", "user.ts"));
		expect(trung.map((r) => r.noiDung)).toContain("LUAT-API-CHI-KHI-CAN");

		expect(reg.khopFile(join(duAn, "src", "web", "a.css"))).toEqual([]);
		// File ngoai goc du an khong duoc keo rule cua du an vao.
		expect(reg.khopFile(join(root, "ngoai", "api", "x.ts"))).toEqual([]);
	});

	it("paths: khong tao duoc mau nao thi rule bi bo va co bao loi", async () => {
		await ghi(join(duAn, ".agentweave", "rules", "hong.md"), '---\npaths: "/"\n---\nKHONG-BAO-GIO');
		const reg = new RuleRegistry({ projectDir: duAn, userRulesDir: null, orgRulesDir: null });
		const rp = await reg.discover();
		expect(rp.rules.some((r) => r.noiDung === "KHONG-BAO-GIO")).toBe(false);
		expect(rp.problems.some((p) => p.kind === "paths_khong_hop_le" && p.fatal)).toBe(true);
	});

	it("paths: ** duoc coi la vo dieu kien nen van vao prompt", async () => {
		await ghi(join(duAn, ".agentweave", "rules", "moi-noi.md"), '---\npaths: "**"\n---\nLUAT-MOI-NOI');
		const reg = new RuleRegistry({ projectDir: duAn, userRulesDir: null, orgRulesDir: null });
		await reg.discover();
		expect(reg.renderSection()).toContain("LUAT-MOI-NOI");
	});

	it("thu muc rule khong ton tai KHONG phai loi", async () => {
		const reg = new RuleRegistry({
			projectDir: join(root, "trong-rong"),
			userRulesDir: join(root, "khong-co"),
			orgRulesDir: join(root, "cung-khong-co"),
		});
		const rp = await reg.discover();
		expect(rp.problems).toEqual([]);
		expect(rp.rules).toEqual([]);
	});
});

describe("installRules", () => {
	it("dat muc system prompt, va bo muc do khi khong con rule nao", async () => {
		const daDat: Array<[string, string | null]> = [];
		const host = {
			setSystemPromptSection: (n: string, c: string | null) => {
				daDat.push([n, c]);
			},
		};

		await installRules(host, {
			projectDir: duAn,
			userRulesDir: userRules,
			orgRulesDir: orgRules,
			quiet: true,
		});
		expect(daDat[0]?.[0]).toBe(RULE_SECTION);
		expect(daDat[0]?.[1]).toContain("LUAT-DU-AN");

		daDat.length = 0;
		await installRules(host, {
			projectDir: join(root, "trong-rong"),
			userRulesDir: null,
			orgRulesDir: null,
			quiet: true,
		});
		// Muc rong van ton token moi luot — phai la null chu khong phai chuoi rong.
		expect(daDat[0]).toEqual([RULE_SECTION, null]);
	});

	it("summarizeRuleReport neu du so lieu cho bo tu kiem tra", async () => {
		const reg = new RuleRegistry({ projectDir: duAn, userRulesDir: null, orgRulesDir: null });
		const rp = await reg.discover();
		expect(summarizeRuleReport(rp)).toMatch(/rule .* co dieu kien.*byte/);
	});
});

describe("nguonRuleTheoDuongDan", () => {
	it("bom rule khi cham file khop, va CHI MOT LAN cho ca pham vi", async () => {
		const reg = new RuleRegistry({ projectDir: duAn, userRulesDir: null, orgRulesDir: null });
		await reg.discover();
		const nguon = nguonRuleTheoDuongDan(reg);

		const lan1 = await thuNhac([nguon], {
			luot: 2,
			fileVuaCham: [join(duAn, "src", "api", "a.ts"), join(duAn, "src", "api", "b.ts")],
			daBom: new Set(),
		});
		// Hai file cung mot rule → mot nhac, khong phai hai.
		expect(lan1.nhac).toHaveLength(1);
		expect(lan1.nhac[0]?.noiDung).toContain("LUAT-API-CHI-KHI-CAN");
		expect(lan1.nhac[0]?.noiDung).toContain("you just worked on");

		const lan2 = await thuNhac([nguon], {
			luot: 3,
			fileVuaCham: [join(duAn, "src", "api", "c.ts")],
			daBom: new Set(lan1.nhac.map((n) => n.khoa!)),
		});
		expect(lan2.nhac).toEqual([]);
	});
});
