/**
 * Lưu và khôi phục phiên trò chuyện.
 *
 * Vì sao cần: `agentweave chat` giữ hội thoại trong bộ nhớ, nên đóng terminal
 * hay máy sập là mất sạch. Với model cục bộ thì một phiên dài có thể là hàng
 * chục nghìn token đã tính toán — mất đi là mất cả thời gian lẫn ngữ cảnh.
 *
 * Ghi theo kiểu THAY THẾ NGUYÊN TỬ (ghi tệp tạm rồi đổi tên): nếu tiến trình
 * chết giữa lúc ghi thì tệp cũ vẫn nguyên vẹn, không để lại JSON cụt.
 */

import { mkdir, readFile, readdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Message } from "@agentweave/types";

const THU_MUC = ".agentweave/sessions";
/** Giữ tối đa ngần này phiên, cũ hơn thì xoá để không phình vô hạn. */
const GIU_TOI_DA = 20;

export interface PhienLuu {
	id: string;
	/** Thời điểm ghi lần cuối, ISO. */
	capNhat: string;
	model: string;
	cwd: string;
	/** Dòng đầu người dùng gõ — để nhận ra phiên nào là phiên nào. */
	tomTat: string;
	soLuot: number;
	tokenVao: number;
	tokenRa: number;
	messages: Message[];
}

function thuMucPhien(goc: string): string {
	return join(goc, THU_MUC);
}

/** Sinh id theo thời gian truyền vào — KHÔNG tự lấy giờ, để test tất định. */
export function taoIdPhien(luc: Date): string {
	const p = (n: number, r = 2) => String(n).padStart(r, "0");
	return (
		`${luc.getFullYear()}${p(luc.getMonth() + 1)}${p(luc.getDate())}` +
		`-${p(luc.getHours())}${p(luc.getMinutes())}${p(luc.getSeconds())}`
	);
}

export async function luuPhien(goc: string, phien: PhienLuu): Promise<void> {
	const thuMuc = thuMucPhien(goc);
	await mkdir(thuMuc, { recursive: true });

	const dich = join(thuMuc, `${phien.id}.json`);
	const tam = `${dich}.tam`;

	// Ghi tạm rồi đổi tên: đổi tên là thao tác nguyên tử trên cùng hệ tệp, nên
	// không bao giờ có tệp phiên hỏng dở.
	await writeFile(tam, JSON.stringify(phien, null, 2), "utf-8");
	await rename(tam, dich);

	await donBot(thuMuc);
}

/** Đọc một phiên theo id. Trả null nếu không có hoặc tệp hỏng. */
export async function docPhien(goc: string, id: string): Promise<PhienLuu | null> {
	try {
		const raw = await readFile(join(thuMucPhien(goc), `${id}.json`), "utf-8");
		const p = JSON.parse(raw) as PhienLuu;
		// Tệp hỏng hoặc sai định dạng thì coi như không có, đừng để nổ ở chỗ khác.
		return Array.isArray(p.messages) ? p : null;
	} catch {
		return null;
	}
}

/** Danh sách phiên, mới nhất trước. */
export async function lietKePhien(goc: string): Promise<PhienLuu[]> {
	const thuMuc = thuMucPhien(goc);
	let ten: string[];
	try {
		ten = (await readdir(thuMuc)).filter((f) => f.endsWith(".json"));
	} catch {
		return [];
	}

	const ds: PhienLuu[] = [];
	for (const t of ten) {
		const p = await docPhien(goc, t.replace(/\.json$/, ""));
		if (p) ds.push(p);
	}
	return ds.sort((a, b) => b.capNhat.localeCompare(a.capNhat));
}

/** Phiên gần nhất — dùng cho `--resume` không kèm id. */
export async function phienGanNhat(goc: string): Promise<PhienLuu | null> {
	return (await lietKePhien(goc))[0] ?? null;
}

async function donBot(thuMuc: string): Promise<void> {
	try {
		const ten = (await readdir(thuMuc)).filter((f) => f.endsWith(".json"));
		if (ten.length <= GIU_TOI_DA) return;

		const theoGio = await Promise.all(
			ten.map(async (t) => ({ t, m: (await stat(join(thuMuc, t))).mtimeMs })),
		);
		theoGio.sort((a, b) => b.m - a.m);
		for (const { t } of theoGio.slice(GIU_TOI_DA)) {
			await unlink(join(thuMuc, t)).catch(() => undefined);
		}
	} catch {
		// Dọn dẹp hỏng không được phép làm hỏng việc lưu phiên.
	}
}
