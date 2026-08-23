/**
 * Kết quả tool quá lớn: GHI RA ĐĨA, không cắt.
 *
 * VÌ SAO GHI ĐĨA TỐT HƠN HẲN CẮT
 *
 * Cắt là mất thông tin vĩnh viễn. Model chạy `npm test` ra 300 KB, ta cắt còn
 * 16 KB, và cái nó cần — dòng thứ 4.000 nói vì sao một test đỏ — biến mất. Nó
 * không có cách nào lấy lại, và cũng không biết là mình đang thiếu.
 *
 * Ghi đĩa thì chỉ DỜI CHỖ: model nhận bản xem trước kèm đường dẫn, rồi dùng
 * chính Grep/FileRead sẵn có để moi đúng phần nó cần. Air-gap hợp hoàn hảo —
 * đĩa là cục bộ, không cần mạng, và `.agentweave/` đã nằm trong .gitignore.
 *
 * HAI TRẦN, KHÔNG PHẢI MỘT
 *
 * Trần mỗi tool không đủ. Mười tool chạy song song, mỗi cái 15 KB (đều dưới
 * trần) thì một lượt vẫn đẩy 150 KB vào cửa sổ 64K. Nên có thêm trần TỔNG cho
 * cả lượt: vượt thì ghi ra đĩa lần lượt từ kết quả TO NHẤT cho tới khi vừa.
 *
 * NGÂN SÁCH QUY VỀ CỬA SỔ 64K
 *
 * Bản gốc: 50.000 ký tự mỗi tool, 200.000 mỗi lượt, trên cửa sổ 200K. Nhân hệ
 * số 0,32 rồi làm tròn xuống.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

/** Trần mỗi kết quả. 16.000 ký tự ≈ 4.000 token ≈ 6% cửa sổ 64K. */
export const TRAN_MOI_TOOL = 16_000;

/** Trần TỔNG các kết quả trong cùng một lượt. ≈ 16.000 token ≈ 25% cửa sổ. */
export const TRAN_TONG_MOI_LUOT = 64_000;

/** Cỡ bản xem trước đưa cho model. */
export const CO_XEM_TRUOC = 1_500;

export const THE_MO = "<persisted-output>";
export const THE_DONG = "</persisted-output>";

/** Thư mục chứa kết quả đã ghi, theo phiên. */
export function thuMucKetQua(cwd: string, sessionId: string): string {
	return resolve(cwd, ".agentweave", "sessions", sessionId, "tool-results");
}

export interface KetQuaDaGhi {
	duong: string;
	coGoc: number;
	xemTruoc: string;
	conNua: boolean;
}

/**
 * Ghi nội dung ra tệp.
 *
 * Cờ `wx` — ghi chỉ khi tệp chưa có. `toolUseId` là duy nhất mỗi lần gọi và
 * nội dung ứng với nó không đổi, nên lượt sau replay cùng kết quả thì bỏ qua.
 * Dùng `wx` thay vì kiểm tra-rồi-ghi để không có khe đua giữa hai bước.
 *
 * @returns thông tin tệp, hoặc `null` nếu ghi hỏng (lúc đó nơi gọi cắt như cũ)
 */
export async function ghiKetQuaRaDia(
	noiDung: string,
	toolUseId: string,
	cwd: string,
	sessionId: string,
): Promise<KetQuaDaGhi | null> {
	const dir = thuMucKetQua(cwd, sessionId);
	// Tên tệp lấy từ toolUseId do harness sinh, nhưng vẫn lọc: id có thể tới từ
	// model qua đường cứu tool-call, và một id chứa "../" sẽ ghi ra ngoài.
	const ten = `${toolUseId.replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 100)}.txt`;
	const duong = join(dir, ten);

	try {
		await mkdir(dir, { recursive: true });
		await writeFile(duong, noiDung, { encoding: "utf-8", flag: "wx" });
	} catch (err) {
		// Đã có tệp = lượt trước ghi rồi, vẫn dùng được. Lỗi khác thì chịu.
		if ((err as NodeJS.ErrnoException).code !== "EEXIST") return null;
	}

	const { xemTruoc, conNua } = dungXemTruoc(noiDung, CO_XEM_TRUOC);
	return { duong, coGoc: noiDung.length, xemTruoc, conNua };
}

/** Cắt bản xem trước ở ranh giới dòng cho dễ đọc. */
export function dungXemTruoc(
	noiDung: string,
	co: number,
): { xemTruoc: string; conNua: boolean } {
	if (noiDung.length <= co) return { xemTruoc: noiDung, conNua: false };
	const cat = noiDung.slice(0, co);
	const xuongDong = cat.lastIndexOf("\n");
	return { xemTruoc: xuongDong > co * 0.5 ? cat.slice(0, xuongDong) : cat, conNua: true };
}

/**
 * Khối thay cho kết quả đã ghi ra đĩa.
 *
 * Nêu ĐƯỜNG DẪN và NÓI RÕ dùng tool nào để moi tiếp. Chỉ nói "output too large"
 * thì model coi như mất hẳn và đoán bừa phần còn lại.
 */
export function thongBaoDaGhi(kq: KetQuaDaGhi): string {
	return (
		`${THE_MO}\n` +
		`Output too large (${kq.coGoc} chars) — the FULL output is on disk, nothing was lost.\n` +
		`Read it with FileRead, or search it with Grep, at: ${kq.duong}\n\n` +
		`Preview (first ${kq.xemTruoc.length} chars):\n${kq.xemTruoc}` +
		`${kq.conNua ? "\n…\n" : "\n"}${THE_DONG}`
	);
}

/**
 * Áp trần TỔNG cho một lượt: ghi ra đĩa từ kết quả TO NHẤT xuống cho tới khi vừa.
 *
 * To nhất trước vì mỗi lần ghi giải phóng nhiều chỗ nhất trên một lần thao tác
 * đĩa — ghi bốn kết quả nhỏ để né một kết quả lớn là tốn công vô ích.
 *
 * @param cac danh sách [toolUseId, nội dung]
 * @returns map toolUseId → nội dung thay thế, chỉ chứa những cái đã bị thay
 */
export async function apTranTongLuot(
	cac: ReadonlyArray<{ toolUseId: string; noiDung: string }>,
	cwd: string,
	sessionId: string,
	tran = TRAN_TONG_MOI_LUOT,
): Promise<Map<string, string>> {
	const thay = new Map<string, string>();
	let tong = cac.reduce((t, x) => t + x.noiDung.length, 0);
	if (tong <= tran) return thay;

	const theoCoGiam = [...cac].sort((a, b) => b.noiDung.length - a.noiDung.length);
	for (const x of theoCoGiam) {
		if (tong <= tran) break;
		const ghi = await ghiKetQuaRaDia(x.noiDung, x.toolUseId, cwd, sessionId);
		if (!ghi) continue;
		const moi = thongBaoDaGhi(ghi);
		thay.set(x.toolUseId, moi);
		tong = tong - x.noiDung.length + moi.length;
	}
	return thay;
}
