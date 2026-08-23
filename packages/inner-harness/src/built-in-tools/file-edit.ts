/**
 * REFERENCE IMPLEMENTATION — not production path (post-pivot 2026-04-22).
 * Production agents ship their own file-edit tool; AgentWeave governs them
 * via hooks + adapters. Kept for the reference agent-loop + tests.
 * See product-spec/POSITIONING.md.
 *
 * FileEdit — Replace a string in a file (exact match).
 *
 * ═══ VÌ SAO PHẢI CHUẨN HOÁ BOM VÀ CRLF ═══
 *
 * Đo thật trên một solution .NET (`docs/SO-TAY-VET-TICH.md`, phiên
 * 20260823-171947): cả buổi làm việc 9 câu hỏi chỉ sửa nổi ĐÚNG MỘT file, và
 * biến số duy nhất phân biệt thành công với thất bại là dòng kết thúc.
 *
 *   Helpdesk.Infrastructure.csproj   LF, không BOM   → sửa được
 *   Helpdesk.Domain.csproj           BOM + CRLF      → "String not found"
 *   Helpdesk.Api.csproj              CRLF            → cũng sẽ trượt
 *
 * Model ĐÃ đọc đúng file trước đó. Nhưng khi dựng lại `old_string` nó trả về
 * LF và không BOM — vì `\r` và BOM **vô hình** trong mọi biểu diễn văn bản mà
 * một LLM nhìn thấy. Không model nào tái tạo được thứ nó không thấy.
 *
 * Hệ quả dây chuyền còn tệ hơn bản thân lỗi: thông báo `String not found`
 * không nói khác chỗ nào, nên model tự suy diễn nguyên nhân và kết luận "tôi
 * không có quyền truy cập đầy đủ" — trong khi vết tích ghi 16 quyết định
 * quyền, KHÔNG một lần từ chối. Người dùng đọc câu đó rồi cấp thêm quyền, và
 * dĩ nhiên không có gì thay đổi.
 *
 * Nên hai việc phải đi cùng nhau: khớp bỏ qua khác biệt vô hình, VÀ khi vẫn
 * không khớp thì nói rõ khác ở đâu.
 */

import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { ToolDefinition } from "@agentweave/types";
import { z } from "zod";
import { ghiNhanDaGhi } from "../file-access-tracker";
import { chuanHoaDuongDan } from "./duong-dan";
import { boiLoiTep } from "./loi-tep";

const BOM = "﻿";

/** Bỏ BOM và quy CRLF về LF — đúng hai thứ model không nhìn thấy được. */
function chuan(s: string): string {
	return (s.startsWith(BOM) ? s.slice(1) : s).replace(/\r\n/g, "\n");
}

type KieuXuongDong = "lf" | "crlf" | "tron";

/**
 * Nhận dạng kiểu xuống dòng.
 *
 * Phân biệt "trộn" là bắt buộc: quy cả file về CRLF khi nó vốn chỉ CRLF một
 * phần sẽ sửa cả những dòng người ta cố ý để LF — một lần ghi làm bẩn cả file
 * là kiểu hỏng khó lần ra hơn hẳn một lần sửa trượt.
 */
function kieuXuongDong(s: string): KieuXuongDong {
	const tongLf = (s.match(/\n/g) ?? []).length;
	const soCrlf = (s.match(/\r\n/g) ?? []).length;
	if (soCrlf === 0) return "lf";
	return soCrlf === tongLf ? "crlf" : "tron";
}

/**
 * Nói RÕ vì sao không khớp.
 *
 * Bản trước chỉ có `String not found in <path>`. Với model đó là ngõ cụt: nó
 * không biết nên sửa khoảng trắng, sửa dòng kết thúc, hay đọc lại file — nên
 * nó bịa một nguyên nhân. Mỗi nhánh dưới đây trỏ thẳng vào HÀNH ĐỘNG tiếp
 * theo, và nhánh nào cũng kết bằng câu cấm báo-xong (cùng quy ước `loi-tep.ts`).
 */
function chanDoanKhongKhop(noiDung: string, tim: string, duong: string): string {
	const phan: string[] = [`String not found in ${duong}.`];

	const boTrang = (s: string) => s.replace(/\s+/g, "");
	if (boTrang(noiDung).includes(boTrang(tim)) && boTrang(tim) !== "") {
		phan.push(
			"The text IS in the file but the WHITESPACE differs (indentation, or spaces vs tabs). " +
				"Re-read the file with FileRead and copy the exact indentation.",
		);
	} else {
		// Dòng đầu tiên trượt là manh mối định vị tốt nhất: nó nói CHÍNH XÁC chỗ
		// model nhớ sai, thay vì bắt nó dò lại cả khối.
		const dongTrat = tim
			.split("\n")
			.map((d) => d.trim())
			.find((d) => d !== "" && !noiDung.includes(d));
		if (dongTrat !== undefined) {
			phan.push(`The first line that does NOT appear in the file is: ${JSON.stringify(dongTrat)}`);
			phan.push("Re-read the file with FileRead — your old_string does not match its content.");
		} else {
			phan.push(
				"Every individual line exists in the file, so the BLOCK you assembled is wrong — " +
					"wrong order, wrong blank lines, or lines that are not actually adjacent. " +
					"Re-read the file with FileRead and copy one contiguous block.",
			);
		}
	}

	phan.push(
		"This is NOT a permissions problem — the file was NOT changed. Do not report this edit as done.",
	);
	return phan.join(" ");
}

export const FileEditTool: ToolDefinition<
	{ path?: string; file?: string; file_path?: string; old_string: string; new_string: string },
	string
> = {
	name: "FileEdit",
	description: "Replace an exact string in a file. old_string must be unique in the file.",
	parameters: z
		.object({
			path: z.string().optional().describe("File path"),
			file: z.string().optional(),
			file_path: z.string().optional(),
			old_string: z.string().describe("Exact string to find (must be unique in file)"),
			new_string: z.string().describe("Replacement string"),
		})
		.refine((v) => v.path || v.file || v.file_path, { message: "path is required" }),
	execute: async ({ path, file, file_path, old_string, new_string }, context) => {
		path = path ?? file ?? file_path ?? "";

		// ── Sửa RỖNG ──
		// Đo thật cùng phiên: bị mặt nạ guard ép phải ghi mà không có gì để ghi,
		// model nộp một FileEdit thay khối bằng CHÍNH NÓ. Nếu nó khớp thì tool sẽ
		// báo "Edited ... replaced 210 chars" — một thành công giả, và cả bộ đếm
		// tiến triển lẫn người dùng đều bị đánh lừa. Chặn ngay từ cửa.
		if (old_string === new_string) {
			throw new Error(
				"old_string and new_string are identical — this edit would change nothing. " +
					"Either make a real change, or stop editing and say what you actually intend to do. " +
					"The file was NOT changed.",
			);
		}

		const absPath = resolve(context.cwd, chuanHoaDuongDan(path));
		const goc = await boiLoiTep(path, () => readFile(absPath, "utf-8"));

		const coBom = goc.startsWith(BOM);
		const kieu = kieuXuongDong(goc);

		// Khớp trên bản CHUẨN HOÁ. Model không thấy được BOM và `\r`, nên bắt nó
		// tái tạo chúng là đòi một điều bất khả.
		const noiChuan = chuan(goc);
		const timChuan = chuan(old_string);

		const soLan = noiChuan.split(timChuan).length - 1;
		if (soLan === 0) {
			throw new Error(chanDoanKhongKhop(noiChuan, timChuan, path));
		}
		if (soLan > 1) {
			throw new Error(
				`String found ${soLan} times in ${path} — must be unique. ` +
					"Include more surrounding lines so the block appears exactly once. The file was NOT changed.",
			);
		}

		let ra = noiChuan.replace(timChuan, chuan(new_string));

		// Trả lại đúng định dạng gốc. File TRỘN thì giữ nguyên LF cho phần đã
		// chuẩn hoá — quy cả file về CRLF sẽ đụng vào những dòng không liên quan.
		if (kieu === "crlf") ra = ra.replace(/\n/g, "\r\n");
		if (coBom) ra = BOM + ra;

		await boiLoiTep(path, () => writeFile(absPath, ra, "utf-8"));
		// FileEdit tự đọc lại và đòi old_string khớp DUY NHẤT, nên nó không cần
		// bắt buộc đọc trước như FileWrite. Ghi dấu mtime mới để lượt sửa tiếp
		// theo không bị chặn oan — nhưng KHÔNG xoá cờ đọc-thiếu, vì thay một đoạn
		// không làm agent nhìn thấy phần còn lại của file.
		await ghiNhanDaGhi(context.sessionId, absPath, false);

		// Nói rõ đã giữ định dạng gì: nếu lượt sau model đọc lại và thấy `\r`, nó
		// cần biết đó là chủ ý của tool chứ không phải file bị hỏng.
		const ghiChu =
			kieu === "crlf" || coBom
				? ` (kept ${[coBom ? "BOM" : null, kieu === "crlf" ? "CRLF" : null].filter(Boolean).join(" + ")})`
				: "";
		return `Edited ${path}: replaced ${old_string.length} chars with ${new_string.length} chars${ghiChu}`;
	},
	metadata: {
		isReadOnly: false,
		isDestructive: false,
		isConcurrencySafe: false,
		category: "file",
	},
};
