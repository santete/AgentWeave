/**
 * Cầu nối tới `agentweave serve --stdio`.
 *
 * Extension KHÔNG nhúng SDK: gói bàn giao air-gap đã mang sẵn một bản
 * AgentWeave cài đặt hoàn chỉnh, nhúng lại thành hai bản hai cấu hình. Ở đây
 * chỉ sinh tiến trình con và nói chuyện bằng JSON dòng.
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface, type Interface } from "node:readline";
import { EventEmitter } from "node:events";

export interface DiffTomTat {
	text: string;
	added: number;
	removed: number;
	isNew: boolean;
}

/** Thông điệp từ agent gửi lên. Khớp giao thức trong packages/cli/src/commands/serve.ts. */
export type SuKienAgent =
	| { type: "ready"; version: string; model: string; cwd: string; permissionMode: string; configSource: string | null }
	| { type: "delta"; text: string }
	| { type: "tool"; id: string; name: string; input: Record<string, unknown> }
	| { type: "tool_result"; id: string; ok: boolean; durationMs: number; preview: string }
	| { type: "permission_request"; id: string; tool: string; input: Record<string, unknown>; message: string; diff: DiffTomTat | null }
	| { type: "denied"; tool: string; reason: string }
	| { type: "attached"; path: string; bytes: number; truncated: boolean }
	| { type: "attach_error"; path: string; reason: string }
	| { type: "context"; used: number; max: number }
	| { type: "compacted"; freedTokens: number; strategy: string | null }
	| { type: "recovered"; reason: string }
	| { type: "turn_end"; reason: string; usage: { inputTokens: number; outputTokens: number }; context: unknown }
	| { type: "reset_ok" }
	| { type: "error"; message: string };

export interface TuyChonAgent {
	cliPath: string;
	cwd: string;
	model: string;
	permissionMode: string;
	ollamaHost: string;
}

export class AgentClient extends EventEmitter {
	private tienTrinh: ChildProcessWithoutNullStreams | null = null;
	private doc: Interface | null = null;
	private dangTat = false;

	constructor(private tuyChon: TuyChonAgent) {
		super();
	}

	batDau(): void {
		this.dungLai();
		this.dangTat = false;

		const args = ["serve", "--stdio", "--mode", this.tuyChon.permissionMode];
		if (this.tuyChon.model) args.push("--model", this.tuyChon.model);

		this.tienTrinh = spawn(this.tuyChon.cliPath, args, {
			cwd: this.tuyChon.cwd,
			env: {
				...process.env,
				AGENTWEAVE_DEFAULT_PROVIDER: "ollama",
				OLLAMA_HOST: this.tuyChon.ollamaHost,
			},
		});

		this.tienTrinh.on("error", (e) => {
			// Lỗi hay gặp nhất: không tìm thấy CLI. Nói rõ cách sửa thay vì ném
			// nguyên ENOENT khiến người dùng không biết phải làm gì.
			const m =
				(e as NodeJS.ErrnoException).code === "ENOENT"
					? `Không tìm thấy "${this.tuyChon.cliPath}". Đặt lại agentweave.cliPath trong Settings, hoặc thêm CLI vào PATH.`
					: e.message;
			this.emit("suKien", { type: "error", message: m } satisfies SuKienAgent);
		});

		this.tienTrinh.on("exit", (ma) => {
			if (this.dangTat) return;
			this.emit("suKien", {
				type: "error",
				message: `Agent thoát bất ngờ (mã ${ma}). Xem Output → AgentWeave để biết chi tiết.`,
			} satisfies SuKienAgent);
		});

		// stderr là kênh cho người đọc, KHÔNG phải giao thức — đẩy sang Output.
		this.tienTrinh.stderr.on("data", (d: Buffer) => this.emit("nhatKy", d.toString()));

		this.doc = createInterface({ input: this.tienTrinh.stdout });
		this.doc.on("line", (dong) => {
			const s = dong.trim();
			if (!s) return;
			try {
				this.emit("suKien", JSON.parse(s) as SuKienAgent);
			} catch {
				// stdout lẫn chữ thường = giao thức hỏng. Báo ra thay vì bỏ qua.
				this.emit("nhatKy", `[stdout khong phai JSON] ${s}\n`);
			}
		});
	}

	private gui(obj: Record<string, unknown>): void {
		if (!this.tienTrinh?.stdin.writable) return;
		this.tienTrinh.stdin.write(`${JSON.stringify(obj)}\n`);
	}

	hoi(text: string): void {
		this.gui({ type: "prompt", text });
	}

	traLoiQuyen(id: string, allow: boolean, alwaysAllow = false): void {
		this.gui({ type: "permission", id, allow, alwaysAllow });
	}

	huy(): void {
		this.gui({ type: "abort" });
	}

	xoaHoiThoai(): void {
		this.gui({ type: "reset" });
	}

	dungLai(): void {
		this.dangTat = true;
		this.doc?.close();
		this.tienTrinh?.stdin.end();
		this.tienTrinh?.kill();
		this.doc = null;
		this.tienTrinh = null;
	}

	dangSong(): boolean {
		return this.tienTrinh !== null && !this.tienTrinh.killed;
	}
}
