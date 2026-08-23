/**
 * Smoke test TẦNG DIST — chặn lớp lỗi "test xanh mà runtime chết".
 *
 * Vì sao phải có: vitest import từ SOURCE (../src), còn extension/agent thật
 * chạy dist/bin.js với @agentweave/* external hoá — import một tên không có
 * trong export của dist làm bin.js chết NGAY khi spawn, mà toàn bộ suite source
 * vẫn xanh. Đã dính thật: import `mucNen` chưa export → agent "ngủm" lúc khởi
 * động, UI treo "Đang đọc yêu cầu" vô hạn, dropdown model trống.
 */
import { describe, it, expect } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolve } from "node:path";

const run = promisify(execFile);
const BIN = resolve(__dirname, "../dist/bin.js");

describe("dist/bin.js — khởi động được thật", () => {
	it("chạy --help thoát 0 (mọi import ở tầng dist phân giải được)", async () => {
		const { stdout } = await run("node", [BIN, "--help"], { timeout: 15000 });
		expect(stdout).toContain("AgentWeave");
	}, 20000);
});
