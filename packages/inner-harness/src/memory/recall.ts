/**
 * Recall tất định — chọn tệp bộ nhớ liên quan mà KHÔNG gọi model.
 *
 * Cách chấm, cố ý đơn giản đến mức đọc là hiểu:
 *
 *   điểm = (số từ chung giữa câu hỏi và `description`) × trọng-số-hiếm
 *        + thưởng nếu tệp vừa được sửa gần đây
 *
 * "Trọng-số-hiếm" là phần duy nhất tinh vi: từ xuất hiện trong NHIỀU mô tả thì
 * gần như không phân biệt được gì (`dự án`, `code`), còn từ chỉ có ở một mô tả
 * thì khớp nó là tín hiệu mạnh. Đây là ý cốt lõi của IDF, viết bằng năm dòng
 * thay vì kéo cả một thư viện BM25 vào gói bàn giao.
 *
 * VÌ SAO KHÔNG DÙNG MODEL
 *
 * Bản gốc gọi Sonnet chọn hộ, kèm một luật rất tinh: "đừng chọn tài liệu API
 * của những tool agent đang dùng trơn tru, NHƯNG vẫn chọn cảnh báo và lỗi đã
 * biết về chính những tool đó". Luật đó hay, và không thể diễn đạt bằng chấm
 * điểm từ khoá.
 *
 * Ta vẫn bỏ, vì air-gap có một model trên Jetson: mỗi lượt gọi phụ là một lần
 * người dùng ngồi chờ thêm. Đổi lại được ba thứ: giải thích được (chỉ ra đúng
 * từ nào khớp), test được (không có ngẫu nhiên), và chi phí bằng không.
 */

import type { TepBoNho } from "./types";

/** Từ quá ngắn hoặc quá phổ biến thì không mang thông tin phân biệt. */
const TU_DUNG = new Set([
	// tiếng Việt
	"và", "là", "của", "cho", "với", "các", "những", "này", "đó", "thì", "mà", "khi",
	"trong", "trên", "dưới", "được", "có", "không", "một", "về", "như", "để", "ở",
	"va", "la", "cua", "cho", "voi", "cac", "nhung", "nay", "do", "thi", "ma", "khi",
	"trong", "tren", "duoi", "duoc", "co", "khong", "mot", "ve", "nhu", "de",
	// tiếng Anh
	"the", "a", "an", "and", "or", "of", "to", "in", "on", "for", "with", "is", "are",
	"be", "this", "that", "it", "as", "at", "by", "from", "not", "was", "were",
]);

const MIN_DAI_TU = 2;

/** Điểm thưởng theo độ mới, cộng thẳng vào điểm khớp. */
const THUONG_MOI = { trong7Ngay: 1.5, trong30Ngay: 0.5 } as const;

/** Dưới ngưỡng này coi như không liên quan — thà không bơm gì còn hơn bơm nhầm. */
export const NGUONG_DIEM = 1.0;

export interface KetQuaChonMot {
	tep: TepBoNho;
	diem: number;
	/** Từ đã khớp — để giải thích được vì sao tệp này được chọn. */
	tuKhop: string[];
}

/** Tách chuỗi thành tập từ đã chuẩn hoá. */
export function tachTu(s: string): string[] {
	return s
		.toLowerCase()
		.split(/[^\p{L}\p{N}_-]+/u)
		.filter((t) => t.length >= MIN_DAI_TU && !TU_DUNG.has(t));
}

/**
 * Chọn tệp liên quan tới câu hỏi.
 *
 * @param cauHoi câu người dùng vừa gõ
 * @param bayGio mốc thời gian, truyền vào để test tất định
 * @param toiDa số tệp tối đa trả về
 */
export function chonLienQuan(
	cauHoi: string,
	tep: ReadonlyArray<TepBoNho>,
	bayGio: number,
	toiDa: number,
): KetQuaChonMot[] {
	const tuHoi = new Set(tachTu(cauHoi));
	if (tuHoi.size === 0 || tep.length === 0) return [];

	// Số mô tả chứa mỗi từ — cơ sở cho trọng số hiếm.
	const soTepChua = new Map<string, number>();
	const tuTheoTep = tep.map((t) => {
		const tu = new Set(tachTu(`${t.moTa} ${t.nhan}`));
		for (const x of tu) soTepChua.set(x, (soTepChua.get(x) ?? 0) + 1);
		return tu;
	});

	const cham: KetQuaChonMot[] = [];
	for (let i = 0; i < tep.length; i++) {
		const t = tep[i]!;
		const tu = tuTheoTep[i]!;

		let diem = 0;
		const tuKhop: string[] = [];
		for (const x of tu) {
			if (!tuHoi.has(x)) continue;
			// Từ có mặt ở mọi mô tả → trọng số ~0. Từ chỉ có ở một mô tả → ~1.
			const hiem = Math.log((tep.length + 1) / (soTepChua.get(x) ?? 1)) / Math.log(tep.length + 1);
			diem += Math.max(0.1, hiem);
			tuKhop.push(x);
		}
		if (tuKhop.length === 0) continue;

		const tuoiNgay = (bayGio - t.mtimeMs) / 86_400_000;
		if (tuoiNgay <= 7) diem += THUONG_MOI.trong7Ngay;
		else if (tuoiNgay <= 30) diem += THUONG_MOI.trong30Ngay;

		if (diem >= NGUONG_DIEM) cham.push({ tep: t, diem, tuKhop });
	}

	cham.sort((a, b) => b.diem - a.diem || b.tep.mtimeMs - a.tep.mtimeMs);
	return cham.slice(0, toiDa);
}

/**
 * Chuỗi tuổi, ĐÓNG BĂNG lúc tạo attachment.
 *
 * Chi tiết dễ bỏ sót: nếu tính lại lúc dựng prompt ở mỗi lượt thì "sửa 3 ngày
 * trước" sẽ thành "4 ngày trước" ở lượt sau → khác byte → vỡ KV-cache cục bộ,
 * và trên Jetson đó là phải prefill lại toàn bộ prefix. Mọi chuỗi phụ thuộc
 * đồng hồ nằm trong ngữ cảnh đều phải được đóng băng đúng một lần.
 */
export function chuoiTuoi(mtimeMs: number, bayGio: number): string {
	const ngay = Math.floor((bayGio - mtimeMs) / 86_400_000);
	if (ngay <= 0) return "saved today";
	if (ngay === 1) return "saved yesterday";
	if (ngay < 30) return `saved ${ngay} days ago`;
	const thang = Math.floor(ngay / 30);
	return thang === 1 ? "saved about a month ago" : `saved about ${thang} months ago`;
}
