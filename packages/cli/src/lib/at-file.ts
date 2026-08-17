/**
 * Chèn file vào câu hỏi bằng cú pháp `@đường-dẫn`.
 *
 * Vì sao cần: không có nó thì phải bảo model "đọc file X" rồi chờ nó gọi tool
 * FileRead — tốn một lượt gọi LLM chỉ để lấy thứ mình đã biết là cần. Với model
 * cục bộ, mỗi lượt thừa là vài giây và vài nghìn token.
 *
 * Cũng an toàn hơn: người dùng chỉ đích danh file, không phụ thuộc việc model
 * có đoán đúng đường dẫn hay không.
 */

import { readFile, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";

/** Trần mỗi file. File to hơn thì cắt và nói rõ, không nhét âm thầm. */
const TRAN_MOI_FILE = 60_000;

export interface KetQuaChen {
	/** Câu hỏi sau khi đã gắn nội dung file. */
	prompt: string;
	daChen: Array<{ duong: string; byte: number; bicat: boolean }>;
	loi: Array<{ duong: string; lyDo: string }>;
}

/**
 * Bắt `@path`. Ký tự đầu CÓ cho phép dấu chấm để `@./src/a.ts` và `@../lib/b.ts`
 * đều nhận ra được — nếu không thì đường dẫn tương đối bị bỏ qua lặng lẽ, và
 * việc chặn vượt thư mục chỉ đúng do TÌNH CỜ regex không khớp chứ không phải
 * do có kiểm tra. An toàn do tình cờ là an toàn mong manh.
 *
 * Ký tự cuối không nhận dấu chấm để không nuốt dấu câu: `@src/a.ts.` → `src/a.ts`.
 */
const MAU = /@([A-Za-z0-9_~.][A-Za-z0-9_./\-]*[A-Za-z0-9_/\-]|[A-Za-z0-9_~])/g;

export async function chenFile(prompt: string, cwd: string): Promise<KetQuaChen> {
	const khop = [...prompt.matchAll(MAU)];
	if (khop.length === 0) return { prompt, daChen: [], loi: [] };

	const daChen: KetQuaChen["daChen"] = [];
	const loi: KetQuaChen["loi"] = [];
	const khoiNoiDung: string[] = [];
	const daXu = new Set<string>();

	for (const k of khop) {
		const duong = k[1]!;
		if (daXu.has(duong)) continue;
		daXu.add(duong);

		const tuyetDoi = resolve(cwd, duong);

		// Chỉ cho phép file TRONG thư mục làm việc. "@../../etc/passwd" phải bị
		// chặn — người dùng gõ nhầm không được biến thành rò rỉ.
		const tuongDoi = relative(cwd, tuyetDoi);
		if (tuongDoi.startsWith("..") || isAbsolute(tuongDoi)) {
			loi.push({ duong, lyDo: "nằm ngoài thư mục làm việc" });
			continue;
		}

		let st: Awaited<ReturnType<typeof stat>>;
		try {
			st = await stat(tuyetDoi);
		} catch {
			// Không phải mọi "@..." đều là file — có thể chỉ là ký hiệu trong câu.
			// Im lặng bỏ qua, KHÔNG báo lỗi ồn ào.
			continue;
		}
		if (!st.isFile()) continue;

		let noi: string;
		try {
			noi = await readFile(tuyetDoi, "utf-8");
		} catch (e) {
			loi.push({ duong, lyDo: (e as Error).message });
			continue;
		}

		const bicat = noi.length > TRAN_MOI_FILE;
		const dung = bicat
			? `${noi.slice(0, TRAN_MOI_FILE)}\n[đã cắt: file dài ${noi.length} ký tự]`
			: noi;

		khoiNoiDung.push(`--- ${duong} ---\n${dung}`);
		daChen.push({ duong, byte: Buffer.byteLength(noi, "utf-8"), bicat });
	}

	if (khoiNoiDung.length === 0) return { prompt, daChen, loi };

	return {
		prompt: `${khoiNoiDung.join("\n\n")}\n\n${prompt}`,
		daChen,
		loi,
	};
}
