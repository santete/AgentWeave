/**
 * Test hồi quy cho ca hỏng THẬT đã đo được.
 *
 * Nguồn: `.agentweave/vet-tich/20260823-171947` trên một solution .NET. Cả
 * buổi 9 câu hỏi chỉ sửa nổi ĐÚNG MỘT file, và biến số duy nhất phân biệt
 * thành công với thất bại là dòng kết thúc:
 *
 *   Helpdesk.Infrastructure.csproj   LF, không BOM   → sửa được
 *   Helpdesk.Domain.csproj           BOM + CRLF      → "String not found"
 *
 * Model đã ĐỌC ĐÚNG file trước đó nhưng dựng lại `old_string` bằng LF không
 * BOM — vì `\r` và BOM vô hình với nó. Rồi vì thông báo lỗi không nói khác chỗ
 * nào, nó kết luận "tôi không có quyền truy cập đầy đủ" trong khi vết tích ghi
 * 16 quyết định quyền và KHÔNG một lần từ chối.
 *
 * Các chuỗi dưới đây chép nguyên từ vết tích.
 */

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolContext } from "@agentweave/types";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FileEditTool } from "../src/built-in-tools/file-edit";

let thuMuc: string;
let ctx: ToolContext;

beforeEach(async () => {
	thuMuc = await mkdtemp(join(tmpdir(), "aw-crlf-"));
	ctx = { cwd: thuMuc, sessionId: `s_${Date.now()}` } as unknown as ToolContext;
});
afterEach(async () => {
	await rm(thuMuc, { recursive: true, force: true });
});

/** Đúng nội dung `Helpdesk.Domain.csproj` như FileRead đã trả về ở #103. */
const CSPROJ_CRLF_BOM =
	'﻿<Project Sdk="Microsoft.NET.Sdk">\r\n\r\n  <PropertyGroup>\r\n' +
	"    <TargetFramework>net8.0</TargetFramework>\r\n" +
	"    <ImplicitUsings>enable</ImplicitUsings>\r\n" +
	"    <Nullable>enable</Nullable>\r\n  </PropertyGroup>\r\n\r\n</Project>\r\n";

/** Đúng `old_string` model gửi ở #115 — LF, không BOM. */
const MODEL_GUI =
	'<Project Sdk="Microsoft.NET.Sdk">\n\n  <PropertyGroup>\n' +
	"    <TargetFramework>net8.0</TargetFramework>\n" +
	"    <ImplicitUsings>enable</ImplicitUsings>\n" +
	"    <Nullable>enable</Nullable>\n  </PropertyGroup>\n\n</Project>";

async function chay(ten: string, noi: string, cu: string, moi: string): Promise<string> {
	await writeFile(join(thuMuc, ten), noi, "utf-8");
	return (await FileEditTool.execute(
		{ path: ten, old_string: cu, new_string: moi },
		ctx,
	)) as string;
}

describe("FileEdit — BOM và CRLF", () => {
	it("CA HỎNG THẬT: old_string dạng LF khớp được file BOM+CRLF", async () => {
		const moi = MODEL_GUI.replace(
			"  </PropertyGroup>",
			"    <RootNamespace>Helpdesk.Domain</RootNamespace>\n  </PropertyGroup>",
		);
		const kq = await chay("Domain.csproj", CSPROJ_CRLF_BOM, MODEL_GUI, moi);
		expect(kq).toContain("Edited");

		const sau = await readFile(join(thuMuc, "Domain.csproj"), "utf-8");
		expect(sau).toContain("RootNamespace");
		// GIỮ NGUYÊN định dạng gốc — sửa một dòng mà đổi cả file sang LF thì diff
		// git nổ ra toàn bộ file và không ai review nổi.
		expect(sau.startsWith("﻿")).toBe(true);
		expect(sau).toContain("\r\n");
		expect(sau).not.toMatch(/[^\r]\n/);
		// Và nói rõ đã giữ gì, để lượt sau model thấy `\r` không tưởng file hỏng.
		expect(kq).toContain("BOM + CRLF");
	});

	it("file LF thuần vẫn giữ LF, không bị nhiễm CRLF", async () => {
		const goc = '<Project Sdk="Microsoft.NET.Sdk">\n  <X>1</X>\n</Project>\n';
		await chay("a.csproj", goc, "<X>1</X>", "<X>2</X>");
		const sau = await readFile(join(thuMuc, "a.csproj"), "utf-8");
		expect(sau).not.toContain("\r");
		expect(sau.startsWith("﻿")).toBe(false);
	});

	it("file TRỘN dòng kết thúc thì KHÔNG quy cả file về CRLF", async () => {
		// Quy cả file sẽ đụng những dòng người ta cố ý để LF — một lần ghi làm
		// bẩn cả file khó lần ra hơn hẳn một lần sửa trượt.
		const goc = "mot\r\nhai\nba\r\n";
		await chay("tron.txt", goc, "hai", "HAI");
		const sau = await readFile(join(thuMuc, "tron.txt"), "utf-8");
		expect(sau).toBe("mot\nHAI\nba\n");
	});
});

describe("FileEdit — thông báo lỗi phải CHẨN ĐOÁN", () => {
	it("khác thụt lề → chỉ đúng nguyên nhân là khoảng trắng", async () => {
		await expect(
			chay("b.txt", "function f() {\n      return 1;\n}\n", "function f() {\n  return 1;\n}", "x"),
		).rejects.toThrow(/WHITESPACE differs/);
	});

	it("nhớ sai nội dung → chỉ ra ĐÚNG dòng đầu tiên không có trong file", async () => {
		await expect(chay("c.txt", "alpha\nbeta\n", "alpha\nGAMMA", "x")).rejects.toThrow(
			/first line that does NOT appear.*GAMMA/s,
		);
	});

	it("ghép khối sai thứ tự → nói rõ là lỗi lắp khối", async () => {
		await expect(chay("d.txt", "alpha\nbeta\ngamma\n", "gamma\nalpha", "x")).rejects.toThrow(
			/BLOCK you assembled is wrong/,
		);
	});

	it("MỌI lỗi đều phủ nhận nguyên nhân 'thiếu quyền' và cấm báo xong", async () => {
		// Đây là câu chặn đúng kiểu hỏng đã đo: model không hiểu vì sao trượt nên
		// bịa ra "không có quyền truy cập", rồi người dùng cấp thêm quyền vô ích.
		await expect(chay("e.txt", "alpha\n", "khong-co", "x")).rejects.toThrow(
			/NOT a permissions problem.*was NOT changed/s,
		);
	});

	it("khớp nhiều chỗ → bảo cách làm cho duy nhất", async () => {
		await expect(chay("f.txt", "x\nx\n", "x", "y")).rejects.toThrow(/more surrounding lines/);
	});
});

describe("FileEdit — chặn sửa RỖNG", () => {
	it("old_string trùng new_string bị từ chối", async () => {
		// Đo thật: bị mặt nạ ép phải ghi mà không có gì để ghi, model nộp một
		// FileEdit thay khối bằng chính nó. Khớp thì tool sẽ báo "Edited ...
		// replaced 210 chars" — một thành công GIẢ đánh lừa cả bộ đếm tiến triển
		// lẫn người dùng.
		await expect(chay("g.txt", "alpha\n", "alpha", "alpha")).rejects.toThrow(
			/identical.*change nothing/s,
		);
	});

	it("bị chặn thì file KHÔNG bị đụng tới", async () => {
		const goc = "alpha\n";
		await writeFile(join(thuMuc, "h.txt"), goc, "utf-8");
		await expect(
			FileEditTool.execute({ path: "h.txt", old_string: "alpha", new_string: "alpha" }, ctx),
		).rejects.toThrow();
		expect(await readFile(join(thuMuc, "h.txt"), "utf-8")).toBe(goc);
	});
});
