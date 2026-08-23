/**
 * `@đường-dẫn` — chèn nội dung tệp khác vào rule.
 *
 * Vì sao cần: quy ước chung của tổ chức thường đã nằm sẵn ở đâu đó trong repo
 * (`docs/quy-uoc.md`). Không có @include thì hoặc chép tay (rồi hai bản lệch
 * nhau, và bản trong prompt là bản sai) hoặc bỏ hẳn.
 *
 * Bốn hàng rào, mỗi cái ứng với một kiểu hỏng thật:
 *   · độ sâu ≤ 5      — chuỗi include dài hơn thế gần như luôn là lỗi cấu hình
 *   · chống vòng lặp  — A gồm B gồm A sẽ nạp tới hết bộ nhớ
 *   · danh sách trắng đuôi tệp — `@logo.png` nạp thật thì bơm rác nhị phân vào
 *     prompt; với model cục bộ đó là hỏng cả phiên
 *   · chặn ra ngoài dự án — rule trong repo không được tự ý đọc `~/.ssh/config`
 *
 * Quy tắc quan trọng nhất về ĐỘ ỒN: `@` xuất hiện đầy trong văn xuôi bình
 * thường (`@nhóm`, địa chỉ thư, `npm i @scope/pkg`). Nên chỉ token CÓ DẤU `/`
 * và có đuôi tệp mới được xét là include; còn lại giữ nguyên, không báo lỗi.
 * Báo lỗi cho mọi dấu `@` sẽ làm bảng chẩn đoán ngập rác đến mức không ai đọc.
 * Hệ quả cần biết: include cùng thư mục phải viết `@./ten.md`, không phải
 * `@ten.md`.
 */

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { extname, isAbsolute, relative, resolve } from "node:path";
import { DUOI_TEP_CHU, MAX_INCLUDE_DEPTH, type RuleProblem, type RuleScope } from "./types";

export interface TuyChonInclude {
	/** Thư mục chứa tệp đang xử lý — cơ sở cho `@./x` và `@x`. */
	thuMuc: string;
	/** Gốc dự án. Include trỏ ra ngoài bị chặn trừ khi mở cờ bên dưới. */
	gocDuAn: string;
	/** Mặc định false. Bật thì rule đọc được tệp ngoài repo — cân nhắc kỹ. */
	chophepNgoaiDuAn?: boolean;
	scope: RuleScope;
}

export interface KetQuaInclude {
	noiDung: string;
	daNap: string[];
	problems: RuleProblem[];
}

/**
 * Bỏ chú thích HTML ở mức khối, GIỮ NGUYÊN phần trong khối mã.
 *
 * Chú thích chưa đóng thì giữ nguyên: một dấu `<!--` gõ nhầm không được phép
 * nuốt mất phần còn lại của tệp rule.
 */
export function boChuThichHtml(noiDung: string): string {
	return chayNgoaiKhoiMa(noiDung, (doan) => doan.replace(/<!--[\s\S]*?-->/g, ""));
}

/** Chạy hàm biến đổi trên các đoạn NGOÀI khối mã ``` / ~~~. */
function chayNgoaiKhoiMa(noiDung: string, bien: (doan: string) => string): string {
	const dong = noiDung.split("\n");
	const ra: string[] = [];
	let dauRao: string | null = null;
	let dem: string[] = [];

	const xa = () => {
		if (dem.length > 0) {
			ra.push(bien(dem.join("\n")));
			dem = [];
		}
	};

	for (const d of dong) {
		const rao = /^\s*(```+|~~~+)/.exec(d);
		if (dauRao === null && rao) {
			xa();
			dauRao = rao[1]!.slice(0, 1);
			ra.push(d);
			continue;
		}
		if (dauRao !== null) {
			ra.push(d);
			if (rao && rao[1]!.startsWith(dauRao)) dauRao = null;
			continue;
		}
		dem.push(d);
	}
	xa();
	return ra.join("\n");
}

/** `@x` trong đoạn chữ. Bỏ qua mã nội tuyến bằng cách tách theo dấu ` trước. */
const MAU_INCLUDE = /(^|[\s(])@([^\s`)\]]+)/g;

/**
 * Mở rộng mọi @include trong nội dung.
 *
 * @param doSau độ sâu hiện tại, người gọi ngoài luôn để 0
 * @param daXuLy tệp đã nạp trên đường đi — chống vòng lặp
 */
export async function moRongInclude(
	noiDung: string,
	tuyChon: TuyChonInclude,
	doSau = 0,
	daXuLy: Set<string> = new Set(),
): Promise<KetQuaInclude> {
	const problems: RuleProblem[] = [];
	const daNap: string[] = [];

	const ra = await bienDoiNgoaiKhoiMa(noiDung, async (doan) => {
		// Mã nội tuyến `@x` không phải include — tách theo dấu ` và chỉ xử lý
		// những mảnh ở vị trí CHẴN (ngoài cặp backtick).
		const manh = doan.split("`");
		for (let i = 0; i < manh.length; i += 2) {
			manh[i] = await thayTrongDoan(manh[i]!, tuyChon, doSau, daXuLy, problems, daNap);
		}
		return manh.join("`");
	});

	return { noiDung: ra, daNap, problems };
}

async function bienDoiNgoaiKhoiMa(
	noiDung: string,
	bien: (doan: string) => Promise<string>,
): Promise<string> {
	const dong = noiDung.split("\n");
	const ra: string[] = [];
	let dauRao: string | null = null;
	let dem: string[] = [];

	const xa = async () => {
		if (dem.length > 0) {
			ra.push(await bien(dem.join("\n")));
			dem = [];
		}
	};

	for (const d of dong) {
		const rao = /^\s*(```+|~~~+)/.exec(d);
		if (dauRao === null && rao) {
			await xa();
			dauRao = rao[1]!.slice(0, 1);
			ra.push(d);
			continue;
		}
		if (dauRao !== null) {
			ra.push(d);
			if (rao && rao[1]!.startsWith(dauRao)) dauRao = null;
			continue;
		}
		dem.push(d);
	}
	await xa();
	return ra.join("\n");
}

async function thayTrongDoan(
	doan: string,
	tuyChon: TuyChonInclude,
	doSau: number,
	daXuLy: Set<string>,
	problems: RuleProblem[],
	daNap: string[],
): Promise<string> {
	const khop = [...doan.matchAll(MAU_INCLUDE)];
	if (khop.length === 0) return doan;

	let ra = "";
	let viTri = 0;

	for (const m of khop) {
		const truoc = m[1] ?? "";
		const tho = m[2]!;
		const batDau = m.index ?? 0;
		ra += doan.slice(viTri, batDau) + truoc;
		viTri = batDau + m[0]!.length;

		// Dấu câu dính đuôi (`@docs/a.md.`) không thuộc đường dẫn.
		const duongTho = tho.replace(/[.,;:!?]+$/, "");
		const duoiCat = tho.slice(duongTho.length);

		const thay = await napMot(duongTho, tuyChon, doSau, daXuLy, problems, daNap);
		ra += (thay ?? `@${duongTho}`) + duoiCat;
	}

	return ra + doan.slice(viTri);
}

/** @returns nội dung thay thế, hoặc `null` để giữ nguyên chữ gốc. */
async function napMot(
	duongTho: string,
	tuyChon: TuyChonInclude,
	doSau: number,
	daXuLy: Set<string>,
	problems: RuleProblem[],
	daNap: string[],
): Promise<string | null> {
	// Không có dấu `/` → văn xuôi (`@nhom-backend`, `@ten.mien`, `@scope`).
	// Giữ nguyên và KHÔNG báo lỗi: cảnh báo cho mọi dấu @ sẽ làm bảng chẩn đoán
	// ngập rác. Đổi lại, include cùng thư mục phải viết rõ `@./ten.md` — mất một
	// lần gõ, được lại một bảng chẩn đoán đọc được.
	if (!duongTho.includes("/")) return null;

	const duoi = extname(duongTho).toLowerCase();
	if (duoi === "") return null;
	if (!DUOI_TEP_CHU.has(duoi)) {
		problems.push({
			kind: "include_duoi_bi_chan",
			scope: tuyChon.scope,
			duong: duongTho,
			detail: `duoi "${duoi}" khong nam trong danh sach trang tep chu — bo qua`,
			fatal: false,
		});
		return null;
	}

	const tuyetDoi = duongTho.startsWith("~/")
		? resolve(homedir(), duongTho.slice(2))
		: isAbsolute(duongTho)
			? resolve(duongTho)
			: resolve(tuyChon.thuMuc, duongTho);

	const ngoai = relative(tuyChon.gocDuAn, tuyetDoi).startsWith("..");
	if (ngoai && tuyChon.chophepNgoaiDuAn !== true) {
		problems.push({
			kind: "include_ngoai_du_an",
			scope: tuyChon.scope,
			duong: tuyetDoi,
			detail: "include tro ra ngoai goc du an — bi chan (bat chophepNgoaiDuAn neu that su can)",
			fatal: false,
		});
		return null;
	}

	// Chuẩn hoá để `C:\A` và `c:\a` trên Windows không lọt qua bộ chống vòng lặp.
	const khoa = process.platform === "win32" ? tuyetDoi.toLowerCase() : tuyetDoi;
	if (daXuLy.has(khoa)) {
		problems.push({
			kind: "include_vong_lap",
			scope: tuyChon.scope,
			duong: tuyetDoi,
			detail: "tep nay da nam tren duong include — bo qua de khong lap vo han",
			fatal: false,
		});
		return null;
	}

	if (doSau >= MAX_INCLUDE_DEPTH) {
		problems.push({
			kind: "include_qua_sau",
			scope: tuyChon.scope,
			duong: tuyetDoi,
			detail: `vuot do sau toi da ${MAX_INCLUDE_DEPTH}`,
			fatal: false,
		});
		return null;
	}

	let noi: string;
	try {
		noi = await readFile(tuyetDoi, "utf-8");
	} catch (err) {
		problems.push({
			kind: "include_khong_doc_duoc",
			scope: tuyChon.scope,
			duong: tuyetDoi,
			detail: `khong doc duoc: ${(err as Error).message}`,
			fatal: false,
		});
		return null;
	}

	daNap.push(tuyetDoi);
	const sau = new Set(daXuLy).add(khoa);
	const { dirname } = await import("node:path");
	const con = await moRongInclude(
		boChuThichHtml(noi),
		{ ...tuyChon, thuMuc: dirname(tuyetDoi) },
		doSau + 1,
		sau,
	);
	problems.push(...con.problems);
	daNap.push(...con.daNap);

	// Nêu rõ nguồn: model phải phân biệt được chỉ dẫn nào đến từ tệp nào, nếu
	// không thì mọi mâu thuẫn giữa hai tệp đều không truy được về đâu.
	return `\n<!-- @${duongTho} -->\n${con.noiDung.trim()}\n`;
}
