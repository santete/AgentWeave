/**
 * Test bộ dựng diff hiện trước khi ghi file.
 *
 * Trọng tâm: diff phải ĐÚNG. Duyệt dựa trên diff sai còn tệ hơn không có diff,
 * vì người dùng tưởng mình đã kiểm tra.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dungDiff } from "../src/lib/diff.js";

let thuMuc: string;

/** Bỏ mã màu ANSI để so khớp cho dễ đọc. */
const sach = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

beforeAll(async () => {
	thuMuc = await mkdtemp(join(tmpdir(), "aw-diff-"));
	await writeFile(join(thuMuc, "a.js"), "mot\nhai\nba\nbon\nnam\n");
});

afterAll(async () => {
	await rm(thuMuc, { recursive: true, force: true });
});

describe("dungDiff — FileEdit", () => {
	it("đếm đúng số dòng thêm và bớt", async () => {
		const d = await dungDiff(
			"FileEdit",
			{ path: "a.js", old_string: "hai", new_string: "HAI DOI ROI" },
			thuMuc,
		);

		expect(d).not.toBeNull();
		expect(d!.them).toBe(1);
		expect(d!.bot).toBe(1);
		expect(sach(d!.text)).toContain("- hai");
		expect(sach(d!.text)).toContain("+ HAI DOI ROI");
	});

	it("giữ dòng ngữ cảnh quanh chỗ đổi", async () => {
		const d = await dungDiff(
			"FileEdit",
			{ path: "a.js", old_string: "ba", new_string: "BA" },
			thuMuc,
		);

		const t = sach(d!.text);
		expect(t).toContain("  hai"); // ngữ cảnh trước
		expect(t).toContain("  bon"); // ngữ cảnh sau
	});

	it("báo trước khi đoạn cần thay KHÔNG có trong file", async () => {
		// Không báo thì người dùng duyệt một lời gọi chắc chắn thất bại.
		const d = await dungDiff(
			"FileEdit",
			{ path: "a.js", old_string: "khong-he-ton-tai", new_string: "x" },
			thuMuc,
		);

		expect(sach(d!.text)).toContain("không tìm thấy đoạn cần thay");
		expect(d!.them).toBe(0);
	});

	it("thay bằng chuỗi y hệt thì báo không đổi", async () => {
		const d = await dungDiff(
			"FileEdit",
			{ path: "a.js", old_string: "ba", new_string: "ba" },
			thuMuc,
		);
		expect(d!.text).toBe("");
		expect(d!.them).toBe(0);
		expect(d!.bot).toBe(0);
	});

	it("FileEdit trên file chưa tồn tại trả null — để tool tự báo lỗi", async () => {
		const d = await dungDiff(
			"FileEdit",
			{ path: "chua-co.js", old_string: "a", new_string: "b" },
			thuMuc,
		);
		expect(d).toBeNull();
	});
});

describe("dungDiff — FileWrite", () => {
	it("file mới được đánh dấu là tạo mới", async () => {
		const d = await dungDiff("FileWrite", { path: "moi.js", content: "x\ny\n" }, thuMuc);

		expect(d!.taoMoi).toBe(true);
		expect(d!.bot).toBe(0);
		expect(d!.them).toBeGreaterThan(0);
		expect(sach(d!.text)).toContain("(tạo mới)");
	});

	it("ghi đè file có sẵn hiện cả phần mất đi", async () => {
		const d = await dungDiff("FileWrite", { path: "a.js", content: "mot\nhai\n" }, thuMuc);

		expect(d!.taoMoi).toBe(false);
		expect(d!.bot).toBe(3); // ba, bon, nam
		expect(sach(d!.text)).toContain("- ba");
	});

	it("ghi nội dung y hệt thì báo không đổi", async () => {
		const d = await dungDiff(
			"FileWrite",
			{ path: "a.js", content: "mot\nhai\nba\nbon\nnam\n" },
			thuMuc,
		);
		expect(d!.text).toBe("");
	});
});

describe("dungDiff — trường hợp không áp dụng", () => {
	it("tool không phải ghi file trả null", async () => {
		expect(await dungDiff("Bash", { command: "ls" }, thuMuc)).toBeNull();
		expect(await dungDiff("FileRead", { path: "a.js" }, thuMuc)).toBeNull();
	});

	it("thiếu tham số trả null thay vì ném lỗi", async () => {
		expect(await dungDiff("FileWrite", {}, thuMuc)).toBeNull();
		expect(await dungDiff("FileWrite", { path: "a.js" }, thuMuc)).toBeNull();
		expect(await dungDiff("FileEdit", { path: "a.js", old_string: "a" }, thuMuc)).toBeNull();
	});

	it("file lớn vẫn dựng được diff, không treo", async () => {
		const to = Array.from({ length: 3000 }, (_, i) => `dong ${i}`).join("\n");
		await writeFile(join(thuMuc, "to.js"), to);

		const d = await dungDiff(
			"FileWrite",
			{ path: "to.js", content: `${to}\nthem mot dong` },
			thuMuc,
		);

		expect(d!.them).toBe(1);
		// Trần in ra phải chặn diff khổng lồ làm trôi màn hình.
		expect(sach(d!.text).split("\n").length).toBeLessThan(140);
	});
});
