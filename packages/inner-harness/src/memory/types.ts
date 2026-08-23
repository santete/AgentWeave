/**
 * Bộ nhớ liên phiên — kiểu dữ liệu và ngân sách.
 *
 * BỐN LOẠI, CỐ Ý HẸP
 *
 * Danh sách KHÔNG lưu quan trọng ngang danh sách lưu. Thứ suy ra được bằng
 * cách đọc code hoặc đọc `git log` mà đem cất vào bộ nhớ thì vừa tốn chỗ vừa
 * sai — code đổi mà ghi chú không đổi, rồi ghi chú cũ đi dạy model điều không
 * còn đúng. Bộ nhớ chỉ giữ thứ KHÔNG suy ra được từ kho mã.
 *
 * RECALL TẤT ĐỊNH, KHÔNG GỌI MODEL
 *
 * Bản gốc gọi một model rẻ (Sonnet) để chọn hộ file nào liên quan. AgentWeave
 * chạy air-gap với MỘT model trên Jetson: gọi phụ một lượt là trả tiền hai lần
 * cho mỗi câu hỏi, và tốc độ sinh là thứ người dùng cảm nhận trực tiếp.
 *
 * Thay bằng chấm điểm từ khoá giữa câu hỏi và `description` trong frontmatter,
 * cộng điểm thưởng cho file mới sửa. Kém chính xác hơn, nhưng **giải thích
 * được, test được, và chi phí bằng không** — ba thứ đáng giá hơn hẳn trong môi
 * trường không ai gỡ rối được sau khi bàn giao.
 */

/** Bốn loại, cố ý hẹp. Thêm loại thứ năm là mở đường cho bộ nhớ thành bãi rác. */
export type LoaiBoNho = "user" | "feedback" | "project" | "reference";

export const CAC_LOAI: readonly LoaiBoNho[] = [
	"user",
	"feedback",
	"project",
	"reference",
] as const;

/** Thư mục bộ nhớ, tính từ gốc dự án. */
export const MEMORY_DIR_SEGMENTS = [".agentweave", "memory"] as const;

/** Chỉ mục — LUÔN nằm trong system prompt. */
export const TEP_CHI_MUC = "MEMORY.md";

/** Tên mục system prompt. */
export const MEMORY_SECTION = "memory";

// ─── Ngân sách cho cửa sổ 64K ────────────────────────────────────
//
// Bản gốc tính cho cửa sổ 200K: chỉ mục 200 dòng / 25KB, bơm 5 file × 4KB mỗi
// lượt, trần 60KB cả phiên. Quy về 64K (hệ số 0,32) và làm tròn xuống cho an
// toàn — chỉ mục nằm thường trực nên mỗi KB ở đây phải trả giá bằng tốc độ
// sinh suốt cả phiên.

/** Chỉ mục dài hơn thì cắt. Nói thẳng con số này cho model trong prompt. */
export const MAX_DONG_CHI_MUC = 60;
export const MAX_BYTE_CHI_MUC = 8_000;

/** Quét frontmatter: đọc bao nhiêu dòng đầu mỗi tệp, và tối đa bao nhiêu tệp. */
export const MAX_DONG_QUET = 30;
export const MAX_TEP_QUET = 200;

/** Bơm mỗi tệp / mỗi lượt / cả phiên. */
export const MAX_BYTE_MOI_TEP = 2_048;
export const MAX_TEP_MOI_LUOT = 3;
export const MAX_BYTE_CA_PHIEN = 20_480;

/** Nhãn đánh dấu khối bộ nhớ trong hội thoại — dùng để ĐẾM LẠI trần phiên. */
export const NHAN_KHOI_BO_NHO = "<memory-recall>";

export interface TepBoNho {
	/** Tên tệp, vd `thich-tieng-viet.md`. */
	ten: string;
	duong: string;
	loai: LoaiBoNho;
	/** Dòng `description:` trong frontmatter — cơ sở duy nhất để chấm điểm. */
	moTa: string;
	/** Tên trong frontmatter; mặc định lấy theo tên tệp. */
	nhan: string;
	mtimeMs: number;
	bytes: number;
}

export type MemoryProblemKind =
	| "khong_doc_duoc"
	| "thieu_frontmatter"
	| "loai_khong_hop_le"
	| "thieu_mo_ta"
	| "chi_muc_qua_dai"
	| "khong_co_trong_chi_muc";

export interface MemoryProblem {
	kind: MemoryProblemKind;
	duong: string;
	detail: string;
	/** true = tệp không vào được recall. */
	fatal: boolean;
}

export interface MemoryScanReport {
	tep: TepBoNho[];
	problems: MemoryProblem[];
	/** Nội dung MEMORY.md sau khi cắt theo ngân sách. */
	chiMuc: string;
	chiMucBytes: number;
	/** Thư mục bộ nhớ, `null` nếu chưa có. */
	dir: string | null;
}
