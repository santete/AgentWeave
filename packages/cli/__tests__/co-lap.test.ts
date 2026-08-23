/**
 * Test dựng ràng buộc cô lập.
 *
 * Điều quan trọng nhất không phải "bật được", mà là **bật hỏng thì DỪNG**.
 * Người vận hành đặt `"sandbox": true` vì họ tin là có cô lập; chạy tiếp mà
 * không có nó là phản bội đúng niềm tin ấy — và không ai phát hiện ra được,
 * vì mọi lệnh vẫn chạy y như thường.
 */

import { describe, it, expect } from "vitest";
import { dungCoLap } from "../src/lib/co-lap";
import { dungCauDanHeThong } from "../src/lib/system-prompt";

describe("dungCoLap", () => {
	it("khong bat thi khong dung gi, khong bao gi", async () => {
		for (const c of [{}, { sandbox: false }]) {
			const kq = await dungCoLap(process.cwd(), c);
			expect(kq.binding).toBeUndefined();
			expect(kq.hong).toBe(false);
			expect(kq.thongBao).toBe("");
		}
	});

	it("bat thi dung duoc binding va noi ro pham vi cho nguoi van hanh", async () => {
		const kq = await dungCoLap(process.cwd(), { sandbox: true });
		// May nay co bwrap; neu khong thi phai bao hong chu khong im lang chay tiep.
		if (kq.hong) {
			expect(kq.thongBao).toContain("bubblewrap");
			return;
		}
		expect(kq.binding).toBeDefined();
		expect(kq.binding!.id).toMatch(/bubblewrap|seatbelt/);
		expect(kq.thongBao).toContain("không mạng");
		expect(kq.thongBao).toContain(process.cwd());
	});

	it("binding boc argv chu KHONG chay — noi goi van kiem soat duoc", async () => {
		const kq = await dungCoLap(process.cwd(), { sandbox: true });
		if (kq.hong) return;
		const argv = kq.binding!.wrap(["bash", "-c", "echo hi"]);
		expect(argv[0]).not.toBe("bash");
		expect(argv).toContain("bash");
		expect(argv.join(" ")).toContain("echo hi");
	});

	it("duong chi doc them duoc dua vao chinh sach", async () => {
		const kq = await dungCoLap(process.cwd(), {
			sandbox: true,
			sandboxReadOnly: ["/opt/toolchain-gia-lap"],
		});
		if (kq.hong) return;
		expect(kq.binding!.wrap(["bash"]).join(" ")).toContain("/opt/toolchain-gia-lap");
	});
});

describe("cau dan he thong khi bat sandbox", () => {
	it("KHONG bat thi khong noi gi ve sandbox — dung ton prompt", () => {
		const c = dungCauDanHeThong({ khongMang: true });
		expect(c).not.toContain("kernel sandbox");
	});

	it("bat thi noi ro pham vi VA canh bao ve thong bao 'No such file'", () => {
		const c = dungCauDanHeThong({
			workspaceCoLap: "/du/an",
			choDocThem: ["/home/u/.m2"],
		});
		expect(c).toContain("ONLY /du/an is writable");
		expect(c).toContain("/home/u/.m2");
		// Cau quan trong nhat: khong co no, model coi duong dan bi chan la file
		// thieu that roi tai lai / tao lai — dot vai luot vao chan doan sai.
		expect(c).toContain("No such file or directory");
		expect(c).toContain("BLOCKED, not missing");
		expect(c).toContain("do not re-download");
		// Va phai chi cho model biet BAO GI cho nguoi van hanh.
		expect(c).toContain("sandboxReadOnly");
	});

	it("khong khai duong doc them thi noi thang la khong co", () => {
		const c = dungCauDanHeThong({ workspaceCoLap: "/du/an" });
		expect(c).toContain("No other paths are readable");
	});
});
