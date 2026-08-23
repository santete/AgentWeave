import { describe, it, expect } from "vitest";
import { DoHieuNang } from "../src/lib/do-hieu-nang";

describe("DoHieuNang — đo tok/s không nổ khi có tool-call", () => {
	it("Turn chỉ sinh chữ: tok/s = out / (end − token đầu)", () => {
		// Đúng như turn 1 trong ảnh: 1839 token, chờ 9,8s, agent 52,3s → ~43 tok/s.
		const d = new DoHieuNang(0);
		d.moLoiGoi(0);
		expect(d.moDelta(9800)).toBe(9800); // TTFT
		expect(d.moDelta(10000)).toBeNull(); // delta sau không phải token đầu
		d.dongLoiGoi(52300);
		const r = d.chot(52300, 1839, 0);
		expect(r.ttftMs).toBe(9800);
		expect(r.genMs).toBe(42500);
		expect(Math.round(r.tokPerSec!)).toBe(43);
	});

	it("Turn có tool-call LỚN (không text delta) KHÔNG làm tok/s nổ", () => {
		// Turn 2 trong ảnh: FileWrite ghi 8 KB (nội dung trong argument, không qua
		// textStream) rồi câu xác nhận ngắn. Bản cũ ra 517 tok/s — sai.
		const d = new DoHieuNang(0);
		d.moLoiGoi(0); // lượt gọi sinh tool-call
		// (không có moDelta — tool-call không đi qua textStream)
		d.dongLoiGoi(48000); // sinh tool-call mất 48s → PHẢI được tính
		d.themTool();
		d.moLoiGoi(48500); // lượt gọi 2: câu xác nhận
		expect(d.moDelta(50300)).toBe(1800); // TTFT = nạp prompt của lượt 2
		d.dongLoiGoi(50600);
		const r = d.chot(50600, 2032, 0);
		expect(r.genMs).toBe(48300); // 48000 (tool) + 300 (xác nhận)
		expect(r.toolCalls).toBe(1);
		// Sane cho model cục bộ — KHÔNG phải 517.
		expect(r.tokPerSec!).toBeGreaterThan(20);
		expect(r.tokPerSec!).toBeLessThan(80);
	});

	it("Nếu bỏ thời gian tool-call (bug cũ) thì tok/s sẽ nổ — chứng minh khác biệt", () => {
		// Mô phỏng công thức CŨ: chỉ tính cửa sổ text delta của lượt xác nhận.
		const genCu = 50600 - 50300; // 300ms
		const tokPerSecCu = (2032 / genCu) * 1000;
		expect(tokPerSecCu).toBeGreaterThan(500); // ~6773 — vô lý, đúng kiểu bug
	});

	it("Trừ đúng thời gian người dùng ngồi duyệt khỏi tổng", () => {
		const d = new DoHieuNang(0);
		d.moLoiGoi(0);
		d.moDelta(1000);
		d.dongLoiGoi(11000);
		const r = d.chot(15000, 500, 4000); // 4s duyệt
		expect(r.totalMs).toBe(11000); // 15000 − 4000
		expect(r.waitUserMs).toBe(4000);
	});

	it("Khoảng sinh quá ngắn → tok/s null (không báo nhiễu)", () => {
		const d = new DoHieuNang(0);
		d.moLoiGoi(0);
		d.moDelta(100);
		d.dongLoiGoi(400); // 300ms < ngưỡng 500ms
		const r = d.chot(400, 50, 0);
		expect(r.tokPerSec).toBeNull();
	});
});

describe("khong duoc BIA phep do", () => {
	it("provider khong bao token → tokPerSec = null, KHONG phai 0", () => {
		const d = new DoHieuNang(0);
		d.moLoiGoi(0);
		d.moDelta(100);
		d.dongLoiGoi(5_000);
		// Ollama doi khi tra usage rong. In "0.0 tok/s" la bia mot phep do:
		// nguoi dung doc thanh "may cham toi muc khong sinh noi chu nao".
		expect(d.chot(6_000, 0, 0).tokPerSec).toBeNull();
	});

	it("khoang sinh qua ngan → null, khong phai mot con so nhieu", () => {
		const d = new DoHieuNang(0);
		d.moLoiGoi(0);
		d.moDelta(10);
		d.dongLoiGoi(300);
		expect(d.chot(400, 50, 0).tokPerSec).toBeNull();
	});

	it("luot chi co tool-call (khong chu nao) van tinh duoc thoi gian sinh", () => {
		const d = new DoHieuNang(0);
		d.moLoiGoi(0);
		d.dongLoiGoi(4_000); // khong co moDelta — model chi nha tool-call
		const k = d.chot(5_000, 200, 0);
		// Ban cu: mau so = 0 → Infinity. Gio tinh ca cua so goi.
		expect(k.genMs).toBe(4_000);
		expect(k.tokPerSec).toBeCloseTo(50, 0);
		expect(Number.isFinite(k.tokPerSec!)).toBe(true);
	});

	it("bat bien: cho + sinh <= tong thoi gian agent", () => {
		const d = new DoHieuNang(1_000);
		d.moLoiGoi(1_000);
		d.moDelta(2_500);
		d.dongLoiGoi(9_000);
		const k = d.chot(11_000, 400, 0);
		expect((k.ttftMs ?? 0) + k.genMs).toBeLessThanOrEqual(k.totalMs);
	});
})
