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
