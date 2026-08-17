/**
 * Test chặn ghi đè mù.
 *
 * Hai kịch bản mất dữ liệu mà không cơ chế nào khác bắt được:
 *   ① agent ghi đè file nó chưa từng đọc
 *   ② file bị người khác sửa sau khi agent đọc, agent vẫn ghi đè bằng bản cũ
 * Cả hai đều chạy trót lọt và báo thành công — chỉ nội dung là sai.
 */

import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolContext } from "@agentweave/types";
import { FileReadTool, FileWriteTool, FileEditTool } from "../src/built-in-tools/index";
import { xoaHetDauVet } from "../src/file-access-tracker";

let thuMuc: string;

function ctx(phien = "phien-1"): ToolContext {
	return { sessionId: phien, agentId: "a", cwd: thuMuc, signal: new AbortController().signal };
}

beforeEach(async () => {
	xoaHetDauVet();
	thuMuc = await mkdtemp(join(tmpdir(), "aw-ghide-"));
	await writeFile(join(thuMuc, "co-san.txt"), "noi dung quan trong\ndong hai\n");
});

afterAll(async () => {
	await rm(thuMuc, { recursive: true, force: true }).catch(() => undefined);
});

describe("FileWrite — chặn đè lên file chưa đọc", () => {
	it("từ chối ghi đè file có sẵn mà agent chưa đọc", async () => {
		await expect(
			FileWriteTool.execute({ path: "co-san.txt", content: "doan model tu doan" }, ctx()),
		).rejects.toThrow(/has not been read in this session/);

		// Quan trọng: nội dung gốc phải còn nguyên.
		expect(await readFile(join(thuMuc, "co-san.txt"), "utf-8")).toContain("noi dung quan trong");
	});

	it("đọc trước rồi ghi thì cho phép", async () => {
		await FileReadTool.execute({ path: "co-san.txt" }, ctx());
		await FileWriteTool.execute({ path: "co-san.txt", content: "noi dung moi" }, ctx());

		expect(await readFile(join(thuMuc, "co-san.txt"), "utf-8")).toBe("noi dung moi");
	});

	it("tạo file MỚI thì không chặn — không đè lên gì cả", async () => {
		await FileWriteTool.execute({ path: "hoan-toan-moi.txt", content: "xin chao" }, ctx());
		expect(await readFile(join(thuMuc, "hoan-toan-moi.txt"), "utf-8")).toBe("xin chao");
	});
});

describe("FileWrite — chặn khi file đã đổi sau lúc đọc", () => {
	it("người khác sửa file giữa chừng thì từ chối ghi đè", async () => {
		await FileReadTool.execute({ path: "co-san.txt" }, ctx());

		// Ai đó sửa file: người dùng, git checkout, hay một tiến trình build.
		await writeFile(join(thuMuc, "co-san.txt"), "THAY DOI CUA NGUOI KHAC\n");

		await expect(
			FileWriteTool.execute({ path: "co-san.txt", content: "ban cu cua agent" }, ctx()),
		).rejects.toThrow(/changed on disk after you read it/);

		// Thay đổi của người khác KHÔNG bị mất.
		expect(await readFile(join(thuMuc, "co-san.txt"), "utf-8")).toBe("THAY DOI CUA NGUOI KHAC\n");
	});

	it("đọc lại rồi ghi thì được", async () => {
		await FileReadTool.execute({ path: "co-san.txt" }, ctx());
		await writeFile(join(thuMuc, "co-san.txt"), "ban moi tu ngoai\n");

		await FileReadTool.execute({ path: "co-san.txt" }, ctx()); // đọc lại
		await FileWriteTool.execute({ path: "co-san.txt", content: "ok roi" }, ctx());

		expect(await readFile(join(thuMuc, "co-san.txt"), "utf-8")).toBe("ok roi");
	});

	it("thông báo lỗi nói rõ phải làm gì để sửa", async () => {
		// Model phải tự khắc phục được ở lượt sau, không cần người can thiệp.
		await expect(
			FileWriteTool.execute({ path: "co-san.txt", content: "x" }, ctx()),
		).rejects.toThrow(/Call FileRead on it first/);
	});
});

describe("FileEdit", () => {
	it("sửa được mà không cần đọc trước — nó tự đọc lại và đòi khớp duy nhất", async () => {
		await FileEditTool.execute(
			{ path: "co-san.txt", old_string: "dong hai", new_string: "DONG HAI" },
			ctx(),
		);

		expect(await readFile(join(thuMuc, "co-san.txt"), "utf-8")).toContain("DONG HAI");
	});

	it("sau khi FileEdit thì FileWrite không bị chặn oan", async () => {
		await FileEditTool.execute(
			{ path: "co-san.txt", old_string: "dong hai", new_string: "x" },
			ctx(),
		);
		await FileWriteTool.execute({ path: "co-san.txt", content: "ghi tiep" }, ctx());

		expect(await readFile(join(thuMuc, "co-san.txt"), "utf-8")).toBe("ghi tiep");
	});
});

describe("Cách ly giữa các phiên", () => {
	it("phiên A đọc KHÔNG cho phép phiên B ghi đè", async () => {
		await FileReadTool.execute({ path: "co-san.txt" }, ctx("phien-A"));

		await expect(
			FileWriteTool.execute({ path: "co-san.txt", content: "x" }, ctx("phien-B")),
		).rejects.toThrow(/has not been read in this session/);
	});
});
