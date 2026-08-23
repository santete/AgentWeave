/**
 * `agentweave vet-tich` — đọc lại mọi điểm chạm dữ liệu của một phiên.
 *
 * Dữ liệu thô vô dụng nếu không dựng lại được dòng thời gian. Lệnh này trả lời
 * đúng bốn câu hỏi mà một phiên hỏng đặt ra:
 *
 *   ① người dùng ĐƯA vào cái gì, duyệt cái gì
 *   ② agent BIẾN ĐỔI nó ra sao trước khi gửi đi
 *   ③ model THẬT SỰ đọc được gì (chứ không phải ta tưởng nó đọc được gì)
 *   ④ model trả về gì, và agent làm gì với thứ đó
 *
 * Ba chế độ, tăng dần độ chi tiết:
 *   (mặc định)   dòng thời gian một dòng một điểm chạm
 *   --luot N     chỉ lượt N, kèm tóm tắt payload
 *   --xem <stt>  đổ NGUYÊN VẸN payload của một điểm chạm ra màn hình
 */

import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import type { DongVetTich } from "../lib/vet-tich-tep.js";

// Mỗi lệnh tự khai bảng màu — quy ước sẵn có của gói này, xem audit.ts/chat.ts.
const C = {
	reset: "\x1b[0m",
	dim: "\x1b[2m",
	bold: "\x1b[1m",
	green: "\x1b[32m",
	red: "\x1b[31m",
	yellow: "\x1b[33m",
	cyan: "\x1b[36m",
	gray: "\x1b[90m",
};

const THU_MUC = ".agentweave/vet-tich";

export interface VetTichArgs {
	/** Id phiên. Bỏ trống = phiên mới nhất. */
	phien?: string;
	/** Chỉ hiện một lượt. */
	luot?: number;
	/** Đổ nguyên payload của điểm chạm có số thứ tự này. */
	xem?: number;
	/** Chỉ hiện một tầng: user | host | agent | llm | tool. */
	tang?: string;
	/** Liệt kê các phiên có vết tích rồi thoát. */
	danhSach?: boolean;
}

/** Màu theo tầng — mắt bắt được nhịp chuyển tầng nhanh hơn đọc chữ. */
const MAU_TANG: Record<string, string> = {
	user: C.cyan,
	host: C.dim,
	agent: C.yellow,
	llm: C.green,
	tool: C.gray,
};

function doDaiNguoiDoc(byte: number): string {
	if (byte < 1024) return `${byte}B`;
	if (byte < 1024 * 1024) return `${(byte / 1024).toFixed(1)}KB`;
	return `${(byte / 1024 / 1024).toFixed(1)}MB`;
}

/** Một dòng tóm tắt cho từng loại điểm chạm. Loại lạ thì đổ `chiTiet` thô. */
function tomTat(d: DongVetTich): string {
	const c = d.chiTiet ?? {};
	const p = d.payload ?? {};
	const byte = Object.values(p).reduce((n, v) => n + v.byte, 0);
	const kem = byte > 0 ? ` ${C.dim}[${doDaiNguoiDoc(byte)}]${C.reset}` : "";

	switch (d.loai) {
		case "user:cau-hoi":
			return `${C.bold}người dùng hỏi${C.reset} — ${c.kyTu} ký tự${c.coAnh ? " + ảnh" : ""}${kem}`;
		case "user:duyet-quyen":
			return `${C.bold}người dùng ${c.choPhep ? "CHO PHÉP" : "TỪ CHỐI"}${C.reset} ${c.tool}${c.luonChoPhep ? " (luôn cho phép)" : ""}`;
		case "user:lenh":
			return `lệnh editor: ${c.lenh}`;
		case "host:cau-day-du":
			return `host ghép thêm ${c.themKyTu} ký tự (file đính kèm)${kem}`;
		case "host:chot-luot":
			return `${C.bold}chốt lượt${C.reset} reason=${c.reason} · vào ${c.tokenVao} / ra ${c.tokenRa} · sửa ${Array.isArray(c.fileDaSua) ? c.fileDaSua.length : 0} file`;
		case "agent:nen":
			return `nén ngữ cảnh mức ${c.muc} (${c.cach}) — bỏ ${c.kyTuBoDi} ký tự, ${c.tinNhanBoDi} tin nhắn · đầy ${c.doDay}/${c.cuaSo}`;
		case "agent:nhac":
			return `bơm nhắc (${c.nguon})${kem}`;
		case "agent:chuan-hoa-cap":
			return `chuẩn hoá cặp tool: ${Array.isArray(c.sua) ? c.sua.join("; ") : ""}`;
		case "agent:guard": {
			const mn = Array.isArray(c.matNa) ? `{${c.matNa.join(",")}}` : "không thu hẹp";
			return `${C.bold}GUARD ${c.coChe}${C.reset} nhịp ${c.nhip}/${c.tran} → mặt nạ ${mn}${c.toolBiChan ? ` · chặn ${c.toolBiChan}` : ""}`;
		}
		case "agent:cuu-tool-call":
			return `cứu tool-call (${c.khuon}): lấy ${c.cuuDuoc}, bỏ ${c.boViNhaiLai} vì nhại lại`;
		case "agent:quyen":
			return `quyền ${c.tool}: ${c.quyetDinh} (${c.nguon}) · chờ ${c.msChoQuyetDinh}ms`;
		case "llm:gui":
			return `${C.bold}→ GỬI MODEL${C.reset} [${c.duong}] ${c.soTinNhan} tin nhắn, ${c.tongKyTu ?? "?"} ký tự · tool: ${Array.isArray(c.toolChoPhep) ? c.toolChoPhep.join(",") : "?"}${c.coMatNa ? ` ${C.yellow}(CÓ MẶT NẠ)${C.reset}` : ""}${kem}`;
		case "llm:nhan":
			return `${C.bold}← MODEL TRẢ${C.reset} ${c.ms}ms · ${c.kyTu} ký tự · token ${c.tokenVao}→${c.tokenRa}${c.tenTool && Array.isArray(c.tenTool) && c.tenTool.length ? ` · gọi ${c.tenTool.join(",")}` : ""}${kem}`;
		case "llm:hong":
			return `${C.red}LLM HỎNG${C.reset} ${c.ma ?? ""} ${c.loi ?? ""} (${c.ms}ms)`;
		case "tool:xong":
			return `tool ${c.tool} xong ${c.ms}ms${c.kiemCuPhap ? ` · ${C.yellow}${String(c.kiemCuPhap).split("\n")[0]}${C.reset}` : ""}${kem}`;
		case "tool:hong":
			return `${C.red}tool ${c.tool} HỎNG${C.reset} ${c.ms}ms${kem}`;
		default:
			return `${d.loai} ${JSON.stringify(c).slice(0, 120)}`;
	}
}

async function docDong(tep: string): Promise<DongVetTich[]> {
	const raw = await readFile(tep, "utf-8");
	const ra: DongVetTich[] = [];
	for (const d of raw.split("\n")) {
		if (d.trim() === "") continue;
		try {
			ra.push(JSON.parse(d) as DongVetTich);
		} catch {
			// Dòng cụt ở cuối tệp khi tiến trình bị giết giữa lúc ghi — bỏ qua nó
			// chứ đừng vứt cả vết tích, vì đúng lượt đó mới là lượt cần xem.
		}
	}
	return ra;
}

/** Phiên mới nhất theo thời điểm sửa thư mục. */
async function phienMoiNhat(goc: string): Promise<string | null> {
	const g = join(goc, THU_MUC);
	let ten: string[];
	try {
		ten = await readdir(g);
	} catch {
		return null;
	}
	const co: Array<{ ten: string; t: number }> = [];
	for (const t of ten) {
		try {
			co.push({ ten: t, t: (await stat(join(g, t))).mtimeMs });
		} catch {
			// thư mục biến mất giữa chừng — bỏ qua
		}
	}
	co.sort((a, b) => b.t - a.t);
	return co[0]?.ten ?? null;
}

export async function chayVetTich(args: VetTichArgs, goc = process.cwd()): Promise<number> {
	if (args.danhSach === true) {
		let ten: string[] = [];
		try {
			ten = (await readdir(join(goc, THU_MUC))).sort().reverse();
		} catch {
			// khong co thu muc
		}
		if (ten.length === 0) {
			console.log(`\n  ${C.yellow}Chưa có vết tích nào.${C.reset}`);
			console.log(`  ${C.dim}Bật bằng "vetTich": true trong .agentweave/agent.json${C.reset}\n`);
			return 0;
		}
		console.log("");
		for (const t of ten) console.log(`  ${t}`);
		console.log("");
		return 0;
	}

	const phien = args.phien ?? (await phienMoiNhat(goc));
	if (!phien) {
		console.log(`\n  ${C.yellow}Chưa có vết tích nào ở ${THU_MUC}.${C.reset}`);
		console.log(`  ${C.dim}Bật bằng "vetTich": true trong .agentweave/agent.json${C.reset}\n`);
		return 1;
	}

	const thuMuc = join(goc, THU_MUC, phien);
	let dong: DongVetTich[];
	try {
		dong = await docDong(join(thuMuc, "vet-tich.jsonl"));
	} catch {
		console.log(`\n  ${C.red}Không đọc được vết tích của phiên ${phien}.${C.reset}\n`);
		return 1;
	}

	// ── Chế độ đổ nguyên payload ──
	if (args.xem !== undefined) {
		const d = dong.find((x) => x.stt === args.xem);
		if (!d) {
			console.log(`\n  ${C.red}Không có điểm chạm #${args.xem}.${C.reset}\n`);
			return 1;
		}
		console.log(`\n  ${C.bold}#${d.stt} ${d.loai}${C.reset}  lượt ${d.luot}  ${d.gio}`);
		if (d.chiTiet) console.log(`  ${C.dim}${JSON.stringify(d.chiTiet, null, 2)}${C.reset}`);
		for (const [ten, p] of Object.entries(d.payload ?? {})) {
			console.log(`\n${C.bold}── ${ten} (${doDaiNguoiDoc(p.byte)}, sha ${p.sha}) ──${C.reset}`);
			if (p.noiDung !== undefined) {
				console.log(p.noiDung);
			} else if (p.tep) {
				console.log(await readFile(join(thuMuc, p.tep), "utf-8"));
			}
		}
		console.log("");
		return 0;
	}

	// ── Dòng thời gian ──
	let loc = dong;
	if (args.luot !== undefined) loc = loc.filter((d) => d.luot === args.luot);
	if (args.tang) loc = loc.filter((d) => d.tang === args.tang);

	console.log(`\n  ${C.bold}Vết tích phiên ${phien}${C.reset}  ${C.dim}${thuMuc}${C.reset}`);
	console.log(
		`  ${C.dim}${dong.length} điểm chạm${loc.length !== dong.length ? ` (hiện ${loc.length})` : ""}${C.reset}\n`,
	);

	let luotTruoc = -1;
	const t0 = dong[0]?.t ?? 0;
	for (const d of loc) {
		if (d.luot !== luotTruoc) {
			luotTruoc = d.luot;
			console.log(`  ${C.bold}${C.dim}── lượt ${d.luot} ──${C.reset}`);
		}
		const mau = MAU_TANG[d.tang] ?? "";
		const giay = ((d.t - t0) / 1000).toFixed(1).padStart(6);
		console.log(
			`  ${C.dim}${giay}s${C.reset} ${C.dim}#${String(d.stt).padStart(4)}${C.reset} ${mau}${d.tang.padEnd(5)}${C.reset} ${tomTat(d)}`,
		);
	}

	// Gợi ý đúng thứ người ta cần tiếp theo: xem trọn chuỗi gửi model.
	const goi = loc.find((d) => d.loai === "llm:gui");
	if (goi) {
		console.log(
			`\n  ${C.dim}Xem trọn chuỗi gửi model:${C.reset} agentweave vet-tich --phien ${phien} --xem ${goi.stt}`,
		);
	}
	console.log("");
	return 0;
}
