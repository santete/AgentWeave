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
import { redactSecrets, terminalAskPrompt } from "../lib/terminal-ask.js";

export interface ChatCommandArgs {
	model: string;
	budget?: number;
	maxTurns?: number;
	permissionMode?: "default" | "strict" | "permissive" | "plan";
	/** Câu hỏi đầu tiên, tuỳ chọn — không có thì vào thẳng dấu nhắc. */
	prompt?: string;
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
	let lichSu: ReadonlyArray<Message> = [];
	let tongVao = 0;
	let tongRa = 0;
	let soLuot = 0;

	inHeader(args);

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

		const harness = createHarness(taoCauHinh(args));
		// Skill: chỉ mục vào system prompt + tool LoadSkill, nạp lại mỗi lượt để
		// skill thêm giữa chừng có hiệu lực ngay.
		await installSkills(harness.inner, { quiet: true }).catch(() => undefined);
		dangChay = harness;

		try {
			const gen = harness.stream(cau, {
				maxTurns: args.maxTurns,
				maxBudgetUsd: args.budget,
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

		console.log(
			`  ${C.gray}${lichSu.length} tin nhắn · ${tongVao.toLocaleString()} vào / ` +
				`${tongRa.toLocaleString()} ra${C.reset}`,
		);
		console.log("");
		rl.prompt();
	}

	if (!thoat) console.log("");
	rl.close();
	console.log(`  ${C.dim}${soLuot} lượt · ${tongVao.toLocaleString()} vào / ${tongRa.toLocaleString()} ra${C.reset}`);
}

// ─── Cấu hình ───────────────────────────────────────────────────

function taoCauHinh(args: ChatCommandArgs): CreateHarnessOptions {
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

		default:
			console.log(`  ${C.dim}Lệnh: /moi (xoá hội thoại) · /trangthai · /thoat${C.reset}\n`);
			return "tiep";
	}
}

// ─── Hiển thị ───────────────────────────────────────────────────

function inHeader(args: ChatCommandArgs): void {
	console.log("");
	console.log(`  ${C.cyan}${C.bold}AgentWeave chat${C.reset} ${C.dim}v${AGENTWEAVE_VERSION}${C.reset}`);
	console.log(
		`  ${C.dim}${args.model} · quyền: ${args.permissionMode ?? "default"} · ${process.cwd()}${C.reset}`,
	);
	console.log(`  ${C.dim}/moi xoá hội thoại · /trangthai · /thoat · Ctrl-C dừng lượt${C.reset}`);
	console.log("");
}

function inSuKien(e: InnerEvent): void {
	switch (e.type) {
		case "tool:requested":
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

		case "message:assistant":
			for (const block of e.content) {
				if (block.type === "text" && block.text.trim()) {
					console.log("");
					console.log(`${block.text.trim()}`);
					console.log("");
				}
			}
			break;

		case "error":
			console.log(`  ${C.red}✗ ${e.error}${C.reset}`);
			break;

		default:
			break;
	}
}
