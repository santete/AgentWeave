/**
 * Test trục "làm ĐÚNG hay SAI".
 *
 * Mọi cơ chế ghì khác đo NHỊP ĐIỆU của agent (lặp, trinh sát mãi, tuyên bố rồi
 * dừng). Không cái nào nhìn thứ nó vừa ghi ra: một file sai cú pháp và một file
 * đúng đều trả về "Written N bytes".
 *
 * Luật quan trọng nhất ở đây là luật IM LẶNG: đuôi không có bộ kiểm phải trả
 * `dat: null`. Báo động giả tệ hơn không báo — model sẽ đi sửa thứ không hỏng.
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cauKemKetQua, kiemCuPhap } from "../src/kiem-cu-phap";

let thuMuc: string;
beforeAll(async () => {
	thuMuc = await mkdtemp(join(tmpdir(), "aw-cu-phap-"));
});
afterAll(async () => {
	await rm(thuMuc, { recursive: true, force: true });
});

async function ghi(ten: string, noi: string): Promise<string> {
	const d = join(thuMuc, ten);
	await writeFile(d, noi, "utf-8");
	return d;
}

describe("kiemCuPhap", () => {
	it("JavaScript hỏng cú pháp → không đạt, kèm thông báo", async () => {
		const kq = await kiemCuPhap(await ghi("hong.js", "const a = (;\n"));
		expect(kq.dat).toBe(false);
		expect(kq.thongBao).toMatch(/SyntaxError|Unexpected/);
	});

	it("JavaScript dùng cú pháp module KHÔNG bị báo giả", async () => {
		// Node 22 tự nhận diện cú pháp module. Nếu chỗ này đỏ nghĩa là bộ kiểm
		// đang phạt mọi file ESM trong dự án — báo động giả hàng loạt.
		const kq = await kiemCuPhap(await ghi("esm.js", 'import x from "y";\nexport default x;\n'));
		expect(kq.dat).toBe(true);
	});

	it("JSON hỏng → không đạt", async () => {
		const kq = await kiemCuPhap(await ghi("hong.json", '{"a": }'));
		expect(kq.dat).toBe(false);
	});

	it("JSON đúng → đạt", async () => {
		expect((await kiemCuPhap(await ghi("ok.json", '{"a": 1}'))).dat).toBe(true);
	});

	it("TypeScript hỏng cú pháp → không đạt, có số dòng", async () => {
		const kq = await kiemCuPhap(await ghi("hong.ts", "function f(: string {}\n"));
		expect(kq.dat).toBe(false);
		expect(kq.thongBao).toMatch(/:1/);
	});

	it("TypeScript chỉ SAI KIỂU thì vẫn đạt — đây là kiểm cú pháp, không kiểm kiểu", async () => {
		// Cố ý: kiểm kiểu một file lẻ ngoài ngữ cảnh dự án sinh hàng loạt lỗi
		// "không tìm thấy module". Báo động giả đẩy model đi sửa thứ không hỏng.
		const kq = await kiemCuPhap(await ghi("saikieu.ts", 'const n: number = "chuoi";\n'));
		expect(kq.dat).toBe(true);
	});

	it("import không phân giải được vẫn đạt", async () => {
		const kq = await kiemCuPhap(await ghi("nhap.ts", 'import { x } from "./khong-ton-tai";\nx;\n'));
		expect(kq.dat).toBe(true);
	});

	it("đuôi không có bộ kiểm → IM LẶNG (dat null)", async () => {
		expect((await kiemCuPhap(await ghi("doc.md", "# tieu de"))).dat).toBeNull();
		expect((await kiemCuPhap(await ghi("a.txt", "gi do"))).dat).toBeNull();
	});

	it("file không tồn tại không làm nổ lượt", async () => {
		const kq = await kiemCuPhap(join(thuMuc, "khong-co.ts"));
		expect(kq.dat).toBeNull();
	});
});

describe("cauKemKetQua", () => {
	it("bỏ qua thì không thêm chữ nào", () => {
		expect(cauKemKetQua({ dat: null })).toBe("");
	});

	it("đạt cũng nói — model cần BẰNG CHỨNG để trích dẫn, không chỉ cần cảnh báo", () => {
		expect(cauKemKetQua({ dat: true })).toContain("SYNTAX OK");
	});

	it("không đạt thì cấm báo xong", () => {
		const c = cauKemKetQua({ dat: false, thongBao: "boom" });
		expect(c).toContain("SYNTAX ERROR");
		expect(c).toContain("boom");
		expect(c).toContain("do NOT report the task as done");
	});
});
