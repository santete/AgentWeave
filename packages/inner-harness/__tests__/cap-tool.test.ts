/**
 * Test chuẩn hoá cặp tool_use / tool_result.
 *
 * Mỗi test ứng với một đường thật làm lệch cặp, không phải giả định:
 *   · mở lại phiên với lịch sử cắt giữa lượt
 *   · vòng lặp thoát sớm giữa lúc xử lý một loạt tool call
 *   · tiêm tin nhắn từ ngoài
 *   · replay/gộp làm trùng id
 */

import { describe, it, expect } from "vitest";
import type { Message } from "@agentweave/types";
import { chuanHoaCapTool, KET_QUA_GIAN_DOAN } from "../src/cap-tool";

const goi = (id: string, ten = "Bash"): Message => ({
	role: "assistant",
	content: [{ type: "tool_use", id, name: ten, input: {} }],
});
const ket = (id: string, noi = "xong"): Message => ({
	role: "user",
	content: [{ type: "tool_result", tool_use_id: id, content: noi, is_error: false }],
});

function capTrong(ds: ReadonlyArray<Message>) {
	const dung = new Set<string>();
	const kq = new Set<string>();
	for (const m of ds) {
		if (!Array.isArray(m.content)) continue;
		for (const k of m.content) {
			if (k.type === "tool_use") dung.add(k.id);
			if (k.type === "tool_result") kq.add(k.tool_use_id);
		}
	}
	return {
		thieuKetQua: [...dung].filter((x) => !kq.has(x)),
		moCoi: [...kq].filter((x) => !dung.has(x)),
	};
}

describe("chuanHoaCapTool", () => {
	it("hoi thoai lanh lan thi KHONG dung toi", () => {
		const ds = [{ role: "user", content: "de bai" } as Message, goi("a"), ket("a")];
		const kq = chuanHoaCapTool(ds);
		expect(kq.daSua).toBe(false);
		expect(kq.changes).toEqual([]);
		expect(kq.messages).toEqual(ds);
	});

	it("tool_use thieu ket qua → chen ket qua GIAN DOAN, khong phai loi that", () => {
		const kq = chuanHoaCapTool([goi("a"), goi("b"), ket("b")]);
		expect(capTrong(kq.messages).thieuKetQua).toEqual([]);

		const chen = kq.messages.find(
			(m) =>
				Array.isArray(m.content) &&
				m.content.some((k) => k.type === "tool_result" && k.tool_use_id === "a"),
		);
		const khoi = (chen!.content as Array<{ content: string }>)[0]!;
		// "loi" thi model di sua cai khong hong; "gian doan" thi no biet chi can goi lai.
		expect(khoi.content).toBe(KET_QUA_GIAN_DOAN);
		expect(KET_QUA_GIAN_DOAN).toContain("Nothing was changed");
	});

	it("tool_result mo coi → go bo", () => {
		const kq = chuanHoaCapTool([{ role: "user", content: "de bai" } as Message, ket("khong-ton-tai")]);
		expect(capTrong(kq.messages).moCoi).toEqual([]);
		expect(kq.changes.some((c) => c.includes("mo coi"))).toBe(true);
	});

	it("lich su MO DAU bang tool_result (mo lai phien cat giua luot)", () => {
		const kq = chuanHoaCapTool([ket("cu"), { role: "user", content: "tiep tuc" } as Message]);
		expect(capTrong(kq.messages).moCoi).toEqual([]);
		// Khong duoc bo han tin nhan — de lai cho giu cho.
		expect(kq.messages).toHaveLength(2);
		expect(typeof kq.messages[0]?.content).toBe("string");
	});

	it("tool_use trung id → giu cai dau, bo cac cai sau", () => {
		const kq = chuanHoaCapTool([goi("a"), ket("a"), goi("a"), ket("a")]);
		const soGoi = kq.messages
			.flatMap((m) => (Array.isArray(m.content) ? m.content : []))
			.filter((k) => k.type === "tool_use" && k.id === "a").length;
		const soKq = kq.messages
			.flatMap((m) => (Array.isArray(m.content) ? m.content : []))
			.filter((k) => k.type === "tool_result" && k.tool_use_id === "a").length;
		expect(soGoi).toBe(1);
		expect(soKq).toBe(1);
	});

	it("mot assistant goi 3 tool, chi 1 co ket qua → chen du 2 cai con lai", () => {
		const ds: Message[] = [
			{
				role: "assistant",
				content: [
					{ type: "tool_use", id: "a", name: "Bash", input: {} },
					{ type: "tool_use", id: "b", name: "Grep", input: {} },
					{ type: "tool_use", id: "c", name: "Glob", input: {} },
				],
			},
			ket("b"),
		];
		const kq = chuanHoaCapTool(ds);
		expect(capTrong(kq.messages).thieuKetQua).toEqual([]);
		expect(kq.changes.filter((c) => c.includes("chen ket qua")).length).toBe(2);
		// Ten tool phai co trong nhat ky de nguoi van hanh truy duoc cai nao bi bo do.
		// "b"/Grep la cai CO ket qua nen khong nam trong danh sach chen.
		expect(kq.changes.some((c) => c.includes("Bash"))).toBe(true);
		expect(kq.changes.some((c) => c.includes("Glob"))).toBe(true);
		expect(kq.changes.some((c) => c.includes("Grep"))).toBe(false);
	});

	it("go het khoi trong mot tin nhan thi KHONG de lai content rong", () => {
		const kq = chuanHoaCapTool([{ role: "user", content: [] } as Message, goi("a"), ket("a")]);
		for (const m of kq.messages) {
			if (Array.isArray(m.content)) expect(m.content.length).toBeGreaterThan(0);
			else expect(String(m.content).length).toBeGreaterThan(0);
		}
	});

	it("moi chinh sua deu duoc GHI LAI — khong bao gio sua lang le", () => {
		const kq = chuanHoaCapTool([goi("a"), ket("khong-co"), goi("a")]);
		expect(kq.daSua).toBe(true);
		expect(kq.changes.length).toBeGreaterThanOrEqual(3);
		for (const c of kq.changes) expect(c.length).toBeGreaterThan(5);
	});

	it("danh sach rong va tin nhan chu thuan khong lam hong gi", () => {
		expect(chuanHoaCapTool([]).messages).toEqual([]);
		const chu: Message[] = [
			{ role: "user", content: "hoi" },
			{ role: "assistant", content: "dap" },
		];
		expect(chuanHoaCapTool(chu).daSua).toBe(false);
	});
});
