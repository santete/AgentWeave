/**
 * Test TẦNG 0 — model có nhìn thấy hành động của chính nó không.
 *
 * Rà soát `docs/RA-SOAT-DIEU-KHIEN.md` (KT-01, KT-04) đo bằng chạy thật: sau
 * một FileWrite thành công, chuỗi gửi tới model là
 *
 *   assistant: ""      ← lời gọi FileWrite của CHÍNH NÓ
 *   user:      ""      ← "Written 205 bytes to thue.js"
 *
 * Hai chuỗi rỗng đó giải thích trọn ground truth: ghi lại cùng một file nhiều
 * lần, và MỌI cảnh báo guard (tiêm qua `appendToolResult`) là chuỗi rỗng với
 * model. Các test dưới khoá lại đúng hai chỗ đó.
 */

import type { Message } from "@agentweave/types";
import { describe, expect, it } from "vitest";
import { MAX_CHU_THAM_SO, mapTinNhanChoSdk, renderChoOllama } from "../src/render-lich-su";

const LICH_SU_GHI_FILE: Message[] = [
	{ role: "user", content: "viet thue.js" },
	{
		role: "assistant",
		content: [
			{ type: "tool_use", id: "tu_1", name: "FileWrite", input: { path: "thue.js", content: "x" } },
		],
	},
	{
		role: "user",
		content: [
			{ type: "tool_result", tool_use_id: "tu_1", content: "Written 205 bytes to thue.js" },
		],
	},
];

describe("renderChoOllama — đường có ràng buộc phải THẤY lịch sử tool", () => {
	it("giữ được xác nhận ghi file", () => {
		const ra = renderChoOllama(LICH_SU_GHI_FILE);
		const tat = ra.map((m) => m.content).join("\n");
		expect(tat).toContain("Written 205 bytes to thue.js");
		expect(tat).toContain("FileWrite");
	});

	it("không sinh tin nhắn rỗng nào", () => {
		for (const m of renderChoOllama(LICH_SU_GHI_FILE)) {
			expect(m.content.trim()).not.toBe("");
		}
	});

	it("cảnh báo guard tiêm qua tool_result tới được model", () => {
		// Guard chặn lệnh rồi tiêm cảnh báo bằng appendToolResult. Trước đây đó là
		// chuỗi rỗng với model: guard nổ mà chỉ người vận hành thấy.
		const canhBao = "Loop detected: you already made this exact Grep call 3 times";
		const msgs: Message[] = [
			{
				role: "assistant",
				content: [{ type: "tool_use", id: "tu_9", name: "Grep", input: { pattern: "x" } }],
			},
			{
				role: "user",
				content: [{ type: "tool_result", tool_use_id: "tu_9", content: canhBao, is_error: true }],
			},
		];
		const tat = renderChoOllama(msgs)
			.map((m) => m.content)
			.join("\n");
		expect(tat).toContain(canhBao);
		expect(tat).toContain("LOI");
	});

	it("nhãn nối lời gọi với kết quả của nó", () => {
		const ra = renderChoOllama(LICH_SU_GHI_FILE);
		expect(ra[1]!.content).toContain("[GOI TOOL FileWrite t1]");
		expect(ra[2]!.content).toContain("[KET QUA t1]");
	});

	it("rút gọn tham số dài — không nhồi lại nội dung file mỗi lượt", () => {
		const dai = "a".repeat(5_000);
		const msgs: Message[] = [
			{
				role: "assistant",
				content: [
					{ type: "tool_use", id: "t", name: "FileWrite", input: { path: "x.js", content: dai } },
				],
			},
		];
		const ra = renderChoOllama(msgs)[0]!.content;
		expect(ra.length).toBeLessThan(MAX_CHU_THAM_SO + 200);
		// Đường dẫn PHẢI còn — model cần biết nó ghi vào đâu.
		expect(ra).toContain("x.js");
	});
});

describe("mapTinNhanChoSdk — đường stream phải đúng khuôn tool", () => {
	it("tool_result thành tin nhắn role:tool, không phải lời người dùng", () => {
		const ra = mapTinNhanChoSdk(LICH_SU_GHI_FILE);
		const ketQua = ra.find((m) => m.role === "tool");
		expect(ketQua).toBeDefined();
		expect(ketQua!.content).toEqual([
			{
				type: "tool-result",
				toolCallId: "tu_1",
				toolName: "FileWrite",
				result: "Written 205 bytes to thue.js",
			},
		]);
	});

	it("không còn tin nhắn nào mang chuỗi JSON escape của content block", () => {
		for (const m of mapTinNhanChoSdk(LICH_SU_GHI_FILE)) {
			if (typeof m.content === "string") expect(m.content).not.toContain('\\"type\\"');
		}
	});

	it("kết quả lỗi mang cờ isError", () => {
		const msgs: Message[] = [
			{
				role: "assistant",
				content: [{ type: "tool_use", id: "a", name: "Bash", input: {} }],
			},
			{
				role: "user",
				content: [{ type: "tool_result", tool_use_id: "a", content: "boom", is_error: true }],
			},
		];
		const t = mapTinNhanChoSdk(msgs).find((m) => m.role === "tool")!;
		expect((t.content as Array<Record<string, unknown>>)[0]!.isError).toBe(true);
	});

	it("lời gọi mất khỏi lịch sử thì kết quả vẫn đi qua với tên unknown", () => {
		// `chuanHoaCapTool` mới là nơi dọn cặp lệch; chỗ này chỉ dịch khuôn, bỏ
		// lặng một kết quả sẽ giấu mất chính cái lỗi đó.
		const msgs: Message[] = [
			{ role: "user", content: [{ type: "tool_result", tool_use_id: "mat", content: "ok" }] },
		];
		const t = mapTinNhanChoSdk(msgs)[0]!;
		expect(t.role).toBe("tool");
		expect((t.content as Array<Record<string, unknown>>)[0]!.toolName).toBe("unknown");
	});
});
