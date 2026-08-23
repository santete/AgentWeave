/**
 * Test đồng hồ hẹn giờ ở tầng CLI.
 *
 * Điều phải chứng minh — cũng là lý do dời đồng hồ khỏi vòng lặp agent:
 * **việc đến hạn nhả được khi agent đang RẢNH**, tức là lúc không có lượt nào
 * chạy và attachment không được thu.
 */

import { describe, it, expect } from "vitest";
import { LichHen } from "@agentweave/inner-harness";
import { batDauDongHo, NHIP_KIEM_TRA_MS } from "../src/lib/dong-ho-hen";

const PHUT = 60_000;

/** Đồng hồ giả: thời gian do test điều khiển, nhịp thật rất ngắn để chạy nhanh. */
function dungDongHo(batDauMs = 1_000_000) {
	let bayGio = batDauMs;
	const lich = new LichHen();
	const daBao: string[] = [];
	const dh = batDauDongHo(lich, {
		nhipMs: 5,
		dongHo: () => bayGio,
		khiDenHan: (v) => daBao.push(v.id),
	});
	return {
		lich,
		dh,
		daBao,
		tien(ms: number) {
			bayGio += ms;
		},
		get gio() {
			return bayGio;
		},
	};
}

const doi = (ms = 30) => new Promise((r) => setTimeout(r, ms));

describe("batDauDongHo", () => {
	it("viec den han vao hang doi MA KHONG can luot agent nao chay", async () => {
		const t = dungDongHo();
		t.lich.them({ id: "kiem-tra", viec: "chay npm test", khoangMs: 5 * PHUT }, t.gio);

		// Agent hoan toan ranh — khong co luot nao, khong thu attachment lan nao.
		expect(t.dh.rutChoDoi()).toEqual([]);

		t.tien(6 * PHUT);
		await doi();

		expect(t.dh.rutChoDoi()).toEqual(["chay npm test"]);
		expect(t.daBao).toEqual(["kiem-tra"]);
		t.dh.dung();
	});

	it("rut roi thi hang doi rong — khong tra lai lan hai", async () => {
		const t = dungDongHo();
		t.lich.them({ id: "a", viec: "viec a", khoangMs: PHUT }, t.gio);
		t.tien(2 * PHUT);
		await doi();

		expect(t.dh.rutChoDoi()).toEqual(["viec a"]);
		expect(t.dh.rutChoDoi()).toEqual([]);
		t.dh.dung();
	});

	it("hen lap ban lai o chu ky sau", async () => {
		const t = dungDongHo();
		t.lich.them({ id: "a", viec: "viec a", khoangMs: PHUT }, t.gio);

		t.tien(2 * PHUT);
		await doi();
		expect(t.dh.rutChoDoi()).toHaveLength(1);

		t.tien(2 * PHUT);
		await doi();
		expect(t.dh.rutChoDoi()).toHaveLength(1);
		t.dh.dung();
	});

	it("doiViec() nha khi co viec — de REPL cho song song voi ban phim", async () => {
		const t = dungDongHo();
		t.lich.them({ id: "a", viec: "viec a", khoangMs: PHUT }, t.gio);

		let daNha = false;
		const cho = t.dh.doiViec().then(() => {
			daNha = true;
		});
		await doi(15);
		expect(daNha).toBe(false); // chua toi han thi con cho

		t.tien(2 * PHUT);
		await cho;
		expect(daNha).toBe(true);
		t.dh.dung();
	});

	it("doiViec() nha ngay khi hang doi DA co san viec", async () => {
		const t = dungDongHo();
		t.lich.them({ id: "a", viec: "viec a", khoangMs: PHUT }, t.gio);
		t.tien(2 * PHUT);
		await doi();

		// Khong duoc treo: hang doi da co viec truoc khi ai do goi doiViec().
		await Promise.race([
			t.dh.doiViec(),
			new Promise((_, rej) => setTimeout(() => rej(new Error("treo")), 200)),
		]);
		t.dh.dung();
	});

	it("dung() nha moi ben dang cho — neu khong REPL treo luc thoat", async () => {
		const t = dungDongHo();
		const cho = t.dh.doiViec();
		t.dh.dung();
		await Promise.race([
			cho,
			new Promise((_, rej) => setTimeout(() => rej(new Error("treo luc thoat")), 200)),
		]);
	});

	it("dung() roi thi khong ban them viec nao nua", async () => {
		const t = dungDongHo();
		t.lich.them({ id: "a", viec: "viec a", khoangMs: PHUT }, t.gio);
		t.dh.dung();
		t.tien(5 * PHUT);
		await doi();
		expect(t.dh.rutChoDoi()).toEqual([]);
	});

	it("nhip mac dinh 1 giay — du min cho hen tinh bang phut", () => {
		expect(NHIP_KIEM_TRA_MS).toBe(1_000);
	});
});
