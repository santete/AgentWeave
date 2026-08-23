/**
 * Test bộ nhận diện "file này thuộc về bài kiểm".
 *
 * Nó phục vụ đúng một việc: cảnh báo khi agent sửa CHÍNH BÀI KIỂM sau lúc bị
 * ép cho cổng xanh. Ép "cho cổng xanh" tạo ra cám dỗ có thật — đo được ngay
 * lần chạy thử đầu: model xoá `process.exit(1)` khỏi bài kiểm rồi báo đạt.
 *
 * Bản đầu viết bằng một regex và BỎ LỌT `test.js` trần ở gốc — một trong
 * những tên phổ biến nhất — nên cảnh báo im lặng đúng lúc cần nhất. Đó là lý
 * do có tệp test này.
 */

import { describe, expect, it } from "vitest";
import { laFileKiem } from "../src/agent-loop";

describe("laFileKiem — nhận đúng file bài kiểm", () => {
	it.each([
		"test.js",
		"tests/a.js",
		"src/foo.test.ts",
		"src/foo.spec.tsx",
		"spec/b.rb",
		"__tests__/c.js",
		"Helpdesk.Tests/DashboardTests.cs",
		"a/b/Tests/X.cs",
	])("nhận: %s", (d) => {
		expect(laFileKiem(d)).toBe(true);
	});

	it.each(["toan.js", "src/index.ts", "src/latest.js", "contest.py", "src/protest/a.ts"])(
		"KHÔNG nhận nhầm: %s",
		(d) => {
			expect(laFileKiem(d)).toBe(false);
		},
	);

	it("dấu gạch ngược của Windows cũng tính là phân cách", () => {
		expect(laFileKiem("src\\tests\\a.cs")).toBe(true);
	});
});
