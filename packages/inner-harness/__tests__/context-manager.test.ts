/**
 * Test quản lý ngữ cảnh.
 *
 * Nén sai thì mất dữ liệu ÂM THẦM — model vẫn trả lời trôi chảy, chỉ là dựa
 * trên hội thoại đã bị cắt mất phần quan trọng. Nên trọng tâm test là:
 *   · không bao giờ mất đề bài (tin nhắn đầu)
 *   · tool_use không bao giờ mồ côi tool_result
 *   · có cắt thì phải để lại dấu, không cắt lén
 */

import { afterEach, describe, it, expect } from "vitest";
import type { Message } from "@agentweave/types";
import {
	CUA_SO_CUC_BO,
	CUA_SO_DAM_MAY,
	canNen,
	capNhatDoDay,
	nenManhTay,
	nenTinNhan,
	mucNen,
	suyRaCuaSo,
} from "../src/context-manager";

const moc = { usedTokens: 0, maxTokens: 65536, pct: 0, compactionCount: 0 };

/** Dựng hội thoại có n cặp lượt, mỗi lượt kèm một tool result dài. */
function dungHoiThoai(n: number, coDaiKetQua = 2000): Message[] {
	const ds: Message[] = [{ role: "user", content: "ĐỀ BÀI GỐC: sửa lỗi tính tiền" }];
	for (let i = 0; i < n; i++) {
		ds.push({
			role: "assistant",
			content: [{ type: "tool_use", id: `t${i}`, name: "Bash", input: { command: `lenh ${i}` } }],
		});
		ds.push({
			role: "user",
			content: [
				{
					type: "tool_result",
					tool_use_id: `t${i}`,
					content: `ket qua ${i} `.repeat(Math.ceil(coDaiKetQua / 11)),
					is_error: false,
				},
			],
		});
	}
	return ds;
}

describe("suyRaCuaSo", () => {
	const luu = { ...process.env };
	afterEach(() => {
		process.env.OLLAMA_CONTEXT_LENGTH = luu.OLLAMA_CONTEXT_LENGTH;
		process.env.AGENTWEAVE_DEFAULT_PROVIDER = luu.AGENTWEAVE_DEFAULT_PROVIDER;
	});

	it("khai tường minh thì dùng đúng số đó", () => {
		expect(suyRaCuaSo("qwen3-coder:30b", 32768)).toBe(32768);
	});

	it("model cục bộ lấy 64K chứ KHÔNG phải 200K của Claude", () => {
		process.env.OLLAMA_CONTEXT_LENGTH = undefined;
		expect(suyRaCuaSo("qwen3-coder:30b")).toBe(CUA_SO_CUC_BO);
		expect(suyRaCuaSo("ollama/bat-ky")).toBe(CUA_SO_CUC_BO);
	});

	it("theo OLLAMA_CONTEXT_LENGTH khi có", () => {
		process.env.OLLAMA_CONTEXT_LENGTH = "32768";
		expect(suyRaCuaSo("qwen3-coder:30b")).toBe(32768);
	});

	it("model đám mây vẫn 200K", () => {
		process.env.AGENTWEAVE_DEFAULT_PROVIDER = undefined;
		expect(suyRaCuaSo("claude-sonnet-4-6")).toBe(CUA_SO_DAM_MAY);
	});
});

describe("capNhatDoDay + canNen", () => {
	it("số token đầu vào của provider chính là độ đầy ngữ cảnh", () => {
		const u = capNhatDoDay(moc, 32768);
		expect(u.usedTokens).toBe(32768);
		expect(u.pct).toBeCloseTo(0.5);
	});

	it("không có số thì giữ nguyên, không đoán bừa", () => {
		expect(capNhatDoDay({ ...moc, usedTokens: 100 }, undefined).usedTokens).toBe(100);
	});

	it("vượt 80% thì báo cần nén", () => {
		expect(canNen({ ...moc, usedTokens: 52_000 })).toBe(false); // 79,3% — chưa tới
		expect(canNen({ ...moc, usedTokens: 52_500 })).toBe(true); // 80,1%
		expect(canNen({ ...moc, usedTokens: 30_000 })).toBe(false);
	});
});

describe("nenTinNhan — lược tool result cũ", () => {
	it("rút ngắn kết quả cũ nhưng giữ nguyên số tin nhắn", () => {
		const goc = dungHoiThoai(10);
		const kq = nenTinNhan(goc);

		expect(kq.daNen).toBe(true);
		expect(kq.messages).toHaveLength(goc.length); // không bỏ tin nào
		// 7 tool result nằm ngoài vùng giữ, mỗi cái 1.820 ký tự, giữ lại 400.
		expect(kq.kyTuBoDi).toBe(7 * (1820 - 400));
	});

	it("để lại dấu đã lược, không cắt lén", () => {
		const kq = nenTinNhan(dungHoiThoai(10));
		const chuoi = JSON.stringify(kq.messages);
		expect(chuoi).toContain("đã lược");
		expect(chuoi).toContain("ký tự để tiết kiệm ngữ cảnh");
	});

	it("KHÔNG đụng vào các lượt gần nhất", () => {
		const goc = dungHoiThoai(10);
		const kq = nenTinNhan(goc, 6);

		for (let i = goc.length - 6; i < goc.length; i++) {
			expect(kq.messages[i]).toEqual(goc[i]);
		}
	});

	it("KHÔNG đụng vào tin nhắn đầu — đó là đề bài", () => {
		const kq = nenTinNhan(dungHoiThoai(10));
		expect(kq.messages[0]!.content).toContain("ĐỀ BÀI GỐC");
	});

	it("hội thoại ngắn thì không làm gì", () => {
		const kq = nenTinNhan(dungHoiThoai(1));
		expect(kq.daNen).toBe(false);
		expect(kq.cach).toBe("khong-lam-gi");
	});

	it("kết quả vốn đã ngắn thì để yên", () => {
		const kq = nenTinNhan(dungHoiThoai(10, 20));
		expect(kq.daNen).toBe(false);
	});
});

describe("nenManhTay — bỏ hẳn lượt cũ", () => {
	it("giữ đề bài và các lượt gần nhất, bỏ khúc giữa", () => {
		const goc = dungHoiThoai(20);
		const kq = nenManhTay(goc, 6);

		expect(kq.daNen).toBe(true);
		expect(kq.messages.length).toBeLessThan(goc.length);
		expect(JSON.stringify(kq.messages[0])).toContain("ĐỀ BÀI GỐC");
		// 6 lượt cuối còn nguyên
		expect(kq.messages.slice(-6)).toEqual(goc.slice(-6));
	});

	it("chèn dấu mốc báo đã nén, kèm cách lấy lại thông tin", () => {
		const kq = nenManhTay(dungHoiThoai(20), 6);
		const mocTin = JSON.stringify(kq.messages[1]);

		expect(mocTin).toContain("đã nén ngữ cảnh");
		expect(mocTin).toContain("đọc lại file hoặc chạy lại lệnh");
	});

	it("tool_use còn lại KHÔNG bao giờ mồ côi tool_result", () => {
		// Đây là bất biến quan trọng nhất: thiếu tool_result cho một tool_use
		// làm API của provider từ chối cả lượt gọi.
		const kq = nenManhTay(dungHoiThoai(20), 6);

		const idDaGoi = new Set<string>();
		const idDaTra = new Set<string>();
		for (const m of kq.messages) {
			if (typeof m.content === "string") continue;
			for (const k of m.content) {
				if (k.type === "tool_use") idDaGoi.add(k.id);
				if (k.type === "tool_result") idDaTra.add(k.tool_use_id);
			}
		}
		for (const id of idDaGoi) expect(idDaTra.has(id)).toBe(true);
	});

	it("giữ số lượt chẵn nên không cắt giữa một cặp", () => {
		const kq = nenManhTay(dungHoiThoai(20), 6);
		// đầu + mốc + 6 lượt gần nhất
		expect(kq.messages).toHaveLength(8);
	});
});

describe("Leo thang mức nén", () => {
	// Đo thật trước khi có leo thang: nén một lần chỉ giải phóng ~140 token
	// trong khi ngữ cảnh phình lên 135% — vì cửa sổ bảo vệ 6 tin nhắn gần nhất
	// chính là chỗ chứa các tool result to.
	it("mức càng cao thì giữ càng ít và cắt càng ngắn", () => {
		expect(mucNen(0).giuGanNhat).toBeGreaterThan(mucNen(1).giuGanNhat);
		expect(mucNen(1).giuGanNhat).toBeGreaterThan(mucNen(2).giuGanNhat);
		expect(mucNen(0).tranToolResult).toBeGreaterThan(mucNen(2).tranToolResult);
	});

	it("mức vượt quá bảng thì kẹp lại, không ném lỗi", () => {
		expect(mucNen(99)).toEqual(mucNen(2));
		expect(mucNen(-5)).toEqual(mucNen(0));
	});

	it("mức cao giải phóng nhiều hơn hẳn mức thấp", () => {
		const goc = dungHoiThoai(10);
		const thap = nenManhTay(goc, mucNen(0).giuGanNhat, mucNen(0).tranToolResult);
		const cao = nenManhTay(goc, mucNen(2).giuGanNhat, mucNen(2).tranToolResult);

		expect(cao.kyTuBoDi).toBeGreaterThan(thap.kyTuBoDi);
		expect(cao.messages.length).toBeLessThan(thap.messages.length);
	});

	it("mức cao nhất VẪN giữ đề bài và vẫn khớp cặp tool_use/tool_result", () => {
		const kq = nenManhTay(dungHoiThoai(10), mucNen(2).giuGanNhat, mucNen(2).tranToolResult);

		expect(JSON.stringify(kq.messages[0])).toContain("ĐỀ BÀI GỐC");

		const goi = new Set<string>();
		const tra = new Set<string>();
		for (const m of kq.messages) {
			if (typeof m.content === "string") continue;
			for (const k of m.content) {
				if (k.type === "tool_use") goi.add(k.id);
				if (k.type === "tool_result") tra.add(k.tool_use_id);
			}
		}
		for (const id of goi) expect(tra.has(id)).toBe(true);
	});
});

// ─────────────────────────────────────────────────────────────────
// Hồi quy: nén KHÔNG được tách đôi cặp tool_use / tool_result.
//
// Docstring đầu context-manager.ts khẳng định "luôn bỏ theo CẶP", nhưng bản
// đầu cắt thuần theo SỐ LƯỢNG. Tuỳ parity của danh sách mà tin nhắn đầu tiên
// được giữ lại là một `tool_result` không còn lời gọi nào đi kèm.
//
// Ống dẫn attachment làm parity lệch thường xuyên (mỗi khối <system-reminder>
// là một tin nhắn user chèn thêm), nên đây không phải trường hợp hiếm.
// ─────────────────────────────────────────────────────────────────

function hoiThoaiCoCapTool(chenNhacTaiLuot: number, soLuot = 6): Message[] {
	const ds: Message[] = [{ role: "user", content: "de bai" }];
	for (let i = 0; i < soLuot; i++) {
		if (i === chenNhacTaiLuot) {
			ds.push({ role: "user", content: "<system-reminder>nhac</system-reminder>" });
		}
		ds.push({
			role: "assistant",
			content: [{ type: "tool_use", id: `t${i}`, name: "Bash", input: {} }],
		});
		ds.push({
			role: "user",
			content: [{ type: "tool_result", tool_use_id: `t${i}`, content: "x".repeat(500) }],
		});
	}
	return ds;
}

function demMoCoi(ds: ReadonlyArray<Message>): { moCoi: string[]; thieuKetQua: string[] } {
	const dung = new Set<string>();
	const ket = new Set<string>();
	for (const m of ds) {
		if (!Array.isArray(m.content)) continue;
		for (const k of m.content) {
			if (k.type === "tool_use") dung.add(k.id);
			if (k.type === "tool_result") ket.add(k.tool_use_id);
		}
	}
	return {
		moCoi: [...ket].filter((x) => !dung.has(x)),
		thieuKetQua: [...dung].filter((x) => !ket.has(x)),
	};
}

describe("nenManhTay — khong bao gio tach doi cap tool", () => {
	it("moi to hop vi tri chen nhac x muc nen deu KHONG sinh mo coi", () => {
		const hong: string[] = [];
		for (let chen = -1; chen < 6; chen++) {
			for (const N of [6, 4, 2]) {
				const kq = nenManhTay(hoiThoaiCoCapTool(chen), N, 80);
				const { moCoi } = demMoCoi(kq.messages);
				if (moCoi.length > 0) hong.push(`chen=${chen} N=${N} → ${moCoi.join(",")}`);
			}
		}
		expect(hong).toEqual([]);
	});

	it("truong hop da tai hien duoc truoc khi sua: chen o luot 4, giu 6 gan nhat", () => {
		const kq = nenManhTay(hoiThoaiCoCapTool(4), 6, 80);
		expect(demMoCoi(kq.messages).moCoi).toEqual([]);
		// Van phai nen duoc that su, khong phai "an toan bang cach khong lam gi".
		expect(kq.daNen).toBe(true);
		expect(kq.messages.length).toBeLessThan(hoiThoaiCoCapTool(4).length);
	});

	it("lui ranh gioi van GIU tin nhan dau (de bai)", () => {
		const kq = nenManhTay(hoiThoaiCoCapTool(5), 6, 80);
		expect(kq.messages[0]?.content).toBe("de bai");
	});
});

// ─────────────────────────────────────────────────────────────────
// Danh sách trắng tool được nén, và nén theo thời gian.
// ─────────────────────────────────────────────────────────────────

import {
	TOOL_NEN_DUOC,
	MAX_NEN_THAT_BAI_LIEN_TIEP,
	NGUONG_BO_DO_MS,
	NOI_DUNG_DA_XOA,
	banDoTenTool,
	daBoDoLau,
	nenTheoThoiGian,
} from "../src/context-manager";

function hoiThoaiTheoTool(tenTool: string): Message[] {
	const ds: Message[] = [{ role: "user", content: "de bai" }];
	for (let i = 0; i < 8; i++) {
		ds.push({
			role: "assistant",
			content: [{ type: "tool_use", id: `t${i}`, name: tenTool, input: {} }],
		});
		ds.push({
			role: "user",
			content: [{ type: "tool_result", tool_use_id: `t${i}`, content: "N".repeat(3000) }],
		});
	}
	return ds;
}

describe("danh sach trang tool duoc nen", () => {
	it("FileRead BI luoc — doc lai la co", () => {
		const kq = nenTinNhan(hoiThoaiTheoTool("FileRead"), 4, 100);
		expect(kq.daNen).toBe(true);
		expect(kq.kyTuBoDi).toBeGreaterThan(0);
	});

	it("LoadSkill KHONG bi luoc — tri thuc quy trinh khong lay lai duoc", () => {
		const kq = nenTinNhan(hoiThoaiTheoTool("LoadSkill"), 4, 100);
		expect(kq.daNen).toBe(false);
		expect(kq.kyTuBoDi).toBe(0);
	});

	it("khong tra ra ten tool thi KHONG luoc — tha ton cho con hon mat han", () => {
		const ds: Message[] = [
			{ role: "user", content: "de bai" },
			// tool_use tuong ung da bi cat khoi lich su.
			{ role: "user", content: [{ type: "tool_result", tool_use_id: "mat-roi", content: "Z".repeat(3000) }] },
			{ role: "assistant", content: "a" },
			{ role: "user", content: "b" },
			{ role: "assistant", content: "c" },
			{ role: "user", content: "d" },
			{ role: "assistant", content: "e" },
		];
		expect(nenTinNhan(ds, 2, 100).daNen).toBe(false);
	});

	it("danh sach trang chi gom tool co lenh lay lai duoc", () => {
		expect(TOOL_NEN_DUOC.has("Bash")).toBe(true);
		expect(TOOL_NEN_DUOC.has("Grep")).toBe(true);
		expect(TOOL_NEN_DUOC.has("LoadSkill")).toBe(false);
		expect(TOOL_NEN_DUOC.has("ScheduleTask")).toBe(false);
	});

	it("banDoTenTool tra nguoc duoc id sang ten", () => {
		const bd = banDoTenTool(hoiThoaiTheoTool("Grep"));
		expect(bd.get("t0")).toBe("Grep");
		expect(bd.get("khong-co")).toBeUndefined();
	});
});

describe("nen theo thoi gian", () => {
	it("daBoDoLau dung nguong 30 phut, va bo qua khi chua co hoat dong nao", () => {
		const t = 1_700_000_000_000;
		expect(daBoDoLau(t, t + NGUONG_BO_DO_MS)).toBe(true);
		expect(daBoDoLau(t, t + NGUONG_BO_DO_MS - 1)).toBe(false);
		// lucCuoi = 0 nghia la chua chay luot nao — khong duoc coi la bo do.
		expect(daBoDoLau(0, t)).toBe(false);
	});

	it("XOA HAN noi dung tool result cu, kem cau chi duong", () => {
		const kq = nenTheoThoiGian(hoiThoaiTheoTool("Bash"), 4);
		expect(kq.daNen).toBe(true);
		const chuoi = JSON.stringify(kq.messages);
		expect(chuoi).toContain(NOI_DUNG_DA_XOA);
		expect(NOI_DUNG_DA_XOA).toMatch(/chạy lại|đọc lại/i);
	});

	it("GIU nguyen so luong tin nhan — chi xoa noi dung, khong bo khung", () => {
		const goc = hoiThoaiTheoTool("Bash");
		expect(nenTheoThoiGian(goc, 4).messages.length).toBe(goc.length);
	});

	it("van ton trong danh sach trang", () => {
		expect(nenTheoThoiGian(hoiThoaiTheoTool("LoadSkill"), 4).daNen).toBe(false);
	});

	it("giuGanNhat = 0 KHONG duoc bien thanh giu tat ca (bay slice(-0))", () => {
		const kq = nenTheoThoiGian(hoiThoaiTheoTool("Bash"), 0);
		expect(kq.daNen).toBe(true);
	});
});

describe("nguong ngat mach", () => {
	it("MAX_NEN_THAT_BAI_LIEN_TIEP la 3 — khop so lieu ban goc", () => {
		expect(MAX_NEN_THAT_BAI_LIEN_TIEP).toBe(3);
	});
});
