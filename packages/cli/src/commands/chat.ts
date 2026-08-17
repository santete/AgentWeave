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
import { createHarness } from "@agentweave/sdk";
import { BUILT_IN_TOOLS, installSkills } from "@agentweave/inner-harness";
import { AGENTWEAVE_VERSION } from "@agentweave/types";
import type { CreateHarnessOptions, HarnessInstance } from "@agentweave/sdk";
import type { InnerEvent, Message } from "@agentweave/types";
import type { CauHinhAgent, LuatQuyen } from "../lib/agent-config.js";
import { redactSecrets, terminalAskPrompt } from "../lib/terminal-ask.js";
import { chenFile } from "../lib/at-file.js";
import { docCauHinhAgent } from "../lib/agent-config.js";
import {
	docPhien,
	lietKePhien,
	luuPhien,
	phienGanNhat,
	taoIdPhien,
	type PhienLuu,
} from "../lib/session-store.js";

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
		console.log(`  ${C.bold}${p.id}${C.reset}  ${C.dim}${luc} · ${p.soLuot} lượt · ${p.model}${C.reset}`);
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

	let lichSu: ReadonlyArray<Message> = [];
	let tongVao = 0;
	let tongRa = 0;
	let soLuot = 0;
	let idPhien = taoIdPhien(new Date());
	let tomTat = "";

	// ── Khôi phục phiên cũ ──
	if (args.resume) {
		const cu =
			typeof args.resume === "string"
				? await docPhien(goc, args.resume)
				: await phienGanNhat(goc);

		if (cu) {
			lichSu = cu.messages;
			tongVao = cu.tokenVao;
			tongRa = cu.tokenRa;
			soLuot = cu.soLuot;
			idPhien = cu.id;
			tomTat = cu.tomTat;
			console.log(`  ${C.green}↻ tiếp tục phiên ${cu.id}${C.reset} ${C.dim}— ${cu.tomTat}${C.reset}`);
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

	/** Câu hỏi mở đầu (nếu có) rồi tới từng dòng người dùng gõ. */
	async function* nguonDong(): AsyncGenerator<string> {
		if (args.prompt) yield args.prompt;
		else rl.prompt();
		for await (const l of rl) yield l;
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

		const harness = createHarness(taoCauHinh(hieuLuc, cauHinh));
		// Skill: chỉ mục vào system prompt + tool LoadSkill, nạp lại mỗi lượt để
		// skill thêm giữa chừng có hiệu lực ngay.
		await installSkills(harness.inner, {
			quiet: true,
			orgSkillsDir: cauHinh.orgSkillsDir,
		}).catch(() => undefined);
		dangChay = harness;

		try {
			const gen = harness.stream(cauDayDu, {
				maxTurns: hieuLuc.maxTurns,
				maxBudgetUsd: hieuLuc.budget,
				initialMessages: lichSu,
			});

			for (;;) {
				const { value, done } = await gen.next();
				if (done) {
					if (value.reason !== "completed") {
						console.log(`  ${C.yellow}⚠ kết thúc: ${value.reason}${C.reset}`);
					}
					break;
				}
				inSuKien(value);
			}
		} catch (err) {
			console.log(`  ${C.red}✗ lỗi: ${err instanceof Error ? err.message : String(err)}${C.reset}`);
		} finally {
			dangChay = null;
		}

		// Mang hội thoại sang lượt sau.
		lichSu = harness.inner.getMessages();
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

	if (!thoat) console.log("");
	rl.close();
	console.log(`  ${C.dim}${soLuot} lượt · ${tongVao.toLocaleString()} vào / ${tongRa.toLocaleString()} ra${C.reset}`);
}

// ─── Cấu hình ───────────────────────────────────────────────────

function taoCauHinh(args: ChatCommandArgs, duAn: CauHinhAgent = {}): CreateHarnessOptions {
	return {
		model: args.model,
		tools: BUILT_IN_TOOLS,
		maxTurns: args.maxTurns ?? 50,
		permissions: {
			mode: args.permissionMode ?? "default",
			rules: [
				{ pattern: "Bash(rm -rf *)", behavior: "deny", source: "policy", priority: 100, message: "Chan xoa huy diet" },
				{ pattern: "Bash(sudo *)", behavior: "deny", source: "policy", priority: 100, message: "Chan sudo" },
				{ pattern: "FileWrite(*.env)", behavior: "deny", source: "policy", priority: 100, message: "Khong ghi .env" },
				{ pattern: "FileRead(*)", behavior: "allow", source: "project", priority: 50 },
				{ pattern: "Grep(*)", behavior: "allow", source: "project", priority: 50 },
				{ pattern: "Glob(*)", behavior: "allow", source: "project", priority: 50 },
				{ pattern: "LoadSkill(*)", behavior: "allow", source: "project", priority: 50 },
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
			console.log(`  token:     ${nc.tongVao.toLocaleString()} vào / ${nc.tongRa.toLocaleString()} ra`);
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
	console.log(`  ${C.cyan}${C.bold}AgentWeave chat${C.reset} ${C.dim}v${AGENTWEAVE_VERSION}${C.reset}`);
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
			const xem =
				typeof e.result === "string" ? e.result : JSON.stringify(e.result);
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

		case "llm:stream_delta":
			// In thẳng, không xuống dòng: chữ chảy ra đúng nhịp model sinh.
			if (!dangChay_chu) {
				process.stdout.write("\n");
				dangChay_chu = true;
			}
			process.stdout.write(e.delta);
			break;

		case "message:assistant":
			// Nội dung đã chảy ra ở llm:stream_delta rồi, chỉ cần đóng đoạn.
			if (dangChay_chu) {
				process.stdout.write("\n\n");
				dangChay_chu = false;
			}
			break;

		case "error":
			console.log(`  ${C.red}✗ ${e.error}${C.reset}`);
			break;

		default:
			break;
	}
}
