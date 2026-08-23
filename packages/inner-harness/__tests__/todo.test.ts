/**
 * Test danh sách việc.
 *
 * Kiểu hỏng cần chặn là thứ người dùng phàn nàn thật: model kể lể, hỏi suông,
 * không bám việc. Nên test tập trung vào các luật ÉP hành vi, không phải vào
 * việc lưu trữ dữ liệu.
 */

import { describe, it, expect } from "vitest";
import type { ToolContext } from "@agentweave/types";
import {
	SoTayViec,
	createTodoTool,
	nguonNhacTodo,
	kiemDanhSach,
	veDanhSach,
	CAU_DAN_TODO,
	MAX_VIEC,
	LUOT_COI_LA_TROI,
	type Viec,
} from "../src/todo";
import { thuNhac } from "../src/attachments/index";

const ctx = {} as ToolContext;
const v = (content: string, status: Viec["status"] = "pending"): Viec => ({
	content,
	activeForm: `${content}...`,
	status,
});

describe("kiemDanhSach — ep dung MOT viec in_progress", () => {
	it("nhieu viec in_progress → giu cai DAU, ha cac cai sau ve pending", () => {
		const kq = kiemDanhSach([v("A", "in_progress"), v("B", "in_progress"), v("C", "in_progress")]);
		expect(kq.ds.filter((x) => x.status === "in_progress")).toHaveLength(1);
		expect(kq.ds[0]?.status).toBe("in_progress");
		expect(kq.canhBao[0]).toContain("Chỉ một việc");
	});

	it("SUA HO chu khong tu choi — model van tien viec, va van hoc duoc khuon dung", () => {
		const kq = kiemDanhSach([v("A", "in_progress"), v("B", "in_progress")]);
		expect(kq.ds).toHaveLength(2);
		expect(kq.canhBao.length).toBeGreaterThan(0);
	});

	it("con viec pending ma khong cai nao in_progress → nhac", () => {
		const kq = kiemDanhSach([v("A"), v("B")]);
		expect(kq.canhBao.some((c) => c.includes("in_progress"))).toBe(true);
	});

	it("tat ca completed thi KHONG nhac — da xong that", () => {
		const kq = kiemDanhSach([v("A", "completed"), v("B", "completed")]);
		expect(kq.canhBao).toEqual([]);
	});

	it("danh sach qua dai bi cat va noi ro ly do", () => {
		const kq = kiemDanhSach(Array.from({ length: MAX_VIEC + 10 }, (_, i) => v(`viec ${i}`)));
		expect(kq.ds).toHaveLength(MAX_VIEC);
		expect(kq.canhBao[0]).toContain("chia việc lớn");
	});
});

describe("SoTayViec", () => {
	it("theo doi viec dang lam va so viec con lai", () => {
		const so = new SoTayViec();
		expect(so.rong).toBe(true);
		so.dat([v("A", "completed"), v("B", "in_progress"), v("C")], 5);
		expect(so.dangLam?.content).toBe("B");
		expect(so.conLai).toBe(2);
		expect(so.luotCuoi).toBe(5);
		expect(so.tomTat()).toBe("1/3 · B...");
	});
});

describe("tool TodoWrite", () => {
	it("tra ve HANG SO NGAN va day model ve viec — KHONG tra danh sach", async () => {
		const so = new SoTayViec();
		const tool = createTodoTool(so, () => 3);
		const ra = String(
			await tool.execute({ todos: [v("Doc code", "in_progress"), v("Sua bug")] }, ctx),
		);
		// Tra ve danh sach = dua model mot thu de doc va phan ung → no doc roi cap
		// nhat, roi lai doc. Do that: 33 loi goi TodoWrite tren 40 loi goi tool.
		expect(ra).not.toContain("[>]");
		expect(ra).not.toContain("Doc code");
		expect(ra).toContain("PROCEED");
		expect(ra).toContain("do not call TodoWrite again");
		// Danh sach van duoc luu day du, chi la khong doi dap lai cho model.
		expect(so.dangLam?.content).toBe("Doc code");
	});

	it("xong het thi XOA sach danh sach — be nguyen ban goc", async () => {
		const so = new SoTayViec();
		const tool = createTodoTool(so, () => 1);
		await tool.execute({ todos: [v("A", "in_progress")] }, ctx);
		expect(so.rong).toBe(false);
		await tool.execute({ todos: [v("A", "completed")] }, ctx);
		// Giu lai danh sach toan [x] chi to lam bo nhac tuong con viec.
		expect(so.rong).toBe(true);
	});

	it("gan canh bao len DAU khi model dung sai", async () => {
		const so = new SoTayViec();
		const ra = String(
			await createTodoTool(so, () => 1).execute(
				{ todos: [v("A", "in_progress"), v("B", "in_progress")] },
				ctx,
			),
		);
		expect(ra.startsWith("⚠")).toBe(true);
		expect(ra).toContain("PROCEED");
	});

	it("mo ta tool noi ro day la thu NGUOI DUNG nhin vao", () => {
		const d = createTodoTool(new SoTayViec(), () => 0).description;
		expect(d).toContain("one task in_progress");
		expect(d).toContain("user sees as your progress");
	});
});

describe("cau dan", () => {
	it("co ca luat DUNG lan luat KHONG dung", () => {
		expect(CAU_DAN_TODO).toContain("3 or more steps");
		// Thieu ve nay thi model lap ke hoach cho ca cau hoi mot cau tra loi duoc.
		expect(CAU_DAN_TODO).toContain("Do NOT use a task list for a single");
		expect(CAU_DAN_TODO).toContain("Exactly ONE task");
	});
});

describe("nguonNhacTodo — keo model ve viec khi no troi", () => {
	const bc = (luot: number) => ({ luot, fileVuaCham: [], daBom: new Set<string>(), byteBoNhoDaBom: 0 });

	it("chua co danh sach + da chay duoc mot luc → nhac lap ke hoach", async () => {
		const kq = await thuNhac([nguonNhacTodo(new SoTayViec())], bc(6));
		expect(kq.nhac).toHaveLength(1);
		expect(kq.nhac[0]?.noiDung).toContain("TodoWrite");
		// Hai kieu hong nguoi dung phan nan, phai goi ten thang ra.
		expect(kq.nhac[0]?.noiDung).toContain("do not ask the user what to do next");
		expect(kq.nhac[0]?.noiDung).toContain("do not summarise instead of acting");
	});

	it("luot dau KHONG nhac — co the la viec mot buoc that", async () => {
		const kq = await thuNhac([nguonNhacTodo(new SoTayViec())], bc(2));
		expect(kq.nhac).toEqual([]);
	});

	it("danh sach vua cap nhat thi im — khong lam phien", async () => {
		const so = new SoTayViec();
		so.dat([v("A", "in_progress")], 10);
		const kq = await thuNhac([nguonNhacTodo(so)], bc(11));
		expect(kq.nhac).toEqual([]);
	});

	it("danh sach cu qua thi keo ve, kem trang thai hien tai", async () => {
		const so = new SoTayViec();
		so.dat([v("Sua login", "in_progress"), v("Chay test")], 2);
		const kq = await thuNhac([nguonNhacTodo(so)], bc(2 + LUOT_COI_LA_TROI));
		expect(kq.nhac).toHaveLength(1);
		const chu = kq.nhac[0]!.noiDung;
		expect(chu).toContain("Sua login");
		expect(chu).toContain("[>]");
		// Cau quan trong nhat voi phan nan cua nguoi dung.
		expect(chu).toContain("Do not ask the user what to do next");
	});

	it("nhac THUA dan — khong bom moi luot cho nhon", async () => {
		const so = new SoTayViec();
		so.dat([v("A", "in_progress")], 0);
		const n = nguonNhacTodo(so);
		const lan1 = await thuNhac([n], bc(10));
		const lan2 = await thuNhac([n], bc(11));
		expect(lan1.nhac).toHaveLength(1);
		expect(lan2.nhac).toEqual([]);
	});
});

describe("veDanhSach", () => {
	it("dau trang thai nhin la hieu", () => {
		expect(veDanhSach([v("A", "completed"), v("B", "in_progress"), v("C")])).toBe(
			"[x] A\n[>] B\n[ ] C",
		);
		expect(veDanhSach([])).toContain("trống");
	});
});

describe("nhan moi khuon model that su gui — hoi quy tu log thuc te", () => {
	/**
	 * Bốn khuôn dưới đây chép NGUYÊN VĂN từ một phiên hỏng: schema chặt làm
	 * model gọi 8 lần, bị từ chối 8 lần, và không ghi được việc nào.
	 */
	const khuonThat: Array<[string, Record<string, unknown>]> = [
		["task_list + description + id", { task_list: [{ id: "001", status: "in_progress", description: "Review codebase" }] }],
		["task_list + task", { task_list: [{ status: "in_progress", task: "Scan codebase", id: 1 }] }],
		["co them truong la (steps)", { task_list: [{ id: "001", status: "in_progress", description: "Review", steps: ["a", "b"] }] }],
		["tasks", { tasks: [{ title: "Doc file", status: "pending" }] }],
		["items", { items: [{ name: "Chay test" }] }],
		["khuon chuan", { todos: [{ content: "Chay test", activeForm: "Dang chay", status: "in_progress" }] }],
	];

	for (const [nhan, vao] of khuonThat) {
		it(`nhan duoc: ${nhan}`, async () => {
			const so = new SoTayViec();
			const ra = String(await createTodoTool(so, () => 1).execute(vao as never, ctx));
			expect(ra).not.toContain("rejected");
			expect(so.danhSach().length).toBeGreaterThan(0);
		});
	}

	it("thieu status thi mac dinh pending, thieu activeForm thi tu suy ra", async () => {
		const so = new SoTayViec();
		await createTodoTool(so, () => 1).execute({ task_list: [{ task: "Doc file" }] } as never, ctx);
		expect(so.danhSach()[0]).toMatchObject({ content: "Doc file", status: "pending" });
		expect(so.danhSach()[0]?.activeForm).toContain("Doc file");
	});

	it("khong doc duoc viec nao thi CHI DAN khuon dung, khong chi bao loi", async () => {
		const ra = String(
			await createTodoTool(new SoTayViec(), () => 1).execute({ task_list: [{ id: 1 }] } as never, ctx),
		);
		expect(ra).toContain('{"todos"');
		expect(ra).toContain("for example");
	});
})
