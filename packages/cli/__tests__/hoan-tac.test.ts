/**
 * Test khôi phục khi hoàn tác.
 *
 * Trọng tâm: phân biệt "file vốn có, agent sửa" với "file vốn KHÔNG có, agent
 * tạo mới". Hoàn tác hai trường hợp này khác nhau — khôi phục nội dung cũ vs
 * xoá hẳn. Nhầm là để lại rác trên đĩa mà không ai truy được nguồn.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, writeFile, readFile, rm, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { apDungHoanTac } from "../src/lib/hoan-tac.js";

let goc: string;
beforeEach(async () => {
	goc = await mkdtemp(join(tmpdir(), "aw-undo-"));
});
afterEach(async () => {
	await rm(goc, { recursive: true, force: true }).catch(() => undefined);
});

const coFile = async (p: string) =>
	access(join(goc, p))
		.then(() => true)
		.catch(() => false);

describe("apDungHoanTac", () => {
	it("file có sẵn bị sửa → khôi phục nội dung cũ", async () => {
		await writeFile(join(goc, "a.txt"), "BẢN MỚI của agent");
		const kq = await apDungHoanTac(goc, { path: "a.txt", truocDo: "ban goc\n" });

		expect(kq.daXoa).toBe(false);
		expect(await readFile(join(goc, "a.txt"), "utf-8")).toBe("ban goc\n");
	});

	it("file agent TẠO MỚI → xoá hẳn, KHÔNG để lại file rỗng", async () => {
		await writeFile(join(goc, "moi.txt"), "agent vua tao");
		const kq = await apDungHoanTac(goc, { path: "moi.txt", truocDo: null });

		expect(kq.daXoa).toBe(true);
		expect(await coFile("moi.txt")).toBe(false);
	});

	it("khôi phục file trong thư mục con chưa tồn tại", async () => {
		// Agent có thể đã tạo cả cây thư mục; khôi phục phải dựng lại đường dẫn.
		const kq = await apDungHoanTac(goc, { path: "sub/dir/b.ts", truocDo: "noi dung\n" });
		expect(kq.daXoa).toBe(false);
		expect(await readFile(join(goc, "sub/dir/b.ts"), "utf-8")).toBe("noi dung\n");
	});

	it("xoá file vốn không tồn tại thì im lặng, không nổ", async () => {
		const kq = await apDungHoanTac(goc, { path: "chua-tung-co.txt", truocDo: null });
		expect(kq.daXoa).toBe(true);
		expect(await coFile("chua-tung-co.txt")).toBe(false);
	});
});
