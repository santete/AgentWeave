/**
 * Test ống dẫn attachment.
 *
 * Trọng tâm là các bảo đảm mà vòng lặp chính DỰA VÀO để dám gọi module này:
 * collector ném lỗi không được làm chết lượt, collector treo không được kéo
 * dài lượt, và nhắc đã bơm rồi không được bơm lại.
 */

import { describe, it, expect } from "vitest";
import {
	thuNhac,
	bocNhacHeThong,
	TIMEOUT_THU_NHAC,
	type BoiCanhLuot,
	type NguonNhac,
} from "../src/attachments/index";

function boiCanh(p: Partial<BoiCanhLuot> = {}): BoiCanhLuot {
	return { luot: 1, fileVuaCham: [], daBom: new Set(), ...p };
}

const nguon = (ten: string, thu: NguonNhac["thu"]): NguonNhac => ({ ten, thu });

describe("thuNhac", () => {
	it("gom nhac tu nhieu nguon", async () => {
		const kq = await thuNhac(
			[
				nguon("a", async () => [{ loai: "x", noiDung: "mot" }]),
				nguon("b", async () => [{ loai: "y", noiDung: "hai" }]),
			],
			boiCanh(),
		);
		expect(kq.nhac.map((n) => n.noiDung).sort()).toEqual(["hai", "mot"]);
		expect(kq.loi).toEqual([]);
		expect(kq.quaHan).toEqual([]);
	});

	it("nguon nem loi KHONG lam hong ca cum, va loi duoc bao cao", async () => {
		const kq = await thuNhac(
			[
				nguon("hong", async () => {
					throw new Error("doc dia that bai");
				}),
				nguon("lanh", async () => [{ loai: "x", noiDung: "van chay" }]),
			],
			boiCanh(),
		);
		expect(kq.nhac).toHaveLength(1);
		expect(kq.nhac[0]?.noiDung).toBe("van chay");
		// Nuot loi IM LANG la thu duy nhat khong duoc phep: nguoi van hanh phai thay.
		expect(kq.loi).toEqual([{ ten: "hong", lyDo: "doc dia that bai" }]);
	});

	it("nguon treo bi cat theo han gio, va ten no duoc bao cao", async () => {
		const batDau = Date.now();
		const kq = await thuNhac(
			[
				nguon("treo", () => new Promise(() => {})),
				nguon("nhanh", async () => [{ loai: "x", noiDung: "kip" }]),
			],
			boiCanh(),
			60,
		);
		expect(Date.now() - batDau).toBeLessThan(1_000);
		expect(kq.nhac.map((n) => n.noiDung)).toEqual(["kip"]);
		expect(kq.quaHan).toEqual(["treo"]);
	});

	it("nguon ve MUON sau han gio bi bo, khong ro ri sang luot sau", async () => {
		const kq = await thuNhac(
			[
				nguon(
					"cham",
					() =>
						new Promise((resolve) => {
							setTimeout(() => resolve([{ loai: "x", noiDung: "muon" }]), 80);
						}),
				),
			],
			boiCanh(),
			20,
		);
		expect(kq.nhac).toEqual([]);
		expect(kq.quaHan).toEqual(["cham"]);
		// Doi qua moc collector tra ve, xac nhan no khong chen nguoc vao ket qua.
		await new Promise((r) => setTimeout(r, 100));
		expect(kq.nhac).toEqual([]);
	});

	it("khoa da bom thi khong bom lai", async () => {
		const kq = await thuNhac(
			[
				nguon("a", async () => [
					{ loai: "luat", noiDung: "cu", khoa: "luat:api" },
					{ loai: "luat", noiDung: "moi", khoa: "luat:sql" },
				]),
			],
			boiCanh({ daBom: new Set(["luat:api"]) }),
		);
		expect(kq.nhac.map((n) => n.noiDung)).toEqual(["moi"]);
	});

	it("hai nguon tra cung khoa thi chi giu mot", async () => {
		const kq = await thuNhac(
			[
				nguon("a", async () => [{ loai: "l", noiDung: "ban A", khoa: "trung" }]),
				nguon("b", async () => [{ loai: "l", noiDung: "ban B", khoa: "trung" }]),
			],
			boiCanh(),
		);
		expect(kq.nhac).toHaveLength(1);
	});

	it("nhac khong co khoa thi bom lai duoc", async () => {
		const ds: NguonNhac[] = [nguon("a", async () => [{ loai: "dinh-ky", noiDung: "lap lai" }])];
		const mot = await thuNhac(ds, boiCanh({ daBom: new Set(["dinh-ky"]) }));
		expect(mot.nhac).toHaveLength(1);
	});

	it("khong co nguon nao thi tra ve rong ngay", async () => {
		const kq = await thuNhac([], boiCanh());
		expect(kq).toEqual({ nhac: [], loi: [], quaHan: [] });
	});

	it("han gio mac dinh la 1 giay", () => {
		expect(TIMEOUT_THU_NHAC).toBe(1_000);
	});
});

describe("bocNhacHeThong", () => {
	it("goi tat ca vao MOT tin nhan user, kem cau giai doc", () => {
		const m = bocNhacHeThong([{ noiDung: "mot" }, { noiDung: "hai" }]);
		expect(m?.role).toBe("user");
		const s = m?.content as string;
		expect(s.startsWith("<system-reminder>")).toBe(true);
		expect(s.endsWith("</system-reminder>")).toBe(true);
		expect(s).toContain("mot");
		expect(s).toContain("hai");
		// Thieu cau nay thi model coi phan chu bom vao la yeu cau moi cua nguoi dung.
		expect(s).toContain("not a new request from the user");
	});

	it("khong co gi thi tra null — dung tao tin nhan rong", () => {
		expect(bocNhacHeThong([])).toBeNull();
		expect(bocNhacHeThong([{ noiDung: "   " }])).toBeNull();
	});
});
