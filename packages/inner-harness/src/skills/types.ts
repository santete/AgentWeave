/**
 * Kiểu dữ liệu cho hệ thống Skill.
 *
 * Skill = tri thức quy trình đóng gói thành chữ. KHÔNG kèm tool riêng
 * (nếu kèm thì thành plugin — phức tạp hơn nhiều, để phiên bản sau).
 *
 * Nguyên tắc chi phối toàn bộ thiết kế: **chỉ mục luôn có mặt, nội dung nạp
 * khi cần**. Đo trên Jetson AGX Thor: context 16K làm tốc độ sinh giảm 34%
 * (63,4 → 41,7 tok/s). Mỗi KB nhồi vào system prompt phải trả giá bằng tốc độ
 * suốt cả phiên, nên chỉ mục chỉ chứa `name` + `whenToUse`.
 */

import { z } from "zod";

/** Phạm vi khai báo skill, xếp theo độ ưu tiên giảm dần. */
export type SkillScope = "project" | "user" | "org";

/** Thứ tự ưu tiên: hẹp hơn thắng khi trùng tên. */
export const SCOPE_PRECEDENCE: readonly SkillScope[] = ["project", "user", "org"] as const;

/** Tên skill phải là kebab-case — cũng là tên thư mục, nên cấm ký tự đường dẫn. */
export const SKILL_NAME_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

/**
 * Trần khuyến nghị mỗi phạm vi. Vượt ngưỡng thì chỉ mục bắt đầu ăn vào phần
 * context dành cho code, và model nhỏ cũng khó chọn đúng giữa quá nhiều lựa chọn.
 * 50 skill ≈ 4 KB ≈ 1,7% của context 64K.
 *
 * Đây là trần ĐẾM SỐ LƯỢNG và chỉ để cảnh báo. Thứ thật sự ràng buộc là ngân
 * sách BYTE bên dưới — 50 skill mô tả ngắn rẻ hơn hẳn 20 skill mô tả dài, mà
 * đếm số lượng không phân biệt được hai trường hợp đó.
 */
export const DEFAULT_MAX_SKILLS_PER_SCOPE = 50;

/**
 * Ngân sách chỉ mục tính theo PHẦN TRĂM cửa sổ, không phải số byte tuyệt đối.
 *
 * Vì sao quan trọng: cùng một dòng code phải chạy đúng trên cửa sổ 64K của model
 * cục bộ lẫn 200K của model đám mây. Hằng số tuyệt đối thì hoặc phí chỗ ở cửa sổ
 * lớn, hoặc bóp nghẹt ở cửa sổ nhỏ — và không ai nhớ sửa nó khi đổi model.
 *
 *   200K → 8.000 ký tự    ·    64K → 2.560 ký tự
 */
export const SKILL_BUDGET_CONTEXT_PERCENT = 0.01;

/** Quy đổi thô token ↔ ký tự. Đủ chính xác cho việc chia ngân sách. */
export const CHARS_PER_TOKEN = 4;

/** Trần cứng mô tả mỗi dòng chỉ mục, kể cả khi ngân sách còn dư. */
export const MAX_LISTING_DESC_CHARS = 250;

/**
 * Sàn mô tả. Ngắn hơn ngần này thì mô tả cụt không giúp model chọn đúng, chỉ
 * tốn chỗ — thà bỏ hẳn, giữ lại mỗi cái tên.
 */
export const MIN_DESC_LENGTH = 20;

/** Ngân sách ký tự cho chỉ mục, suy từ cửa sổ ngữ cảnh thật của model. */
export function nganSachChiMuc(cuaSoToken: number): number {
	return Math.floor(cuaSoToken * SKILL_BUDGET_CONTEXT_PERCENT * CHARS_PER_TOKEN);
}

/** `whenToUse` dài hơn ngưỡng này thì cảnh báo — chỉ mục phình ra tuyến tính. */
export const WHEN_TO_USE_SOFT_LIMIT = 100;

/** Trần nội dung SKILL.md nạp vào hội thoại. 32 KB ≈ 8K token ≈ 12% context 64K. */
export const DEFAULT_MAX_CONTENT_BYTES = 32_768;

/** Tên tệp cố định trong mỗi thư mục skill. */
export const SKILL_MANIFEST_FILE = "skill.json";
export const SKILL_CONTENT_FILE = "SKILL.md";

/** Thư mục con chứa skill, tính từ gốc mỗi phạm vi. */
export const SKILLS_DIR_SEGMENTS = [".agentweave", "skills"] as const;

export const SkillManifestSchema = z.object({
	name: z
		.string()
		.min(1)
		.max(64)
		.regex(SKILL_NAME_PATTERN, "phai la kebab-case: chu thuong, so va dau gach ngang"),
	description: z.string().min(1).max(300),
	whenToUse: z.string().min(1).max(300),
	version: z.string().max(32).optional(),
	tags: z.array(z.string().min(1).max(32)).max(10).optional(),
	/**
	 * SKILL CÓ ĐIỀU KIỆN — cú pháp gitignore, nhiều mẫu ngăn bằng dấu phẩy.
	 *
	 * Có `paths:` thì skill KHÔNG vào chỉ mục lúc khởi động. Nó chỉ được giới
	 * thiệu khi model chạm một file khớp. Với cửa sổ 64K đây là khoản tiết kiệm
	 * lớn nhất của cả hệ skill: quy ước .NET không cần quảng cáo trong phiên sửa
	 * một dự án Python, mà chỉ mục thì nằm thường trực suốt phiên.
	 *
	 * `**` được coi như không đặt — quy về skill vô điều kiện.
	 */
	paths: z.string().min(1).max(500).optional(),
});

export type SkillManifest = z.infer<typeof SkillManifestSchema>;

export interface Skill {
	manifest: SkillManifest;
	scope: SkillScope;
	/** true = có `paths:` thật sự thu hẹp phạm vi. */
	coDieuKien: boolean;
	/**
	 * Dự án ĐÃ CÓ sẵn tệp khớp `paths:` — tức là stack này đang được dùng thật.
	 *
	 * Khi đó skill vào thẳng chỉ mục nền dù có điều kiện: quy ước phải có mặt
	 * TRƯỚC khi model viết tệp đầu tiên, không phải sau. Xem quet-du-an.ts.
	 */
	coTrongDuAn: boolean;
	/** Gốc để tính đường dẫn tương đối trước khi khớp `paths:`. */
	gocKhop: string;
	/** Thư mục chứa skill.json và SKILL.md. */
	dir: string;
	/** Đường dẫn tuyệt đối tới SKILL.md. */
	contentPath: string;
	/** Cỡ SKILL.md tính lúc phát hiện — dùng để cảnh báo trước khi nạp. */
	contentBytes: number;
}

export type SkillProblemKind =
	| "manifest_missing"
	| "manifest_invalid"
	| "content_missing"
	| "content_empty"
	| "name_mismatch"
	| "duplicate_name"
	| "over_scope_limit"
	| "when_to_use_too_long"
	| "content_too_large"
	| "paths_khong_hop_le"
	| "chi_muc_vuot_ngan_sach"
	| "scan_failed";

/**
 * Một vấn đề phát hiện lúc quét. `fatal = true` nghĩa là skill bị loại khỏi
 * chỉ mục — người vận hành PHẢI thấy, vì trong air-gap không ai sửa được sau
 * khi bàn giao. Không bao giờ bỏ qua im lặng.
 */
export interface SkillProblem {
	kind: SkillProblemKind;
	scope: SkillScope;
	/** Đường dẫn liên quan (thư mục skill hoặc tệp). */
	path: string;
	/** Mô tả cho người vận hành, tiếng Việt không dấu để an toàn với mọi terminal. */
	detail: string;
	/** true = skill không vào được chỉ mục. */
	fatal: boolean;
}

export interface ShadowedSkill {
	name: string;
	winner: SkillScope;
	loser: SkillScope;
	loserDir: string;
}

export interface ScopeScan {
	scope: SkillScope;
	dir: string | null;
	exists: boolean;
	/** Số skill hợp lệ tìm thấy trong phạm vi này (trước khi xử lý trùng tên). */
	found: number;
}

export interface SkillDiscoveryReport {
	/** Skill đã qua kiểm tra và thắng ở tranh chấp tên. */
	skills: Skill[];
	problems: SkillProblem[];
	shadowed: ShadowedSkill[];
	scopes: ScopeScan[];
	/** Cỡ chỉ mục sẽ chèn vào system prompt, tính bằng byte UTF-8. */
	indexBytes: number;
	/** Ngân sách ký tự đã dùng để dựng chỉ mục. */
	nganSach: number;
	/** Số skill chờ điều kiện `paths:` — không tốn chỗ trong chỉ mục nền. */
	soCoDieuKien: number;
}
