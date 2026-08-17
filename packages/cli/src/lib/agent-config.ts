/**
 * Cấu hình agent theo dự án: `.agentweave/agent.json`.
 *
 * Vì sao cần: không có nó thì mỗi lần chạy phải gõ lại `--model`, `--mode`,
 * `--max-turns`. Tệ hơn, mỗi dự án một stack khác nhau nên luật quyền cũng
 * khác — gõ tay thì sớm muộn cũng sai một lần, mà sai theo hướng nới lỏng thì
 * không ai nhận ra.
 *
 * Thứ tự ưu tiên: cờ dòng lệnh > tệp dự án > mặc định. Cờ luôn thắng để còn
 * ghi đè nhanh khi cần.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";

export const DUONG_CAU_HINH = ".agentweave/agent.json";

export interface LuatQuyen {
	pattern: string;
	behavior: "allow" | "deny" | "ask";
	message?: string;
}

export interface CauHinhAgent {
	model?: string;
	permissionMode?: "default" | "strict" | "permissive" | "plan";
	maxTurns?: number;
	budget?: number;
	contextWindow?: number;
	/** Câu dẫn thêm vào system prompt cho riêng dự án này. */
	systemPrompt?: string;
	/** Luật quyền BỔ SUNG. Luật chặn cứng dựng sẵn không bị ghi đè. */
	rules?: LuatQuyen[];
	/** Thư mục skill của tổ chức, nếu để ngoài repo. */
	orgSkillsDir?: string;
}

const CHE_DO = ["default", "strict", "permissive", "plan"] as const;
const HANH_VI = ["allow", "deny", "ask"] as const;

/**
 * Kiểm tra thủ công thay vì dùng zod: gói cli không có zod, mà thêm phụ thuộc
 * chỉ để đọc 8 trường thì không đáng — gói bàn giao air-gap phải mang theo mọi
 * thứ. Đổi lại, thông báo lỗi viết được rõ ràng hơn.
 */
function kiemTra(x: unknown): { ok: true; giaTri: CauHinhAgent } | { ok: false; loi: string[] } {
	const loi: string[] = [];
	if (typeof x !== "object" || x === null || Array.isArray(x)) {
		return { ok: false, loi: ["gốc phải là một object JSON"] };
	}
	const o = x as Record<string, unknown>;
	const ra: CauHinhAgent = {};

	const chuoi = (k: keyof CauHinhAgent, max = 20_000) => {
		const v = o[k];
		if (v === undefined) return;
		if (typeof v !== "string" || v.length === 0 || v.length > max) {
			loi.push(`${k}: phải là chuỗi 1..${max} ký tự`);
			return;
		}
		(ra as Record<string, unknown>)[k] = v;
	};
	const so = (k: keyof CauHinhAgent, min: number, max: number, nguyen = true) => {
		const v = o[k];
		if (v === undefined) return;
		if (typeof v !== "number" || !Number.isFinite(v) || v < min || v > max || (nguyen && !Number.isInteger(v))) {
			loi.push(`${k}: phải là số ${nguyen ? "nguyên " : ""}trong khoảng ${min}..${max}`);
			return;
		}
		(ra as Record<string, unknown>)[k] = v;
	};

	chuoi("model", 200);
	chuoi("systemPrompt");
	chuoi("orgSkillsDir", 4096);
	so("maxTurns", 1, 10_000);
	so("contextWindow", 1, 10_000_000);
	so("budget", 0, 10_000, false);

	if (o.permissionMode !== undefined) {
		if (!CHE_DO.includes(o.permissionMode as (typeof CHE_DO)[number])) {
			loi.push(`permissionMode: phải là một trong ${CHE_DO.join(", ")}`);
		} else {
			ra.permissionMode = o.permissionMode as CauHinhAgent["permissionMode"];
		}
	}

	if (o.rules !== undefined) {
		if (!Array.isArray(o.rules) || o.rules.length > 200) {
			loi.push("rules: phải là mảng, tối đa 200 phần tử");
		} else {
			const ds: LuatQuyen[] = [];
			o.rules.forEach((r, i) => {
				const l = r as Record<string, unknown>;
				if (typeof l?.pattern !== "string" || l.pattern.length === 0) {
					loi.push(`rules[${i}].pattern: thiếu hoặc rỗng`);
					return;
				}
				if (!HANH_VI.includes(l.behavior as (typeof HANH_VI)[number])) {
					loi.push(`rules[${i}].behavior: phải là một trong ${HANH_VI.join(", ")}`);
					return;
				}
				ds.push({
					pattern: l.pattern,
					behavior: l.behavior as LuatQuyen["behavior"],
					message: typeof l.message === "string" ? l.message : undefined,
				});
			});
			ra.rules = ds;
		}
	}

	return loi.length > 0 ? { ok: false, loi } : { ok: true, giaTri: ra };
}

export interface KetQuaDoc {
	config: CauHinhAgent;
	/** Đường dẫn tệp đã đọc, null nghĩa là không có tệp nào. */
	nguon: string | null;
	/** Tệp có nhưng hỏng — PHẢI hiện ra, đừng lặng lẽ dùng mặc định. */
	loi: string | null;
}

/**
 * Đọc cấu hình dự án.
 *
 * Tệp hỏng KHÔNG bị nuốt: trả về `loi` để chỗ gọi in cảnh báo. Lặng lẽ rơi về
 * mặc định là kiểu hỏng khó chịu nhất — người dùng sửa cấu hình rồi tưởng đã
 * có hiệu lực.
 */
export async function docCauHinhAgent(cwd: string): Promise<KetQuaDoc> {
	const duong = join(cwd, DUONG_CAU_HINH);

	let raw: string;
	try {
		raw = await readFile(duong, "utf-8");
	} catch {
		return { config: {}, nguon: null, loi: null };
	}

	let tho: unknown;
	try {
		tho = JSON.parse(raw);
	} catch (e) {
		return { config: {}, nguon: duong, loi: `JSON hỏng: ${(e as Error).message}` };
	}

	const kq = kiemTra(tho);
	if (!kq.ok) return { config: {}, nguon: duong, loi: kq.loi.join("; ") };

	return { config: kq.giaTri, nguon: duong, loi: null };
}

/** Gộp: cờ dòng lệnh thắng tệp cấu hình, tệp thắng mặc định. */
export function gop<T extends Record<string, unknown>>(
	tuCo: Partial<T>,
	tuTep: Partial<T>,
	macDinh: T,
): T {
	const ra = { ...macDinh };
	for (const k of Object.keys(macDinh) as Array<keyof T>) {
		if (tuCo[k] !== undefined) ra[k] = tuCo[k] as T[keyof T];
		else if (tuTep[k] !== undefined) ra[k] = tuTep[k] as T[keyof T];
	}
	return ra;
}
