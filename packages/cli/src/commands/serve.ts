/**
 * `agentweave serve --stdio` — giao thức JSON dòng để editor lái agent.
 *
 * Vì sao không cho extension nhúng thẳng SDK: gói bàn giao air-gap đã mang sẵn
 * một bản AgentWeave cài đặt hoàn chỉnh. Nhúng lại nghĩa là có hai bản, hai
 * cấu hình, hai chỗ phải vá. Editor chỉ nên LÁI bản đã cài.
 *
 * Giao thức cũng cố ý không phụ thuộc VS Code — mỗi dòng là một JSON, đọc bằng
 * gì cũng được: Neovim, JetBrains, hay một script bash.
 *
 * ── VÀO (stdin, mỗi dòng một JSON) ──
 *   {"type":"prompt","text":"...","images":[{"data":"<base64>","mimeType":"image/png"}]}
 *   {"type":"permission","id":"..","allow":true,"alwaysAllow":false}
 *   {"type":"abort"}                          dừng lượt đang chạy
 *   {"type":"reset"}                          xoá hội thoại (lưu phiên cũ lại)
 *   {"type":"list_sessions"}                   liệt kê phiên đã lưu
 *   {"type":"resume","id":".."}                mở lại phiên (bỏ id = phiên gần nhất)
 *   {"type":"undo"}                            hoàn tác thay đổi file gần nhất
 *
 * ── RA (stdout, mỗi dòng một JSON) ──
 *   {"type":"ready",...}                      sẵn sàng nhận việc
 *   {"type":"delta","text":"..."}             chữ model đang sinh
 *   {"type":"tool","id":"..","name":"..","input":{}}
 *   {"type":"tool_result","id":"..","ok":true,"preview":".."}
 *   {"type":"permission_request","id":"..","tool":"..","input":{},"diff":"..."}
 *   {"type":"turn_end","usage":{},"context":{}}
 *   {"type":"model_switched","from":"..","to":"..","reason":"image","tam":true}
 *   {"type":"error","message":".."}
 *
 * MỌI thứ dành cho người đọc đều ra stderr, stdout CHỈ có JSON — nếu lẫn một
 * dòng chữ thường thì phía kia hỏng ngay mà rất khó truy.
 */

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createInterface } from "node:readline";
import {
	LichHen,
	SoTayViec,
	boToolMacDinh,
	locNhacGuard,
	mucNen,
	nenManhTay,
} from "@agentweave/inner-harness";
import { createHarness } from "@agentweave/sdk";
import type { HarnessInstance } from "@agentweave/sdk";
import { AGENTWEAVE_VERSION } from "@agentweave/types";
import type { ContentBlock, InnerEvent, Message } from "@agentweave/types";
import type { ProcessSandboxBinding } from "@agentweave/types";
import { type CauHinhAgent, type LuatQuyen, docCauHinhAgent } from "../lib/agent-config.js";
import { chenFile } from "../lib/at-file.js";
import { dungCayThuMuc } from "../lib/cay-thu-muc.js";
import { chanDoan } from "../lib/chan-doan-loi.js";
import { dungCoLap } from "../lib/co-lap";
import { dungDiff } from "../lib/diff.js";
import { DoHieuNang } from "../lib/do-hieu-nang.js";
import { batDauDongHo } from "../lib/dong-ho-hen";
import { type BuocHoanTac, apDungHoanTac } from "../lib/hoan-tac.js";
import { LUAT_NGUY_HIEM } from "../lib/luat-nguy-hiem.js";
import { napTriThuc } from "../lib/nap-tri-thuc";
import {
	type PhienLuu,
	docPhien,
	lietKePhien,
	luuPhien,
	taoIdPhien,
} from "../lib/session-store.js";
import { doanLenhKiemTra, dungCauDanHeThong } from "../lib/system-prompt.js";
import { TheoDoiKiemTra, laLenhKiemTra } from "../lib/theo-doi-kiem-tra.js";

export interface ServeArgs {
	model: string;
	permissionMode?: "default" | "strict" | "permissive" | "plan";
	maxTurns?: number;
}

/** Ghi một sự kiện ra stdout. Một dòng, một JSON, không có gì khác. */
function phat(obj: Record<string, unknown>): void {
	process.stdout.write(`${JSON.stringify(obj)}\n`);
}

/**
 * Phát lỗi kèm chỉ dẫn sửa nếu nhận ra được.
 *
 * Trong khu cô lập, thông báo lỗi là tất cả thông tin dev có. `hint` là mảng
 * bước sửa — editor hiện thành danh sách; CLI ghép lại thành nhiều dòng.
 */
function phatLoi(message: string): void {
	const cd = chanDoan(message);
	if (cd) phat({ type: "error", message: cd.tomTat, hint: cd.buoc });
	else phat({ type: "error", message });
}

/**
 * Năng lực model, hỏi thẳng Ollama /api/show. Cache theo tên vì không đổi giữa
 * các lượt. Đây là chỗ quyết định có gửi tool và ảnh hay không:
 *   · Model không có "tools" mà vẫn gửi định nghĩa tool → Ollama trả 400 và
 *     đường streaming của AI SDK TREO IM (đã đo). Nên phải biết TRƯỚC.
 *   · Model không có "vision" thì gửi ảnh là vô nghĩa — cảnh báo thay vì để im.
 */
/**
 * Câu dẫn tối giản cho model CHỈ có thị giác (không tool).
 *
 * Câu dẫn lập trình đầy đủ ("chạy lệnh kiểm tra bằng Bash…") làm model thị giác
 * nhỏ lạc hướng: đo thật, cùng ảnh mà kèm câu dẫn coding thì đọc sai (1/3), bỏ
 * đi thì đọc đúng (3/3). Model này không chạy tool được nên câu dẫn đó vừa vô
 * dụng vừa gây hại.
 */
const CAU_DAN_THI_GIAC =
	"Ban co the nhin thay anh nguoi dung gui. Doc ky anh va tra loi dung trong tam cau hoi, bang ngon ngu cua nguoi dung. Neu anh la anh chup loi, doc chinh xac thong bao loi.";

const cacheNangLuc = new Map<string, { tools: boolean; vision: boolean }>();
async function layNangLuc(model: string): Promise<{ tools: boolean; vision: boolean }> {
	const cu = cacheNangLuc.get(model);
	if (cu) return cu;
	let kq = { tools: true, vision: false }; // đoán an toàn nếu không hỏi được
	try {
		const host = process.env.OLLAMA_HOST ?? "127.0.0.1:11434";
		const url = host.startsWith("http") ? host : `http://${host}`;
		const r = await fetch(`${url}/api/show`, {
			method: "POST",
			body: JSON.stringify({ model }),
		});
		const j = (await r.json()) as { capabilities?: string[] };
		const caps = j.capabilities ?? [];
		kq = { tools: caps.includes("tools"), vision: caps.includes("vision") };
	} catch {
		// Không hỏi được thì giữ đoán an toàn; đừng chặn cả lượt vì một lần lỡ.
	}
	cacheNangLuc.set(model, kq);
	return kq;
}

/**
 * Tìm một model THỊ GIÁC đã cài để tự chuyển sang khi đầu vào có ảnh.
 *
 * Ưu tiên model người dùng chỉ định trong cấu hình (`visionModel`); nếu không,
 * dò trong danh sách model đã cài, lấy model đầu tiên có năng lực "vision".
 * Cache kết quả dò (kể cả "không có") để không quét lại mỗi lượt.
 *
 * Chỉ tìm trong model ĐÃ CÀI: khu cô lập không `pull` được, nên model thị giác
 * phải nằm sẵn trong gói. Không thấy thì trả null, chỗ gọi sẽ báo rõ.
 */
let daDoModelThiGiac: { xong: boolean; ten: string | null } = { xong: false, ten: null };
async function timModelThiGiac(uaChon?: string): Promise<string | null> {
	if (uaChon?.trim()) {
		const nl = await layNangLuc(uaChon.trim());
		if (nl.vision) return uaChon.trim();
		// Chỉ định nhưng không phải model thị giác — coi như không chỉ định, dò tiếp.
	}
	if (daDoModelThiGiac.xong) return daDoModelThiGiac.ten;
	let ten: string | null = null;
	try {
		const host = process.env.OLLAMA_HOST ?? "127.0.0.1:11434";
		const url = host.startsWith("http") ? host : `http://${host}`;
		const r = await fetch(`${url}/api/tags`);
		const j = (await r.json()) as { models?: Array<{ name: string }> };
		for (const m of j.models ?? []) {
			if ((await layNangLuc(m.name)).vision) {
				ten = m.name;
				break;
			}
		}
	} catch {
		// Không dò được thì để null; đừng chặn lượt vì một lần lỡ.
	}
	daDoModelThiGiac = { xong: true, ten };
	return ten;
}

/**
 * Dùng model thị giác đọc ảnh và VIẾT LẠI thành chữ, để model coder (có công cụ
 * nhưng mù ảnh) dựng được.
 *
 * Đây là cầu nối cốt lõi: model thị giác nhỏ nhìn được ảnh nhưng KHÔNG chạy tool
 * (không FileWrite/Bash), nên nó chỉ "nói" chứ không "làm". Model coder thì
 * ngược lại. Cho model thị giác làm ĐÔI MẮT — mô tả thật chi tiết — rồi trao mô
 * tả đó cho coder làm ĐÔI TAY. Gọi thẳng Ollama /v1, không qua AI SDK.
 */
async function moTaAnh(
	model: string,
	yeuCau: string,
	anh: Array<{ data: string; mimeType?: string }>,
): Promise<string> {
	const host = process.env.OLLAMA_HOST ?? "127.0.0.1:11434";
	const url = host.startsWith("http") ? host : `http://${host}`;
	const loi = `Nguoi dung gui anh nay kem yeu cau: "${yeuCau}". Hay MO TA THAT CHI TIET moi thu ban thay trong anh — bo cuc, cac thanh phan giao dien, mau sac, chu, so lieu, vi tri — du de mot lap trinh vien KHONG nhin thay anh van dung lai duoc. Chi mo ta, KHONG viet code.`;
	const content = [
		{ type: "text", text: loi },
		...anh.map((a) => ({ type: "image_url", image_url: { url: a.data } })),
	];
	const r = await fetch(`${url}/v1/chat/completions`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ model, messages: [{ role: "user", content }], stream: false }),
	});
	if (!r.ok) throw new Error(`model thi giac tra ma ${r.status}`);
	const j = (await r.json()) as { choices?: Array<{ message?: { content?: string } }> };
	return j.choices?.[0]?.message?.content?.trim() ?? "";
}

/** Một mục để hiện lại khi mở phiên cũ. */
interface MucTranscript {
	kind: "hoi" | "tra-loi" | "tool";
	text: string;
	/** Câu hỏi có kèm ảnh — để webview vẽ dấu ảnh. */
	coAnh?: boolean;
}

/**
 * Dựng lại hội thoại để hiện khi mở phiên cũ.
 *
 * Chỉ lấy thứ người đọc cần: câu hỏi, câu trả lời, và tên tool đã gọi. Bỏ
 * tool_result và thinking (quá dài, làm rối). Ảnh trong câu hỏi chỉ đánh dấu,
 * KHÔNG gửi lại base64 — phiên lưu không giữ ảnh gốc, mà gửi lại cũng nặng.
 */
function dungTranscript(messages: ReadonlyArray<Message>): MucTranscript[] {
	const ra: MucTranscript[] = [];
	for (const m of messages) {
		if (m.role === "system") continue;
		if (typeof m.content === "string") {
			if (m.content.trim())
				ra.push({ kind: m.role === "user" ? "hoi" : "tra-loi", text: m.content });
			continue;
		}
		// ContentBlock[]
		const laToolResult = m.content.some((b) => b.type === "tool_result");
		if (laToolResult) continue; // kết quả tool — bỏ cho gọn
		const chu = m.content
			.filter((b): b is Extract<ContentBlock, { type: "text" }> => b.type === "text")
			.map((b) => b.text)
			.join("\n")
			.trim();
		const coAnh = m.content.some((b) => b.type === "image");
		if (chu || coAnh) {
			ra.push({ kind: m.role === "user" ? "hoi" : "tra-loi", text: chu, coAnh });
		}
		for (const b of m.content) {
			if (b.type === "tool_use") ra.push({ kind: "tool", text: b.name });
		}
	}
	return ra;
}

/** Thông tin cho người vận hành đọc — LUÔN ra stderr. */
function nhatKy(msg: string): void {
	process.stderr.write(`[agentweave serve] ${msg}\n`);
}

export async function serveCommand(args: ServeArgs): Promise<void> {
	const goc = process.cwd();
	const { config: cauHinh, nguon, loi: loiCauHinh } = await docCauHinhAgent(goc);
	if (loiCauHinh) nhatKy(`cau hinh ${nguon} khong dung duoc: ${loiCauHinh}`);

	let model = args.model || cauHinh.model || "qwen3-coder:30b";
	const cheDoQuyen = args.permissionMode ?? cauHinh.permissionMode ?? "default";
	const maxTurns = args.maxTurns ?? cauHinh.maxTurns ?? 50;

	let lichSu: ReadonlyArray<Message> = [];

	// ── Trạng thái phiên để lưu/khôi phục ──
	// serve giữ hội thoại trong bộ nhớ; đóng editor là mất. Model cục bộ một
	// phiên dài là hàng chục nghìn token đã tính — lưu lại để mở editor sau còn
	// tiếp được. Ghi sau MỖI lượt, thay thế nguyên tử, giống REPL.
	let idPhien = taoIdPhien(new Date());
	let tomTat = "";
	let soLuot = 0;
	let tongVao = 0;
	let tongRa = 0;

	// Ngăn xếp hoàn tác cho các thay đổi file, sống qua các lượt trong phiên.
	const hoanTac: BuocHoanTac[] = [];

	async function luuLai(): Promise<void> {
		if (lichSu.length === 0) return;
		const phien: PhienLuu = {
			id: idPhien,
			capNhat: new Date().toISOString(),
			model,
			cwd: goc,
			tomTat,
			soLuot,
			tokenVao: tongVao,
			tokenRa: tongRa,
			messages: [...lichSu] as Message[],
		};
		// Lưu hỏng KHÔNG được làm sập serve — chỉ ghi nhật ký rồi đi tiếp.
		await luuPhien(goc, phien).catch((e) => nhatKy(`luu phien that bai: ${String(e)}`));
	}

	// Giữ trong object: TypeScript không thu hẹp kiểu thuộc tính qua ranh giới
	// hàm, nên phép gán từ callback không làm nó tưởng biến luôn là null.
	const chay: { hien: HarnessInstance | null } = { hien: null };

	// Các lời xin quyền đang chờ editor trả lời.
	const dangCho = new Map<string, (kq: { allow: boolean; alwaysAllow?: boolean }) => void>();
	let demXinQuyen = 0;

	// "Luôn cho phép" phải sống qua các lượt: mỗi lượt dựng harness mới nên bộ
	// nhớ quyền bên trong mất theo, bấm xong lượt sau lại hỏi.
	const luonChoPhep = new Set<string>();

	// Câu dẫn hệ thống: dựng một lần, dùng cho mọi lượt.
	const cauDan = dungCauDanHeThong({
		cuaDuAn: cauHinh.systemPrompt,
		lenhKiemTra: await doanLenhKiemTra(goc),
		khongMang: cauHinh.offline,
		danhSachViec: cauHinh.danhSachViec === true,
		// Nói cho model biết nó đang bị cô lập. Không nói thì nó đọc "No such
		// file or directory" của đường dẫn bị chặn và chẩn đoán như file thiếu
		// thật — tải lại (hỏng vì không mạng), hoặc tạo lại (mất khi phiên xong).
		workspaceCoLap: cauHinh.sandbox === true ? goc : undefined,
		choDocThem: cauHinh.sandboxReadOnly,
	});

	phat({
		type: "ready",
		version: AGENTWEAVE_VERSION,
		model,
		cwd: goc,
		permissionMode: cheDoQuyen,
		configSource: nguon,
	});

	// ── Chạy một lượt ──
	// Tách thành hàm vì có HAI nguồn khởi phát: người dùng gõ, và hẹn giờ đến hạn.
	// Trước đây khối này nằm thẳng trong nhánh "prompt" nên hẹn giờ không dùng lại được.
	function khoiChayLuot(text: string, anh: Array<{ data: string; mimeType?: string }>): void {
		soLuot++;
		if (!tomTat) tomTat = text.slice(0, 80);
		const ketQua = { usage: { inputTokens: 0, outputTokens: 0 }, reason: "" };

		// KHÔNG await ở đây. Vòng lặp đọc stdin là chỗ DUY NHẤT đọc stdin; await
		// trọn lượt nghĩa là lời "permission" của editor không bao giờ đọc tới,
		// agent xin quyền rồi treo cho đến khi interceptor hết giờ. Đã vấp đúng
		// lỗi này: editor trả allow=true mà tool vẫn bị từ chối.
		void chayMotLuot({
			text,
			goc,
			model,
			cheDoQuyen,
			maxTurns,
			cauHinh,
			lichSu,
			dangCho,
			luonChoPhep,
			cauDan,
			anh,
			dongHoChoNguoi: { ms: 0 },
			lichHen,
			soTayViec,
			soLuot,
			coLap: coLap.binding,
			layId: () => `q${++demXinQuyen}`,
			datDangChay: (h) => {
				chay.hien = h;
			},
			ketQua,
			hoanTac,
		})
			.then(async (ds) => {
				// Bỏ nhắc guard trước khi mang sang câu sau — xem ghi chú cùng chỗ
				// trong chat.ts.
				lichSu = locNhacGuard(ds);
				tongVao += ketQua.usage.inputTokens;
				tongRa += ketQua.usage.outputTokens;
				await luuLai();
			})
			.catch((e) => phatLoi(String(e?.message ?? e)))
			.finally(() => {
				chay.hien = null;
				// Lượt vừa xong là lúc tốt nhất để rút việc hẹn giờ đang chờ.
				thuChayHenGio();
			});
	}

	// ── Hẹn giờ ──
	// Đồng hồ nằm ở TIẾN TRÌNH SERVE, không ở vòng lặp agent: agent chỉ sống
	// trong một lượt, còn hẹn "mỗi 5 phút" phải nhích cả lúc người dùng đang gõ.
	const choHenGio: string[] = [];

	/** Rút một việc đến hạn nếu đang rảnh. Bận thì để lần sau — không tiêm giữa lượt. */
	function thuChayHenGio(): void {
		if (chay.hien) return;
		const viec = choHenGio.shift();
		if (viec === undefined) return;

		// Editor tự đặt trạng thái "đang bận" khi NGƯỜI DÙNG bấm gửi. Lượt do
		// server khởi phát thì nó không biết, nên phải báo — nếu không, ô nhập
		// vẫn mở và câu gõ tiếp theo bị từ chối bằng "dang chay mot luot khac".
		phat({ type: "turn_start", reason: "hen_gio" });
		khoiChayLuot(viec, []);
	}

	// Sổ tay việc sống suốt phiên serve.
	const soTayViec = new SoTayViec();
	const lichHen = new LichHen();
	const dongHo = batDauDongHo(lichHen, {
		khiDenHan: (v) => {
			// Nói RA vì sao agent tự chạy. Kênh `notice` đã có sẵn và editor đã
			// render, nên không phải thêm gì vào giao thức cho phần thông báo.
			phat({
				type: "notice",
				level: "info",
				message: `⏰ đến hạn: ${v.id} — ${v.viec}`,
			});
			choHenGio.push(v.viec);
			thuChayHenGio();
		},
	});

	// Cô lập tầng nhân — chỉ khi agent.json bật tường minh. Hỏng thì DỪNG:
	// người vận hành bật cờ đó vì tin là có cô lập.
	const coLap = await dungCoLap(goc, cauHinh);
	if (coLap.hong) {
		phat({ type: "error", message: coLap.thongBao });
		nhatKy(coLap.thongBao);
		return;
	}
	if (coLap.thongBao) phat({ type: "notice", level: "info", message: `🔒 ${coLap.thongBao}` });

	const rl = createInterface({ input: process.stdin, terminal: false });

	for await (const dong of rl) {
		const s = dong.trim();
		if (s === "") continue;

		let msg: Record<string, unknown>;
		try {
			msg = JSON.parse(s) as Record<string, unknown>;
		} catch {
			phat({ type: "error", message: `dong khong phai JSON hop le: ${s.slice(0, 120)}` });
			continue;
		}

		switch (msg.type) {
			case "permission": {
				const id = String(msg.id ?? "");
				const traLoi = dangCho.get(id);
				if (traLoi) {
					dangCho.delete(id);
					const luon = msg.alwaysAllow === true;
					const tenTool = typeof msg.tool === "string" ? msg.tool : "";
					if (luon && tenTool) {
						luonChoPhep.add(tenTool);
						phat({ type: "always_allowed", tool: tenTool });
					}
					traLoi({ allow: msg.allow === true, alwaysAllow: luon });
				}
				break;
			}

			case "abort":
				chay.hien?.abort("editor huy");
				break;

			case "reset":
				// Lưu phiên hiện tại trước khi bỏ, rồi mở phiên mới — không đè lên
				// phiên cũ, để người dùng còn quay lại được.
				await luuLai();
				lichSu = [];
				idPhien = taoIdPhien(new Date());
				tomTat = "";
				soLuot = 0;
				tongVao = 0;
				tongRa = 0;
				phat({ type: "reset_ok" });
				break;

			case "list_sessions": {
				const ds = await lietKePhien(goc);
				phat({
					type: "sessions",
					current: idPhien,
					sessions: ds.map((x) => ({
						id: x.id,
						capNhat: x.capNhat,
						tomTat: x.tomTat,
						soLuot: x.soLuot,
						model: x.model,
					})),
				});
				break;
			}

			case "resume": {
				if (chay.hien) {
					phat({ type: "error", message: "dang chay mot luot, hay abort truoc khi mo phien khac" });
					break;
				}
				const id = String(msg.id ?? "").trim();
				const cu = id
					? await docPhien(goc, id)
					: await (async () => (await lietKePhien(goc))[0] ?? null)();
				if (!cu) {
					phat({
						type: "error",
						message: id ? `khong tim thay phien "${id}"` : "chua co phien nao de mo",
					});
					break;
				}
				// Lưu phiên đang mở trước khi chuyển, rồi nạp phiên cũ vào trạng thái.
				await luuLai();
				lichSu = cu.messages;
				idPhien = cu.id;
				tomTat = cu.tomTat;
				soLuot = cu.soLuot;
				tongVao = cu.tokenVao;
				tongRa = cu.tokenRa;
				if (cu.model) {
					model = cu.model;
					phat({ type: "model_changed", model });
				}
				phat({
					type: "resumed",
					id: cu.id,
					tomTat: cu.tomTat,
					soLuot: cu.soLuot,
					messages: cu.messages.length,
					transcript: dungTranscript(cu.messages),
				});
				break;
			}

			case "undo": {
				if (chay.hien) {
					phat({ type: "error", message: "dang chay mot luot, hay abort truoc khi hoan tac" });
					break;
				}
				const buoc = hoanTac.pop();
				if (!buoc) {
					phat({ type: "error", message: "khong con thay doi nao de hoan tac" });
					break;
				}
				try {
					const kq = await apDungHoanTac(goc, buoc);
					phat({ type: "undone", path: kq.path, daXoa: kq.daXoa, conLai: hoanTac.length });
				} catch (e) {
					// Khôi phục hỏng thì trả bước vào lại ngăn, đừng mất dấu.
					hoanTac.push(buoc);
					phat({ type: "error", message: `hoan tac that bai: ${String(e)}` });
				}
				break;
			}

			case "set_model": {
				const m = String(msg.model ?? "").trim();
				if (!m) break;
				if (chay.hien) {
					phat({ type: "error", message: "dang chay mot luot, hay abort truoc khi doi model" });
					break;
				}
				model = m;
				phat({ type: "model_changed", model });
				break;
			}

			case "list_models": {
				// Hỏi thẳng Ollama — danh sách phải là thứ máy ĐANG có, không phải
				// một danh sách cứng trong mã rồi lệch dần theo thời gian.
				try {
					const host = process.env.OLLAMA_HOST ?? "127.0.0.1:11434";
					const url = host.startsWith("http") ? host : `http://${host}`;
					const r = await fetch(`${url}/api/tags`);
					const j = (await r.json()) as { models?: Array<{ name: string; size: number }> };
					phat({
						type: "models",
						models: (j.models ?? []).map((x) => ({ name: x.name, size: x.size })),
						current: model,
					});
				} catch (e) {
					phatLoi(`khong lay duoc danh sach model: ${String(e)}`);
				}
				break;
			}

			case "prompt": {
				if (chay.hien) {
					phat({ type: "error", message: "dang chay mot luot khac, hay abort truoc" });
					break;
				}
				const text = String(msg.text ?? "");
				// Nén THỦ CÔNG: gõ /nen hoặc /compact trong ô chat. Nén tự động chỉ
				// kích hoạt khi gần đầy — nhưng người dùng thấy phiên ì ạch có quyền
				// chủ động dọn mà không phải mở phiên mới (mất mạch làm việc).
				if (/^\/(nen|compact)\s*$/i.test(text.trim())) {
					const muc = mucNen(0);
					const kq = nenManhTay([...lichSu], muc.giuGanNhat, muc.tranToolResult);
					if (kq.daNen) {
						lichSu = kq.messages;
						phat({
							type: "notice",
							level: "info",
							message: `Đã nén ngữ cảnh thủ công (${kq.cach}) — bỏ ~${kq.kyTuBoDi.toLocaleString()} ký tự, còn ${lichSu.length} tin nhắn.`,
						});
					} else {
						phat({
							type: "notice",
							level: "info",
							message: "Ngữ cảnh còn gọn — không có gì để nén.",
						});
					}
					break;
				}
				// Ảnh: mảng {data, mimeType}. data là base64 thuần hoặc data URL.
				const anh: Array<{ data: string; mimeType?: string }> = Array.isArray(msg.images)
					? (msg.images as unknown[]).flatMap((x) => {
							const o = x as Record<string, unknown>;
							if (typeof o?.data !== "string") return [];
							return [
								typeof o.mimeType === "string"
									? { data: o.data, mimeType: o.mimeType }
									: { data: o.data },
							];
						})
					: [];
				// Cho phép chỉ gửi ảnh không kèm chữ; nhưng rỗng cả hai thì bỏ qua.
				if (!text.trim() && anh.length === 0) break;

				khoiChayLuot(text, anh);
				break;
			}

			default:
				phat({ type: "error", message: `khong hieu type="${String(msg.type)}"` });
		}
	}

	// Dừng đồng hồ khi stdin đóng, nếu không tiến trình serve không thoát.
	dongHo.dung();
	nhatKy("stdin dong, thoat");
}

interface ThamSoLuot {
	text: string;
	goc: string;
	model: string;
	cheDoQuyen: "default" | "strict" | "permissive" | "plan";
	maxTurns: number;
	cauHinh: CauHinhAgent;
	lichSu: ReadonlyArray<Message>;
	dangCho: Map<string, (kq: { allow: boolean; alwaysAllow?: boolean }) => void>;
	/** Tool người dùng đã bấm "Luôn cho phép" ở các lượt trước. */
	luonChoPhep: Set<string>;
	cauDan: string;
	/** Cộng dồn thời gian người dùng ngồi quyết định, ms. */
	dongHoChoNguoi: { ms: number };
	/** Lịch hẹn của phiên serve — để đăng ký tool ScheduleTask cho model. */
	lichHen?: LichHen;
	/** Ràng buộc cô lập tầng nhân, nếu agent.json bật. */
	coLap?: ProcessSandboxBinding;
	/** Sổ tay việc của phiên. */
	soTayViec?: SoTayViec;
	/** Số lượt đã chạy — sổ tay dùng để biết danh sách cũ bao lâu rồi. */
	soLuot: number;
	layId: () => string;
	datDangChay: (h: HarnessInstance | null) => void;
	/**
	 * Kết quả lượt để lớp ngoài lưu phiên. Mutable, giống dongHoChoNguoi: đặt
	 * ngay tại turn_end. Không trả qua Promise vì lượt chạy non-blocking (void).
	 */
	ketQua: { usage: { inputTokens: number; outputTokens: number }; reason: string };
	/** Ngăn xếp hoàn tác dùng chung ở lớp serve — xem BuocHoanTac. */
	hoanTac: BuocHoanTac[];
	/** Ảnh đính kèm lượt này (base64 + mimeType). Rỗng nếu không có. */
	anh: Array<{ data: string; mimeType?: string }>;
}

async function chayMotLuot(t: ThamSoLuot): Promise<ReadonlyArray<Message>> {
	// @file: gắn nội dung vào trước, giống hệt REPL.
	const { prompt, daChen, loi: loiChen } = await chenFile(t.text, t.goc);
	for (const f of daChen)
		phat({ type: "attached", path: f.duong, bytes: f.byte, truncated: f.bicat });
	for (const f of loiChen) phat({ type: "attach_error", path: f.duong, reason: f.lyDo });

	// Năng lực model quyết định có gửi tool không: gửi tool cho model không hỗ
	// trợ → Ollama 400 và AI SDK treo im. Hỏi trước, tắt tool nếu cần.
	const nangLuc = await layNangLuc(t.model);

	// CẦU NỐI VISION → CODER. Ảnh mà model chính không đọc được thì KHÔNG đổi cả
	// lượt sang model thị giác (nó không có công cụ, chỉ nói được chứ không dựng
	// được). Thay vào đó: model thị giác ĐỌC ảnh và mô tả thành chữ, rồi model
	// chính (có công cụ) dựng từ mô tả đó. Mắt một model, tay một model.
	let moTaAnhChen: string | null = null;
	let khongCoModelThiGiac = false;
	if (t.anh.length > 0 && !nangLuc.vision) {
		const mtg = await timModelThiGiac(t.cauHinh.visionModel);
		if (mtg) {
			phat({ type: "model_switched", from: t.model, to: mtg, reason: "image", tam: true });
			try {
				moTaAnhChen = await moTaAnh(mtg, prompt, t.anh);
			} catch (e) {
				phat({ type: "notice", level: "warn", message: `Doc anh that bai: ${String(e)}` });
			}
		} else {
			khongCoModelThiGiac = true;
		}
	}

	const harness = createHarness({
		model: t.model,
		tools: nangLuc.tools ? boToolMacDinh({ bashTimeoutMs: t.cauHinh.bashTimeoutMs }) : [],
		// Câu dẫn + CÂY THƯ MỤC THẬT (sinh lại mỗi lượt — rẻ, vài ms): không có nó
		// model bịa layout ước lệ (src/**) rồi dò mãi trong thư mục không tồn tại.
		systemPrompt: nangLuc.tools ? `${t.cauDan}\n\n${dungCayThuMuc(t.goc)}` : CAU_DAN_THI_GIAC,
		maxTurns: t.maxTurns,
		// Mặc định BẬT cho agent cục bộ (đo thật: parse 100%, code không tệ). Khai
		// structuredProtocol:false trong agent.json để tắt (vd cần stream token).
		structuredProtocol: t.cauHinh.structuredProtocol ?? true,
		// Cửa sổ THẬT của model — xem ghi chú cùng chỗ trong chat.ts.
		contextWindow: t.cauHinh.contextWindow,
		// Tham số bộ sinh — xem ghi chú cùng chỗ trong chat.ts.
		thamSoSinh: {
			temperature: t.cauHinh.temperature,
			topP: t.cauHinh.topP,
			repeatPenalty: t.cauHinh.repeatPenalty,
			seed: t.cauHinh.seed,
		},
		processSandbox: t.coLap,
		laLenhKiemTra,
		permissions: {
			mode: t.cheDoQuyen,
			rules: [
				...LUAT_NGUY_HIEM,
				{ pattern: "FileRead(*)", behavior: "allow", source: "project", priority: 50 },
				{ pattern: "Grep(*)", behavior: "allow", source: "project", priority: 50 },
				{ pattern: "Glob(*)", behavior: "allow", source: "project", priority: 50 },
				{ pattern: "LoadSkill(*)", behavior: "allow", source: "project", priority: 50 },
				// Hai tool chỉ đụng bộ nhớ phiên, không chạm máy — hỏi quyền cho
				// chúng là bắt người dùng bấm nút vô nghĩa.
				{ pattern: "ScheduleTask(*)", behavior: "allow", source: "project", priority: 50 },
				{ pattern: "TodoWrite(*)", behavior: "allow", source: "project", priority: 50 },
				// Ưu tiên 45: cao hơn luật dự án nhưng THẤP HƠN luật chặn cứng (100),
				// nên "Luôn cho phép Bash" vẫn không mở được rm -rf, sudo, ghi .env.
				...[...t.luonChoPhep].map((ten) => ({
					pattern: `${ten}(*)`,
					behavior: "allow" as const,
					source: "user" as const,
					priority: 45,
					message: "nguoi dung da chon Luon cho phep",
				})),
				...(t.cauHinh.rules ?? []).map((r: LuatQuyen) => ({
					pattern: r.pattern,
					behavior: r.behavior,
					source: "project" as const,
					priority: 40,
					message: r.message,
				})),
			],
			failMode: "closed",
		},
		// Xin quyền: phát ra editor rồi CHỜ. Editor vẽ nút, người dùng bấm.
		onAsk: async (toolName, toolInput, message) => {
			const id = t.layId();
			// Với tool ghi file thì gửi kèm diff — editor hiện được ngay, khỏi
			// bắt người dùng duyệt mù như bản CLI đầu tiên.
			const diff = await dungDiff(toolName, toolInput, t.goc).catch(() => null);

			phat({
				type: "permission_request",
				id,
				tool: toolName,
				input: toolInput,
				message,
				diff: diff?.text
					? { text: diff.text, added: diff.them, removed: diff.bot, isNew: diff.taoMoi }
					: null,
			});

			// Bấm giờ đúng khoảng người dùng suy nghĩ, để trừ ra khỏi "tổng".
			const batDauCho = Date.now();
			return new Promise((resolve) =>
				t.dangCho.set(id, (kq) => {
					t.dongHoChoNguoi.ms += Date.now() - batDauCho;
					resolve(kq);
				}),
			);
		},
	});

	// Rule luôn nạp; skill chỉ khi model hỗ trợ tool — nếu không, LoadSkill vẫn
	// được gửi và Ollama trả 400 "does not support tools".
	await napTriThuc(harness.inner, {
		goc: t.goc,
		cauHinh: t.cauHinh,
		boQuaSkill: !nangLuc.tools,
		lichHen: t.lichHen,
		soTayViec: t.soTayViec,
		layLuot: () => t.soLuot,
		quiet: true,
	});
	t.datDangChay(harness);

	// Không tin lời model tuyên bố "đã kiểm tra" — QUAN SÁT xem nó có thật sự
	// chạy lệnh kiểm tra không, VÀ lệnh đó kết luận ra sao.
	const daSua = new Set<string>();
	// Có thao tác GHI FILE bị từ chối/lỗi trong lượt không — để chốt "báo xong mà chưa ghi".
	let ghiHong = false;
	const kiemTra = new TheoDoiKiemTra();
	// Chụp chờ commit, theo toolUseId: chỉ đẩy vào ngăn hoàn tác khi tool xong.
	const choChup = new Map<string, BuocHoanTac>();

	// Đo hiệu năng thật: với model cục bộ, tok/s và thời gian chờ token đầu là
	// hai con số quyết định "dùng được hay không", và chúng đổi theo ngữ cảnh.
	const batDau = Date.now();
	// Bộ đo tách theo TỪNG lượt gọi LLM — xem do-hieu-nang.ts. Sửa bug tok/s nổ
	// (đo được 517 tok/s cho model thực ~40) khi model nhả tool-call lớn: nội dung
	// tool-call không đi qua textStream nên bản cũ không tính thời gian sinh đó.
	const doHieu = new DoHieuNang(batDau);

	try {
		// Có ảnh thì gửi prompt nhiều khối cho model thị giác; không thì chuỗi như cũ.
		// Ba đường tuỳ theo ảnh và năng lực model:
		let dauVao: string | ContentBlock[] = prompt;
		if (moTaAnhChen) {
			// Đã có mô tả ảnh từ model thị giác: đưa cho coder dạng CHỮ (không kèm
			// ảnh, vì coder mù ảnh). Giờ coder có công cụ + mô tả → dựng được.
			dauVao = `${prompt}

[Nội dung ảnh người dùng gửi — model thị giác đọc và mô tả lại]:
${moTaAnhChen}`;
		} else if (t.anh.length > 0 && nangLuc.vision) {
			// Model chính tự đọc được ảnh: gửi thẳng ảnh cho nó.
			const khoiAnh: ContentBlock[] = t.anh.map((a) => ({
				type: "image",
				image: a.data,
				mimeType: a.mimeType,
			}));
			dauVao = [{ type: "text", text: prompt }, ...khoiAnh];
		} else if (khongCoModelThiGiac) {
			// Không có model thị giác nào đã cài — bỏ ảnh, chạy phần chữ. Cảnh báo vàng.
			phat({
				type: "notice",
				level: "warn",
				message:
					"Chua co model thi giac nao da cai nen khong doc duoc anh — da bo qua anh. Cai qwen2.5vl (ollama pull qwen2.5vl:3b khi con mang) roi gui lai.",
			});
		}
		const gen = harness.stream(dauVao, {
			maxTurns: t.maxTurns,
			// Phanh duy nhất còn hiệu lực với model cục bộ — xem `maxDurationMs`.
			timeoutMs: t.cauHinh.maxDurationMs,
			initialMessages: t.lichSu,
		});
		for (;;) {
			const { value, done } = await gen.next();
			if (done) {
				const dung = harness.getUsage();
				const hieu = doHieu.chot(Date.now(), dung.outputTokens, t.dongHoChoNguoi.ms);
				t.ketQua.usage = dung;
				t.ketQua.reason = value.reason;
				phat({
					type: "turn_end",
					reason: value.reason,
					usage: dung,
					context: harness.inner.getContextUsage(),
					edited: [...daSua],
					ranCheck: kiemTra.daKiemChung,
					checkOutcome: kiemTra.ketCuc,
					perf: hieu,
				});
				// Chốt "báo xanh mà sai" đúng ca hay gặp: model kết thúc, có lệnh ghi
				// file bị từ chối/lỗi, mà KHÔNG file nào được ghi → nếu nó nói "đã
				// tạo file" thì đang bịa. Cảnh báo phản bác ngay để người dùng khỏi tin.
				if (value.reason === "max_turns") {
					phat({
						type: "notice",
						level: "warn",
						message: `⚠ Chạm trần ${t.maxTurns} lượt tool — agent buộc dừng. Việc có thể CHƯA xong; đọc phần tóm tắt cuối ở trên (đã làm gì / còn thiếu gì) rồi chia nhỏ yêu cầu cho bước kế.`,
					});
				}
				if (value.reason === "loop") {
					phat({
						type: "notice",
						level: "warn",
						message:
							"⚠ Agent bị KẸT LẶP (gọi cùng một lệnh nhiều lần vô ích) nên đã tự dừng. CHƯA hoàn thành — thử chia nhỏ yêu cầu, nói rõ bước tiếp theo, hoặc đổi cách hỏi.",
					});
				}
				if (ghiHong && daSua.size === 0) {
					phat({
						type: "notice",
						level: "warn",
						message:
							"⚠ Lượt này có lệnh GHI FILE không thành (bị guard an toàn chặn, lỗi, hoặc từ chối quyền) và KHÔNG file nào được ghi. Model nói đã tạo/ghi file = SAI — kiểm lại trước khi tin.",
					});
				}
				break;
			}
			if (value.type === "llm:request_start") {
				doHieu.moLoiGoi(Date.now());
			}
			if (value.type === "llm:stream_delta") {
				const ms = doHieu.moDelta(Date.now());
				if (ms !== null) phat({ type: "first_token", afterMs: ms });
			}
			if (value.type === "llm:stream_end") {
				doHieu.dongLoiGoi(Date.now());
			}
			if (value.type === "tool:requested") {
				doHieu.themTool();
				const vao = value.toolInput as Record<string, unknown>;
				const duongVao = vao.path ?? vao.file ?? vao.file_path ?? vao.filename;
				if (
					(value.toolName === "FileEdit" || value.toolName === "FileWrite") &&
					typeof duongVao === "string"
				) {
					// KHÔNG đếm "đã sửa" ở đây — tool có thể bị TỪ CHỐI quyền hoặc
					// lỗi. Chỉ tính khi tool:completed (thành công thật). Trước đây
					// đếm sớm nên write bị denied vẫn báo "đã sửa 1 file".
					// Chụp nội dung TRƯỚC khi tool chạy. Sự kiện này được phát trước
					// lúc thực thi (generator kéo — chưa gọi next() thì tool chưa
					// chạy), nên đọc ở đây là bản gốc. Giữ theo toolUseId, chỉ đưa
					// vào ngăn hoàn tác khi tool báo thành công.
					const abs = resolve(t.goc, duongVao);
					const truocDo = await readFile(abs, "utf-8").catch(() => null);
					choChup.set(value.toolUseId, { path: duongVao, truocDo });
				}
				kiemTra.yeuCau(value.toolName, value.toolInput, value.toolUseId);
			}
			// Lệnh gửi đi chưa nói lên điều gì — kết luận nằm ở mã thoát.
			if (value.type === "tool:completed") {
				kiemTra.hoanTat(value.toolUseId, value.result);
				const chup = choChup.get(value.toolUseId);
				if (chup) {
					choChup.delete(value.toolUseId);
					t.hoanTac.push(chup);
					daSua.add(chup.path); // chỉ tính "đã sửa" khi tool GHI XONG thật
				}
			}
			if (value.type === "tool:failed") {
				kiemTra.thatBai(value.toolUseId);
				if (choChup.has(value.toolUseId)) ghiHong = true; // ghi file mà LỖI
				choChup.delete(value.toolUseId); // tool hỏng thì không có gì để hoàn tác
			}
			if (
				value.type === "permission:denied" &&
				(value.toolName === "FileWrite" || value.toolName === "FileEdit")
			) {
				ghiHong = true; // ghi file bị TỪ CHỐI quyền
			}
			chuyenSuKien(value);
		}
	} catch (err) {
		phat({ type: "error", message: err instanceof Error ? err.message : String(err) });
	}

	return harness.inner.getMessages();
}

/** Đổi sự kiện nội bộ thành thông điệp giao thức. Chỉ phát thứ editor cần. */
function chuyenSuKien(e: InnerEvent): void {
	switch (e.type) {
		case "llm:stream_delta":
			phat({ type: "delta", text: e.delta });
			break;
		case "llm:text_corrected":
			// Chữ vừa in hoá ra là tool-call dạng văn bản — bảo giao diện thay thế.
			phat({ type: "text_corrected", text: e.text });
			break;
		case "tool:requested":
			phat({ type: "tool", id: e.toolUseId, name: e.toolName, input: e.toolInput });
			break;
		case "tool:completed":
			phat({
				type: "tool_result",
				id: e.toolUseId,
				ok: true,
				durationMs: e.durationMs,
				preview: String(typeof e.result === "string" ? e.result : JSON.stringify(e.result)).slice(
					0,
					2000,
				),
			});
			break;
		case "tool:failed":
			phat({
				type: "tool_result",
				id: e.toolUseId,
				ok: false,
				durationMs: e.durationMs,
				preview: e.error,
			});
			break;
		case "permission:denied":
			phat({ type: "denied", tool: e.toolName, reason: e.reason });
			break;
		case "context:usage":
			phat({ type: "context", used: e.usedTokens, max: e.maxTokens });
			break;
		case "context:compacted":
			phat({ type: "compacted", freedTokens: e.freedTokens, strategy: e.strategy ?? null });
			break;
		case "recovery:retry":
			phat({ type: "recovered", reason: e.reason });
			break;
		case "context:reminder":
			// Kiểm toán được việc bơm rule/bộ nhớ. Dùng `notice` sẵn có nên
			// editor bản cũ vẫn hiện được, không cần đổi giao thức.
			phat({
				type: "notice",
				level: "info",
				message: `ⓘ đã bơm ${e.loai.join(", ")} (${e.bytes} byte)`,
			});
			break;
		case "error":
			// Lỗi gọi LLM đi qua đây — chỗ dev hay gặp Ollama chưa chạy nhất.
			phatLoi(e.error);
			break;
		default:
			break;
	}
}
