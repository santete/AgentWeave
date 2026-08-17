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
 */
export const DEFAULT_MAX_SKILLS_PER_SCOPE = 50;

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
});

export type SkillManifest = z.infer<typeof SkillManifestSchema>;

export interface Skill {
	manifest: SkillManifest;
	scope: SkillScope;
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
}
