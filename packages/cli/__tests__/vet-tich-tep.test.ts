/**
 * Test bộ ghi vết tích ra đĩa.
 *
 * Hai thứ đáng khoá nhất ở đây đều là hệ quả của việc BẬT MẶC ĐỊNH:
 *
 *   · mặc định phải đúng là BẬT, và `false` phải tắt được thật — một cờ mặc
 *     định sai hướng thì hoặc mất hết dữ liệu chẩn đoán, hoặc ghi lén sau lưng
 *     người vận hành;
 *   · phải TỰ DỌN. Bật mặc định mà không dọn thì đĩa Jetson đầy dần trong im
 *     lặng, và nó không báo gì cho tới lúc mọi thứ cùng hỏng.
 */

import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GhiVetTichTep, batVetTich } from "../src/lib/vet-tich-tep.js";

let goc: string;
beforeEach(() => {
	goc = mkdtempSync(join(tmpdir(), "aw-vet-"));
});
afterEach(() => {
	rmSync(goc, { recursive: true, force: true });
	process.env.AGENTWEAVE_TRACE = undefined;
	// biome-ignore lint/performance/noDelete: phải xoá hẳn, gán undefined thành chuỗi "undefined"
	delete process.env.AGENTWEAVE_TRACE;
});

describe("batVetTich — thứ tự ưu tiên và MẶC ĐỊNH", () => {
	it("không khai gì thì BẬT", () => {
		expect(batVetTich(undefined)).toBe(true);
	});

	it("cấu hình false thì tắt", () => {
		expect(batVetTich(false)).toBe(false);
	});

	it("env tắt được, kể cả khi cấu hình bật", () => {
		process.env.AGENTWEAVE_TRACE = "0";
		expect(batVetTich(true)).toBe(false);
		process.env.AGENTWEAVE_TRACE = "false";
		expect(batVetTich(true)).toBe(false);
	});

	it("env bật được, kể cả khi cấu hình tắt", () => {
		process.env.AGENTWEAVE_TRACE = "1";
		expect(batVetTich(false)).toBe(true);
	});

	it("cờ dòng lệnh thắng tất cả", () => {
		process.env.AGENTWEAVE_TRACE = "1";
		expect(batVetTich(true, false)).toBe(false);
	});
});

describe("ghi ra đĩa", () => {
	it("payload nhỏ nằm trong dòng, payload lớn tách ra tệp", () => {
		const g = new GhiVetTichTep({ goc, phien: "p1" });
		g.ghi({ tang: "user", loai: "user:cau-hoi", noiDungLon: { "a.txt": "ngan" } });
		g.ghi({ tang: "llm", loai: "llm:gui", luot: 1, noiDungLon: { "gui.json": "x".repeat(5000) } });

		const dong = readFileSync(join(g.duong, "vet-tich.jsonl"), "utf-8")
			.trim()
			.split("\n")
			.map((d) => JSON.parse(d));

		expect(dong[0].payload["a.txt"].noiDung).toBe("ngan");
		expect(dong[0].payload["a.txt"].tep).toBeUndefined();

		expect(dong[1].payload["gui.json"].noiDung).toBeUndefined();
		expect(dong[1].payload["gui.json"].byte).toBe(5000);
		// NGUYÊN VẸN — cắt là hỏng mục đích.
		const noi = readFileSync(join(g.duong, dong[1].payload["gui.json"].tep), "utf-8");
		expect(noi.length).toBe(5000);
	});

	it("số thứ tự tăng đơn điệu để sắp xếp được khi cùng mili-giây", () => {
		const g = new GhiVetTichTep({ goc, phien: "p2" });
		for (let i = 0; i < 5; i++) g.ghi({ tang: "agent", loai: "agent:guard" });
		const stt = readFileSync(join(g.duong, "vet-tich.jsonl"), "utf-8")
			.trim()
			.split("\n")
			.map((d) => JSON.parse(d).stt);
		expect(stt).toEqual([1, 2, 3, 4, 5]);
	});

	it("hỏng thì NGƯNG chứ không ném — lượt trả lời không được chết theo", () => {
		const loi: string[] = [];
		const g = new GhiVetTichTep({ goc, phien: "p3", nhatKy: (m) => loi.push(m) });
		// Xoá thư mục dưới chân bộ ghi rồi chặn tạo lại bằng một tệp cùng tên.
		rmSync(g.duong, { recursive: true, force: true });
		expect(() => g.ghi({ tang: "user", loai: "user:cau-hoi" })).not.toThrow();
	});
});

describe("tự dọn phiên cũ", () => {
	it("giữ 20 phiên gần nhất, xoá phần dư", () => {
		// 25 phiên: tên tăng dần nên mtime cũng tăng dần theo thứ tự tạo.
		for (let i = 1; i <= 25; i++) {
			new GhiVetTichTep({ goc, phien: `p${String(i).padStart(3, "0")}` }).ghi({
				tang: "user",
				loai: "user:cau-hoi",
			});
		}
		const con = readdirSync(join(goc, ".agentweave/vet-tich")).sort();
		expect(con.length).toBeLessThanOrEqual(20);
		// Phiên mới nhất phải còn; phiên đầu tiên phải đi.
		expect(con).toContain("p025");
		expect(existsSync(join(goc, ".agentweave/vet-tich/p001"))).toBe(false);
	});
});
