/**
 * Test dịch lỗi hệ thống tệp.
 *
 * Điều phải bảo đảm ở MỌI nhánh: câu trả về nói rõ (a) nguyên nhân, (b) hành
 * động đúng tiếp theo, và (c) **không được báo là đã sửa xong**. Thiếu (c) là
 * kiểu hỏng đắt nhất — người dùng tin là xong, phát hiện ở lần build sau.
 */

import { describe, it, expect } from "vitest";
import { dienGiaiLoiTep, boiLoiTep } from "../src/built-in-tools/loi-tep";

const loi = (code: string, message = "") => Object.assign(new Error(message || code), { code });

describe("dienGiaiLoiTep", () => {
	it("EBUSY → noi la TAM THOI va chi ra ai dang giu tep", () => {
		const c = dienGiaiLoiTep(loi("EBUSY", "resource busy or locked"), "Api.dll")!;
		expect(c).toContain("LOCKED by another process");
		expect(c).toContain("temporary");
		expect(c).toMatch(/dotnet watch|dotnet build|npm run dev/);
		// Khong duoc de model thu lai vo han hoac nhay sang file khac.
		expect(c).toContain("Do NOT retry it repeatedly");
	});

	it("chuoi Windows 'being used by another process' cung duoc nhan ra", () => {
		const c = dienGiaiLoiTep(
			loi("EPERM", "The process cannot access the file because it is being used by another process"),
			"a.cs",
		)!;
		expect(c).toContain("LOCKED by another process");
	});

	it("EACCES → khong tu khac phuc duoc, cam thu lai va cam sudo", () => {
		const c = dienGiaiLoiTep(loi("EACCES"), "/etc/hosts")!;
		expect(c).toContain("No permission");
		expect(c).toContain("do not try sudo");
	});

	it("ENOENT → bao tim duong dan that thay vi doan", () => {
		expect(dienGiaiLoiTep(loi("ENOENT"), "x.ts")).toContain("Glob or Grep");
	});

	it("ENOSPC / EROFS → noi ro thu lai VO ICH", () => {
		expect(dienGiaiLoiTep(loi("ENOSPC"), "a")).toContain("Retrying will not help");
		expect(dienGiaiLoiTep(loi("EROFS"), "a")).toContain("Retrying will not help");
	});

	it("MOI nhanh deu cam bao da sua xong", () => {
		for (const ma of ["EBUSY", "EACCES", "EROFS", "ENOSPC", "EISDIR", "ENOENT", "EMFILE"]) {
			expect(dienGiaiLoiTep(loi(ma), "f")).toContain("Do not report this edit as done");
		}
	});

	it("ma la thi tra null — giu nguyen loi goc, khong doan bua", () => {
		expect(dienGiaiLoiTep(loi("EWEIRD"), "f")).toBeNull();
		expect(dienGiaiLoiTep(new Error("chuyen gi do"), "f")).toBeNull();
	});
});

describe("boiLoiTep", () => {
	it("chay tron thi tra ket qua nguyen ven", async () => {
		expect(await boiLoiTep("f", async () => "xong")).toBe("xong");
	});

	it("loi nhan ra duoc thi nem lai ban da dich", async () => {
		await expect(
			boiLoiTep("Api.dll", async () => {
				throw loi("EBUSY");
			}),
		).rejects.toThrow(/LOCKED by another process/);
	});

	it("loi khong nhan ra thi nem NGUYEN loi goc", async () => {
		const goc = loi("EWEIRD", "thong bao rat rieng");
		await expect(boiLoiTep("f", async () => { throw goc; })).rejects.toBe(goc);
	});
});
