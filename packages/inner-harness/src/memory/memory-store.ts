/**
 * Đọc thư mục bộ nhớ.
 *
 * Chỉ đọc **30 dòng đầu** mỗi tệp lúc quét — đủ để lấy frontmatter, và giữ chi
 * phí quét gần như không đổi dù tệp có to đến đâu. Nội dung đầy đủ chỉ đọc khi
 * recall thật sự chọn tệp đó.
 *
 * Ghi thì KHÔNG có API: model dùng FileWrite/FileEdit sẵn có, theo quy trình
 * viết trong prompt. Thêm một tool `SaveMemory` chỉ là một tên khác cho việc
 * ghi tệp, mà lại thêm một chỗ để model chọn sai.
 */

import { readFile, readdir, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tachFrontmatter } from "../rules/frontmatter";
import {
	CAC_LOAI,
	MAX_BYTE_CHI_MUC,
	MAX_BYTE_MOI_TEP,
	MAX_DONG_CHI_MUC,
	MAX_DONG_QUET,
	MAX_TEP_QUET,
	MEMORY_DIR_SEGMENTS,
	TEP_CHI_MUC,
	type LoaiBoNho,
	type MemoryProblem,
	type MemoryScanReport,
	type TepBoNho,
} from "./types";

export function memoryDir(projectDir: string): string {
	return resolve(projectDir, ...MEMORY_DIR_SEGMENTS);
}

/**
 * Quét thư mục bộ nhớ.
 *
 * Thư mục chưa tồn tại KHÔNG phải lỗi — phần lớn dự án chưa dùng bộ nhớ, và
 * bắt người vận hành tạo tay một thư mục rỗng chỉ để hết cảnh báo là vô nghĩa.
 */
export async function quetBoNho(projectDir: string): Promise<MemoryScanReport> {
	const dir = memoryDir(projectDir);
	const problems: MemoryProblem[] = [];

	let ten: string[];
	try {
		const ds = await readdir(dir, { withFileTypes: true });
		ten = ds
			.filter((d) => d.isFile() && d.name.toLowerCase().endsWith(".md") && d.name !== TEP_CHI_MUC)
			.map((d) => d.name);
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") {
			return { tep: [], problems: [], chiMuc: "", chiMucBytes: 0, dir: null };
		}
		return {
			tep: [],
			problems: [
				{
					kind: "khong_doc_duoc",
					duong: dir,
					detail: `khong doc duoc thu muc: ${(err as Error).message}`,
					fatal: true,
				},
			],
			chiMuc: "",
			chiMucBytes: 0,
			dir,
		};
	}

	const tep: TepBoNho[] = [];
	for (const t of ten) {
		const duong = join(dir, t);
		const mot = await docSieuDuLieu(duong, t, problems);
		if (mot) tep.push(mot);
	}

	// Mới nhất trước: khi điểm khớp bằng nhau thì thứ vừa ghi thường đúng hơn.
	tep.sort((a, b) => b.mtimeMs - a.mtimeMs);
	if (tep.length > MAX_TEP_QUET) {
		problems.push({
			kind: "khong_doc_duoc",
			duong: dir,
			detail: `co ${tep.length} tep, chi xet ${MAX_TEP_QUET} tep moi nhat`,
			fatal: false,
		});
		tep.length = MAX_TEP_QUET;
	}

	const { chiMuc, problem } = await docChiMuc(dir);
	if (problem) problems.push(problem);

	return { tep, problems, chiMuc, chiMucBytes: Buffer.byteLength(chiMuc, "utf-8"), dir };
}

async function docSieuDuLieu(
	duong: string,
	ten: string,
	problems: MemoryProblem[],
): Promise<TepBoNho | null> {
	let dau: string;
	let mtimeMs: number;
	let bytes: number;
	try {
		const st = await stat(duong);
		mtimeMs = st.mtimeMs;
		bytes = st.size;
		const raw = await readFile(duong, "utf-8");
		// Chỉ 30 dòng đầu: frontmatter nằm ở đó, phần thân không ảnh hưởng chấm điểm.
		dau = raw.split("\n").slice(0, MAX_DONG_QUET).join("\n");
	} catch (err) {
		problems.push({
			kind: "khong_doc_duoc",
			duong,
			detail: (err as Error).message,
			fatal: true,
		});
		return null;
	}

	const { truong, coFrontmatter } = tachFrontmatter(dau);
	if (!coFrontmatter) {
		problems.push({
			kind: "thieu_frontmatter",
			duong,
			detail: "thieu khoi --- frontmatter --- nen khong biet loai va mo ta",
			fatal: true,
		});
		return null;
	}

	const loaiTho = (truong.type ?? "").trim();
	if (!CAC_LOAI.includes(loaiTho as LoaiBoNho)) {
		problems.push({
			kind: "loai_khong_hop_le",
			duong,
			detail: `type="${loaiTho}" khong thuoc ${CAC_LOAI.join(" | ")}`,
			fatal: true,
		});
		return null;
	}

	const moTa = (truong.description ?? "").trim();
	if (moTa === "") {
		// Không có mô tả thì recall không có gì để chấm — tệp thành vô hình.
		problems.push({
			kind: "thieu_mo_ta",
			duong,
			detail: "thieu description: nen khong bao gio duoc chon khi recall",
			fatal: true,
		});
		return null;
	}

	return {
		ten,
		duong,
		loai: loaiTho as LoaiBoNho,
		moTa,
		nhan: (truong.name ?? ten.replace(/\.md$/i, "")).trim(),
		mtimeMs,
		bytes,
	};
}

async function docChiMuc(
	dir: string,
): Promise<{ chiMuc: string; problem: MemoryProblem | null }> {
	const duong = join(dir, TEP_CHI_MUC);
	let raw: string;
	try {
		raw = await readFile(duong, "utf-8");
	} catch {
		return { chiMuc: "", problem: null };
	}

	const dong = raw.split("\n");
	if (dong.length <= MAX_DONG_CHI_MUC && Buffer.byteLength(raw, "utf-8") <= MAX_BYTE_CHI_MUC) {
		return { chiMuc: raw.trim(), problem: null };
	}

	// Cắt, và NÓI RA đã cắt. Giới hạn kỹ thuật phải được nói thẳng với model —
	// nó không đoán được vì sao nửa cuối chỉ mục biến mất.
	let ra = dong.slice(0, MAX_DONG_CHI_MUC).join("\n");
	while (Buffer.byteLength(ra, "utf-8") > MAX_BYTE_CHI_MUC && ra.length > 0) {
		ra = ra.slice(0, Math.floor(ra.length * 0.9));
	}
	return {
		chiMuc: `${ra.trim()}\n[${TEP_CHI_MUC} bi cat o dong ${MAX_DONG_CHI_MUC}. Hay gop bot muc va giu chi muc ngan.]`,
		problem: {
			kind: "chi_muc_qua_dai",
			duong,
			detail: `${dong.length} dong / ${Buffer.byteLength(raw, "utf-8")} byte, vuot ${MAX_DONG_CHI_MUC} dong / ${MAX_BYTE_CHI_MUC} byte`,
			fatal: false,
		},
	};
}

/**
 * Đọc nội dung một tệp bộ nhớ để bơm vào hội thoại.
 *
 * Cắt theo trần và kèm đường dẫn đầy đủ: cắt im lặng thì model kết luận trên
 * một nửa sự thật mà không biết còn nửa kia.
 */
export async function docNoiDung(tep: TepBoNho, tran = MAX_BYTE_MOI_TEP): Promise<string> {
	const buf = await readFile(tep.duong);
	if (buf.byteLength <= tran) return buf.toString("utf-8");

	const cat = buf.subarray(0, tran).toString("utf-8");
	const xuongDong = cat.lastIndexOf("\n");
	const an = xuongDong > 0 ? cat.slice(0, xuongDong + 1) : cat;
	return `${an}\n> Memory file truncated at ${tran} bytes. Read the whole file with FileRead at: ${tep.duong}\n`;
}
