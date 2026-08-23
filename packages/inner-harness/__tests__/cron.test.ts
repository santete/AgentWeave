/**
 * Test hẹn giờ.
 *
 * Bốn lỗi bản gốc đã ghi lại, mỗi cái một test — đó mới là lý do module này
 * tồn tại thay vì một `setInterval`:
 *   · neo sai mốc làm mọi task đến hạn cùng lúc sau khi khôi phục
 *   · lên lịch lại từ mốc cũ làm bắn dồn bù khi phiên bị chặn
 *   · bắn kép khi kiểm tra lại lúc việc trước chưa xong
 *   · jitter ngẫu nhiên thật làm hai lần chạy cho hai kết quả khác nhau
 *
 * Không test nào dùng đồng hồ thật: mọi mốc thời gian truyền vào tường minh.
 */

import { describe, it, expect } from "vitest";
import {
	LichHen,
	phanJitter,
	doTre,
	nguonHenGio,
	createScheduleTool,
	KHOANG_TOI_THIEU_MS,
	TU_HET_HAN_MAC_DINH_MS,
	JITTER,
} from "../src/cron/index";
import { thuNhac } from "../src/attachments/index";
import type { ToolContext } from "@agentweave/types";

const T0 = 1_700_000_000_000;
const PHUT = 60_000;

describe("jitter tat dinh", () => {
	it("cung id thi cung ket qua, khac id thi khac nhau", () => {
		expect(phanJitter("abc")).toBe(phanJitter("abc"));
		expect(phanJitter("abc")).not.toBe(phanJitter("abd"));
	});

	it("luon nam trong [0,1)", () => {
		for (const id of ["a", "bbbb", "task-kiem-tra-build", "0", "zzzzzzzzzz"]) {
			const p = phanJitter(id);
			expect(p).toBeGreaterThanOrEqual(0);
			expect(p).toBeLessThan(1);
		}
	});

	it("do tre TI LE voi khoang cach — task dai trai rong, task ngan trai hep", () => {
		const ngan = doTre({ id: "x", khoangMs: PHUT, lapLai: true });
		const dai = doTre({ id: "x", khoangMs: 60 * PHUT, lapLai: true });
		expect(ngan).toBeLessThanOrEqual(PHUT * JITTER.phanLap);
		expect(dai).toBeGreaterThan(ngan);
	});

	it("do tre cua task lap bi chan o 15 phut", () => {
		const rat = doTre({ id: "zzz", khoangMs: 30 * 24 * 60 * PHUT, lapLai: true });
		expect(rat).toBeLessThanOrEqual(JITTER.tranLapMs);
	});

	it("do tre cua task mot lan bi chan o 90 giay", () => {
		const m = doTre({ id: "zzz", khoangMs: 10 * 60 * PHUT, lapLai: false });
		expect(m).toBeLessThanOrEqual(JITTER.tranMotLanMs);
	});
});

describe("LichHen", () => {
	it("khoang duoi 1 phut bi lam tron LEN va bao lai da tron thanh bao nhieu", () => {
		const l = new LichHen();
		const kq = l.them({ id: "a", viec: "x", khoangMs: 30_000 }, T0);
		expect(kq.viec.khoangMs).toBe(KHOANG_TOI_THIEU_MS);
		// Lam tron IM LANG la kieu hong te nhat cua moi bo hen gio.
		expect(kq.daLamTron).toEqual({ xin: 30_000, thanh: KHOANG_TOI_THIEU_MS });
	});

	it("khoang hop le thi khong bao lam tron", () => {
		const l = new LichHen();
		expect(l.them({ id: "a", viec: "x", khoangMs: 5 * PHUT }, T0).daLamTron).toBeUndefined();
	});

	it("chua toi han thi kiemTra khong tra gi", () => {
		const l = new LichHen();
		l.them({ id: "a", viec: "x", khoangMs: 5 * PHUT }, T0);
		expect(l.kiemTra(T0 + PHUT)).toEqual([]);
		expect(l.kiemTra(T0 + 6 * PHUT).map((v) => v.id)).toEqual(["a"]);
	});

	it("dangChay chan ban kep khi viec truoc chua xong", () => {
		const l = new LichHen();
		l.them({ id: "a", viec: "x", khoangMs: 5 * PHUT }, T0);
		const lan1 = l.kiemTra(T0 + 10 * PHUT);
		expect(lan1).toHaveLength(1);
		// Goi lai ngay: van den han, nhung dang chay nen KHONG duoc tra lai.
		expect(l.kiemTra(T0 + 10 * PHUT)).toEqual([]);
		l.xong("a", T0 + 10 * PHUT);
		expect(l.kiemTra(T0 + 20 * PHUT)).toHaveLength(1);
	});

	it("sau khi ban thi len lich lai tu BAY GIO, khong ban don bu", () => {
		const l = new LichHen();
		l.them({ id: "a", viec: "x", khoangMs: 5 * PHUT }, T0);
		// Phien bi chan 40 phut roi moi chay.
		const muon = T0 + 40 * PHUT;
		expect(l.kiemTra(muon)).toHaveLength(1);
		l.xong("a", muon);

		const v = l.get("a")!;
		expect(v.denHanLuc).toBeGreaterThanOrEqual(muon + 5 * PHUT);
		// Neu neo tu moc cu thi lan ke tiep se o qua khu va ban them 7 lan bu.
		expect(l.kiemTra(muon + PHUT)).toEqual([]);
	});

	it("task mot lan bi go sau khi ban", () => {
		const l = new LichHen();
		l.them({ id: "a", viec: "x", khoangMs: PHUT, lapLai: false }, T0);
		l.kiemTra(T0 + 2 * PHUT);
		expect(l.xong("a", T0 + 2 * PHUT)).toBe(false);
		expect(l.soViec).toBe(0);
	});

	it("task lap tu het han sau 7 ngay — ban lan cuoi roi go", () => {
		const l = new LichHen();
		l.them({ id: "a", viec: "x", khoangMs: PHUT }, T0);
		expect(l.get("a")!.tuHetHanMs).toBe(TU_HET_HAN_MAC_DINH_MS);

		const sau8Ngay = T0 + 8 * 24 * 60 * PHUT;
		expect(l.kiemTra(sau8Ngay)).toHaveLength(1); // van ban lan cuoi
		expect(l.xong("a", sau8Ngay)).toBe(false);
		expect(l.soViec).toBe(0);
	});

	it("tuHetHanMs = 0 nghia la vo han", () => {
		const l = new LichHen();
		l.them({ id: "a", viec: "x", khoangMs: PHUT, tuHetHanMs: 0 }, T0);
		const sau8Ngay = T0 + 8 * 24 * 60 * PHUT;
		l.kiemTra(sau8Ngay);
		expect(l.xong("a", sau8Ngay)).toBe(true);
		expect(l.soViec).toBe(1);
	});

	it("dungLai() neo tu banLanCuoi — KHONG lam moi task den han cung luc", () => {
		const l = new LichHen();
		const cu = [
			{
				id: "a",
				viec: "x",
				khoangMs: 60 * PHUT,
				lapLai: true,
				taoLuc: T0 - 10 * 24 * 60 * PHUT, // tao 10 ngay truoc
				banLanCuoi: T0 - 5 * PHUT, // nhung vua ban 5 phut truoc
				denHanLuc: 0,
				tuHetHanMs: 0,
			},
		];
		l.dungLai(cu);
		// Neo tu taoLuc (loi cua ban goc) se lam no den han ngay lap tuc.
		expect(l.kiemTra(T0)).toEqual([]);
		expect(l.kiemTra(T0 + 61 * PHUT)).toHaveLength(1);
	});

	it("huy() go khoi lich", () => {
		const l = new LichHen();
		l.them({ id: "a", viec: "x", khoangMs: PHUT }, T0);
		expect(l.huy("a")).toBe(true);
		expect(l.huy("a")).toBe(false);
		expect(l.danhSach()).toEqual([]);
	});
});

describe("nguonHenGio", () => {
	it("viec den han thanh mot nhac, va TU DANH DAU xong de lan sau ban lai", async () => {
		const l = new LichHen();
		l.them({ id: "kiem-tra", viec: "chay npm test", khoangMs: 5 * PHUT }, T0);
		let bayGio = T0 + 6 * PHUT;
		const nguon = nguonHenGio(l, () => bayGio);

		const lan1 = await thuNhac([nguon], { luot: 2, fileVuaCham: [], daBom: new Set() });
		expect(lan1.nhac).toHaveLength(1);
		expect(lan1.nhac[0]?.noiDung).toContain("chay npm test");
		// Khong dat khoa: hen lap PHAI bom lai duoc o lan den han sau.
		expect(lan1.nhac[0]?.khoa).toBeUndefined();

		// Chua toi han ke tiep.
		bayGio = T0 + 7 * PHUT;
		expect((await thuNhac([nguon], { luot: 3, fileVuaCham: [], daBom: new Set() })).nhac).toEqual([]);

		bayGio = T0 + 20 * PHUT;
		expect((await thuNhac([nguon], { luot: 4, fileVuaCham: [], daBom: new Set() })).nhac).toHaveLength(1);
	});
});

describe("tool ScheduleTask", () => {
	const ctx = {} as ToolContext;

	it("add — bao ro chu ky va NHAC lam ngay lan dau", async () => {
		const l = new LichHen();
		const tool = createScheduleTool(l, () => T0);
		const ra = await tool.execute(
			{ action: "add", id: "build", task: "chay build", everySeconds: 300 },
			ctx,
		);
		expect(ra).toContain("every 300s");
		// Thieu cau nay thi "/loop 1h" im lang mot tieng va nguoi dung tuong hong.
		expect(ra).toContain("immediately");
		expect(l.soViec).toBe(1);
	});

	it("add — khoang qua ngan thi noi ro da tron thanh bao nhieu", async () => {
		const tool = createScheduleTool(new LichHen(), () => T0);
		const ra = await tool.execute(
			{ action: "add", id: "x", task: "y", everySeconds: 5 },
			ctx,
		);
		expect(ra).toContain("rounded up");
		expect(ra).toContain("tell the user");
	});

	it("list — rong thi noi rong, co thi neu con bao lau", async () => {
		const l = new LichHen();
		const tool = createScheduleTool(l, () => T0);
		expect(await tool.execute({ action: "list" }, ctx)).toContain("Nothing is scheduled");

		l.them({ id: "a", viec: "viec a", khoangMs: 10 * PHUT }, T0);
		const ra = await tool.execute({ action: "list" }, ctx);
		expect(ra).toContain("a: every 600s");
		expect(ra).toContain("viec a");
	});

	it("cancel — bao ro huy duoc hay khong", async () => {
		const l = new LichHen();
		const tool = createScheduleTool(l, () => T0);
		l.them({ id: "a", viec: "x", khoangMs: PHUT }, T0);
		expect(await tool.execute({ action: "cancel", id: "a" }, ctx)).toContain('Cancelled "a"');
		expect(await tool.execute({ action: "cancel", id: "a" }, ctx)).toContain("No scheduled task");
	});

	it("thieu tham so thi noi ro thieu gi, khong im lang bo qua", async () => {
		const tool = createScheduleTool(new LichHen(), () => T0);
		expect(await tool.execute({ action: "add", id: "a" }, ctx)).toContain("needs id, task and everySeconds");
		expect(await tool.execute({ action: "cancel" }, ctx)).toContain("needs an id");
	});
});
