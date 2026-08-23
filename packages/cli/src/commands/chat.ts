/**
 * 'chat' — REPL tương tác cho reference agent-loop.
 *
 * Khác `agentweave run` (một phát một): giữ hội thoại qua nhiều lượt, sửa
 * hướng giữa chừng được, ngắt bằng Ctrl-C mà không mất phiên.
 *
 * Cơ chế: `AgentLoop.run()` chỉ gọi được MỘT LẦN mỗi thể hiện, nên mỗi lượt
 * dựng harness mới và mang lịch sử cũ sang qua `initialMessages`.
 */

import { createInterface } from "node:readline";
import {
	LichHen,
	SoTayViec,
	boToolMacDinh,
	laModelCucBo,
	locNhacGuard,
} from "@agentweave/inner-harness";
import { createHarness } from "@agentweave/sdk";
import type { CreateHarnessOptions, HarnessInstance } from "@agentweave/sdk";
import { AGENTWEAVE_VERSION, LOAI_DIEM_CHAM } from "@agentweave/types";
import type { InnerEvent, Message } from "@agentweave/types";
import type { ProcessSandboxBinding } from "@agentweave/types";
import type { CauHinhAgent, LuatQuyen } from "../lib/agent-config.js";
import { docCauHinhAgent } from "../lib/agent-config.js";
import { chenFile } from "../lib/at-file.js";
import { moTaLoi } from "../lib/chan-doan-loi.js";
import { dungCoLap } from "../lib/co-lap";
import { DoHieuNang } from "../lib/do-hieu-nang";
import { batDauDongHo } from "../lib/dong-ho-hen";
import { LUAT_NGUY_HIEM } from "../lib/luat-nguy-hiem.js";
import { napTriThuc } from "../lib/nap-tri-thuc";
import {
	type PhienLuu,
	docPhien,
	lietKePhien,
	luuPhien,
	phienGanNhat,
	taoIdPhien,
} from "../lib/session-store.js";
import { doanLenhKiemTra, dungCauDanHeThong } from "../lib/system-prompt.js";
import { redactSecrets, terminalAskPrompt } from "../lib/terminal-ask.js";
import { TheoDoiKiemTra, canhBaoKiemTra, laLenhKiemTra } from "../lib/theo-doi-kiem-tra.js";
import { GhiVetTichTep, batVetTich } from "../lib/vet-tich-tep.js";

export interface ChatCommandArgs {
	model: string;
	budget?: number;
	maxTurns?: number;
	permissionMode?: "default" | "strict" | "permissive" | "plan";
	/** Câu hỏi đầu tiên, tuỳ chọn — không có thì vào thẳng dấu nhắc. */
	prompt?: string;
	/** Tiếp tục phiên cũ: true = phiên gần nhất, chuỗi = id cụ thể. */
	resume?: boolean | string;
	/** Chỉ liệt kê phiên đã lưu rồi thoát. */
	listSessions?: boolean;
}

/** In danh sách phiên đã lưu. */
export async function lietKePhienCommand(): Promise<void> {
	const ds = await lietKePhien(process.cwd());
	if (ds.length === 0) {
		console.log(`\n  ${C.dim}Chưa có phiên nào được lưu trong .agentweave/sessions/${C.reset}\n`);
		return;
	}
	console.log(`\n  ${C.cyan}${C.bold}Phiên đã lưu${C.reset} ${C.dim}(mới nhất trước)${C.reset}\n`);
	for (const p of ds) {
		const luc = p.capNhat.slice(0, 16).replace("T", " ");
		console.log(
			`  ${C.bold}${p.id}${C.reset}  ${C.dim}${luc} · ${p.soLuot} lượt · ${p.model}${C.reset}`,
		);
		console.log(`    ${C.gray}${p.tomTat}${C.reset}`);
	}
	console.log(`\n  ${C.dim}Tiếp tục: agentweave chat --resume <id>${C.reset}\n`);
}

const C = {
	reset: "\x1b[0m",
	dim: "\x1b[2m",
	bold: "\x1b[1m",
	green: "\x1b[32m",
	red: "\x1b[31m",
	yellow: "\x1b[33m",
	cyan: "\x1b[36m",
	gray: "\x1b[90m",
	white: "\x1b[37m",
};

export async function chatCommand(args: ChatCommandArgs): Promise<void> {
	const goc = process.cwd();

	// Cấu hình dự án: cờ dòng lệnh luôn thắng.
	const { config: cauHinh, nguon, loi: loiCauHinh } = await docCauHinhAgent(goc);
	if (loiCauHinh) {
		// KHÔNG lặng lẽ rơi về mặc định — người dùng sẽ tưởng cấu hình đã có hiệu lực.
		console.log(`  ${C.red}✗ ${nguon} không dùng được: ${loiCauHinh}${C.reset}`);
		console.log(`  ${C.dim}đang chạy bằng cấu hình mặc định${C.reset}`);
	}
	const hieuLuc: ChatCommandArgs = {
		...args,
		model: args.model || cauHinh.model || "qwen3-coder:30b",
		maxTurns: args.maxTurns ?? cauHinh.maxTurns,
		budget: args.budget ?? cauHinh.budget,
		permissionMode: args.permissionMode ?? cauHinh.permissionMode,
	};

	// Câu dẫn hệ thống — REPL trước đây chạy với system prompt RỖNG, nên model
	// không biết phải chạy test sau khi sửa.
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

	// PHANH CHẾT: `budget` tính bằng USD, mà model cục bộ luôn được tính giá 0 —
	// ngưỡng không bao giờ chạm. Người vận hành đặt nó rồi tưởng đã có trần.
	// Nói thẳng và chỉ sang cái phanh thật sự đạp được.
	if (hieuLuc.budget !== undefined && laModelCucBo(hieuLuc.model)) {
		console.log(
			`  ${C.yellow}⚠ budget=$${hieuLuc.budget} KHÔNG có tác dụng với model cục bộ ` +
				`(giá luôn bằng 0). Dùng maxDurationMs trong .agentweave/agent.json để đặt trần thời gian.${C.reset}`,
		);
	}

	// Cô lập tầng nhân — chỉ khi .agentweave/agent.json bật tường minh.
	const coLap = await dungCoLap(goc, cauHinh);
	if (coLap.hong) {
		console.log(`  ${C.red}✗ ${coLap.thongBao}${C.reset}`);
		return;
	}
	if (coLap.thongBao) console.log(`  ${C.green}🔒 ${coLap.thongBao}${C.reset}`);

	let lichSu: ReadonlyArray<Message> = [];
	let tongVao = 0;
	let tongRa = 0;
	let soLuot = 0;
	let idPhien = taoIdPhien(new Date());
	let tomTat = "";

	// ── Vết tích ──
	// Đặt tên theo phiên đầu; `resume` đổi `idPhien` nhưng bộ ghi giữ nguyên chỗ
	// — một buổi mổ xẻ thường trải qua vài lần resume, cắt nhỏ ra thì mất chính
	// chỗ nối giữa chúng.
	const vetTich = batVetTich(cauHinh.vetTich)
		? new GhiVetTichTep({
				goc,
				phien: idPhien,
				nhatKy: (m) => console.log(`  ${C.yellow}⚠ ${m}${C.reset}`),
			})
		: undefined;
	if (vetTich) console.log(`  ${C.dim}vết tích: ${vetTich.duong}${C.reset}`);

	// ── Khôi phục phiên cũ ──
	if (args.resume) {
		const cu =
			typeof args.resume === "string" ? await docPhien(goc, args.resume) : await phienGanNhat(goc);

		if (cu) {
			lichSu = cu.messages;
			tongVao = cu.tokenVao;
			tongRa = cu.tokenRa;
			soLuot = cu.soLuot;
			idPhien = cu.id;
			tomTat = cu.tomTat;
			console.log(
				`  ${C.green}↻ tiếp tục phiên ${cu.id}${C.reset} ${C.dim}— ${cu.tomTat}${C.reset}`,
			);
			console.log(`  ${C.dim}${cu.messages.length} tin nhắn · ${cu.soLuot} lượt${C.reset}`);
		} else {
			console.log(`  ${C.yellow}⚠ không tìm thấy phiên để tiếp tục, bắt đầu phiên mới${C.reset}`);
		}
	}

	inHeader(hieuLuc, nguon);

	// terminal: chỉ bật khi có TTY thật. Bật nhầm với stdin dạng ống làm readline
	// đóng sớm rồi ném ERR_USE_AFTER_CLOSE ở lượt thứ hai.
	const rl = createInterface({
		input: process.stdin,
		output: process.stdout,
		terminal: process.stdin.isTTY === true,
	});
	rl.setPrompt(`${C.cyan}${C.bold}› ${C.reset}`);
	// Ctrl-C khi agent đang chạy: dừng lượt đó, KHÔNG thoát phiên.
	let dangChay: HarnessInstance | null = null;
	let daNhacThoat = false;
	rl.on("SIGINT", () => {
		if (dangChay) {
			dangChay.abort("nguoi dung ngat");
			console.log(`\n  ${C.yellow}⏹ đã dừng lượt này. Gõ tiếp hoặc /thoat để ra.${C.reset}`);
			return;
		}
		if (daNhacThoat) {
			rl.close();
			return;
		}
		daNhacThoat = true;
		console.log(`\n  ${C.dim}Ctrl-C lần nữa để thoát, hoặc gõ /thoat${C.reset}`);
		rl.prompt();
	});

	// ── Đồng hồ hẹn giờ ──
	// Nằm ở TIẾN TRÌNH CLI chứ không ở vòng lặp agent: agent chỉ sống trong một
	// lượt, còn hẹn "mỗi 5 phút" phải nhích cả lúc người dùng đang gõ. Xem
	// lib/dong-ho-hen.ts.
	// Sổ tay việc sống suốt phiên — model ghi kế hoạch vào đây, người dùng
	// nhìn vào đây để biết tiến độ.
	const soTayViec = new SoTayViec();
	const lichHen = new LichHen();
	const dongHo = batDauDongHo(lichHen, {
		khiDenHan: (v) => {
			// Nói RA vì sao agent tự chạy. Không nói thì người dùng thấy nó đột
			// nhiên làm việc gì đó và tưởng hỏng.
			console.log(`\n  ${C.cyan}⏰ đến hạn: ${v.id}${C.reset} ${C.dim}— ${v.viec}${C.reset}`);
		},
	});

	/**
	 * Câu hỏi mở đầu, rồi từng dòng người dùng gõ — XEN với việc đến hạn.
	 *
	 * Chạy đua giữa "người dùng gõ xong một dòng" và "có việc tới hạn". Promise
	 * đọc dòng được GIỮ LẠI giữa các vòng: gọi `next()` lần nữa khi lần trước
	 * chưa xong sẽ làm dòng người dùng gõ bị nuốt mất.
	 */
	async function* nguonDong(): AsyncGenerator<string> {
		if (args.prompt) yield args.prompt;
		else rl.prompt();

		const doc = rl[Symbol.asyncIterator]();
		let choDong: Promise<IteratorResult<string>> | null = null;

		for (;;) {
			// Việc đến hạn được rút TRƯỚC: nó đã chờ sẵn, không phải đợi thêm.
			const cho = dongHo.rutChoDoi();
			if (cho.length > 0) {
				for (const c of cho) yield c;
				continue;
			}

			if (!choDong) choDong = doc.next();
			const ai = await Promise.race([
				choDong.then((r) => ({ loai: "dong" as const, r })),
				dongHo.doiViec().then(() => ({ loai: "hen" as const })),
			]);

			if (ai.loai === "hen") continue; // vòng lại, rutChoDoi() sẽ trả việc
			choDong = null;
			if (ai.r.done) return;
			yield ai.r.value;
		}
	}

	let thoat = false;
	for await (const dong of nguonDong()) {
		const cau = dong.trim();
		if (cau === "") {
			rl.prompt();
			continue;
		}
		daNhacThoat = false;

		// ── Lệnh gạch chéo ──
		if (cau.startsWith("/")) {
			const xong = xuLyLenh(cau, {
				lichSu,
				datLichSu: (m) => {
					lichSu = m;
				},
				tongVao,
				tongRa,
				model: args.model,
			});
			if (xong === "thoat") {
				thoat = true;
				break;
			}
			rl.prompt();
			continue;
		}

		soLuot++;
		if (!tomTat) tomTat = cau.slice(0, 80);

		// @đường-dẫn → nội dung file được gắn thẳng vào câu hỏi, khỏi tốn một
		// lượt LLM chỉ để bảo model tự đọc.
		const { prompt: cauDayDu, daChen, loi: loiChen } = await chenFile(cau, goc);
		for (const f of daChen) {
			console.log(
				`  ${C.gray}📎 ${f.duong} (${f.byte} byte${f.bicat ? ", đã cắt" : ""})${C.reset}`,
			);
		}
		for (const f of loiChen) {
			console.log(`  ${C.yellow}⚠ @${f.duong}: ${f.lyDo}${C.reset}`);
		}

		// Hai điểm chạm RIÊNG, cố ý: câu người dùng GÕ, và câu host thật sự GỬI
		// vào agent sau khi chèn nội dung file. Gộp làm một thì mất đúng chỗ cần
		// soi — phần chữ agent nhận thêm mà người dùng không hề thấy.
		vetTich?.ghi({
			tang: "user",
			loai: LOAI_DIEM_CHAM.USER_CAU_HOI,
			chiTiet: { kyTu: cau.length, soLuot },
			noiDungLon: { "cau-hoi.txt": cau },
		});
		if (cauDayDu !== cau) {
			vetTich?.ghi({
				tang: "host",
				loai: LOAI_DIEM_CHAM.HOST_CAU_DAY_DU,
				chiTiet: {
					kyTu: cauDayDu.length,
					fileDaChen: daChen,
					themKyTu: cauDayDu.length - cau.length,
				},
				noiDungLon: { "cau-day-du.txt": cauDayDu },
			});
		}
		const harness = createHarness(taoCauHinh(hieuLuc, cauHinh, cauDan, coLap.binding, vetTich));
		// Rule + skill: rule vô điều kiện và chỉ mục skill vào system prompt, rule
		// và skill CÓ ĐIỀU KIỆN đăng ký làm nguồn nhắc để chỉ bơm khi model chạm
		// đúng đường dẫn. Nạp lại mỗi lượt để thứ thêm giữa chừng có hiệu lực ngay.
		await napTriThuc(harness.inner, {
			goc,
			cauHinh,
			lichHen,
			soTayViec,
			layLuot: () => soLuot,
			quiet: true,
		});
		dangChay = harness;

		try {
			const gen = harness.stream(cauDayDu, {
				maxTurns: hieuLuc.maxTurns,
				maxBudgetUsd: hieuLuc.budget,
				// Phanh duy nhất còn hiệu lực với model cục bộ — xem `maxDurationMs`.
				timeoutMs: cauHinh.maxDurationMs,
				initialMessages: lichSu,
			});

			// Quan sát thay vì tin lời: model 30B hay tuyên bố "test đều pass"
			// mà chưa chạy lệnh nào.
			const daSua = new Set<string>();
			const kiemTra = new TheoDoiKiemTra();
			const batDau = Date.now();
			// MỘT bộ đo duy nhất, dùng chung với serve. Bản trước chat.ts tự tính
			// tại chỗ bằng đúng công thức mà DoHieuNang sinh ra để thay thế:
			// mẫu số là "từ token chữ đầu tới HẾT LƯỢT" — tức là gộp cả thời gian
			// chạy tool vào thời gian sinh, nên tok/s thấp hẳn so với thực; và khi
			// lượt không có chữ nào (chỉ tool-call) thì mẫu số bằng 0.
			// Hai lệnh cùng một sản phẩm mà báo hai con số khác nhau là mất tin cậy.
			const doHieu = new DoHieuNang(batDau);

			for (;;) {
				const { value, done } = await gen.next();
				if (done) {
					vetTich?.ghi({
						tang: "host",
						loai: LOAI_DIEM_CHAM.HOST_CHOT_LUOT,
						chiTiet: {
							reason: value.reason,
							tokenVao: value.usage?.inputTokens,
							tokenRa: value.usage?.outputTokens,
							fileDaSua: [...daSua],
						},
					});
					if (value.reason !== "completed") {
						console.log(`  ${C.yellow}⚠ kết thúc: ${value.reason}${C.reset}`);
					}
					const canh = canhBaoKiemTra(kiemTra.ketCuc, daSua.size);
					if (canh) {
						console.log(`  ${C.yellow}⚠ ${canh}${C.reset}`);
						console.log(`  ${C.dim}file đã sửa: ${[...daSua].join(", ")}${C.reset}`);
					}
					const hieu = doHieu.chot(Date.now(), harness.getUsage().outputTokens, 0);
					const phanDo = [`${(hieu.totalMs / 1000).toFixed(1)}s`];
					if (hieu.ttftMs !== null) phanDo.push(`chờ ${(hieu.ttftMs / 1000).toFixed(1)}s`);
					if (hieu.tokPerSec !== null) phanDo.push(`${hieu.tokPerSec.toFixed(1)} tok/s`);
					if (hieu.toolCalls > 0) phanDo.push(`${hieu.toolCalls} tool`);
					console.log(`  ${C.gray}${phanDo.join(" · ")}${C.reset}`);
					break;
				}
				if (value.type === "llm:request_start") doHieu.moLoiGoi(Date.now());
				if (value.type === "llm:stream_delta") doHieu.moDelta(Date.now());
				if (value.type === "llm:stream_end") doHieu.dongLoiGoi(Date.now());
				if (value.type === "tool:requested") doHieu.themTool();
				if (value.type === "tool:requested") {
					const vao = value.toolInput as Record<string, unknown>;
					if (
						(value.toolName === "FileEdit" || value.toolName === "FileWrite") &&
						typeof vao.path === "string"
					) {
						daSua.add(vao.path);
					}
					kiemTra.yeuCau(value.toolName, value.toolInput, value.toolUseId);
				}
				// Lệnh gửi đi chưa nói lên điều gì — kết luận nằm ở mã thoát.
				if (value.type === "tool:completed") kiemTra.hoanTat(value.toolUseId, value.result);
				if (value.type === "tool:failed") kiemTra.thatBai(value.toolUseId);
				inSuKien(value);
			}
		} catch (err) {
			console.log(
				`  ${C.red}✗ ${moTaLoi(err instanceof Error ? err.message : String(err)).replace(/\n/g, `\n  ${C.red}`)}${C.reset}`,
			);
		} finally {
			dangChay = null;
		}

		// Mang hội thoại sang lượt sau — BỎ nhắc guard.
		//
		// Nhắc guard là chữ điều khiển của đúng một lượt (xem `NHAN_NHAC_GUARD`).
		// Giữ lại thì nó vừa được lưu vĩnh viễn vào tệp phiên, vừa được replay ở
		// mọi câu sau: transcript model đọc phân kỳ khỏi transcript người dùng
		// thấy, và người vận hành gỡ rối trên một bản không phải bản model đã đọc.
		lichSu = locNhacGuard(harness.inner.getMessages());
		const dung = harness.getUsage();
		tongVao += dung.inputTokens;
		tongRa += dung.outputTokens;

		// Ghi phiên sau MỖI lượt, không đợi lúc thoát: máy sập hay đóng terminal
		// giữa chừng thì vẫn còn nguyên tới lượt cuối cùng.
		const phien: PhienLuu = {
			id: idPhien,
			capNhat: new Date().toISOString(),
			model: hieuLuc.model,
			cwd: goc,
			tomTat,
			soLuot,
			tokenVao: tongVao,
			tokenRa: tongRa,
			messages: [...lichSu],
		};
		await luuPhien(goc, phien).catch((e) =>
			console.log(`  ${C.yellow}⚠ không lưu được phiên: ${(e as Error).message}${C.reset}`),
		);

		console.log(
			`  ${C.gray}${lichSu.length} tin nhắn · ${tongVao.toLocaleString()} vào / ` +
				`${tongRa.toLocaleString()} ra · phiên ${idPhien}${C.reset}`,
		);
		console.log("");
		rl.prompt();
	}

	// Dừng đồng hồ TRƯỚC khi đóng readline: nếu không, `nguonDong()` có thể còn
	// treo ở `doiViec()` và tiến trình không thoát.
	dongHo.dung();
	if (!thoat) console.log("");
	rl.close();
	console.log(
		`  ${C.dim}${soLuot} lượt · ${tongVao.toLocaleString()} vào / ${tongRa.toLocaleString()} ra${C.reset}`,
	);
}

// ─── Cấu hình ───────────────────────────────────────────────────

function taoCauHinh(
	args: ChatCommandArgs,
	duAn: CauHinhAgent = {},
	cauDan = "",
	processSandbox?: ProcessSandboxBinding,
	vetTich?: GhiVetTichTep,
): CreateHarnessOptions {
	return {
		model: args.model,
		tools: boToolMacDinh({ bashTimeoutMs: duAn.bashTimeoutMs }),
		systemPrompt: cauDan,
		maxTurns: args.maxTurns ?? 400,
		structuredProtocol: duAn.structuredProtocol ?? true,
		// Cửa sổ THẬT của model. Thiếu dòng này thì AgentLoop suy ra 65.536 cho
		// mọi model, và model 32K sẽ tràn ngữ cảnh mà không báo gì.
		contextWindow: duAn.contextWindow,
		// Tham số bộ sinh. Bỏ trống trường nào thì không gửi trường đó — mặc định
		// của model thắng, đừng ghi đè Modelfile bằng một con số mặc nhiên.
		thamSoSinh: {
			temperature: duAn.temperature,
			topP: duAn.topP,
			repeatPenalty: duAn.repeatPenalty,
			seed: duAn.seed,
		},
		processSandbox,
		vetTich,
		laLenhKiemTra,
		permissions: {
			mode: args.permissionMode ?? "default",
			rules: [
				...LUAT_NGUY_HIEM,
				{ pattern: "FileRead(*)", behavior: "allow", source: "project", priority: 50 },
				{ pattern: "Grep(*)", behavior: "allow", source: "project", priority: 50 },
				{ pattern: "Glob(*)", behavior: "allow", source: "project", priority: 50 },
				{ pattern: "LoadSkill(*)", behavior: "allow", source: "project", priority: 50 },
				// Hẹn giờ chỉ sống trong phiên, không ghi đĩa, không đụng gì bên ngoài.
				{ pattern: "ScheduleTask(*)", behavior: "allow", source: "project", priority: 50 },
				// Danh sách việc chỉ nằm trong bộ nhớ phiên — hỏi quyền cho nó là
				// bắt người dùng bấm nút cho một việc không đụng gì tới máy.
				{ pattern: "TodoWrite(*)", behavior: "allow", source: "project", priority: 50 },
				{ pattern: "Bash(ls *)", behavior: "allow", source: "project", priority: 50 },
				{ pattern: "Bash(cat *)", behavior: "allow", source: "project", priority: 50 },
				{ pattern: "Bash(git status*)", behavior: "allow", source: "project", priority: 50 },
				{ pattern: "Bash(git diff*)", behavior: "allow", source: "project", priority: 50 },
				// Luật của dự án: ưu tiên 40 — thấp hơn luật chặn cứng ở trên, nên
				// .agentweave/agent.json KHÔNG mở được rm -rf hay sudo.
				...(duAn.rules ?? []).map((r: LuatQuyen) => ({
					pattern: r.pattern,
					behavior: r.behavior,
					source: "project" as const,
					priority: 40,
					message: r.message,
				})),
			],
			failMode: "closed",
		},
		output: {
			gateMode: "batch",
			filters: [
				{ type: "secret", name: "secrets", patterns: [], replacement: "[SECRET]" },
				{ type: "pii", name: "pii", entities: ["email", "ssn"], replacement: "[PII]" },
			],
		},
		budget: { maxPerSession: args.budget, warningThreshold: 0.8 },
		onAsk: terminalAskPrompt,
	};
}

// ─── Lệnh gạch chéo ─────────────────────────────────────────────

interface NguCanhLenh {
	lichSu: ReadonlyArray<Message>;
	datLichSu: (m: ReadonlyArray<Message>) => void;
	tongVao: number;
	tongRa: number;
	model: string;
}

function xuLyLenh(cau: string, nc: NguCanhLenh): "thoat" | "tiep" {
	const [lenh] = cau.slice(1).split(/\s+/);

	switch (lenh) {
		case "thoat":
		case "quit":
		case "exit":
			return "thoat";

		case "moi":
		case "clear":
			nc.datLichSu([]);
			console.log(`  ${C.green}✓ đã xoá hội thoại, bắt đầu lại${C.reset}\n`);
			return "tiep";

		case "trangthai":
		case "status":
			console.log(`  model:     ${nc.model}`);
			console.log(`  tin nhắn:  ${nc.lichSu.length}`);
			console.log(
				`  token:     ${nc.tongVao.toLocaleString()} vào / ${nc.tongRa.toLocaleString()} ra`,
			);
			console.log(`  thư mục:   ${process.cwd()}\n`);
			return "tiep";

		case "phien":
		case "sessions":
			// In đồng bộ ở đây không được (hàm này không async), nên chỉ nhắc lệnh.
			console.log(`  ${C.dim}Xem danh sách: agentweave chat --list-sessions${C.reset}`);
			console.log(`  ${C.dim}Tiếp tục:      agentweave chat --resume [id]${C.reset}\n`);
			return "tiep";

		default:
			console.log(
				`  ${C.dim}Lệnh: /moi · /trangthai · /phien · /thoat · @đường-dẫn để chèn file${C.reset}\n`,
			);
			return "tiep";
	}
}

// ─── Hiển thị ───────────────────────────────────────────────────

function inHeader(args: ChatCommandArgs, nguonCauHinh?: string | null): void {
	console.log("");
	console.log(
		`  ${C.cyan}${C.bold}AgentWeave chat${C.reset} ${C.dim}v${AGENTWEAVE_VERSION}${C.reset}`,
	);
	console.log(
		`  ${C.dim}${args.model} · quyền: ${args.permissionMode ?? "default"} · ${process.cwd()}${C.reset}`,
	);
	if (nguonCauHinh) console.log(`  ${C.dim}cấu hình: ${nguonCauHinh}${C.reset}`);
	console.log(
		`  ${C.dim}/moi · /trangthai · /phien · /thoat · @file để chèn · Ctrl-C dừng lượt${C.reset}`,
	);
	console.log("");
}

/** Đang ở giữa một đoạn chữ đang chảy — để biết khi nào cần xuống dòng. */
let dangChay_chu = false;

function inSuKien(e: InnerEvent): void {
	switch (e.type) {
		case "tool:requested":
			if (dangChay_chu) {
				process.stdout.write("\n");
				dangChay_chu = false;
			}
			console.log(
				`  ${C.yellow}⚡${C.reset} ${C.bold}${e.toolName}${C.reset} ` +
					`${C.dim}${redactSecrets(JSON.stringify(e.toolInput)).slice(0, 90)}${C.reset}`,
			);
			break;

		case "permission:denied":
			console.log(`  ${C.red}  ✗ từ chối${C.reset} — ${e.reason}`);
			break;

		case "tool:completed": {
			const xem = typeof e.result === "string" ? e.result : JSON.stringify(e.result);
			const dong = xem.split("\n").filter((l) => l.trim());
			console.log(
				`  ${C.green}  ✓${C.reset} ${C.dim}${e.durationMs.toFixed(0)}ms · ` +
					`${dong[0]?.slice(0, 100) ?? ""}${dong.length > 1 ? ` … +${dong.length - 1} dòng` : ""}${C.reset}`,
			);
			break;
		}

		case "tool:failed":
			console.log(`  ${C.red}  ✗${C.reset} ${e.error.slice(0, 160)}`);
			break;

		case "recovery:retry":
			// Cứu tool-call dạng chữ — hiện ra để biết model đang lệch khuôn.
			console.log(`  ${C.gray}  ↻ ${e.reason}${C.reset}`);
			break;

		case "context:reminder":
			// Chữ bơm ngầm mà không có dấu vết là thứ khó gỡ rối nhất: model đột
			// nhiên đổi hành vi và không ai truy được vì sao. Hiện một dòng mờ,
			// gọn — đủ để đối chiếu khi cần, không đủ để gây nhiễu.
			console.log(`  ${C.gray}  ⓘ đã bơm ${e.loai.join(", ")} (${e.bytes} byte)${C.reset}`);
			break;

		case "llm:stream_delta":
			// In thẳng, không xuống dòng: chữ chảy ra đúng nhịp model sinh.
			if (!dangChay_chu) {
				process.stdout.write("\n");
				dangChay_chu = true;
			}
			process.stdout.write(e.delta);
			break;

		case "llm:text_corrected":
			// Terminal không xoá lại được chữ đã in, nên chỉ nói rõ phần vừa hiện
			// là tool-call chứ không phải câu trả lời — thà thừa một dòng còn hơn
			// để người đọc tưởng model nói năng lộn xộn.
			if (dangChay_chu) {
				process.stdout.write(
					`\n  ${C.gray}↑ phần trên là tool-call model viết dạng chữ, không phải câu trả lời${C.reset}\n`,
				);
				dangChay_chu = false;
			}
			if (e.text.trim()) console.log(e.text.trim());
			break;

		case "message:assistant":
			// Nội dung đã chảy ra ở llm:stream_delta rồi, chỉ cần đóng đoạn.
			if (dangChay_chu) {
				process.stdout.write("\n\n");
				dangChay_chu = false;
			}
			break;

		case "error":
			// Dịch lỗi hạ tầng (Ollama chưa chạy…) thành chỉ dẫn sửa được.
			console.log(`  ${C.red}✗ ${moTaLoi(e.error).replace(/\n/g, `\n  ${C.red}`)}${C.reset}`);
			break;

		default:
			break;
	}
}
