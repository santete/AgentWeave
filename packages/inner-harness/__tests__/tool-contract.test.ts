/**
 * Test hợp đồng giao tiếp model ↔ tool.
 *
 * Mọi khẳng định ở đây đều nói về CHỮ MODEL NHẬN ĐƯỢC, không phải kiểu dữ
 * liệu — vì đó mới là thứ quyết định model có sửa được ở lượt sau hay không.
 * Model 30B đọc "missing required parameter `path`" thì sửa; đọc một mảng JSON
 * `{"code":"invalid_type",...}` thì thử lại y hệt rồi bỏ cuộc.
 */

import { describe, it, expect } from "vitest";
import { z } from "zod";
import type { ToolContext, ToolDefinition } from "@agentweave/types";
import {
	chuanHoaThamSo,
	dienGiaiLoiZod,
	duongDanLoi,
	goiYTenGan,
	loiToolKhongCo,
	catKetQua,
	TRAN_KET_QUA_MAC_DINH,
} from "../src/tool-contract";
import { mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TRAN_MOI_TOOL } from "../src/tool-result-store";
import { ToolExecutor } from "../src/tool-executor";
import { ToolRegistry } from "../src/tool-registry";

const ctx = { sessionId: "s", agentId: "a", cwd: process.cwd() } as unknown as ToolContext;

function toolDoc(): ToolDefinition {
	return {
		name: "FileRead",
		description: "doc file",
		parameters: z.object({
			path: z.string(),
			offset: z.number().optional(),
			all: z.boolean().optional(),
		}),
		execute: async (i: unknown) => `da doc ${JSON.stringify(i)}`,
		metadata: { isReadOnly: true, isDestructive: false, isConcurrencySafe: true, category: "file" },
	} as ToolDefinition;
}

describe("dienGiaiLoiZod", () => {
	const s = z.object({ path: z.string(), offset: z.number().optional() }).strict();

	it("thieu tham so — noi TEN tham so thieu", () => {
		const kq = s.safeParse({});
		const chu = dienGiaiLoiZod("FileRead", (kq as { error: z.ZodError }).error);
		expect(chu).toContain("missing `path`");
		// Khong duoc con dau vet cua bai JSON goc.
		expect(chu).not.toContain("invalid_type");
		expect(chu).not.toContain('"code"');
	});

	it("sai kieu — noi CAN gi va DA GUI gi", () => {
		const kq = s.safeParse({ path: "a.ts", offset: "10" });
		const chu = dienGiaiLoiZod("FileRead", (kq as { error: z.ZodError }).error);
		expect(chu).toContain("`offset` must be a number, not a string");
	});

	it("thua tham so — goi ten cai thua", () => {
		const kq = s.safeParse({ path: "a.ts", filePath: "a.ts" });
		const chu = dienGiaiLoiZod("FileRead", (kq as { error: z.ZodError }).error);
		expect(chu).toContain("unexpected `filePath`");
	});

	it("gop nhieu tham so thieu vao MOT dong", () => {
		const s2 = z.object({ a: z.string(), b: z.string(), c: z.string() });
		const kq = s2.safeParse({});
		const chu = dienGiaiLoiZod("X", (kq as { error: z.ZodError }).error);
		expect(chu).toContain("missing `a` (string), `b` (string), `c` (string)");
		// Van phai la MOT dong — giao dien chi hien dong dau cua ket qua tool.
		expect(chu.split("\n")).toHaveLength(1);
	});

	it("cau mo dau BAO PHAI GOI LAI — khong de model tuong da xong", () => {
		const kq = s.safeParse({});
		const chu = dienGiaiLoiZod("FileRead", (kq as { error: z.ZodError }).error);
		expect(chu).toContain("fix and call it again");
		// Giao dien chi hien DONG DAU cua ket qua tool. Doi thong tin xuong dong
		// hai nghia la nguoi dung thay mot dong do choi khong noi gi.
		expect(chu.split("\n")).toHaveLength(1);
	});

	it("duong dan long nhau viet dang todos[0].activeForm", () => {
		expect(duongDanLoi(["todos", 0, "activeForm"])).toBe("todos[0].activeForm");
		expect(duongDanLoi([])).toBe("");
	});

	it("loai loi khong nhan ra thi GIU nguyen ban, khong nuot thong tin", () => {
		const s3 = z.object({ n: z.string().min(5) });
		const kq = s3.safeParse({ n: "ab" });
		const chu = dienGiaiLoiZod("X", (kq as { error: z.ZodError }).error);
		expect(chu).toContain("`n`");
		expect(chu.length).toBeGreaterThan(10);
	});
});

describe("goiYTenGan / loiToolKhongCo", () => {
	const ds = ["Bash", "FileRead", "FileWrite", "FileEdit", "Grep", "Glob"];

	it("go sai mot chu thi goi y dung", () => {
		expect(goiYTenGan("Bsh", ds)).toBe("Bash");
		expect(goiYTenGan("fileread", ds)).toBe("FileRead");
		expect(goiYTenGan("FileWirte", ds)).toBe("FileWrite");
	});

	it("ten khac han thi KHONG goi y bua — model tin ngay va goi nham tool", () => {
		expect(goiYTenGan("SendEmail", ds)).toBeNull();
		expect(goiYTenGan("x", ds)).toBeNull();
	});

	it("thong bao dat goi y TRUOC danh sach day du", () => {
		const chu = loiToolKhongCo("Bsh", ds);
		expect(chu.indexOf("Did you mean")).toBeLessThan(chu.indexOf("Available tools"));
		expect(chu).toContain("`Bash`");
		expect(chu).toContain("do not invent tool names");
	});

	it("khong co tool nao dang ky thi noi thang the", () => {
		expect(loiToolKhongCo("X", [])).toContain("no tools are registered");
	});
});

describe("chuanHoaThamSo", () => {
	const s = z.object({ path: z.string(), offset: z.number().optional(), all: z.boolean().optional() });

	it('ep "10" thanh 10 khi schema doi number, VA bao lai da sua', () => {
		const kq = chuanHoaThamSo({ path: "a.ts", offset: "10" }, s);
		expect(kq.thamSo.offset).toBe(10);
		expect(kq.daSua[0]).toContain("must be a number");
	});

	it('ep "true" thanh true khi schema doi boolean', () => {
		const kq = chuanHoaThamSo({ path: "a.ts", all: "true" }, s);
		expect(kq.thamSo.all).toBe(true);
	});

	it("KHONG ep khi chuoi khong phai so tron ven", () => {
		for (const x of ["10abc", "", "  ", "1e", "0x10"]) {
			const kq = chuanHoaThamSo({ path: "a.ts", offset: x }, s);
			expect(kq.thamSo.offset).toBe(x);
			expect(kq.daSua).toEqual([]);
		}
	});

	it("KHONG doi so thanh chuoi — mat kieu goc la mat thong tin", () => {
		const kq = chuanHoaThamSo({ path: 123 }, s);
		expect(kq.thamSo.path).toBe(123);
		expect(kq.daSua).toEqual([]);
	});

	it("go lop vo {input:{...}} bao quanh tham so that", () => {
		const kq = chuanHoaThamSo({ input: { path: "a.ts" } }, s);
		expect(kq.thamSo.path).toBe("a.ts");
		expect(kq.daSua[0]).toContain("wrapped in an extra");
	});

	it("KHONG go khi schema co tham so ten that su la `input`", () => {
		const s2 = z.object({ input: z.object({ path: z.string() }) });
		const kq = chuanHoaThamSo({ input: { path: "a.ts" } }, s2);
		expect(kq.thamSo.input).toEqual({ path: "a.ts" });
		expect(kq.daSua).toEqual([]);
	});

	it("go chuoi JSON thanh object", () => {
		const kq = chuanHoaThamSo('{"path":"a.ts"}', s);
		expect(kq.thamSo.path).toBe("a.ts");
		expect(kq.daSua[0]).toContain("JSON string");
	});

	it("dau vao vo nghia thi tra object rong, de buoc kiem tra bao loi ro", () => {
		expect(chuanHoaThamSo(null, s).thamSo).toEqual({});
		expect(chuanHoaThamSo("khong phai json", s).thamSo).toEqual({});
	});
});

describe("ToolExecutor — hop dong day du", () => {
	function dungExecutor() {
		const reg = new ToolRegistry();
		reg.register(toolDoc());
		return new ToolExecutor(reg, ctx);
	}

	it("tham so thieu → chu model doc duoc, khong phai mang JSON", async () => {
		const [kq] = await dungExecutor().execute([
			{ toolUseId: "t1", toolName: "FileRead", toolInput: {} },
		]);
		expect(kq!.isError).toBe(true);
		expect(String(kq!.result)).toContain("missing `path`");
		expect(String(kq!.result)).not.toContain('"code"');
	});

	it('"10" duoc ep thanh 10, tool CHAY, va ket qua noi ro da sua gi', async () => {
		const [kq] = await dungExecutor().execute([
			{ toolUseId: "t1", toolName: "FileRead", toolInput: { path: "a.ts", offset: "10" } },
		]);
		expect(kq!.isError).toBe(false);
		const chu = String(kq!.result);
		// Ghi chu phai o DAU: duoi ket qua se bi nen cat truoc.
		expect(chu.startsWith("[arguments auto-corrected")).toBe(true);
		expect(chu).toContain('"offset":10');
	});

	it("khong sua gi thi KHONG gan ghi chu — dung ton token vo ich", async () => {
		const [kq] = await dungExecutor().execute([
			{ toolUseId: "t1", toolName: "FileRead", toolInput: { path: "a.ts", offset: 10 } },
		]);
		expect(String(kq!.result).startsWith("[arguments auto-corrected")).toBe(false);
	});

	it("ten tool sai → goi y ten dung gan nhat", async () => {
		const [kq] = await dungExecutor().execute([
			{ toolUseId: "t1", toolName: "FileReed", toolInput: { path: "a.ts" } },
		]);
		expect(kq!.isError).toBe(true);
		expect(String(kq!.result)).toContain("Did you mean `FileRead`?");
	});
});

describe("catKetQua — tran kich thuoc ket qua", () => {
	it("ngan hon tran thi giu nguyen tung byte", () => {
		expect(catKetQua("ngan", 100)).toBe("ngan");
	});

	it("GIU CA HAI DAU — cuoi la cho co ma thoat va loi that", () => {
		const noi = `DONG-DAU${"x".repeat(5000)}DONG-CUOI`;
		const ra = catKetQua(noi, 1000);
		expect(ra).toContain("DONG-DAU");
		expect(ra).toContain("DONG-CUOI");
		expect(ra.length).toBeLessThanOrEqual(1000);
	});

	it("cat thi phai NOI RA da cat bao nhieu va lay phan thieu bang cach nao", () => {
		const ra = catKetQua("y".repeat(50_000), 1_000);
		expect(ra).toContain("đã cắt");
		expect(ra).toContain("50000 ký tự");
		// Cat im lang = model tuong day la toan bo su that.
		expect(ra).toMatch(/grep|head|tail/);
	});

	it("tran = 0 hoac am nghia la khong gioi han", () => {
		const dai = "z".repeat(10_000);
		expect(catKetQua(dai, 0)).toBe(dai);
	});

	it("tran nho hon ca ghi chu thi van khong vuot tran", () => {
		const ra = catKetQua("q".repeat(1000), 50);
		expect(ra.length).toBeLessThanOrEqual(50);
	});
});

describe("ToolExecutor — ket qua qua lon", () => {
	function executorTraDai(maxOutputSize: number | undefined, cwd: string) {
		const reg = new ToolRegistry();
		reg.register({
			name: "Xa",
			description: "tra ket qua rat dai",
			parameters: z.object({}),
			execute: async () => `BAT-DAU${"x".repeat(60_000)}KET-THUC`,
			metadata: {
				isReadOnly: true,
				isDestructive: false,
				isConcurrencySafe: true,
				category: "custom",
				...(maxOutputSize === undefined ? {} : { maxOutputSize }),
			},
		} as ToolDefinition);
		return new ToolExecutor(reg, { ...ctx, cwd, sessionId: "phien-test" } as ToolContext);
	}

	it("GHI RA DIA thay vi cat — model lay lai duoc bang FileRead/Grep", async () => {
		const cwd = join(tmpdir(), `aw-trs-${Date.now()}-a`);
		await mkdir(cwd, { recursive: true });
		const [kq] = await executorTraDai(undefined, cwd).execute([
			{ toolUseId: "t1", toolName: "Xa", toolInput: {} },
		]);

		const chu = String(kq!.result);
		expect(chu).toContain("<persisted-output>");
		expect(chu).toContain("nothing was lost");
		expect(chu).toMatch(/FileRead|Grep/);

		// Tep phai co that va chua DU noi dung goc — day moi la diem khac biet
		// so voi cat: khong mat mot ky tu nao.
		const duong = /at: (\S+)/.exec(chu)![1]!;
		const tren = await readFile(duong, "utf-8");
		expect(tren.length).toBe(60_000 + "BAT-DAUKET-THUC".length);
		expect(tren.endsWith("KET-THUC")).toBe(true);
		await rm(cwd, { recursive: true, force: true });
	});

	it("tran he thong THANG khai bao cua tool — 200k van khong duoc phep", async () => {
		const cwd = join(tmpdir(), `aw-trs-${Date.now()}-b`);
		await mkdir(cwd, { recursive: true });
		const [kq] = await executorTraDai(200_000, cwd).execute([
			{ toolUseId: "t1", toolName: "Xa", toolInput: {} },
		]);
		expect(String(kq!.result)).toContain("<persisted-output>");
		expect(String(kq!.result).length).toBeLessThan(TRAN_MOI_TOOL);
		await rm(cwd, { recursive: true, force: true });
	});

	it("ket qua nho hon tran thi khong dung toi dia", async () => {
		const cwd = join(tmpdir(), `aw-trs-${Date.now()}-c`);
		await mkdir(cwd, { recursive: true });
		const reg = new ToolRegistry();
		reg.register({
			name: "Nho",
			description: "d",
			parameters: z.object({}),
			execute: async () => "ket qua ngan",
			metadata: { isReadOnly: true, isDestructive: false, isConcurrencySafe: true, category: "custom" },
		} as ToolDefinition);
		const [kq] = await new ToolExecutor(reg, { ...ctx, cwd, sessionId: "p" } as ToolContext).execute([
			{ toolUseId: "t1", toolName: "Nho", toolInput: {} },
		]);
		expect(kq!.result).toBe("ket qua ngan");
		await rm(cwd, { recursive: true, force: true });
	});

	it("loi thi CAT chu khong ghi dia — phan can nhat nam o hai dau", async () => {
		const reg = new ToolRegistry();
		reg.register({
			name: "Hong",
			description: "nem loi rat dai",
			parameters: z.object({}),
			execute: async () => {
				throw new Error(`DAU-LOI${"e".repeat(60_000)}CUOI-LOI`);
			},
			metadata: {
				isReadOnly: true,
				isDestructive: false,
				isConcurrencySafe: true,
				category: "custom",
				maxOutputSize: 1_500,
			},
		} as ToolDefinition);

		const [kq] = await new ToolExecutor(reg, ctx).execute([
			{ toolUseId: "t1", toolName: "Hong", toolInput: {} },
		]);
		expect(kq!.isError).toBe(true);
		const chu = String(kq!.result);
		expect(chu.length).toBeLessThanOrEqual(1_500);
		expect(chu).toContain("DAU-LOI");
		expect(chu).toContain("CUOI-LOI");
		expect(chu).not.toContain("<persisted-output>");
	});
});
