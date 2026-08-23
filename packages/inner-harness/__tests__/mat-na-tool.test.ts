/**
 * Test đòn bẩy CƯỠNG CHẾ của hệ ghì — mặt nạ tool.
 *
 * Rà soát `docs/RA-SOAT-DIEU-KHIEN.md` (F1, NS-4): cờ `epChiViet` cũ chỉ được
 * đọc ở một trong hai đường chạy, và chỉ biết ép VIẾT. Ý "sửa xong phải kiểm
 * chứng" được phát biểu ở 6 chỗ trên 3 tầng mà không có cách nào diễn đạt
 * "lượt sau chỉ được Bash" — nên nó mãi là lời khuyên bằng văn.
 *
 * Mặt nạ không quan sát được từ ngoài, nên nó được gắn vào `recovery:retry`:
 * một đòn bẩy mà người vận hành không thấy thì không phân biệt được với việc
 * nó chết im.
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
			isReadOnly: name === "Grep" || name === "FileRead",
			isDestructive: false,
			isConcurrencySafe: false,
			category: "file",
		},
	} as unknown as ToolDefinition;
}

/** Các mặt nạ đã áp, trích theo thứ tự từ `recovery:retry`. */
function matNaDaAp(ev: InnerEvent[]): string[] {
	const ra: string[] = [];
	for (const e of ev) {
		if (e.type !== "recovery:retry") continue;
		const m = /thu hep tool con \{([^}]*)\}/.exec(String((e as { reason?: string }).reason));
		if (m) ra.push(m[1]!);
	}
	return ra;
}

describe("cổng kiểm chứng — leo thang tới {Bash}", () => {
	it("nhịp 1 cho viết-hoặc-chạy, nhịp 2 CHỈ còn Bash", async () => {
		const loop = new AgentLoop({
			model: "mock",
			maxTurns: 8,
			laLenhKiemTra: (c) => /npm test/.test(c),
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
			// Từ đây model chỉ nói chuyện, không chạy kiểm — cổng phải nổ hai nhịp.
			return { text: "Da tao a.js xong roi.", stopReason: "end_turn" };
		});

		const ev: InnerEvent[] = [];
		for await (const e of loop.run("lam di")) ev.push(e);

		expect(matNaDaAp(ev)).toEqual(["FileWrite,Bash", "Bash"]);
	});

	it("mặt nạ chỉ chứa tool ĐÃ đăng ký — không khoá model vào tool không tồn tại", async () => {
		// Bash không được đăng ký. Nhịp 2 muốn ép {Bash} nhưng tập giao là rỗng,
		// nên KHÔNG thu hẹp: thà mất đòn bẩy còn hơn để model không còn nước đi.
		const loop = new AgentLoop({
			model: "mock",
			maxTurns: 8,
			laLenhKiemTra: (c) => /npm test/.test(c),
		});
		loop.registerTool(toolGia("FileWrite", "Written 100 bytes"));

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
			return { text: "Da tao a.js xong roi.", stopReason: "end_turn" };
		});

		const ev: InnerEvent[] = [];
		for await (const e of loop.run("lam di")) ev.push(e);

		expect(matNaDaAp(ev)).toEqual(["FileWrite"]);
	});
});

describe("gọi liên tiếp cùng một tool", () => {
	it("ghi mãi không chạy → mặt nạ về đúng {Bash}, khớp với câu nhắc", async () => {
		// Bản cũ: `epChiViet = !LA_TOOL_GHI.has(...)` nên ghi-lặp KHÔNG thu hẹp gì
		// cả, trong khi câu nhắc lại bảo "chạy lệnh kiểm tra bằng Bash".
		const loop = new AgentLoop({ model: "mock", maxTurns: 8 });
		loop.registerTool(toolGia("FileWrite", "Written 100 bytes"));
		loop.registerTool(toolGia("Bash"));

		let n = 0;
		loop.setLLMCaller(async () => {
			n++;
			if (n <= 5)
				return {
					stopReason: "tool_use",
					toolCalls: [
						{
							toolUseId: `t${n}`,
							toolName: "FileWrite",
							toolInput: { path: `f${n}.js`, content: "x" },
						},
					],
				};
			return { text: "xong", stopReason: "end_turn" };
		});

		const ev: InnerEvent[] = [];
		for await (const e of loop.run("lam di")) ev.push(e);

		expect(matNaDaAp(ev)).toContain("Bash");
	});
});
