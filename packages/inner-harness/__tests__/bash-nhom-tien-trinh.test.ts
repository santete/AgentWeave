/**
 * Hồi quy: Bash hết hạn giờ KHÔNG được bỏ lại tiến trình cháu.
 *
 * Bug đã tái hiện được trước khi sửa: `exec` với tuỳ chọn `timeout` của Node
 * chỉ giết đúng tiến trình con TRỰC TIẾP. Với lệnh ghép (`cd x && dotnet build`)
 * thì `sh` là con còn `dotnet` là cháu — giết `sh` xong `dotnet` vẫn sống.
 *
 * Hậu quả thật, và là lý do phải sửa: `dotnet build` bỏ lại MSBuild worker giữ
 * khoá `bin/obj`; lượt sau agent gọi FileEdit lên đúng tệp đó và nhận "being
 * used by another process" — do CHÍNH NÓ để lại, chứ không phải người dùng.
 *
 * Đo bằng PID chứ không bằng `pgrep -f`: khớp chuỗi thì lệnh đo tự khớp chính
 * nó, và phép đo trở nên vô nghĩa (đã vấp đúng bẫy này).
 */

import { describe, it, expect, afterEach } from "vitest";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ToolContext } from "@agentweave/types";
import { taoBashTool } from "../src/built-in-tools/bash";

const ctx = {
	sessionId: "s",
	agentId: "a",
	cwd: tmpdir(),
	signal: new AbortController().signal,
} as ToolContext;

const tepPid = join(tmpdir(), `aw-chau-${process.pid}.pid`);
const conSong = (pid: number): boolean => {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
};

afterEach(() => rmSync(tepPid, { force: true }));

describe("Bash — giết cả nhóm tiến trình", () => {
	it("hết hạn giờ thì tiến trình CHÁU cũng chết", async () => {
		rmSync(tepPid, { force: true });
		const tool = taoBashTool(1_200);

		// `sh` là con; `sleep` chạy nền là CHÁU. Đây đúng hình dạng của
		// `cd duan && dotnet build` — thứ để lại MSBuild worker.
		await tool
			.execute({ command: `cd ${tmpdir()} && (sleep 60 & echo $! > ${tepPid}) && sleep 60` }, ctx)
			.catch(() => undefined);

		expect(existsSync(tepPid)).toBe(true);
		const pid = Number(readFileSync(tepPid, "utf-8").trim());
		expect(Number.isFinite(pid)).toBe(true);

		// Cho qua cả ân hạn SIGKILL.
		await new Promise((r) => setTimeout(r, 2_600));

		const song = conSong(pid);
		if (song) process.kill(pid, "SIGKILL");
		expect(song).toBe(false);
	}, 15_000);

	it("lệnh bình thường vẫn trả stdout và stderr như cũ", async () => {
		const ra = String(await taoBashTool(5_000).execute({ command: "echo ra && echo loi >&2" }, ctx));
		expect(ra).toContain("ra");
		expect(ra).toContain("loi");
	});

	it("mã thoát khác 0 vẫn báo đúng — đó là lúc output quan trọng nhất", async () => {
		const ra = String(await taoBashTool(5_000).execute({ command: "echo truoc; exit 3" }, ctx));
		expect(ra).toContain("[mã thoát 3]");
		expect(ra).toContain("truoc");
	});

	it("bị giết vì hết giờ thì nói rõ, không giả vờ chạy xong", async () => {
		const ra = String(await taoBashTool(400).execute({ command: "sleep 30" }, ctx));
		expect(ra).toMatch(/bị giết|mã thoát/);
	}, 10_000);
});
