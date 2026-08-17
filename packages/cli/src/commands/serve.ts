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
 *   {"type":"prompt","text":"..."}            gửi câu hỏi
 *   {"type":"permission","id":"..","allow":true,"alwaysAllow":false}
 *   {"type":"abort"}                          dừng lượt đang chạy
 *   {"type":"reset"}                          xoá hội thoại
 *
 * ── RA (stdout, mỗi dòng một JSON) ──
 *   {"type":"ready",...}                      sẵn sàng nhận việc
 *   {"type":"delta","text":"..."}             chữ model đang sinh
 *   {"type":"tool","id":"..","name":"..","input":{}}
 *   {"type":"tool_result","id":"..","ok":true,"preview":".."}
 *   {"type":"permission_request","id":"..","tool":"..","input":{},"diff":"..."}
 *   {"type":"turn_end","usage":{},"context":{}}
 *   {"type":"error","message":".."}
 *
 * MỌI thứ dành cho người đọc đều ra stderr, stdout CHỈ có JSON — nếu lẫn một
 * dòng chữ thường thì phía kia hỏng ngay mà rất khó truy.
 */

import { createInterface } from "node:readline";
import { createHarness } from "@agentweave/sdk";
import { BUILT_IN_TOOLS, installSkills } from "@agentweave/inner-harness";
import { AGENTWEAVE_VERSION } from "@agentweave/types";
import type { HarnessInstance } from "@agentweave/sdk";
import type { InnerEvent, Message } from "@agentweave/types";
import { docCauHinhAgent, type CauHinhAgent, type LuatQuyen } from "../lib/agent-config.js";
import { chenFile } from "../lib/at-file.js";
import { dungDiff } from "../lib/diff.js";

export interface ServeArgs {
	model: string;
	permissionMode?: "default" | "strict" | "permissive" | "plan";
	maxTurns?: number;
}

/** Ghi một sự kiện ra stdout. Một dòng, một JSON, không có gì khác. */
function phat(obj: Record<string, unknown>): void {
	process.stdout.write(`${JSON.stringify(obj)}\n`);
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
	// Giữ trong object: TypeScript không thu hẹp kiểu thuộc tính qua ranh giới
	// hàm, nên phép gán từ callback không làm nó tưởng biến luôn là null.
	const chay: { hien: HarnessInstance | null } = { hien: null };

	// Các lời xin quyền đang chờ editor trả lời.
	const dangCho = new Map<string, (kq: { allow: boolean; alwaysAllow?: boolean }) => void>();
	let demXinQuyen = 0;

	phat({
		type: "ready",
		version: AGENTWEAVE_VERSION,
		model,
		cwd: goc,
		permissionMode: cheDoQuyen,
		configSource: nguon,
	});

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
					traLoi({ allow: msg.allow === true, alwaysAllow: msg.alwaysAllow === true });
				}
				break;
			}

			case "abort":
				chay.hien?.abort("editor huy");
				break;

			case "reset":
				lichSu = [];
				phat({ type: "reset_ok" });
				break;

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
					phat({ type: "error", message: `khong lay duoc danh sach model: ${String(e)}` });
				}
				break;
			}

			case "prompt": {
				if (chay.hien) {
					phat({ type: "error", message: "dang chay mot luot khac, hay abort truoc" });
					break;
				}
				const text = String(msg.text ?? "");
				if (!text.trim()) break;

				// KHÔNG await ở đây. Vòng lặp này là chỗ DUY NHẤT đọc stdin; await
				// trọn lượt nghĩa là lời "permission" của editor không bao giờ đọc
				// tới, agent xin quyền rồi treo cho đến khi interceptor hết giờ.
				// Đã vấp đúng lỗi này: editor trả allow=true mà tool vẫn bị từ chối.
				void chayMotLuot({
					text,
					goc,
					model,
					cheDoQuyen,
					maxTurns,
					cauHinh,
					lichSu,
					dangCho,
					layId: () => `q${++demXinQuyen}`,
					datDangChay: (h) => {
						chay.hien = h;
					},
				})
					.then((ds) => {
						lichSu = ds;
					})
					.catch((e) => phat({ type: "error", message: String(e?.message ?? e) }))
					.finally(() => {
						chay.hien = null;
					});
				break;
			}

			default:
				phat({ type: "error", message: `khong hieu type="${String(msg.type)}"` });
		}
	}

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
	layId: () => string;
	datDangChay: (h: HarnessInstance | null) => void;
}

async function chayMotLuot(t: ThamSoLuot): Promise<ReadonlyArray<Message>> {
	// @file: gắn nội dung vào trước, giống hệt REPL.
	const { prompt, daChen, loi: loiChen } = await chenFile(t.text, t.goc);
	for (const f of daChen) phat({ type: "attached", path: f.duong, bytes: f.byte, truncated: f.bicat });
	for (const f of loiChen) phat({ type: "attach_error", path: f.duong, reason: f.lyDo });

	const harness = createHarness({
		model: t.model,
		tools: BUILT_IN_TOOLS,
		maxTurns: t.maxTurns,
		permissions: {
			mode: t.cheDoQuyen,
			rules: [
				{ pattern: "Bash(rm -rf *)", behavior: "deny", source: "policy", priority: 100, message: "Chan xoa huy diet" },
				{ pattern: "Bash(sudo *)", behavior: "deny", source: "policy", priority: 100, message: "Chan sudo" },
				{ pattern: "FileWrite(*.env)", behavior: "deny", source: "policy", priority: 100, message: "Khong ghi .env" },
				{ pattern: "FileRead(*)", behavior: "allow", source: "project", priority: 50 },
				{ pattern: "Grep(*)", behavior: "allow", source: "project", priority: 50 },
				{ pattern: "Glob(*)", behavior: "allow", source: "project", priority: 50 },
				{ pattern: "LoadSkill(*)", behavior: "allow", source: "project", priority: 50 },
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
				diff: diff?.text ? { text: diff.text, added: diff.them, removed: diff.bot, isNew: diff.taoMoi } : null,
			});

			return new Promise((resolve) => t.dangCho.set(id, resolve));
		},
	});

	await installSkills(harness.inner, {
		quiet: true,
		orgSkillsDir: t.cauHinh.orgSkillsDir,
	}).catch(() => undefined);
	t.datDangChay(harness);

	try {
		const gen = harness.stream(prompt, { maxTurns: t.maxTurns, initialMessages: t.lichSu });
		for (;;) {
			const { value, done } = await gen.next();
			if (done) {
				phat({
					type: "turn_end",
					reason: value.reason,
					usage: harness.getUsage(),
					context: harness.inner.getContextUsage(),
				});
				break;
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
				preview: String(typeof e.result === "string" ? e.result : JSON.stringify(e.result)).slice(0, 2000),
			});
			break;
		case "tool:failed":
			phat({ type: "tool_result", id: e.toolUseId, ok: false, durationMs: e.durationMs, preview: e.error });
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
		case "error":
			phat({ type: "error", message: e.error });
			break;
		default:
			break;
	}
}
