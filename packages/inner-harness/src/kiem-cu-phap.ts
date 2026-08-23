/**
 * Kiểm CÚ PHÁP rẻ ngay sau khi ghi file.
 *
 * VÌ SAO CÓ
 *
 * Rà soát `docs/RA-SOAT-DIEU-KHIEN.md` chỉ ra một trục hoàn toàn trống: mọi cơ
 * chế ghì hiện có đều đo *nhịp điệu* của agent — lặp, trinh sát mãi, tuyên bố
 * rồi dừng. Không cơ chế nào nhìn thứ nó VỪA GHI RA. Sau `FileWrite` model chỉ
 * nhận lại "Written 205 bytes"; một file sai cú pháp và một file đúng cho ra
 * cùng một câu, nên agent tự tin báo xong trong cả hai trường hợp.
 *
 * `quality-gate` của pipeline SDLC làm đúng việc này nhưng KHÔNG được nối vào
 * chat/serve (xem §13 bản đồ kỹ thuật). Chờ tới lúc chạy test thì đã muộn vài
 * lượt; còn kiểm cú pháp thì mất vài chục mili-giây.
 *
 * PHẠM VI — CỐ Ý HẸP
 *
 * Chỉ CÚ PHÁP, không phải kiểu, không phải lint, không phải phân giải import.
 * Kiểm kiểu một file lẻ ngoài ngữ cảnh dự án sẽ nôn ra hàng loạt lỗi "không
 * tìm thấy module" — báo động giả, mà báo động giả thì tệ hơn không báo: model
 * sẽ đi sửa thứ không hỏng.
 *
 * Đuôi nào không có bộ kiểm thì trả `dat: null` — nơi gọi im lặng bỏ qua.
 * Thà không nói gì còn hơn nói một câu vô nghĩa về file `.md`.
 */

import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { extname } from "node:path";

/** Hạn giờ cho tiến trình kiểm. Vượt là bất thường — bỏ qua, đừng chặn lượt. */
const HAN_GIO_MS = 5_000;

/** Trần ký tự thông báo lỗi trả về model. Đủ để định vị, không đủ để nhấn chìm. */
const TRAN_THONG_BAO = 400;

export interface KetQuaKiemCuPhap {
	/** `null` = không có bộ kiểm cho đuôi này. Nơi gọi bỏ qua, không nói gì. */
	dat: boolean | null;
	/** Thông báo dành cho model. Chỉ có khi `dat === false`. */
	thongBao?: string;
}

const BO_QUA: KetQuaKiemCuPhap = { dat: null };

/** Bộ nhớ đệm module TypeScript — nạp một lần, khỏi trả giá ở mọi lần ghi sau. */
let tsModule: typeof import("typescript") | null | undefined;

async function napTypeScript(): Promise<typeof import("typescript") | null> {
	if (tsModule !== undefined) return tsModule;
	try {
		tsModule = await import("typescript");
	} catch {
		// Không cài TypeScript (bản bàn giao gọn) — bỏ qua chứ không phải lỗi.
		tsModule = null;
	}
	return tsModule;
}

function catGon(s: string): string {
	const sach = s.trim();
	return sach.length <= TRAN_THONG_BAO ? sach : `${sach.slice(0, TRAN_THONG_BAO)}…`;
}

/** `node --check`. Node 22 tự nhận diện cú pháp module nên `import` không báo giả. */
function kiemBangNode(duong: string): Promise<KetQuaKiemCuPhap> {
	return new Promise((resolve) => {
		execFile(
			process.execPath,
			["--check", duong],
			{ timeout: HAN_GIO_MS, windowsHide: true },
			(loi, _out, err) => {
				if (loi === null) return resolve({ dat: true });
				// Bị giết vì hết giờ, hoặc không chạy nổi `node`: không kết luận được
				// gì về file, nên im lặng thay vì báo file hỏng.
				const g = loi as NodeJS.ErrnoException & { killed?: boolean };
				if (g.killed === true || g.code === "ENOENT") return resolve(BO_QUA);
				resolve({ dat: false, thongBao: catGon(err || loi.message) });
			},
		);
	});
}

async function kiemJson(duong: string): Promise<KetQuaKiemCuPhap> {
	try {
		JSON.parse(await readFile(duong, "utf-8"));
		return { dat: true };
	} catch (e) {
		// Đọc file hỏng (bị xoá ngay sau khi ghi) cũng rơi vào đây; thông báo của
		// JSON.parse và của fs khác hẳn nhau nên model vẫn phân biệt được.
		return { dat: false, thongBao: catGon(e instanceof Error ? e.message : String(e)) };
	}
}

async function kiemTypeScript(duong: string): Promise<KetQuaKiemCuPhap> {
	const ts = await napTypeScript();
	if (ts === null) return BO_QUA;
	let nguon: string;
	try {
		nguon = await readFile(duong, "utf-8");
	} catch {
		return BO_QUA;
	}
	// `createSourceFile` chỉ PHÂN TÍCH CÚ PHÁP — không phân giải import, không
	// kiểm kiểu. Đúng phạm vi cần, và không cần tsconfig của dự án.
	const sf = ts.createSourceFile(
		duong,
		nguon,
		ts.ScriptTarget.Latest,
		/* setParentNodes */ false,
		duong.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
	);
	// `parseDiagnostics` không nằm trong kiểu công khai của SourceFile.
	const chuanDoan = (
		sf as unknown as { parseDiagnostics?: readonly import("typescript").Diagnostic[] }
	).parseDiagnostics;
	if (chuanDoan === undefined || chuanDoan.length === 0) return { dat: true };

	const d = chuanDoan[0]!;
	const vt = d.start === undefined ? "" : `:${sf.getLineAndCharacterOfPosition(d.start).line + 1}`;
	return {
		dat: false,
		thongBao: catGon(`${duong}${vt} — ${ts.flattenDiagnosticMessageText(d.messageText, " ")}`),
	};
}

/**
 * Kiểm cú pháp một file theo ĐUÔI của nó.
 *
 * Không bao giờ ném: mọi lỗi ngoài dự kiến quy về `dat: null`. Đây là việc
 * phụ chạy sau mỗi lần ghi — nó không được phép làm hỏng lượt chính.
 */
export async function kiemCuPhap(duong: string): Promise<KetQuaKiemCuPhap> {
	try {
		switch (extname(duong).toLowerCase()) {
			case ".js":
			case ".mjs":
			case ".cjs":
				return await kiemBangNode(duong);
			case ".json":
				return await kiemJson(duong);
			case ".ts":
			case ".tsx":
			case ".mts":
			case ".cts":
				return await kiemTypeScript(duong);
			default:
				return BO_QUA;
		}
	} catch {
		return BO_QUA;
	}
}

/**
 * Câu gắn thêm vào `tool_result` của lệnh ghi.
 *
 * Nói ĐẠT lẫn KHÔNG ĐẠT chứ không chỉ nói khi hỏng: một câu xác nhận rẻ cũng
 * là bằng chứng model được phép trích dẫn, mà thiếu bằng chứng chính là lý do
 * nó phải chọn giữa nói dối và không báo cáo được gì (xem KT-01).
 */
export function cauKemKetQua(kq: KetQuaKiemCuPhap): string {
	if (kq.dat === null) return "";
	if (kq.dat) return "\n[SYNTAX OK] The file parses.";
	return (
		`\n[SYNTAX ERROR] The file you just wrote does NOT parse:\n${kq.thongBao}\n` +
		"Fix this before doing anything else, and do NOT report the task as done."
	);
}
