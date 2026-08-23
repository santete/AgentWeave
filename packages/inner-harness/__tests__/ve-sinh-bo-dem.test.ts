/**
 * Test vệ sinh bộ đếm ghì model + khung nhắc guard.
 *
 * Ba kiểu hỏng mà rà soát `docs/RA-SOAT-DIEU-KHIEN.md` chỉ ra:
 *
 *   · F9    — chạy lại đúng một lệnh kiểm tra hợp lệ 3 lần bị chặn với thông
 *             điệp sai loại việc, lần 5 CẮT PHIÊN với `reason: "loop"`.
 *   · Critic — bộ đếm tính cả lời gọi bị NGƯỜI DÙNG từ chối quyền, nên chuỗi
 *             "từ chối → model thử lại" tích luỹ tới cắt phiên và đổ lỗi cho
 *             model về một quyết định của con người.
 *   · F3    — ngưỡng phẳng: cùng một bài răn nổ lại ở lần 4, 6, 7, 8, 9 mà
 *             không bao giờ dừng.
 */

import type { InnerEvent, ToolDefinition } from "@agentweave/types";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { AgentLoop } from "../src/agent-loop";
import { NHAN_NHAC_GUARD, locNhacGuard } from "../src/attachments/index";

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

function lyDo(ev: InnerEvent[]): string[] {
	return ev
		.filter((e) => e.type === "recovery:retry")
		.map((e) => String((e as { reason?: string }).reason));
}

describe("miễn trừ lệnh kiểm chứng khỏi bộ đếm (tool+tham số)", () => {
	it("chạy lại đúng một lệnh test nhiều lần KHÔNG bị coi là lặp-y-hệt", async () => {
		const loop = new AgentLoop({
			model: "mock",
			maxTurns: 12,
			laLenhKiemTra: (c) => /npm test/.test(c),
		});
		loop.registerTool(toolGia("Bash", "1 passed"));

		let n = 0;
		loop.setLLMCaller(async () => {
			n++;
			if (n <= 9)
				return {
					stopReason: "tool_use",
					toolCalls: [{ toolUseId: `t${n}`, toolName: "Bash", toolInput: { command: "npm test" } }],
				};
			return { text: "xong", stopReason: "end_turn" };
		});

		const ev: InnerEvent[] = [];
		const kq = await (async () => {
			let cuoi: unknown;
			const g = loop.run("chay test di");
			for (;;) {
				const b = await g.next();
				if (b.done) {
					cuoi = b.value;
					break;
				}
				ev.push(b.value);
			}
			return cuoi as { reason: string };
		})();

		// Bộ đếm (tool+tham số) không được nổ — trước đây nó chặn ở lần 3 với
		// thông điệp "STOP repeating searches" (sai hẳn loại việc).
		expect(lyDo(ev).filter((r) => r.startsWith("loop:"))).toEqual([]);
		// ...nhưng phiên vẫn phải dừng được: bộ đếm gọi-LIÊN-TIẾP vẫn phủ ca
		// "chạy test mãi mà không sửa gì". Miễn trừ không mở lỗ hổng nào.
		expect(lyDo(ev).some((r) => r.includes("goi lien tiep"))).toBe(true);
		expect(kq.reason).toBe("loop");
	});
});

describe("lời gọi bị NGƯỜI DÙNG từ chối quyền không bị tính", () => {
	it("từ chối 6 lần cùng một lệnh không đẩy phiên tới cắt vì loop", async () => {
		const loop = new AgentLoop({
			model: "mock",
			maxTurns: 8,
			controlPlane: {
				intercept: async (loai: string) =>
					loai === "tool_request"
						? { behavior: "deny", reason: "nguoi dung bam tu choi", source: "user" }
						: { action: "allow" },
				onCommand: () => {},
				// biome-ignore lint/suspicious/noExplicitAny: control plane giả tối thiểu
			} as any,
		});
		loop.registerTool(toolGia("Bash"));

		let n = 0;
		loop.setLLMCaller(async () => {
			n++;
			if (n <= 6)
				return {
					stopReason: "tool_use",
					toolCalls: [{ toolUseId: `t${n}`, toolName: "Bash", toolInput: { command: "rm x" } }],
				};
			return { text: "bi tu choi", stopReason: "end_turn" };
		});

		const ev: InnerEvent[] = [];
		let cuoi: { reason: string } | undefined;
		const g = loop.run("xoa di");
		for (;;) {
			const b = await g.next();
			if (b.done) {
				cuoi = b.value as { reason: string };
				break;
			}
			ev.push(b.value);
		}

		expect(lyDo(ev).filter((r) => r.startsWith("loop:"))).toEqual([]);
		expect(cuoi!.reason).not.toBe("loop");
	});
});

describe("khung nhắc guard", () => {
	it("bài răn đi kênh nhắc, tool_result chỉ giữ SỰ KIỆN ngắn", async () => {
		const loop = new AgentLoop({ model: "mock", maxTurns: 6 });
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

		for await (const _ of loop.run("tim di")) {
			// chỉ cần chạy hết
		}

		const msgs = loop.getMessages();
		const ketQuaChan = msgs.flatMap((m) =>
			Array.isArray(m.content)
				? m.content.filter((b) => b.type === "tool_result" && b.is_error === true)
				: [],
		);
		expect(ketQuaChan.length).toBeGreaterThan(0);
		// Kết quả bị chặn phải NGẮN: nó mượn id của tool nằm trong TOOL_NEN_DUOC
		// nên nén mức 2 cắt còn 80 ký tự — bài răn dài sẽ đứt giữa câu.
		for (const k of ketQuaChan) {
			expect(String((k as { content: string }).content).length).toBeLessThan(120);
		}

		const nhac = msgs.filter(
			(m) => typeof m.content === "string" && m.content.includes(NHAN_NHAC_GUARD),
		);
		expect(nhac.length).toBeGreaterThan(0);
		expect(String(nhac[0]!.content)).toContain("<system-reminder");
		expect(String(nhac[0]!.content)).toMatch(/STOP calling|Loop detected|STOP searching/);
	});

	it("locNhacGuard bỏ đúng nhắc guard, giữ nguyên chữ thật", () => {
		const ra = locNhacGuard([
			{ role: "user", content: "viet thue.js" },
			{
				role: "user",
				content: `<system-reminder source="${NHAN_NHAC_GUARD}">ran</system-reminder>`,
			},
			{ role: "assistant", content: "xong" },
			// Nhắc thường (rule/skill/bộ nhớ) KHÔNG mang nhãn guard — phải ở lại.
			{ role: "user", content: "<system-reminder>quy uoc du an</system-reminder>" },
		]);
		expect(ra.map((m) => m.content)).toEqual([
			"viet thue.js",
			"xong",
			"<system-reminder>quy uoc du an</system-reminder>",
		]);
	});
});
