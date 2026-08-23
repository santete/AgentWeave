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
	it("lần đầu từ chối nhưng ĐƯA nội dung hiện tại (đọc hộ); lần hai cho ghi", async () => {
		// Hợp đồng mới: từ chối suông thì model lì không chịu FileRead (đo thật kẹt
		// 4 lần). Giờ guard đính nội dung + tính là đã-đọc → lần ghi sau qua ngay.
		await expect(
			FileWriteTool.execute({ path: "co-san.txt", content: "doan model tu doan" }, ctx()),
		).rejects.toThrow(/Cannot overwrite .*blindly[\s\S]*noi dung quan trong/);

		// Nội dung gốc phải còn nguyên sau lần từ chối.
		expect(await readFile(join(thuMuc, "co-san.txt"), "utf-8")).toContain("noi dung quan trong");

		// Lần hai: đã "thấy" nội dung → được ghi.
		const kq = await FileWriteTool.execute(
			{ path: "co-san.txt", content: "ban moi sau khi da thay noi dung cu" },
			ctx(),
		);
		expect(kq).toContain("Written");
		// Trả lại file gốc cho các test sau trong suite dùng chung.
		const { writeFile } = await import("node:fs/promises");
		await writeFile(join(thuMuc, "co-san.txt"), "noi dung quan trong\n", "utf-8");
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
		// Model phải tự khắc phục được ở lượt sau, không cần người can thiệp:
		// thông báo chứa nội dung hiện tại + nói rõ lần ghi sau sẽ qua.
		await expect(
			FileWriteTool.execute({ path: "co-san.txt", content: "x" }, ctx()),
		).rejects.toThrow(/now counts as read[\s\S]*re-issue FileWrite|Cannot overwrite/);
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

	// ĐỔI HÀNH VI (trước đây test này khẳng định ngược lại).
	//
	// Cũ: FileEdit mù xong thì FileWrite được ghi đè cả file, lý do "không chặn
	// oan". Nhưng agent chưa hề đọc file — nó mới thấy đúng đoạn old_string khớp.
	// Ghi đè toàn bộ lúc đó xoá sạch phần nó chưa từng nhìn thấy, im lặng.
	//
	// Mới: chặn, và bảo nó đọc trước. FileEdit vẫn sửa tiếp được bình thường.
	it("FileEdit mù KHÔNG mở đường cho FileWrite đè cả file", async () => {
		await FileEditTool.execute(
			{ path: "co-san.txt", old_string: "dong hai", new_string: "x" },
			ctx(),
		);

		await expect(
			FileWriteTool.execute({ path: "co-san.txt", content: "ghi tiep" }, ctx()),
		).rejects.toThrow(/only read PART of this file/);

		// Dòng đầu — thứ agent chưa bao giờ nhìn thấy — còn nguyên.
		expect(await readFile(join(thuMuc, "co-san.txt"), "utf-8")).toContain("noi dung quan trong");
	});

	it("đọc đủ rồi FileEdit thì FileWrite vẫn được phép", async () => {
		await FileReadTool.execute({ path: "co-san.txt" }, ctx());
		await FileEditTool.execute(
			{ path: "co-san.txt", old_string: "dong hai", new_string: "x" },
			ctx(),
		);
		await FileWriteTool.execute({ path: "co-san.txt", content: "ghi tiep" }, ctx());

		expect(await readFile(join(thuMuc, "co-san.txt"), "utf-8")).toBe("ghi tiep");
	});
});

/**
 * Đọc thiếu là kiểu mất dữ liệu KHÔNG để lại dấu vết trên đĩa: mtime và size
 * vẫn khớp hoàn hảo, nên hai lớp chặn ở trên không thấy gì cả.
 */
describe("FileWrite — chặn khi mới đọc được một phần", () => {
	it("đọc theo khoảng dòng rồi ghi đè cả file thì bị chặn", async () => {
		await FileReadTool.execute({ path: "co-san.txt", offset: 1, limit: 1 }, ctx());

		await expect(
			FileWriteTool.execute({ path: "co-san.txt", content: "chi con dong hai" }, ctx()),
		).rejects.toThrow(/only read PART of this file/);

		expect(await readFile(join(thuMuc, "co-san.txt"), "utf-8")).toContain("noi dung quan trong");
	});

	it("khoảng đọc phủ hết file thì không tính là thiếu", async () => {
		await FileReadTool.execute({ path: "co-san.txt", offset: 0, limit: 9999 }, ctx());
		await FileWriteTool.execute({ path: "co-san.txt", content: "ok" }, ctx());

		expect(await readFile(join(thuMuc, "co-san.txt"), "utf-8")).toBe("ok");
	});

	it("đọc lại cho đủ thì gỡ được chặn", async () => {
		await FileReadTool.execute({ path: "co-san.txt", offset: 1, limit: 1 }, ctx());
		await FileReadTool.execute({ path: "co-san.txt" }, ctx());
		await FileWriteTool.execute({ path: "co-san.txt", content: "ok" }, ctx());

		expect(await readFile(join(thuMuc, "co-san.txt"), "utf-8")).toBe("ok");
	});

	it("file vượt trần 200 KB: output NÓI RÕ đã cắt, và chặn ghi đè", async () => {
		const to = "x".repeat(250_000);
		await writeFile(join(thuMuc, "khong-lo.txt"), to);

		const ra = await FileReadTool.execute({ path: "khong-lo.txt" }, ctx());

		// Bản cũ cắt im lặng — model tưởng đã thấy hết file.
		expect(ra).toContain("PARTIAL READ");
		expect(ra).toContain("250000");

		await expect(
			FileWriteTool.execute({ path: "khong-lo.txt", content: "ngan" }, ctx()),
		).rejects.toThrow(/only read PART of this file/);

		expect((await readFile(join(thuMuc, "khong-lo.txt"), "utf-8")).length).toBe(250_000);
	});

	it("file dưới trần thì đọc đủ, không có cảnh báo thừa", async () => {
		const ra = await FileReadTool.execute({ path: "co-san.txt" }, ctx());
		expect(ra).not.toContain("PARTIAL READ");
		expect(ra).toBe("noi dung quan trong\ndong hai\n");
	});
});

describe("Cách ly giữa các phiên", () => {
	it("phiên A đọc KHÔNG cho phép phiên B ghi đè", async () => {
		await FileReadTool.execute({ path: "co-san.txt" }, ctx("phien-A"));

		await expect(
			FileWriteTool.execute({ path: "co-san.txt", content: "x" }, ctx("phien-B")),
		).rejects.toThrow(/Cannot overwrite|has not been read/);
	});
});
