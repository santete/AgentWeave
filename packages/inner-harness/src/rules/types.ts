/**
 * Kiểu dữ liệu cho hệ Rule — chỉ dẫn phân tầng theo nguồn.
 *
 * Rule khác Skill ở chỗ ai chọn: skill do MODEL gọi khi thấy hợp, rule thì
 * người vận hành áp đặt và model không có quyền bỏ qua. Vì vậy rule vô điều
 * kiện nằm thường trực trong system prompt, còn skill chỉ có một dòng chỉ mục.
 *
 * Bốn tầng, nạp theo THỨ TỰ NGƯỢC của độ ưu tiên — tầng nạp sau cùng nằm gần
 * cuối prompt và được model chú ý nhất. Đây là quy ước ngầm nhưng đo được:
 * cùng một câu, đặt cuối prompt thì model tuân, chôn giữa thì bỏ qua.
 *
 *   org     → chính sách tổ chức, đóng băng trong gói bàn giao
 *   user    → ~/.agentweave/rules
 *   project → AGENTS.md và .agentweave/rules, đi từ gốc repo xuống cwd
 *   local   → AGENTS.local.md, không commit
 *
 * ĐÓNG GÓP LỚN NHẤT VỀ CONTEXT là rule CÓ ĐIỀU KIỆN (`paths:` trong
 * frontmatter). Với cửa sổ 64K, để mọi quy ước của mọi tầng nằm thường trực là
 * lãng phí thuần tuý: quy ước migration SQL không giúp gì cho lượt sửa CSS.
 * Rule có điều kiện KHÔNG vào system prompt — nó chỉ được bơm dưới dạng
 * attachment đúng lúc model chạm một file khớp glob.
 */

/** Xếp theo thứ tự NẠP (ưu tiên tăng dần). */
export type RuleScope = "org" | "user" | "project" | "local";

export const SCOPE_NAP_TRUOC_SAU: readonly RuleScope[] = [
	"org",
	"user",
	"project",
	"local",
] as const;

/** Nhãn nguồn gắn kèm mỗi tệp, để model biết trọng lượng của chỉ dẫn. */
export const NHAN_NGUON: Record<RuleScope, string> = {
	org: "organization policy, frozen in the handover package",
	user: "user's personal instructions",
	project: "project instructions, checked into the codebase",
	local: "user's private project instructions, not checked in",
};

/** Thư mục rule trong mỗi phạm vi. */
export const RULES_DIR_SEGMENTS = [".agentweave", "rules"] as const;

/** Tệp rule đặt thẳng ở gốc dự án. */
export const TEP_RULE_DU_AN = "AGENTS.md";
/** Bản riêng của từng người, .gitignore nên bỏ qua. */
export const TEP_RULE_LOCAL = "AGENTS.local.md";

/**
 * Số tầng thư mục tối đa đi ngược lên tìm gốc dự án.
 *
 * Có trần vì `projectDir` có thể trỏ vào chỗ không phải repo, và lúc đó vòng
 * lặp "đi lên tới khi thấy .git" sẽ quét tới tận `/`.
 */
export const MAX_TANG_DI_NGUOC = 12;

/** Trần độ sâu @include. Sâu hơn thì gần như chắc chắn là lỗi cấu hình. */
export const MAX_INCLUDE_DEPTH = 5;

/**
 * Cảnh báo khi một tệp rule vượt ngưỡng này.
 *
 * Không CHẶN, vì đôi khi quy ước dài thật. Nhưng 40.000 ký tự ≈ 10K token ≈
 * 15% cửa sổ 64K nằm thường trực mọi lượt — người vận hành phải biết mình đang
 * trả giá đó.
 */
export const MAX_KY_TU_MOT_RULE = 40_000;

/**
 * Danh sách trắng đuôi tệp cho @include.
 *
 * Chặn nhị phân là chính: `@logo.png` mà nạp thật thì bơm hàng trăm KB rác vào
 * prompt, và với model cục bộ đó là hỏng cả phiên chứ không phải một lỗi nhỏ.
 */
export const DUOI_TEP_CHU = new Set([
	".md",
	".markdown",
	".txt",
	".rst",
	".adoc",
	".json",
	".jsonc",
	".json5",
	".yaml",
	".yml",
	".toml",
	".ini",
	".cfg",
	".conf",
	".env",
	".ts",
	".tsx",
	".js",
	".jsx",
	".mjs",
	".cjs",
	".py",
	".rb",
	".go",
	".rs",
	".java",
	".kt",
	".cs",
	".fs",
	".c",
	".h",
	".cpp",
	".hpp",
	".php",
	".swift",
	".scala",
	".sh",
	".bash",
	".zsh",
	".sql",
	".graphql",
	".proto",
	".css",
	".scss",
	".less",
	".html",
	".xml",
	".csv",
]);

export interface Rule {
	scope: RuleScope;
	/** Đường dẫn tuyệt đối tới tệp rule. */
	duong: string;
	/** Nội dung đã bỏ frontmatter và đã mở rộng @include. */
	noiDung: string;
	/** Chuỗi `paths:` gốc trong frontmatter, giữ nguyên để hiển thị cho model. */
	paths?: string;
	/** true = chỉ bơm khi model chạm file khớp. */
	coDieuKien: boolean;
	/** Gốc để tính đường dẫn tương đối trước khi khớp glob. */
	gocKhop: string;
	bytes: number;
}

export type RuleProblemKind =
	| "doc_that_bai"
	| "rule_qua_lon"
	| "include_qua_sau"
	| "include_vong_lap"
	| "include_khong_doc_duoc"
	| "include_duoi_bi_chan"
	| "include_ngoai_du_an"
	| "paths_khong_hop_le";

/**
 * Một vấn đề phát hiện lúc quét. Không bao giờ bỏ qua im lặng: trong air-gap,
 * một rule âm thầm không được nạp nghĩa là chính sách tổ chức không có hiệu lực
 * mà không ai biết — hỏng nguy hiểm hơn hẳn báo lỗi ồn ào.
 */
export interface RuleProblem {
	kind: RuleProblemKind;
	scope: RuleScope;
	duong: string;
	/** Tiếng Việt không dấu cho an toàn với mọi terminal. */
	detail: string;
	/** true = rule (hoặc phần include) không vào được prompt. */
	fatal: boolean;
}

export interface RuleDiscoveryReport {
	rules: Rule[];
	problems: RuleProblem[];
	/** Cỡ phần chèn thẳng vào system prompt, byte UTF-8. */
	promptBytes: number;
	/** Số rule chờ điều kiện — không tốn context cho tới khi khớp. */
	soCoDieuKien: number;
}
