/**
 * Test cho sandbox TIẾN TRÌNH (cô lập ở tầng hệ điều hành).
 *
 * Phân biệt với `sandbox.test.ts` — file đó test `checkSandbox` trong
 * tool-executor: kiểm tra chuỗi đường dẫn ở tầng ứng dụng, và chính mã nguồn
 * đã ghi rõ giới hạn "tool đặt tên tham số khác là lọt".
 *
 * Hai lớp bổ sung nhau:
 *   checkSandbox     → mềm, hiểu ngữ nghĩa, chặn sớm, có thể lọt
 *   sandbox tiến trình → cứng, không hiểu ngữ nghĩa, không lọt được
 */
import { describe, expect, it } from "vitest";
import { BubblewrapSandbox } from "../src/sandbox/bubblewrap";
import { SeatbeltSandbox } from "../src/sandbox/seatbelt";
import { NoopSandbox } from "../src/sandbox";

const POLICY = { workspace: "/tmp/ws", readOnlyPaths: ["/opt/toolchain"] };

describe("BubblewrapSandbox (Linux)", () => {
	const sb = new BubblewrapSandbox();

	it("khai báo đúng nền tảng và khả năng", () => {
		expect(sb.id).toBe("bubblewrap");
		expect(sb.platform).toBe("linux");
		expect(sb.capabilities()).toEqual({
			filesystemIsolation: true,
			networkIsolation: true,
			processIsolation: true,
		});
	});

	it("🔴 HỒI QUY: --tmpfs /tmp phải đứng TRƯỚC --bind workspace", () => {
		// Lỗi này đã xảy ra thật khi phát triển: tmpfs gắn sau sẽ CHE MẤT
		// workspace nếu workspace nằm dưới /tmp →
		//   "bwrap: Can't chdir to /tmp/ws: No such file or directory"
		// Nguy hiểm ở chỗ phần CHẶN vẫn hoạt động đúng, nên nhìn qua tưởng
		// sandbox ổn; chỉ lộ khi chạy lệnh thật.
		const a = sb.wrap(["echo", "hi"], POLICY);
		const iTmpfs = a.indexOf("--tmpfs");
		const iBind = a.findIndex((x, k) => x === "--bind" && a[k + 1] === "/tmp/ws");
		expect(iTmpfs).toBeGreaterThan(-1);
		expect(iBind).toBeGreaterThan(-1);
		expect(iTmpfs).toBeLessThan(iBind);
	});

	it("workspace là chỗ ghi DUY NHẤT", () => {
		const a = sb.wrap(["echo"], POLICY);
		expect(a.filter((x) => x === "--bind").length).toBe(1);
		expect(a.join(" ")).toContain("--ro-bind-try /opt/toolchain /opt/toolchain");
	});

	it("mặc định CHẶN mạng", () => {
		const a = sb.wrap(["echo"], POLICY);
		expect(a).toContain("--unshare-all");
		expect(a).not.toContain("--share-net");
	});

	it("mở mạng chỉ khi yêu cầu rõ ràng", () => {
		expect(sb.wrap(["echo"], { ...POLICY, allowNetwork: true })).toContain("--share-net");
	});

	it("có --die-with-parent và --new-session", () => {
		const a = sb.wrap(["echo"], POLICY);
		expect(a).toContain("--die-with-parent");
		expect(a).toContain("--new-session");
	});

	it("🔴 HỒI QUY: không dùng --ro-bind cứng (aarch64 không có /lib64)", () => {
		// Mọi hướng dẫn bubblewrap trên mạng viết cho x86 và khai cứng /lib64,
		// gây lỗi ngay dòng đầu trên ARM: "Can't find source path /lib64".
		const a = sb.wrap(["echo"], POLICY);
		expect(a.filter((x) => x === "--ro-bind").length).toBe(0);
	});

	it("truyền biến môi trường", () => {
		expect(sb.wrap(["echo"], { ...POLICY, env: { FOO: "bar" } }).join(" ")).toContain(
			"--setenv FOO bar",
		);
	});

	it("từ chối đầu vào không hợp lệ", () => {
		expect(() => sb.wrap([], POLICY)).toThrow();
		expect(() => sb.wrap(["echo"], { workspace: "" })).toThrow();
	});

	it("lệnh thật nằm sau dấu --", () => {
		const a = sb.wrap(["/bin/sh", "-c", "ls"], POLICY);
		expect(a.slice(a.indexOf("--") + 1)).toEqual(["/bin/sh", "-c", "ls"]);
	});
});

describe("SeatbeltSandbox (macOS)", () => {
	const sb = new SeatbeltSandbox();

	it("khai báo TRUNG THỰC: không cô lập tiến trình", () => {
		// Seatbelt không có namespace như Linux. Khai đúng để người vận hành
		// biết mình có gì, thay vì tưởng tương đương bubblewrap.
		expect(sb.capabilities().processIsolation).toBe(false);
		expect(sb.capabilities().filesystemIsolation).toBe(true);
	});

	it("profile mặc định CẤM TẤT CẢ", () => {
		expect(sb.wrap(["echo"], POLICY)[2]).toContain("(deny default)");
	});

	it("chỉ workspace được ghi", () => {
		expect(sb.wrap(["echo"], POLICY)[2]).toContain('file-write* (subpath "/tmp/ws")');
	});

	it("mặc định chặn mạng — khớp hành vi bản Linux", () => {
		expect(sb.wrap(["echo"], POLICY)[2]).toContain("(deny network*)");
		expect(sb.wrap(["echo"], { ...POLICY, allowNetwork: true })[2]).toContain("(allow network*)");
	});
});

describe("NoopSandbox", () => {
	it("khai báo trung thực rằng KHÔNG cô lập gì", () => {
		const c = new NoopSandbox().capabilities();
		expect(c.filesystemIsolation).toBe(false);
		expect(c.networkIsolation).toBe(false);
		expect(c.processIsolation).toBe(false);
	});

	it("trả nguyên lệnh, không bọc", () => {
		expect(new NoopSandbox().wrap(["ls", "-la"])).toEqual(["ls", "-la"]);
	});
});
