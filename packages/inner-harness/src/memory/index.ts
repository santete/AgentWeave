/**
 * Bộ nhớ liên phiên — điểm vào duy nhất.
 *
 * `installMemory` đặt hai thứ vào system prompt: cách dùng bộ nhớ, và chỉ mục
 * `MEMORY.md`. Nội dung từng tệp thì KHÔNG — nó chỉ được bơm khi câu hỏi của
 * người dùng thật sự khớp, qua nguồn nhắc `nguonBoNhoLienQuan`.
 *
 * Đây là tiết lộ tiệm tiến lần thứ ba trong cùng một harness: skill có
 * index → nội dung, rule có vô-điều-kiện → theo-đường-dẫn, bộ nhớ có
 * MEMORY.md → tệp. Cùng một hình dạng, vì cùng một sức ép: cửa sổ 64K.
 */

import type { NguonNhac, Nhac } from "../attachments/index";
import { docNoiDung, memoryDir, quetBoNho } from "./memory-store";
import { cauDanBoNho, cauDanBoNhoRong, khoiChiMuc } from "./prompt";
import { chonLienQuan, chuoiTuoi } from "./recall";
import {
	MAX_BYTE_CA_PHIEN,
	MAX_BYTE_MOI_TEP,
	MAX_TEP_MOI_LUOT,
	MEMORY_SECTION,
	type MemoryScanReport,
	NHAN_KHOI_BO_NHO,
} from "./types";

export { quetBoNho, docNoiDung, memoryDir } from "./memory-store";
export { chonLienQuan, chuoiTuoi, tachTu, NGUONG_DIEM } from "./recall";
export { cauDanBoNho, cauDanBoNhoRong, khoiChiMuc } from "./prompt";
export {
	CAC_LOAI,
	MEMORY_SECTION,
	MEMORY_DIR_SEGMENTS,
	TEP_CHI_MUC,
	NHAN_KHOI_BO_NHO,
	MAX_DONG_CHI_MUC,
	MAX_BYTE_MOI_TEP,
	MAX_TEP_MOI_LUOT,
	MAX_BYTE_CA_PHIEN,
} from "./types";
export type {
	LoaiBoNho,
	TepBoNho,
	MemoryProblem,
	MemoryProblemKind,
	MemoryScanReport,
} from "./types";

export interface MemoryHost {
	setSystemPromptSection(name: string, content: string | null): void;
}

export interface InstallMemoryOptions {
	projectDir?: string;
	/** Tắt cảnh báo ra console. Mặc định false — im lặng là nguy hiểm. */
	quiet?: boolean;
	/**
	 * Người dùng bảo bỏ qua bộ nhớ trong phiên này.
	 *
	 * Bỏ qua nghĩa là **không đặt gì vào prompt cả** — không phải đặt vào rồi dặn
	 * model đừng dùng. Bản gốc ghi lỗi thật: model đọc đúng code nhưng vẫn thêm
	 * "không phải Y như ghi trong bộ nhớ", tức là biến "bỏ qua" thành "thừa nhận
	 * rồi gạt sang bên". Cách chắc chắn duy nhất là để nó không thấy gì.
	 */
	boQua?: boolean;
}

export interface InstallMemoryResult {
	report: MemoryScanReport;
	/** false khi bỏ qua hoặc chưa có thư mục bộ nhớ. */
	daBat: boolean;
}

export async function installMemory(
	host: MemoryHost,
	options: InstallMemoryOptions = {},
): Promise<InstallMemoryResult> {
	const projectDir = options.projectDir ?? process.cwd();
	const report = await quetBoNho(projectDir);

	if (options.boQua === true) {
		host.setSystemPromptSection(MEMORY_SECTION, null);
		return { report, daBat: false };
	}

	// Chưa có tệp nhớ nào thì vẫn dạy cách ghi — nếu không, model không bao giờ
	// biết là có thể ghi, và bộ nhớ mãi mãi rỗng. Nhưng dạy bằng bản LƯỜI:
	// hướng dẫn đầy đủ tốn ~711 token ở MỌI lượt, trả giá đó cho một thư mục
	// rỗng là vi phạm chính nguyên tắc tiết lộ tiệm tiến của nó.
	const muc =
		report.tep.length === 0
			? cauDanBoNhoRong(memoryDir(projectDir))
			: `${cauDanBoNho(memoryDir(projectDir))}\n\n${khoiChiMuc(report.chiMuc)}`;
	host.setSystemPromptSection(MEMORY_SECTION, muc);

	if (!options.quiet) {
		for (const p of report.problems) {
			const tag = p.fatal ? "BO QUA BO NHO" : "canh bao";
			console.warn(`[AgentWeave:memory] ${tag} ${p.duong}: ${p.detail}`);
		}
	}

	return { report, daBat: true };
}

/**
 * Nguồn nhắc bơm tệp bộ nhớ liên quan tới câu hỏi hiện tại.
 *
 * Trần cả phiên được suy ra từ NỘI DUNG hội thoại (`ctx.byteBoNhoDaBom`) chứ
 * không giữ một biến song song. Nhờ vậy nén xoá khối bộ nhớ cũ đi thì bộ đếm tự
 * lùi lại — bơm lại là hợp lệ, vì thứ cũ đã không còn trong ngữ cảnh nữa. Giữ
 * biến riêng thì sớm muộn nó cũng lệch khỏi sự thật.
 */
export function nguonBoNhoLienQuan(
	report: MemoryScanReport,
	dongHo: () => number = Date.now,
): NguonNhac {
	return {
		ten: "bo-nho-lien-quan",
		async thu(ctx): Promise<Nhac[]> {
			const cauHoi = ctx.promptNguoiDung ?? "";
			if (cauHoi.trim() === "" || report.tep.length === 0) return [];
			if (ctx.byteBoNhoDaBom >= MAX_BYTE_CA_PHIEN) return [];

			const bayGio = dongHo();
			const chon = chonLienQuan(cauHoi, report.tep, bayGio, MAX_TEP_MOI_LUOT);
			if (chon.length === 0) return [];

			const phan: string[] = [];
			let dungByte = 0;
			for (const c of chon) {
				if (ctx.byteBoNhoDaBom + dungByte >= MAX_BYTE_CA_PHIEN) break;
				let noi: string;
				try {
					noi = await docNoiDung(c.tep, MAX_BYTE_MOI_TEP);
				} catch {
					continue; // tệp vừa bị xoá giữa lúc quét và lúc đọc — bỏ qua, không ném
				}
				// Chuỗi tuổi ĐÓNG BĂNG tại đây, không tính lại lúc dựng prompt.
				phan.push(
					`### ${c.tep.ten} (${c.tep.loai}, ${chuoiTuoi(c.tep.mtimeMs, bayGio)})\n${noi.trim()}`,
				);
				dungByte += Buffer.byteLength(noi, "utf-8");
			}
			if (phan.length === 0) return [];

			return [
				{
					loai: "bo-nho-lien-quan",
					noiDung:
						`${NHAN_KHOI_BO_NHO}\n` +
						`These memories look relevant to what was just asked. They were true when written — ` +
						`verify anything that names a file, function, or flag before you rely on it.\n\n` +
						`${phan.join("\n\n")}`,
					// Không đặt khoá: câu hỏi sau có thể cần đúng tệp này lần nữa, và
					// nén có thể đã xoá khối cũ khỏi ngữ cảnh. Trần phiên là thứ chặn.
				},
			];
		},
	};
}

/** Tóm tắt một dòng cho bộ tự kiểm tra lúc bàn giao. */
export function summarizeMemoryReport(report: MemoryScanReport): string {
	const fatal = report.problems.filter((p) => p.fatal).length;
	const warn = report.problems.length - fatal;
	return (
		`${report.tep.length} bo nho · chi muc ${report.chiMucBytes} byte · ` +
		`${fatal} loi nghiem trong · ${warn} canh bao`
	);
}
