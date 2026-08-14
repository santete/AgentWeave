/**
 * Hiện diff trước khi ghi file.
 *
 * Vì sao cần: agent ghi thẳng lên đĩa thì người dùng chỉ biết chuyện gì xảy ra
 * SAU khi nó xảy ra. Thấy diff trước lúc duyệt là khác biệt lớn nhất giữa
 * "công cụ dám dùng trên repo thật" và "công cụ chỉ dám chạy trên bản sao".
 *
 * Tự viết LCS thay vì thêm phụ thuộc: gói bàn giao chạy air-gap, mỗi phụ thuộc
 * mới là một thứ phải mang theo và phải tin.
 */

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const C = {
	reset: "\x1b[0m",
	dim: "\x1b[2m",
	bold: "\x1b[1m",
	green: "\x1b[32m",
	red: "\x1b[31m",
	cyan: "\x1b[36m",
	gray: "\x1b[90m",
};

/** Số dòng ngữ cảnh giữ quanh mỗi cụm thay đổi. */
const NGU_CANH = 3;
/** Trần dòng in ra — diff khổng lồ làm trôi hết màn hình, phản tác dụng. */
const TRAN_DONG = 120;

export interface KetQuaDiff {
	/** Diff đã tô màu, sẵn sàng in. Rỗng nghĩa là không có gì đổi. */
	text: string;
	them: number;
	bot: number;
	/** File chưa tồn tại — đây là tạo mới. */
	taoMoi: boolean;
}

/**
 * Dựng diff cho một lời gọi FileWrite/FileEdit.
 * Trả null nếu tool không phải loại ghi file, hoặc không dựng được diff.
 */
export async function dungDiff(
	toolName: string,
	input: Record<string, unknown>,
	cwd: string,
): Promise<KetQuaDiff | null> {
	const duong = typeof input.path === "string" ? input.path : null;
	if (!duong) return null;

	const tuyetDoi = resolve(cwd, duong);
	let cu = "";
	let taoMoi = false;
	try {
		cu = await readFile(tuyetDoi, "utf-8");
	} catch {
		taoMoi = true;
	}

	let moi: string;
	if (toolName === "FileWrite") {
		if (typeof input.content !== "string") return null;
		moi = input.content;
	} else if (toolName === "FileEdit") {
		const canTim = input.old_string;
		const thayBang = input.new_string;
		if (typeof canTim !== "string" || typeof thayBang !== "string") return null;
		if (taoMoi) return null; // FileEdit trên file chưa có — để tool tự báo lỗi
		if (!cu.includes(canTim)) {
			// Không khớp thì tool sẽ hỏng; báo trước còn hơn để người dùng duyệt mù.
			return {
				text: `  ${C.red}✗ không tìm thấy đoạn cần thay trong ${duong}${C.reset}\n` +
					`  ${C.dim}lời gọi này sẽ thất bại${C.reset}`,
				them: 0,
				bot: 0,
				taoMoi: false,
			};
		}
		moi = cu.replace(canTim, thayBang);
	} else {
		return null;
	}

	return veDiff(duong, cu, moi, taoMoi);
}

function veDiff(duong: string, cu: string, moi: string, taoMoi: boolean): KetQuaDiff {
	const a = cu === "" ? [] : cu.split("\n");
	const b = moi === "" ? [] : moi.split("\n");
	const cacBuoc = lcsDiff(a, b);

	const them = cacBuoc.filter((x) => x.loai === "+").length;
	const bot = cacBuoc.filter((x) => x.loai === "-").length;
	if (them === 0 && bot === 0) {
		return { text: "", them: 0, bot: 0, taoMoi };
	}

	// Chỉ giữ vùng quanh thay đổi.
	const giu = new Set<number>();
	cacBuoc.forEach((x, i) => {
		if (x.loai === " ") return;
		for (let j = Math.max(0, i - NGU_CANH); j <= Math.min(cacBuoc.length - 1, i + NGU_CANH); j++) {
			giu.add(j);
		}
	});

	const dong: string[] = [];
	dong.push(
		`  ${C.bold}${duong}${C.reset} ${C.green}+${them}${C.reset} ${C.red}-${bot}${C.reset}` +
			(taoMoi ? ` ${C.cyan}(tạo mới)${C.reset}` : ""),
	);

	let truoc = -1;
	let daIn = 0;
	for (let i = 0; i < cacBuoc.length; i++) {
		if (!giu.has(i)) continue;
		if (daIn >= TRAN_DONG) {
			dong.push(`  ${C.dim}… còn nữa, đã cắt ở ${TRAN_DONG} dòng${C.reset}`);
			break;
		}
		if (truoc !== -1 && i > truoc + 1) dong.push(`  ${C.gray}⋮${C.reset}`);
		truoc = i;
		daIn++;

		const x = cacBuoc[i]!;
		if (x.loai === "+") dong.push(`  ${C.green}+ ${x.chu}${C.reset}`);
		else if (x.loai === "-") dong.push(`  ${C.red}- ${x.chu}${C.reset}`);
		else dong.push(`  ${C.dim}  ${x.chu}${C.reset}`);
	}

	return { text: dong.join("\n"), them, bot, taoMoi };
}

interface Buoc {
	loai: "+" | "-" | " ";
	chu: string;
}

/**
 * Diff theo dòng.
 *
 * Cắt phần đầu và phần cuối GIỐNG NHAU trước rồi mới chạy LCS trên khúc giữa.
 * Sửa thật thường chỉ đụng một vùng nhỏ của file lớn, nên bước này đưa bài toán
 * 3.000×3.000 về vài dòng. Không có nó thì file nguồn cỡ bình thường đã chạm
 * ngưỡng an toàn và rơi về "thay toàn bộ" — diff vô dụng đúng lúc cần nhất.
 */
function lcsDiff(a: string[], b: string[]): Buoc[] {
	let dau = 0;
	while (dau < a.length && dau < b.length && a[dau] === b[dau]) dau++;

	let cuoi = 0;
	while (
		cuoi < a.length - dau &&
		cuoi < b.length - dau &&
		a[a.length - 1 - cuoi] === b[b.length - 1 - cuoi]
	) {
		cuoi++;
	}

	const giua = lcsLoi(a.slice(dau, a.length - cuoi), b.slice(dau, b.length - cuoi));

	return [
		...a.slice(0, dau).map((chu): Buoc => ({ loai: " ", chu })),
		...giua,
		...a.slice(a.length - cuoi).map((chu): Buoc => ({ loai: " ", chu })),
	];
}

/** LCS thuần trên khúc đã cắt. O(n·m) — chỉ chạy trên phần thật sự khác nhau. */
function lcsLoi(a: string[], b: string[]): Buoc[] {
	if (a.length === 0) return b.map((chu): Buoc => ({ loai: "+", chu }));
	if (b.length === 0) return a.map((chu): Buoc => ({ loai: "-", chu }));

	// Khúc giữa vẫn khổng lồ (file bị viết lại gần như toàn bộ) thì thôi không
	// LCS nữa — kết quả cũng chỉ là "bỏ hết, thêm hết".
	if (a.length * b.length > 4_000_000) {
		return [
			...a.map((chu): Buoc => ({ loai: "-", chu })),
			...b.map((chu): Buoc => ({ loai: "+", chu })),
		];
	}

	const n = a.length;
	const m = b.length;
	const bang: Int32Array[] = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));

	for (let i = n - 1; i >= 0; i--) {
		for (let j = m - 1; j >= 0; j--) {
			bang[i]![j] = a[i] === b[j] ? bang[i + 1]![j + 1]! + 1 : Math.max(bang[i + 1]![j]!, bang[i]![j + 1]!);
		}
	}

	const ra: Buoc[] = [];
	let i = 0;
	let j = 0;
	while (i < n && j < m) {
		if (a[i] === b[j]) {
			ra.push({ loai: " ", chu: a[i]! });
			i++;
			j++;
		} else if (bang[i + 1]![j]! >= bang[i]![j + 1]!) {
			ra.push({ loai: "-", chu: a[i]! });
			i++;
		} else {
			ra.push({ loai: "+", chu: b[j]! });
			j++;
		}
	}
	while (i < n) ra.push({ loai: "-", chu: a[i++]! });
	while (j < m) ra.push({ loai: "+", chu: b[j++]! });
	return ra;
}
