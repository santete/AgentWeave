/**
 * Thu thập và đóng gói nhắc.
 *
 * Hai bảo đảm, cả hai đều là điều kiện để dám gắn module này vào vòng lặp chính:
 *   · KHÔNG BAO GIỜ ném — collector hỏng thì mất đúng phần nhắc của nó
 *   · KHÔNG BAO GIỜ chạy quá `timeoutMs` — collector treo thì lượt vẫn đi tiếp
 */

import type { Message } from "@agentweave/types";
import { type BoiCanhLuot, type KetQuaThuNhac, type NguonNhac, TIMEOUT_THU_NHAC } from "./types";

/**
 * Chạy toàn bộ collector song song, gom kết quả.
 *
 * Hạn giờ tính cho cả cụm chứ không cho từng cái: điều người dùng cảm nhận là
 * tổng thời gian chờ trước khi model bắt đầu trả lời, không phải thời gian của
 * một collector riêng lẻ.
 */
export async function thuNhac(
	nguon: ReadonlyArray<NguonNhac>,
	ctx: BoiCanhLuot,
	timeoutMs = TIMEOUT_THU_NHAC,
): Promise<KetQuaThuNhac> {
	const ketQua: KetQuaThuNhac = { nhac: [], loi: [], quaHan: [] };
	if (nguon.length === 0) return ketQua;

	const chuaXong = new Set(nguon.map((n) => n.ten));
	let hetHan = false;

	// Mỗi collector tự bọc lỗi và tự đánh dấu đã xong. Không dùng
	// Promise.allSettled + race vì cần biết CÁI NÀO quá hạn để báo tên.
	const chay = nguon.map(async (n) => {
		try {
			const ra = await n.thu(ctx);
			if (hetHan) return; // về muộn sau hạn giờ — bỏ, đừng bơm vào lượt sau
			chuaXong.delete(n.ten);
			for (const item of ra) {
				if (item.khoa !== undefined && ctx.daBom.has(item.khoa)) continue;
				ketQua.nhac.push(item);
			}
		} catch (err) {
			if (hetHan) return;
			chuaXong.delete(n.ten);
			ketQua.loi.push({ ten: n.ten, lyDo: err instanceof Error ? err.message : String(err) });
		}
	});

	let hen: ReturnType<typeof setTimeout> | undefined;
	const dongHo = new Promise<void>((resolve) => {
		hen = setTimeout(() => {
			hetHan = true;
			resolve();
		}, timeoutMs);
		// Không giữ tiến trình sống chỉ vì cái hẹn này — CLI phải thoát được ngay.
		hen.unref?.();
	});

	await Promise.race([Promise.all(chay), dongHo]);
	if (hen) clearTimeout(hen);

	if (hetHan) ketQua.quaHan = [...chuaXong];

	// Trùng khoá giữa hai collector: giữ cái đầu. Xảy ra khi cùng một rule vừa
	// khớp đường dẫn vừa được nạp thủ công — bơm hai lần là lãng phí thuần tuý.
	const daThay = new Set<string>();
	ketQua.nhac = ketQua.nhac.filter((n) => {
		if (n.khoa === undefined) return true;
		if (daThay.has(n.khoa)) return false;
		daThay.add(n.khoa);
		return true;
	});

	return ketQua;
}

/**
 * Câu giải độc, bắt buộc đứng cuối mọi khối nhắc.
 *
 * Không có nó, model nhỏ coi phần chữ bơm vào là YÊU CẦU MỚI của người dùng và
 * quay ra bình luận về nội dung rule thay vì làm việc đang dở. Đã đo đúng kiểu
 * hỏng đó với chỉ mục skill trước khi thêm câu điều kiện vào câu dẫn.
 */
const CAU_GIAI_DOC =
	"This is background context, not a new request from the user. " +
	"Do not reply to it, do not summarise it — apply it silently to the work in progress.";

/**
 * Nhãn đánh dấu nhắc do GUARD bơm (phát hiện lặp, ngân sách trinh sát, cổng
 * kiểm chứng…).
 *
 * Hai lý do phải phân biệt được chúng với chữ thật của hội thoại:
 *
 *   ① Chúng là chữ ĐIỀU KHIỂN của một lượt cụ thể, không phải nội dung phiên.
 *      Trước đây guard bơm thẳng một tin nhắn giả role "user", tin đó được LƯU
 *      VĨNH VIỄN vào tệp phiên và replay ở mọi câu sau — transcript model đọc
 *      phân kỳ khỏi transcript người dùng nhìn thấy, và người vận hành gỡ rối
 *      trên một bản không phải bản model đã thấy.
 *   ② Cùng một loại chữ điều khiển trước đây mang ba khung khác nhau (user
 *      trần / system-reminder / tool_result). Model học được rằng khung nào
 *      cũng có thể là chữ điều khiển, nên không khung nào còn trọng lượng.
 *
 * Xem `locNhacGuard` để lọc chúng ra trước khi ghi phiên.
 */
export const NHAN_NHAC_GUARD = "agentweave:nhac-guard";

/**
 * Bọc một câu răn của guard vào ĐÚNG khung mà mọi nhắc khác đang dùng.
 *
 * @param phan các câu răn của lượt này — gộp thành MỘT tin nhắn, xem `bocNhacHeThong`.
 */
export function nhacGuard(phan: ReadonlyArray<string>): Message | null {
	const sach = phan.map((p) => p.trim()).filter((p) => p !== "");
	if (sach.length === 0) return null;
	return {
		role: "user",
		content:
			`<system-reminder source="${NHAN_NHAC_GUARD}">\n${sach.join("\n\n")}\n\n` +
			`${CAU_GIAI_DOC}\n</system-reminder>`,
	};
}

/**
 * Bỏ mọi nhắc guard khỏi lịch sử.
 *
 * Gọi ở ranh giới GIỮA HAI CÂU của người dùng (nơi `chat`/`serve` mang hội
 * thoại sang lượt sau và ghi tệp phiên). Trong cùng một lượt `run()` thì nhắc
 * phải còn — nó vừa được bơm để model đọc ở chính lượt đó.
 */
export function locNhacGuard(messages: ReadonlyArray<Message>): Message[] {
	return messages.filter(
		(m) => !(typeof m.content === "string" && m.content.includes(NHAN_NHAC_GUARD)),
	);
}

/**
 * Bọc danh sách nhắc thành MỘT tin nhắn user.
 *
 * Một tin nhắn chứ không phải mỗi nhắc một tin: mỗi tin nhắn thêm vào là một
 * lần model phải quyết định "có phải người dùng vừa nói không". Gộp lại thì
 * chỉ phải trả lời câu hỏi đó một lần.
 *
 * @returns `null` khi không có gì để bơm — người gọi bỏ qua, không tạo tin rỗng.
 */
export function bocNhacHeThong(nhac: ReadonlyArray<{ noiDung: string }>): Message | null {
	const phan = nhac.map((n) => n.noiDung.trim()).filter((s) => s !== "");
	if (phan.length === 0) return null;

	return {
		role: "user",
		content: `<system-reminder>\n${phan.join("\n\n")}\n\n${CAU_GIAI_DOC}\n</system-reminder>`,
	};
}
