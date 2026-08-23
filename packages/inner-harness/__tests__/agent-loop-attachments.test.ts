/**
 * Test phần nối ống dẫn attachment vào vòng lặp agent.
 *
 * Đây là chỗ dễ hỏng nhất của cả cụm: module attachment có thể xanh hết mà
 * vòng lặp vẫn không bơm gì, hoặc bơm nhưng bơm lại mãi một câu. Nên test ở
 * đây chạy vòng lặp THẬT với LLM giả, rồi soi tin nhắn và sự kiện.
 */

import { describe, it, expect } from "vitest";
import { z } from "zod";
import type { InnerEvent, Message, ToolDefinition } from "@agentweave/types";
import { AgentLoop } from "../src/agent-loop";
import type { NguonNhac } from "../src/attachments/index";

function toolDocFile(): ToolDefinition {
	return {
		name: "FileRead",
		description: "doc file",
		parameters: z.object({ path: z.string() }),
		execute: async () => "noi dung file",
		metadata: { isReadOnly: true, isDestructive: false, isConcurrencySafe: true, category: "file" },
	};
}

async function gom(gen: AsyncGenerator<InnerEvent, unknown, void>): Promise<InnerEvent[]> {
	const ra: InnerEvent[] = [];
	for await (const e of gen) ra.push(e);
	return ra;
}

/** LLM giả: đọc một file ở lượt đầu, rồi trả lời chữ ở lượt sau. */
function llmDocRoiTraLoi(duong: string) {
	let luot = 0;
	return async () => {
		luot++;
		if (luot === 1) {
			return {
				stopReason: "tool_use",
				toolCalls: [{ toolUseId: "t1", toolName: "FileRead", toolInput: { path: duong } }],
			};
		}
		return { text: "xong", stopReason: "end_turn" };
	};
}

describe("AgentLoop — ống dẫn attachment", () => {
	it("bơm nhắc thành <system-reminder> và phát sự kiện context:reminder", async () => {
		const loop = new AgentLoop({ model: "mock", maxTurns: 3 });
		loop.themNguonNhac({
			ten: "thu",
			thu: async () => [{ loai: "thu-nghiem", noiDung: "NOI-DUNG-NHAC" }],
		});
		loop.setLLMCaller(async () => ({ text: "xong", stopReason: "end_turn" }));

		const ev = await gom(loop.run("lam gi do"));

		const sk = ev.find((e) => e.type === "context:reminder");
		expect(sk).toBeDefined();
		expect(sk!.type === "context:reminder" && sk!.loai).toEqual(["thu-nghiem"]);

		const tin = loop.getMessages().find(
			(m: Message) => typeof m.content === "string" && m.content.includes("NOI-DUNG-NHAC"),
		);
		expect(tin).toBeDefined();
		expect(tin!.content as string).toContain("<system-reminder>");
		// Cau giai doc: thieu no thi model quay ra binh luan ve rule thay vi lam viec.
		expect(tin!.content as string).toContain("not a new request from the user");
	});

	it("nguồn nhắc ném lỗi KHÔNG làm hỏng lượt — vẫn chạy tới 'completed'", async () => {
		const loop = new AgentLoop({ model: "mock", maxTurns: 2 });
		loop.themNguonNhac({
			ten: "hong",
			thu: async () => {
				throw new Error("dia hong");
			},
		});
		loop.setLLMCaller(async () => ({ text: "van xong", stopReason: "end_turn" }));

		const ev = await gom(loop.run("hi"));

		const terminal = ev.find((e) => e.type === "terminal");
		expect(terminal!.type === "terminal" && terminal!.reason).toBe("completed");
		// Nhung KHONG duoc im lang: phai co dau vet de nguoi van hanh thay.
		const loi = ev.find((e) => e.type === "error");
		expect(loi!.type === "error" && loi!.error).toContain("hong");
		expect(loi!.type === "error" && loi!.recoverable).toBe(true);
	});

	it("khoá đã bơm thì lượt sau KHÔNG bơm lại", async () => {
		const loop = new AgentLoop({ model: "mock", maxTurns: 5 });
		let soLanThu = 0;
		loop.themNguonNhac({
			ten: "co-khoa",
			thu: async () => {
				soLanThu++;
				return [{ loai: "luat", noiDung: "LUAT-MOT-LAN", khoa: "luat:x" }];
			},
		});
		// Ba luot: hai luot goi tool, luot cuoi tra chu.
		let luot = 0;
		loop.registerTool(toolDocFile());
		loop.setLLMCaller(async () => {
			luot++;
			if (luot <= 2) {
				return {
					stopReason: "tool_use",
					toolCalls: [{ toolUseId: `t${luot}`, toolName: "FileRead", toolInput: { path: "a.ts" } }],
				};
			}
			return { text: "xong", stopReason: "end_turn" };
		});

		await gom(loop.run("doc di"));

		expect(soLanThu).toBeGreaterThanOrEqual(3); // nguon van duoc hoi moi luot
		const soLanXuatHien = loop
			.getMessages()
			.filter((m) => typeof m.content === "string" && m.content.includes("LUAT-MOT-LAN")).length;
		expect(soLanXuatHien).toBe(1);
	});

	it("file model vừa ĐỌC được báo cho nguồn nhắc ở lượt kế tiếp, rồi xoá đi", async () => {
		const loop = new AgentLoop({ model: "mock", maxTurns: 4 });
		const thayGi: string[][] = [];
		const nguon: NguonNhac = {
			ten: "ghi-lai",
			thu: async (ctx) => {
				thayGi.push([...ctx.fileVuaCham]);
				return [];
			},
		};
		loop.themNguonNhac(nguon);
		loop.registerTool(toolDocFile());
		loop.setLLMCaller(llmDocRoiTraLoi("src/api/user.ts"));

		await gom(loop.run("doc file"));

		// Luot 1: chua cham gi.
		expect(thayGi[0]).toEqual([]);
		// Luot 2: thay file vua doc, duong dan TUYET DOI.
		expect(thayGi[1]?.[0]?.endsWith("src/api/user.ts")).toBe(true);
		// Luot 3 (neu co): da xoa — tin hieu la "luot vua roi", khong cong don.
		if (thayGi[2]) expect(thayGi[2]).toEqual([]);
	});

	it("không đăng ký nguồn nào thì không bơm gì, không phát sự kiện nào", async () => {
		const loop = new AgentLoop({ model: "mock", maxTurns: 2 });
		loop.setLLMCaller(async () => ({ text: "xong", stopReason: "end_turn" }));
		const ev = await gom(loop.run("hi"));
		expect(ev.find((e) => e.type === "context:reminder")).toBeUndefined();
	});
});

// ─────────────────────────────────────────────────────────────────
// Ngắt mạch nén: đã leo hết các mức mà ngữ cảnh vẫn đầy thì DỪNG,
// thay vì chạy tiếp và đốt token không tiến triển.
// ─────────────────────────────────────────────────────────────────

describe("AgentLoop — ngắt mạch nén", () => {
	/** LLM giả luôn báo ngữ cảnh đầy và luôn gọi tool, tức là không bao giờ tự dừng. */
	function llmLuonDayVaGoiTool() {
		let n = 0;
		return async () => {
			n++;
			return {
				stopReason: "tool_use",
				toolCalls: [
					{ toolUseId: `t${n}`, toolName: "FileRead", toolInput: { path: `f${n}.ts` } },
				],
				// 60.000 / 65.536 = 0,92 — luôn trên ngưỡng 0,8.
				usage: { inputTokens: 60_000, outputTokens: 10 },
			};
		};
	}

	it("dung han voi reason 'error' va thong bao noi ro phai lam gi", async () => {
		const loop = new AgentLoop({ model: "qwen3-coder:30b", maxTurns: 30, contextWindow: 65_536 });
		loop.registerTool(toolDocFile());
		loop.setLLMCaller(llmLuonDayVaGoiTool());

		const ev = await gom(loop.run("lam viec gi do"));

		const terminal = ev.find((e) => e.type === "terminal");
		expect(terminal!.type === "terminal" && terminal!.reason).toBe("error");

		const loi = ev.find((e) => e.type === "error");
		const chu = loi!.type === "error" ? loi!.error : "";
		expect(chu).toContain("muc cao nhat");
		// Bao loi phai NEU LOI RA, khong chi noi that bai.
		expect(chu).toMatch(/phien moi|chia nho/);
		expect(loi!.type === "error" && loi!.recoverable).toBe(false);
	});

	it("dung TRUOC khi cham tran maxTurns — bang chung la no ngat that", async () => {
		const loop = new AgentLoop({ model: "qwen3-coder:30b", maxTurns: 30, contextWindow: 65_536 });
		loop.registerTool(toolDocFile());
		loop.setLLMCaller(llmLuonDayVaGoiTool());

		const ev = await gom(loop.run("lam viec gi do"));
		const soLuot = ev.filter((e) => e.type === "turn:start").length;
		expect(soLuot).toBeLessThan(30);
		expect(soLuot).toBeGreaterThan(3); // van cho nen leo thang du cac muc truoc khi bo cuoc
	});

	it("ngu canh KHONG day thi khong bao gio ngat mach", async () => {
		const loop = new AgentLoop({ model: "qwen3-coder:30b", maxTurns: 5, contextWindow: 65_536 });
		loop.registerTool(toolDocFile());
		let n = 0;
		loop.setLLMCaller(async () => {
			n++;
			if (n <= 2) {
				return {
					stopReason: "tool_use",
					toolCalls: [{ toolUseId: `t${n}`, toolName: "FileRead", toolInput: { path: `f${n}.ts` } }],
					usage: { inputTokens: 1_000, outputTokens: 10 },
				};
			}
			return { text: "xong", stopReason: "end_turn", usage: { inputTokens: 1_000, outputTokens: 10 } };
		});

		const ev = await gom(loop.run("hi"));
		const terminal = ev.find((e) => e.type === "terminal");
		expect(terminal!.type === "terminal" && terminal!.reason).toBe("completed");
	});
});
