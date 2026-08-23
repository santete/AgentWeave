/**
 * Test đường ảnh đi vào model.
 *
 * Bản trước JSON.stringify cả prompt, nên ảnh biến thành chuỗi JSON và mất hẳn
 * với model thị giác — báo xanh mà sai: agent nhận "ảnh" nhưng model chỉ thấy
 * `{"type":"image",...}`. Test khoá lại: khối ảnh phải thành "parts" đa phương
 * thức, còn mọi thứ khác giữ nguyên cách cũ.
 */

import type { ContentBlock, Message } from "@agentweave/types";
import { describe, expect, it } from "vitest";
import { mapTinNhanChoSdk, thayChu, trichChu } from "../src/agent-loop";

const anh: ContentBlock = { type: "image", image: "AAAABBBB", mimeType: "image/png" };

describe("trichChu — trích phần chữ để kiểm duyệt", () => {
	it("nối các khối chữ, bỏ ảnh", () => {
		const khoi: ContentBlock[] = [{ type: "text", text: "xem ảnh này" }, anh];
		expect(trichChu(khoi)).toBe("xem ảnh này");
	});

	it("prompt chỉ có ảnh thì chữ rỗng", () => {
		expect(trichChu([anh])).toBe("");
	});
});

describe("thayChu — cổng biến đổi chữ, GIỮ ảnh", () => {
	it("thay khối chữ đầu, ảnh còn nguyên", () => {
		const ra = thayChu([{ type: "text", text: "gốc" }, anh], "đã kiểm duyệt");
		expect(ra).toEqual([{ type: "text", text: "đã kiểm duyệt" }, anh]);
	});

	it("prompt chỉ có ảnh thì chèn khối chữ lên đầu", () => {
		const ra = thayChu([anh], "chú thích");
		expect(ra[0]).toEqual({ type: "text", text: "chú thích" });
		expect(ra[1]).toBe(anh);
	});
});

describe("mapTinNhanChoSdk — dựng parts đa phương thức", () => {
	it("tin nhắn chữ thuần giữ nguyên là chuỗi", () => {
		const msgs: Message[] = [{ role: "user", content: "chào" }];
		expect(mapTinNhanChoSdk(msgs)).toEqual([{ role: "user", content: "chào" }]);
	});

	it("người dùng + ảnh → mảng part text và image", () => {
		const msgs: Message[] = [
			{ role: "user", content: [{ type: "text", text: "lỗi gì đây?" }, anh] },
		];
		const ra = mapTinNhanChoSdk(msgs);
		expect(ra[0].role).toBe("user");
		expect(ra[0].content).toEqual([
			{ type: "text", text: "lỗi gì đây?" },
			{ type: "image", image: "AAAABBBB", mimeType: "image/png" },
		]);
	});

	it("ảnh không có mimeType thì part không kèm mimeType", () => {
		const msgs: Message[] = [{ role: "user", content: [{ type: "image", image: "XXXX" }] }];
		const ra = mapTinNhanChoSdk(msgs);
		expect(ra[0].content).toEqual([{ type: "image", image: "XXXX" }]);
	});

	it("tool_use thành part tool-call, KHÔNG phải chuỗi JSON", () => {
		// Bản cũ `JSON.stringify` cả mảng rồi giữ role "user": model đọc lời gọi
		// của CHÍNH NÓ như lời người dùng, dưới khuôn nó chưa từng được huấn luyện.
		const msgs: Message[] = [
			{
				role: "assistant",
				content: [{ type: "tool_use", id: "1", name: "Bash", input: { command: "ls" } }],
			},
		];
		const ra = mapTinNhanChoSdk(msgs);
		expect(ra[0].role).toBe("assistant");
		expect(ra[0].content).toEqual([
			{ type: "tool-call", toolCallId: "1", toolName: "Bash", args: { command: "ls" } },
		]);
	});

	it("ảnh ở tin nhắn assistant thành chữ, KHÔNG thành part ảnh", () => {
		// Không API nào nhận part ảnh trong lượt assistant, nhưng bỏ hẳn thì model
		// mất dấu vết lượt đó có ảnh.
		const msgs: Message[] = [{ role: "assistant", content: [anh] }];
		expect(mapTinNhanChoSdk(msgs)[0].content).toEqual([{ type: "text", text: "[anh dinh kem]" }]);
	});
});
