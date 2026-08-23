/**
 * Test hai mục "Chưa soi" của `docs/RA-SOAT-DIEU-KHIEN.md`.
 *
 *   · mục 2 — `cuuToolCall` chạy trước bộ bắt vẹt và KHÔNG đối chiếu lời gọi
 *     đã thực thi, nên văn xuôi nhại lại JSON trong lịch sử bị "cứu" thành
 *     lệnh THẬT và chạy lại. Ứng viên trực tiếp cho ground truth "lần 3 GHI
 *     ĐÈ bản đúng bằng bản sai". Nay model ĐỌC ĐƯỢC lịch sử tool của chính nó
 *     nên nó nhại khuôn đó thường xuyên hơn hẳn — lỗ này rộng ra chứ không hẹp đi.
 *
 *   · mục 3 — bản đồ phanh thủng: `budget` USD luôn = 0 với model cục bộ nên
 *     không bao giờ kích, `maxTurns` đếm lượt chứ không đếm giờ, và
 *     `RunOptions.timeoutMs` + `TerminalReason: "timeout"` nằm trong kiểu từ
 *     lâu mà KHÔNG ai nối.
 */

import type { InnerEvent, ToolDefinition } from "@agentweave/types";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { AgentLoop } from "../src/agent-loop";

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

async function chay(
	loop: AgentLoop,
	cau: string,
): Promise<{ ev: InnerEvent[]; kq: { reason: string } }> {
	const ev: InnerEvent[] = [];
	const g = loop.run(cau);
	for (;;) {
		const b = await g.next();
		if (b.done) return { ev, kq: b.value as { reason: string } };
		ev.push(b.value);
	}
}

describe("cuuToolCall — phân biệt GỌI với KỂ LẠI", () => {
	it("văn xuôi nhại lại lệnh ĐÃ chạy không được cứu thành lệnh thật", async () => {
		const loop = new AgentLoop({ model: "mock", maxTurns: 6 });
		let soLanGhi = 0;
		loop.registerTool({
			name: "FileWrite",
			description: "ghi file",
			parameters: z.object({ path: z.string(), content: z.string() }),
			execute: async () => {
				soLanGhi++;
				return "Written 205 bytes to thue.js";
			},
			metadata: {
				isReadOnly: false,
				isDestructive: false,
				isConcurrencySafe: false,
				category: "file",
			},
		} as unknown as ToolDefinition);

		let n = 0;
		loop.setLLMCaller(async () => {
			n++;
			if (n === 1)
				return {
					stopReason: "tool_use",
					toolCalls: [
						{
							toolUseId: "t1",
							toolName: "FileWrite",
							toolInput: { path: "thue.js", content: "x" },
						},
					],
				};
			// Lượt 2: model KỂ LẠI việc nó vừa làm, nhại nguyên khuôn JSON. Không
			// có cổng chặn thì đây là một lời gọi FileWrite hợp lệ với vòng lặp —
			// và nó GHI ĐÈ file vừa đúng.
			return {
				text: 'Toi da goi {"name":"FileWrite","input":{"path":"thue.js","content":"x"}} va no thanh cong.',
				stopReason: "end_turn",
			};
		});

		const { ev } = await chay(loop, "viet thue.js");

		expect(soLanGhi).toBe(1);
		const boDi = ev.filter(
			(e) =>
				e.type === "recovery:retry" &&
				/trung khit lenh da chay/.test(String((e as { reason?: string }).reason)),
		);
		expect(boDi.length).toBe(1);
	});

	it("lời gọi được cứu mà KHÁC lệnh đã chạy thì vẫn qua — cổng không được chặn oan", async () => {
		const loop = new AgentLoop({ model: "mock", maxTurns: 6 });
		let soLanGhi = 0;
		loop.registerTool({
			name: "FileWrite",
			description: "ghi file",
			parameters: z.object({ path: z.string(), content: z.string() }),
			execute: async () => {
				soLanGhi++;
				return "Written 10 bytes";
			},
			metadata: {
				isReadOnly: false,
				isDestructive: false,
				isConcurrencySafe: false,
				category: "file",
			},
		} as unknown as ToolDefinition);

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
			if (n === 2)
				return {
					text: '{"name":"FileWrite","input":{"path":"b.js","content":"y"}}',
					stopReason: "end_turn",
				};
			return { text: "xong", stopReason: "end_turn" };
		});

		await chay(loop, "viet hai file");
		expect(soLanGhi).toBe(2);
	});
});

describe("trần THỜI GIAN — phanh duy nhất còn đạp được với model cục bộ", () => {
	it("hết hạn thì dừng với reason timeout", async () => {
		const loop = new AgentLoop({ model: "mock", maxTurns: 100 });
		loop.registerTool(toolGia("Bash"));

		// Mỗi lượt ăn 30ms; trần 60ms nên chỉ đi được vài lượt rồi phải dừng.
		loop.setLLMCaller(async () => {
			await new Promise((r) => setTimeout(r, 30));
			return {
				stopReason: "tool_use",
				toolCalls: [
					{ toolUseId: `t${Math.random()}`, toolName: "Bash", toolInput: { command: "sleep 0" } },
				],
			};
		});

		const ev: InnerEvent[] = [];
		const g = loop.run("chay mai di", { timeoutMs: 60 });
		let kq: { reason: string } | undefined;
		for (;;) {
			const b = await g.next();
			if (b.done) {
				kq = b.value as { reason: string };
				break;
			}
			ev.push(b.value);
		}

		expect(kq!.reason).toBe("timeout");
		// Và phải dừng SỚM hơn trần lượt rất nhiều — nếu chạm 100 lượt thì trần
		// thời gian không có tác dụng gì.
		expect(loop.getState().turnIndex).toBeLessThan(20);
	});

	it("không đặt trần thì không đổi hành vi", async () => {
		const loop = new AgentLoop({ model: "mock", maxTurns: 3 });
		loop.setLLMCaller(async () => ({ text: "xong", stopReason: "end_turn" }));
		const { kq } = await chay(loop, "chao");
		expect(kq.reason).toBe("completed");
	});
});
