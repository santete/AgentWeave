/**
 * Test dịch lỗi hạ tầng thành chỉ dẫn.
 *
 * Trong khu cô lập, một dòng "fetch failed" không dịch ra sẽ khiến dev tưởng
 * agent hỏng thay vì Ollama chưa bật. Nhưng dịch NHẦM còn tệ hơn — dẫn đi sai
 * hướng — nên test cả hai chiều: nhận đúng lỗi quen, và trả nguyên văn lỗi lạ.
 */

import { describe, it, expect, afterEach } from "vitest";
import { chanDoan, moTaLoi } from "../src/lib/chan-doan-loi.js";

const hostCu = process.env.OLLAMA_HOST;
afterEach(() => {
	if (hostCu === undefined) delete process.env.OLLAMA_HOST;
	else process.env.OLLAMA_HOST = hostCu;
});

describe("chanDoan — nhận lỗi hạ tầng quen", () => {
	it("Ollama chưa chạy: ECONNREFUSED", () => {
		const cd = chanDoan("connect ECONNREFUSED 127.0.0.1:11434");
		expect(cd?.tomTat).toMatch(/Không kết nối được tới Ollama/);
		expect(cd?.buoc.some((b) => b.includes("ollama ps"))).toBe(true);
	});

	it("Ollama chưa chạy: fetch failed (undici bọc lại)", () => {
		expect(chanDoan("TypeError: fetch failed")?.tomTat).toMatch(/Không kết nối được/);
	});

	it("host sai dạng: ENOTFOUND", () => {
		expect(chanDoan("getaddrinfo ENOTFOUND ollama-host")?.tomTat).toMatch(/phân giải/);
	});

	it("model chưa nạp", () => {
		const cd = chanDoan('model "qwen3-coder:30b" not found, try pulling it first');
		expect(cd?.tomTat).toMatch(/Model chưa có/);
		// Nhắc KHÔNG pull trong khu cô lập — không có mạng.
		expect(cd?.buoc.some((b) => b.includes("KHÔNG"))).toBe(true);
	});

	it("Ollama treo: timeout", () => {
		expect(chanDoan("request timed out after 30000ms")?.tomTat).toMatch(/không trả lời kịp/);
	});

	it("chèn đúng host đang cấu hình vào chỉ dẫn", () => {
		process.env.OLLAMA_HOST = "10.0.0.5:11434";
		expect(chanDoan("ECONNREFUSED")?.tomTat).toContain("10.0.0.5:11434");
	});
});

describe("chanDoan — KHÔNG đoán bừa lỗi lạ", () => {
	it("lỗi không nhận ra thì trả null", () => {
		expect(chanDoan("Something completely unexpected happened")).toBeNull();
		expect(chanDoan("SyntaxError: unexpected token")).toBeNull();
	});
});

describe("moTaLoi — ghép cho CLI", () => {
	it("lỗi quen: có tóm tắt + các bước đánh số", () => {
		const s = moTaLoi("ECONNREFUSED");
		expect(s).toMatch(/Không kết nối được/);
		expect(s).toMatch(/1\. /);
	});

	it("lỗi lạ: trả nguyên văn, không thêm thắt", () => {
		expect(moTaLoi("weird error xyz")).toBe("weird error xyz");
	});
});
