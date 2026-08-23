/**
 * Test ghi kết quả tool ra đĩa.
 *
 * Điểm phải chứng minh được, vì đó là lý do đổi từ cắt sang ghi đĩa:
 * **không mất một ký tự nào**. Mọi test dưới đây đều đọc lại tệp và so độ dài
 * với bản gốc chứ không chỉ tin vào thông báo.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
	ghiKetQuaRaDia,
	dungXemTruoc,
	thongBaoDaGhi,
	apTranTongLuot,
	thuMucKetQua,
	TRAN_MOI_TOOL,
	TRAN_TONG_MOI_LUOT,
	CO_XEM_TRUOC,
} from "../src/tool-result-store";

let cwd: string;
const PHIEN = "phien-abc";

beforeEach(async () => {
	cwd = join(tmpdir(), `aw-trstore-${Date.now()}-${Math.floor(performance.now())}`);
	await mkdir(cwd, { recursive: true });
});
afterEach(async () => {
	await rm(cwd, { recursive: true, force: true });
});

describe("ghiKetQuaRaDia", () => {
	it("ghi DU noi dung, khong mat mot ky tu nao", async () => {
		const noi = `DAU${"m".repeat(50_000)}CUOI`;
		const kq = (await ghiKetQuaRaDia(noi, "t1", cwd, PHIEN))!;
		expect(kq.coGoc).toBe(noi.length);
		const tren = await readFile(kq.duong, "utf-8");
		expect(tren).toBe(noi);
	});

	it("ghi vao .agentweave/sessions/<phien>/tool-results — da nam trong .gitignore", async () => {
		const kq = (await ghiKetQuaRaDia("x", "t1", cwd, PHIEN))!;
		expect(kq.duong.startsWith(thuMucKetQua(cwd, PHIEN))).toBe(true);
		expect(kq.duong).toContain(join(".agentweave", "sessions", PHIEN));
	});

	it("goi lai cung toolUseId thi KHONG ghi de (co wx) — replay khong ton dia", async () => {
		await ghiKetQuaRaDia("ban dau", "t1", cwd, PHIEN);
		const lan2 = (await ghiKetQuaRaDia("ban khac", "t1", cwd, PHIEN))!;
		// Van tra ve thong tin dung duoc, nhung noi dung tren dia giu nguyen ban dau.
		expect(await readFile(lan2.duong, "utf-8")).toBe("ban dau");
	});

	it("toolUseId chua ../ KHONG ghi duoc ra ngoai thu muc phien", async () => {
		const kq = (await ghiKetQuaRaDia("x", "../../../thoat", cwd, PHIEN))!;
		// Diem quan trong khong phai la "khong con dau cham" — sau khi loc, ".." chi
		// con la ky tu trong TEN TEP. Diem quan trong la no khong con la phan cach
		// duong dan, nen tep nam tron trong thu muc phien.
		expect(kq.duong.startsWith(thuMucKetQua(cwd, PHIEN))).toBe(true);
		const ten = kq.duong.slice(thuMucKetQua(cwd, PHIEN).length + 1);
		expect(ten).not.toContain("/");
		expect(ten).not.toContain("\\");
		expect(await readFile(kq.duong, "utf-8")).toBe("x");
	});

	it("ghi hong thi tra null de noi goi lui ve cat", async () => {
		// Tao mot TEP tai dung cho thu muc phien can — mkdir se that bai.
		const chan = join(cwd, ".agentweave");
		await writeFile(chan, "khong phai thu muc");
		expect(await ghiKetQuaRaDia("x", "t1", cwd, PHIEN)).toBeNull();
	});
});

describe("dungXemTruoc", () => {
	it("ngan hon co thi giu nguyen, khong bao la con nua", () => {
		expect(dungXemTruoc("ngan", 100)).toEqual({ xemTruoc: "ngan", conNua: false });
	});

	it("cat o ranh gioi dong cho de doc", () => {
		const noi = `${"a".repeat(80)}\n${"b".repeat(80)}\n${"c".repeat(80)}`;
		const { xemTruoc, conNua } = dungXemTruoc(noi, 170);
		expect(conNua).toBe(true);
		expect(xemTruoc.endsWith("\n")).toBe(false);
		expect(xemTruoc.includes("c")).toBe(false);
	});

	it("khong co dong nao gan cho cat thi cat thang, khong tra ve chuoi rong", () => {
		const { xemTruoc } = dungXemTruoc("z".repeat(1000), 100);
		expect(xemTruoc.length).toBe(100);
	});
});

describe("thongBaoDaGhi", () => {
	it("neu duong dan, cach doc lai, va khang dinh khong mat gi", () => {
		const chu = thongBaoDaGhi({
			duong: "/tmp/x/t1.txt", coGoc: 90_000, xemTruoc: "vai dong dau", conNua: true,
		});
		expect(chu).toContain("/tmp/x/t1.txt");
		expect(chu).toContain("FileRead");
		expect(chu).toContain("Grep");
		// Khong noi ro "khong mat gi" thi model coi nhu da mat va doan bua phan con lai.
		expect(chu).toContain("nothing was lost");
		expect(chu.startsWith("<persisted-output>")).toBe(true);
		expect(chu.endsWith("</persisted-output>")).toBe(true);
	});
});

describe("apTranTongLuot — tran TONG ca luot", () => {
	it("tong duoi tran thi khong dung toi cai nao", async () => {
		const thay = await apTranTongLuot(
			[
				{ toolUseId: "a", noiDung: "x".repeat(1000) },
				{ toolUseId: "b", noiDung: "y".repeat(1000) },
			],
			cwd,
			PHIEN,
		);
		expect(thay.size).toBe(0);
	});

	it("N tool moi cai DUOI tran rieng nhung cong lai vuot → van bi ghi ra dia", async () => {
		// Day chinh la lo hong ma tran-moi-tool khong bit duoc.
		const cac = Array.from({ length: 8 }, (_, i) => ({
			toolUseId: `t${i}`,
			noiDung: `k${i}`.repeat(6_000), // ~12.000 ky tu, duoi TRAN_MOI_TOOL
		}));
		for (const c of cac) expect(c.noiDung.length).toBeLessThan(TRAN_MOI_TOOL);
		expect(cac.reduce((t, c) => t + c.noiDung.length, 0)).toBeGreaterThan(TRAN_TONG_MOI_LUOT);

		const thay = await apTranTongLuot(cac, cwd, PHIEN);
		expect(thay.size).toBeGreaterThan(0);

		const conLai = cac.reduce(
			(t, c) => t + (thay.get(c.toolUseId)?.length ?? c.noiDung.length),
			0,
		);
		expect(conLai).toBeLessThanOrEqual(TRAN_TONG_MOI_LUOT);
	});

	it("ghi tu cai TO NHAT xuong — it thao tac dia nhat", async () => {
		const thay = await apTranTongLuot(
			[
				{ toolUseId: "nho", noiDung: "n".repeat(2_000) },
				{ toolUseId: "to", noiDung: "T".repeat(70_000) },
			],
			cwd,
			PHIEN,
		);
		expect([...thay.keys()]).toEqual(["to"]);
	});

	it("ngan sach quy ve cua so 64K", () => {
		expect(TRAN_MOI_TOOL).toBe(16_000);
		expect(TRAN_TONG_MOI_LUOT).toBe(64_000);
		expect(CO_XEM_TRUOC).toBe(1_500);
	});
});
