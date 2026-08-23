/**
 * Test bước nối tri thức vào phiên.
 *
 * Kiểu hỏng cần chặn được ghi thẳng trong docstring của `nap-tri-thuc.ts`:
 * quét ra rule có điều kiện nhưng QUÊN đăng ký nguồn nhắc. Lúc đó mọi thứ báo
 * xanh — có rule, có báo cáo, không lỗi — mà rule không bao giờ tới được model.
 */

import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { napTriThuc } from "../src/lib/nap-tri-thuc";

const root = join(tmpdir(), `agentweave-naptrithuc-${Date.now()}`);
const duAn = join(root, "duan");

/** Harness giả — chỉ ghi lại những gì bị gọi. */
function harnessGia() {
	const muc: Array<[string, string | null]> = [];
	const nguon: string[] = [];
	const tools: Array<{ name: string }> = [];
	return {
		muc,
		nguon,
		tools,
		setSystemPromptSection: (n: string, c: string | null) => muc.push([n, c]),
		themNguonNhac: (x: { ten: string }) => nguon.push(x.ten),
		registerTool: (t: { name: string }) => tools.push(t),
		getTools: () => tools,
		unregisterTool: (n: string) => {
			const i = tools.findIndex((t) => t.name === n);
			if (i >= 0) tools.splice(i, 1);
		},
	};
}

beforeAll(async () => {
	await mkdir(join(duAn, ".git"), { recursive: true });
	await mkdir(join(duAn, ".agentweave", "rules"), { recursive: true });
	await mkdir(join(duAn, ".agentweave", "skills", "quy-uoc-sql"), { recursive: true });

	await writeFile(join(duAn, "AGENTS.md"), "Luat chung cua du an.");
	await writeFile(
		join(duAn, ".agentweave", "rules", "api.md"),
		'---\npaths: "src/api/**"\n---\nQuy uoc tang API.',
	);
	await writeFile(
		join(duAn, ".agentweave", "skills", "quy-uoc-sql", "skill.json"),
		JSON.stringify({
			name: "quy-uoc-sql",
			description: "quy uoc migration",
			whenToUse: "khi sua migration SQL",
			paths: "**/*.sql",
		}),
	);
	await writeFile(
		join(duAn, ".agentweave", "skills", "quy-uoc-sql", "SKILL.md"),
		"# SQL\nnoi dung",
	);
});

afterAll(async () => {
	await rm(root, { recursive: true, force: true });
});

describe("napTriThuc", () => {
	it("dat rule vo dieu kien vao system prompt VA dang ky nguon nhac cho rule co dieu kien", async () => {
		const h = harnessGia();
		const kq = await napTriThuc(h, { goc: duAn, cauHinh: {}, quiet: true });

		const mucRule = h.muc.find(([n]) => n === "rules");
		expect(mucRule?.[1]).toContain("Luat chung cua du an.");
		// Rule co dieu kien KHONG duoc nam trong system prompt — mat het loi ich.
		expect(mucRule?.[1]).not.toContain("Quy uoc tang API.");

		expect(kq.rule?.soCoDieuKien).toBe(1);
		expect(h.nguon).toContain("rule-theo-duong-dan");
	});

	it("dang ky tool LoadSkill va nguon nhac cho skill co dieu kien", async () => {
		const h = harnessGia();
		const kq = await napTriThuc(h, { goc: duAn, cauHinh: {}, quiet: true });

		expect(h.tools.map((t) => t.name)).toContain("LoadSkill");
		expect(kq.skill?.soCoDieuKien).toBe(1);
		expect(h.nguon).toContain("skill-theo-duong-dan");
	});

	it("boQuaSkill: khong dang ky LoadSkill, nhung rule van nap", async () => {
		const h = harnessGia();
		const kq = await napTriThuc(h, { goc: duAn, cauHinh: {}, boQuaSkill: true, quiet: true });

		expect(h.tools).toEqual([]);
		expect(kq.skill).toBeUndefined();
		expect(kq.rule).toBeDefined();
		expect(h.nguon).toContain("rule-theo-duong-dan");
	});

	it("khong co rule co dieu kien thi KHONG dang ky nguon nhac thua", async () => {
		const trong = join(root, "trong");
		await mkdir(trong, { recursive: true });
		const h = harnessGia();
		await napTriThuc(h, { goc: trong, cauHinh: {}, quiet: true });
		expect(h.nguon).toEqual([]);
	});

	it("tom tat neu du so lieu cho bo tu kiem tra", async () => {
		const h = harnessGia();
		const kq = await napTriThuc(h, { goc: duAn, cauHinh: {}, quiet: true });
		expect(kq.tomTat.some((d) => d.startsWith("rule:"))).toBe(true);
		expect(kq.tomTat.some((d) => d.startsWith("skill:"))).toBe(true);
	});

	it("contextWindow cua du an quyet dinh ngan sach chi muc skill", async () => {
		const h = harnessGia();
		const kq = await napTriThuc(h, {
			goc: duAn,
			cauHinh: { contextWindow: 200_000 },
			quiet: true,
		});
		// 1% x 200.000 x 4 = 8.000 ky tu.
		expect(kq.skill?.nganSach).toBe(8_000);
	});
});

describe("napTriThuc — bộ nhớ liên phiên", () => {
	it("chua co tep nho nao → ban LUOI, khong phai bai huong dan 711 token", async () => {
		const h = harnessGia();
		const kq = await napTriThuc(h, { goc: duAn, cauHinh: {}, quiet: true });
		const muc = h.muc.find(([n]) => n === "memory")?.[1];
		expect(muc).toContain("EMPTY");
		expect(muc).not.toContain("Before recommending from memory");
		expect(muc!.length).toBeLessThan(600);
		expect(kq.boNho).toBeDefined();
	});

	it("co tep nho thi bung ra huong dan DAY DU", async () => {
		const coNho = join(root, "co-bo-nho");
		await mkdir(join(coNho, ".agentweave", "memory"), { recursive: true });
		await writeFile(
			join(coNho, ".agentweave", "memory", "vd.md"),
			"---\nname: vd\ndescription: mot ghi chu thu nghiem\ntype: project\n---\nnoi dung",
		);
		const h = harnessGia();
		await napTriThuc(h, { goc: coNho, cauHinh: {}, quiet: true });
		const muc = h.muc.find(([n]) => n === "memory")?.[1];
		expect(muc).toContain("Before recommending from memory");
	});

	it("co bo nho thi dang ky nguon nhac; khong co thi khong dang ky thua", async () => {
		await mkdir(join(duAn, ".agentweave", "memory"), { recursive: true });
		await writeFile(
			join(duAn, ".agentweave", "memory", "vd.md"),
			"---\nname: vd\ndescription: mot ghi chu thu nghiem\ntype: project\n---\nnoi dung",
		);
		const h = harnessGia();
		await napTriThuc(h, { goc: duAn, cauHinh: {}, quiet: true });
		expect(h.nguon).toContain("bo-nho-lien-quan");

		const trong = join(root, "trong-bo-nho");
		await mkdir(trong, { recursive: true });
		const h2 = harnessGia();
		await napTriThuc(h2, { goc: trong, cauHinh: {}, quiet: true });
		expect(h2.nguon).not.toContain("bo-nho-lien-quan");
	});

	it("boQuaBoNho → khong dat gi vao prompt, va khong dang ky nguon", async () => {
		const h = harnessGia();
		await napTriThuc(h, { goc: duAn, cauHinh: {}, boQuaBoNho: true, quiet: true });
		expect(h.muc.find(([n]) => n === "memory")?.[1]).toBeNull();
		expect(h.nguon).not.toContain("bo-nho-lien-quan");
	});
});

describe("napTriThuc — hẹn giờ", () => {
	it("co lichHen thi dang ky tool ScheduleTask va nguon nhac", async () => {
		const { LichHen } = await import("@agentweave/inner-harness");
		const h = harnessGia();
		const kq = await napTriThuc(h, {
			goc: duAn,
			cauHinh: {},
			lichHen: new LichHen(),
			quiet: true,
		});
		expect(h.tools.map((t) => t.name)).toContain("ScheduleTask");
		expect(h.nguon).toContain("hen-gio");
		expect(kq.tomTat.some((d) => d.startsWith("hen gio:"))).toBe(true);
	});

	it("khong co lichHen thi KHONG dang ky gi ve hen gio", async () => {
		const h = harnessGia();
		await napTriThuc(h, { goc: duAn, cauHinh: {}, quiet: true });
		expect(h.tools.map((t) => t.name)).not.toContain("ScheduleTask");
		expect(h.nguon).not.toContain("hen-gio");
	});
});
