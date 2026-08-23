/**
 * Test vết tích — thứ duy nhất trả lời được "model ĐỌC ĐƯỢC gì".
 *
 * Trước đợt này không tầng nào giữ nội dung thật gửi cho model:
 * `AuditLogger` chỉ nằm trong RAM, `.agentweave/audit.log` chỉ ghi quyết định
 * của lệnh `guard`, còn `llm:request_start` chỉ mang
 * `{model, estimatedInputTokens}`. Rà soát `docs/RA-SOAT-DIEU-KHIEN.md` phải
 * chặn ở tầng mạng mới dựng lại được chuỗi đó.
 *
 * Hai luật bị khoá ở đây:
 *   ① Payload gửi/nhận phải NGUYÊN VẸN. Cắt ngắn là hỏng mục đích.
 *   ② Bật vết tích KHÔNG được đổi hành vi agent — chỉ quan sát.
 */

import type { BoGhiVetTich, DiemCham, ToolDefinition } from "@agentweave/types";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { AgentLoop } from "../src/agent-loop";

class BoGhiGia implements BoGhiVetTich {
	readonly ds: DiemCham[] = [];
	ghi(d: DiemCham): void {
		this.ds.push(d);
	}
	loai(l: string): DiemCham[] {
		return this.ds.filter((d) => d.loai === l);
	}
}

function toolGia(name: string, ketQua = "ok"): ToolDefinition {
	return {
		name,
		description: `tool ${name}`,
		parameters: z.object({}).passthrough(),
		execute: async () => ketQua,
		metadata: {
			isReadOnly: false,
			isDestructive: false,
			isConcurrencySafe: false,
			category: "file",
		},
	} as unknown as ToolDefinition;
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("ranh giới LLM — bytes thật đi qua dây", () => {
	it("ghi TRỌN chuỗi gửi Ollama và raw trả về, đường có ràng buộc", async () => {
		const bo = new BoGhiGia();
		const loop = new AgentLoop({
			model: "qwen3-coder:30b",
			maxTurns: 2,
			structuredProtocol: true,
			contextWindow: 4096,
			vetTich: bo,
			thamSoSinh: { temperature: 0.3, seed: 7 },
		});
		loop.registerTool(toolGia("FileWrite", "Written 205 bytes to thue.js"));

		const raw = JSON.stringify({ tool: "respond", message: "xong roi", done: true });
		vi.stubGlobal("fetch", async () =>
			Response.json({ message: { content: raw }, prompt_eval_count: 11, eval_count: 3 }),
		);

		for await (const _ of loop.run("viet thue.js")) {
			// chạy hết
		}

		const gui = bo.loai("llm:gui");
		expect(gui.length).toBe(1);

		// Payload phải là thân request THẬT, giải mã lại được.
		const than = JSON.parse(gui[0]!.noiDungLon!["gui.json"]!) as {
			messages: Array<{ role: string; content: string }>;
			options: Record<string, number>;
			format: unknown;
		};
		// Câu người dùng phải có mặt — nếu không thì thứ ta ghi không phải thứ đã gửi.
		expect(than.messages.some((m) => m.content.includes("viet thue.js"))).toBe(true);
		// System prompt + giao thức đi cùng lượt gọi.
		expect(than.messages[0]!.role).toBe("system");
		// num_ctx và tham số sinh phải xuất hiện — đây là chỗ chứng minh chúng
		// thật sự được gửi, chứ không chỉ được đặt trong cấu hình.
		expect(than.options.num_ctx).toBe(4096);
		expect(than.options.temperature).toBe(0.3);
		expect(than.options.seed).toBe(7);

		// Danh sách tool đi kèm để đối chiếu với mặt nạ.
		expect(gui[0]!.chiTiet!.toolChoPhep).toEqual(["FileWrite", "respond"]);
		expect(gui[0]!.chiTiet!.coMatNa).toBe(false);

		const nhan = bo.loai("llm:nhan");
		expect(nhan.length).toBe(1);
		// NGUYÊN VẸN: đúng từng ký tự, không cắt, không diễn giải.
		expect(nhan[0]!.noiDungLon!["nhan.json"]).toBe(raw);
		expect(nhan[0]!.chiTiet!.tokenVao).toBe(11);
	});

	it("lượt gọi hỏng cũng để lại vết", async () => {
		const bo = new BoGhiGia();
		const loop = new AgentLoop({
			model: "qwen3-coder:30b",
			maxTurns: 2,
			structuredProtocol: true,
			vetTich: bo,
		});
		vi.stubGlobal("fetch", async () => new Response("boom", { status: 500 }));

		for await (const _ of loop.run("lam gi do")) {
			// chạy hết
		}

		expect(bo.loai("llm:hong").length).toBe(1);
		expect(bo.loai("llm:hong")[0]!.chiTiet!.ma).toBe(500);
	});
});

describe("điểm chạm trong vòng lặp", () => {
	it("guard nổ thì ghi cơ chế, nhịp và MẶT NẠ đặt cho lượt sau", async () => {
		const bo = new BoGhiGia();
		const loop = new AgentLoop({
			model: "mock",
			maxTurns: 8,
			laLenhKiemTra: (c) => /npm test/.test(c),
			vetTich: bo,
		});
		loop.registerTool(toolGia("FileWrite", "Written 100 bytes"));
		loop.registerTool(toolGia("Bash"));

		let n = 0;
		loop.setLLMCaller(async () => {
			n++;
			if (n === 1)
				return {
					stopReason: "tool_use",
					toolCalls: [
						{ toolUseId: "t1", toolName: "FileWrite", toolInput: { path: "a.js", content: "x" } },
					],
				};
			return { text: "Da tao a.js xong.", stopReason: "end_turn" };
		});

		for await (const _ of loop.run("lam di")) {
			// chạy hết
		}

		const g = bo.loai("agent:guard");
		expect(g.length).toBe(2);
		expect(g.map((x) => x.chiTiet!.coChe)).toEqual(["cong-kiem-chung", "cong-kiem-chung"]);
		// Leo thang phải nhìn thấy được: nhịp 1 còn cho viết, nhịp 2 chỉ còn Bash.
		expect(g[0]!.chiTiet!.matNa).toEqual(["FileWrite", "Bash"]);
		expect(g[1]!.chiTiet!.matNa).toEqual(["Bash"]);
	});

	it("tool chạy xong ghi cả tham số VÀO lẫn kết quả RA", async () => {
		const bo = new BoGhiGia();
		const loop = new AgentLoop({ model: "mock", maxTurns: 3, vetTich: bo });
		loop.registerTool(toolGia("Bash", "1 passed"));

		let n = 0;
		loop.setLLMCaller(async () => {
			n++;
			if (n === 1)
				return {
					stopReason: "tool_use",
					toolCalls: [{ toolUseId: "t1", toolName: "Bash", toolInput: { command: "npm test" } }],
				};
			return { text: "xong", stopReason: "end_turn" };
		});

		for await (const _ of loop.run("chay test")) {
			// chạy hết
		}

		const t = bo.loai("tool:xong");
		expect(t.length).toBe(1);
		expect(JSON.parse(t[0]!.noiDungLon!["vao.json"]!)).toEqual({ command: "npm test" });
		expect(t[0]!.noiDungLon!["ket-qua.txt"]).toBe("1 passed");
	});
});

describe("luật ② — chỉ quan sát", () => {
	it("bật vết tích không đổi kết cục của lượt", async () => {
		const chay = async (bo?: BoGhiVetTich) => {
			const loop = new AgentLoop({ model: "mock", maxTurns: 5, vetTich: bo });
			loop.registerTool(toolGia("Grep"));
			let n = 0;
			loop.setLLMCaller(async () => {
				n++;
				if (n <= 4)
					return {
						stopReason: "tool_use",
						toolCalls: [{ toolUseId: `t${n}`, toolName: "Grep", toolInput: { pattern: "x" } }],
					};
				return { text: "xong", stopReason: "end_turn" };
			});
			const g = loop.run("tim di");
			for (;;) {
				const b = await g.next();
				if (b.done) return { kq: b.value, soTin: loop.getMessages().length };
			}
		};

		const khong = await chay(undefined);
		const co = await chay(new BoGhiGia());
		expect(co.kq).toEqual(khong.kq);
		expect(co.soTin).toBe(khong.soTin);
	});
});
