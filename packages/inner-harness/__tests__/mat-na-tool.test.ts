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

describe("FileRead KHÔNG BAO GIỜ bị loại khỏi mặt nạ", () => {
	it("cổng kiểm chứng vẫn cho đọc ở cả hai nhịp", async () => {
		// Đo thật (`vet-tich/20260823-171947`): mặt nạ loại FileRead ra, model bị
		// ép ghi nhưng không còn cách lấy đúng nội dung file, nên nó dựng
		// `old_string` từ trí nhớ — thiếu BOM, thiếu `\r` — và sửa trượt. Rồi vì
		// không hiểu vì sao trượt, nó kết luận "không có quyền".
		//
		// Đọc không bao giờ là hành động giả. Cấm đọc thì ta không ép model làm
		// việc, ta ép nó ĐOÁN.
		const loop = new AgentLoop({
			model: "mock",
			maxTurns: 8,
			laLenhKiemTra: (c) => /npm test/.test(c),
		});
		loop.registerTool(toolGia("FileWrite", "Written 100 bytes"));
		loop.registerTool(toolGia("FileRead", "noi dung"));
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
			return { text: "Da tao a.js xong roi.", stopReason: "end_turn" };
		});

		const ev: InnerEvent[] = [];
		for await (const e of loop.run("lam di")) ev.push(e);

		const mn = matNaDaAp(ev);
		expect(mn.length).toBeGreaterThan(0);
		for (const m of mn) expect(m.split(",")).toContain("FileRead");
	});
});

describe("tự khai chưa xong — CẤM respond", () => {
	/**
	 * Đo thật (`vet-tich/20260823-180443`): mặt nạ thu về
	 * {FileWrite,FileEdit,Bash,FileRead} nhưng `respond` vẫn nằm trong enum ở
	 * MỌI lượt, nên model cứ nộp thêm một bài văn "tôi cần thêm thời gian".
	 * Nó khai done=false ba lần rồi vẫn kết thúc với 0 file được sửa, và
	 * harness ghi `reason: completed`.
	 */
	function loopKeLe(): { loop: AgentLoop; soLanGoi: () => number } {
		const loop = new AgentLoop({ model: "mock", maxTurns: 10 });
		loop.registerTool(toolGia("FileWrite", "Written 10 bytes"));
		loop.registerTool(toolGia("Bash"));
		let n = 0;
		// Model LÌ: lượt nào cũng chỉ nói, và lượt nào cũng tự khai chưa xong.
		loop.setLLMCaller(async () => {
			n++;
			return { text: "Toi se tiep tuc sua chua...", stopReason: "end_turn", chuaXong: true };
		});
		return { loop, soLanGoi: () => n };
	}

	it("nhịp 2 trở đi thì cờ cấm respond được bật", async () => {
		const { loop } = loopKeLe();
		const ev: InnerEvent[] = [];
		for await (const e of loop.run("sua di")) ev.push(e);

		const camm = ev.filter(
			(e) =>
				e.type === "recovery:retry" &&
				/CAM respond/.test(String((e as { reason?: string }).reason)),
		);
		expect(camm.length).toBeGreaterThan(0);
	});

	it("thu hẹp NGAY nhịp 1, không nhắc suông một lượt", async () => {
		const { loop } = loopKeLe();
		const ev: InnerEvent[] = [];
		for await (const e of loop.run("sua di")) ev.push(e);
		// Mọi nhịp đều phải có mặt nạ — kể cả nhịp đầu.
		expect(matNaDaAp(ev).length).toBeGreaterThanOrEqual(3);
	});

	it("hết nhịp mà vẫn khai chưa xong thì KHÔNG được ghi completed", async () => {
		// Model tự nói chưa xong mà ta chốt "completed" là nói dối trong chính
		// số liệu của mình — người dùng đọc turn_end thấy xanh rồi tin là xong.
		const { loop } = loopKeLe();
		let kq: { reason: string } | undefined;
		const g = loop.run("sua di");
		for (;;) {
			const b = await g.next();
			if (b.done) {
				kq = b.value as { reason: string };
				break;
			}
		}
		expect(kq!.reason).not.toBe("completed");
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

describe("cổng thứ hai — lệnh kiểm còn HỎNG thì không cho dừng", () => {
	/**
	 * Cổng cũ chỉ hỏi "đã kiểm chưa" — một boolean. Model chạy `dotnet build`
	 * MỘT lần, dù mã thoát 1, là nó thoả mãn vĩnh viễn. Đo thật qua 4 phiên:
	 * 28 lượt kết thúc, 25 lượt KHÔNG sửa file nào, cả 28 đều ghi `completed`.
	 */
	function dungLoop(ketQuaKiem: string) {
		const loop = new AgentLoop({
			model: "mock",
			maxTurns: 14,
			laLenhKiemTra: (c) => /npm test/.test(c),
		});
		loop.registerTool(toolGia("FileWrite", "Written 10 bytes"));
		loop.registerTool(toolGia("Bash", ketQuaKiem));
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
					stopReason: "tool_use",
					toolCalls: [{ toolUseId: "t2", toolName: "Bash", toolInput: { command: "npm test" } }],
				};
			// Từ đây model chỉ muốn kết thúc.
			return { text: "Da xong roi nhe.", stopReason: "end_turn" };
		});
		return loop;
	}

	it("kiểm HỎNG (mã thoát ≠ 0) → chặn và ép sửa tiếp", async () => {
		const loop = dungLoop("[mã thoát 1]\n1 test failed");
		const ev: InnerEvent[] = [];
		for await (const e of loop.run("sua di")) ev.push(e);

		const chan = ev.filter(
			(e) =>
				e.type === "recovery:retry" &&
				/lenh kiem con HONG/.test(String((e as { reason?: string }).reason)),
		);
		expect(chan.length).toBeGreaterThan(0);
		// Có điểm dừng — nhưng dựa trên KHÔNG CÒN TIẾN TRIỂN, không phải "đã thử
		// đủ số lần". Ở đây model không chạy lại lệnh kiểm lần nào sau khi bị ép,
		// nên `EP_MA_KHONG_CHAY_KIEM_TOI_DA` là thứ dừng nó lại.
		expect(chan.length).toBeLessThanOrEqual(5);
	});

	it("kiểm ĐẠT → cho dừng ngay, không quấy rầy", async () => {
		const loop = dungLoop("1 passed");
		const ev: InnerEvent[] = [];
		for await (const e of loop.run("sua di")) ev.push(e);
		expect(
			ev.filter(
				(e) =>
					e.type === "recovery:retry" &&
					/lenh kiem con HONG/.test(String((e as { reason?: string }).reason)),
			),
		).toEqual([]);
	});
});

describe("cổng ② dừng theo TIẾN TRIỂN, không theo số lần thử", () => {
	/**
	 * Đếm lần thử là thước đo sai — một refactor thật có thể cần hai chục vòng.
	 * Thước đo đúng: đầu ra lệnh kiểm có ĐỔI không.
	 */
	function loopKiem(dayKetQua: string[]) {
		const loop = new AgentLoop({
			model: "mock",
			maxTurns: 40,
			laLenhKiemTra: (c) => /npm test/.test(c),
		});
		let i = 0;
		loop.registerTool({
			name: "Bash",
			description: "chay lenh",
			parameters: z.object({}).passthrough(),
			execute: async () => dayKetQua[Math.min(i++, dayKetQua.length - 1)],
			metadata: {
				isReadOnly: false,
				isDestructive: false,
				isConcurrencySafe: false,
				category: "file",
			},
		} as unknown as ToolDefinition);
		loop.registerTool(toolGia("FileWrite", "Written 10 bytes"));
		// Model ngoan: lượt nào cũng chạy lệnh kiểm, rồi định kết thúc.
		let n = 0;
		loop.setLLMCaller(async () => {
			n++;
			return n % 2 === 1
				? {
						stopReason: "tool_use",
						toolCalls: [
							{ toolUseId: `t${n}`, toolName: "Bash", toolInput: { command: "npm test" } },
						],
					}
				: { text: "xong roi", stopReason: "end_turn" };
		});
		return loop;
	}

	const demChan = (ev: InnerEvent[]) =>
		ev.filter(
			(e) =>
				e.type === "recovery:retry" &&
				/lenh kiem con HONG/.test(String((e as { reason?: string }).reason)),
		).length;

	it("đầu ra kiểm CỨ ĐỔI thì cho đi tiếp quá 4 vòng", async () => {
		// Mỗi lần một lỗi khác = đang gỡ dần. Trần cũ (4) sẽ cắt oan ở đây.
		const loop = loopKiem(
			Array.from({ length: 12 }, (_, k) => `[mã thoát 1]\nloi thu ${"x".repeat(k + 1)}`),
		);
		const ev: InnerEvent[] = [];
		for await (const e of loop.run("sua di")) ev.push(e);
		expect(demChan(ev)).toBeGreaterThan(4);
	});

	it("đầu ra kiểm Y HỆT NHAU thì dừng sớm", async () => {
		const loop = loopKiem(["[mã thoát 1]\nloi y het"]);
		const ev: InnerEvent[] = [];
		for await (const e of loop.run("sua di")) ev.push(e);
		expect(demChan(ev)).toBeLessThanOrEqual(5);
	});
});

describe("done=false: bộ đếm phải ĐẶT LẠI khi có tiến triển", () => {
	/**
	 * Một việc nhiều bước thì model khai `done=false` hàng chục lần là chuyện
	 * ĐÚNG — nó đang thành thật. Đếm cộng dồn rồi cắt phiên là phạt đúng cái
	 * tính thành thật đó.
	 *
	 * Đo thật (`vet-tich/20260823-215734`): agent chạy 11 tool, sửa
	 * TicketService.cs, rồi bị cắt `reason: "loop"` vì đã khai done=false ba
	 * lần rải khắp lượt — trong khi nó đang làm việc.
	 */
	it("xen kẽ ghi file thì KHÔNG bị cắt dù khai done=false nhiều lần", async () => {
		const loop = new AgentLoop({ model: "mock", maxTurns: 30 });
		loop.registerTool(toolGia("FileWrite", "Written 10 bytes"));

		let n = 0;
		loop.setLLMCaller(async () => {
			n++;
			// Cứ hai lượt: một lần ghi file thật, một lần khai chưa xong.
			if (n % 2 === 1)
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
			if (n < 12) return { text: "dang lam tiep", stopReason: "end_turn", chuaXong: true };
			return { text: "xong", stopReason: "end_turn" };
		});

		let kq: { reason: string } | undefined;
		const g = loop.run("lam viec nhieu buoc");
		for (;;) {
			const b = await g.next();
			if (b.done) {
				kq = b.value as { reason: string };
				break;
			}
		}
		// Khai done=false 5 lần nhưng lần nào cũng có ghi file xen giữa → không cắt.
		expect(kq!.reason).toBe("completed");
	});
});
