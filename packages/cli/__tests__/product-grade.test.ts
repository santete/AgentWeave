/**
 * Test ba thành phần thêm ở vòng product-grade: lưu phiên, chèn @file,
 * cấu hình dự án.
 *
 * Trọng tâm là các đường HỎNG, vì đường đẹp đã kiểm chứng bằng chạy thật:
 *   · tệp phiên hỏng không được làm sập cả CLI
 *   · @../../ ngoài thư mục làm việc phải bị chặn
 *   · cấu hình hỏng phải BÁO, không lặng lẽ rơi về mặc định
 */

import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { mkdtemp, mkdir, writeFile, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chenFile } from "../src/lib/at-file.js";
import { docCauHinhAgent } from "../src/lib/agent-config.js";
import {
	docPhien,
	lietKePhien,
	luuPhien,
	phienGanNhat,
	taoIdPhien,
	type PhienLuu,
} from "../src/lib/session-store.js";

let goc: string;

function phienMau(id: string, capNhat: string): PhienLuu {
	return {
		id,
		capNhat,
		model: "qwen3-coder:30b",
		cwd: goc,
		tomTat: `viec ${id}`,
		soLuot: 1,
		tokenVao: 100,
		tokenRa: 20,
		messages: [{ role: "user", content: "xin chao" }],
	};
}

beforeEach(async () => {
	goc = await mkdtemp(join(tmpdir(), "aw-pg-"));
});

afterAll(async () => {
	await rm(goc, { recursive: true, force: true }).catch(() => undefined);
});

describe("Lưu phiên", () => {
	it("lưu rồi đọc lại nguyên vẹn", async () => {
		await luuPhien(goc, phienMau("p1", "2026-08-17T10:00:00Z"));
		const p = await docPhien(goc, "p1");

		expect(p?.tomTat).toBe("viec p1");
		expect(p?.messages).toHaveLength(1);
	});

	it("id sinh từ thời điểm truyền vào nên tất định", () => {
		expect(taoIdPhien(new Date("2026-08-17T09:05:03"))).toBe("20260817-090503");
	});

	it("liệt kê theo thứ tự mới nhất trước", async () => {
		await luuPhien(goc, phienMau("cu", "2026-08-01T10:00:00Z"));
		await luuPhien(goc, phienMau("moi", "2026-08-17T10:00:00Z"));

		expect((await lietKePhien(goc)).map((p) => p.id)).toEqual(["moi", "cu"]);
		expect((await phienGanNhat(goc))?.id).toBe("moi");
	});

	it("tệp phiên hỏng bị bỏ qua, KHÔNG làm sập", async () => {
		await mkdir(join(goc, ".agentweave/sessions"), { recursive: true });
		await writeFile(join(goc, ".agentweave/sessions/hong.json"), "{ khong phai json");
		await luuPhien(goc, phienMau("tot", "2026-08-17T10:00:00Z"));

		expect(await docPhien(goc, "hong")).toBeNull();
		expect((await lietKePhien(goc)).map((p) => p.id)).toEqual(["tot"]);
	});

	it("chưa có phiên nào thì trả mảng rỗng, không ném lỗi", async () => {
		expect(await lietKePhien(goc)).toEqual([]);
		expect(await phienGanNhat(goc)).toBeNull();
	});

	it("ghi đè phiên cũ không để lại tệp tạm", async () => {
		await luuPhien(goc, phienMau("p1", "2026-08-17T10:00:00Z"));
		await luuPhien(goc, { ...phienMau("p1", "2026-08-17T11:00:00Z"), soLuot: 5 });

		expect((await docPhien(goc, "p1"))?.soLuot).toBe(5);
		await expect(readFile(join(goc, ".agentweave/sessions/p1.json.tam"))).rejects.toThrow();
	});
});

describe("Chèn @file", () => {
	beforeEach(async () => {
		await mkdir(join(goc, "src"), { recursive: true });
		await writeFile(join(goc, "src/a.ts"), "export const a = 1;");
	});

	it("gắn nội dung file vào trước câu hỏi", async () => {
		const kq = await chenFile("Giai thich @src/a.ts giup toi", goc);

		expect(kq.prompt).toContain("export const a = 1;");
		expect(kq.prompt).toContain("Giai thich @src/a.ts giup toi");
		expect(kq.daChen[0]?.duong).toBe("src/a.ts");
	});

	it("CHẶN đường dẫn ra ngoài thư mục làm việc", async () => {
		// Gõ nhầm không được biến thành rò rỉ tệp hệ thống.
		const kq = await chenFile("xem @../../../etc/passwd", goc);

		expect(kq.daChen).toHaveLength(0);
		expect(kq.loi[0]?.lyDo).toContain("ngoài thư mục làm việc");
		expect(kq.prompt).not.toContain("root:");
	});

	it("@ không phải file thì im lặng bỏ qua, không báo ồn", async () => {
		const kq = await chenFile("gui mail cho @nam va @team nhe", goc);

		expect(kq.daChen).toHaveLength(0);
		expect(kq.loi).toHaveLength(0);
		expect(kq.prompt).toBe("gui mail cho @nam va @team nhe");
	});

	it("cùng một file nhắc hai lần chỉ chèn một lần", async () => {
		const kq = await chenFile("so sanh @src/a.ts voi @src/a.ts", goc);
		expect(kq.daChen).toHaveLength(1);
	});

	it("không có @ nào thì trả nguyên câu hỏi", async () => {
		const kq = await chenFile("chao ban", goc);
		expect(kq.prompt).toBe("chao ban");
	});
});

describe("Cấu hình dự án", () => {
	it("không có tệp thì dùng mặc định, không báo lỗi", async () => {
		const kq = await docCauHinhAgent(goc);
		expect(kq.config).toEqual({});
		expect(kq.nguon).toBeNull();
		expect(kq.loi).toBeNull();
	});

	it("đọc được cấu hình hợp lệ", async () => {
		await mkdir(join(goc, ".agentweave"), { recursive: true });
		await writeFile(
			join(goc, ".agentweave/agent.json"),
			JSON.stringify({ model: "qwen3.6:35b", permissionMode: "permissive", maxTurns: 12 }),
		);

		const kq = await docCauHinhAgent(goc);
		expect(kq.config.model).toBe("qwen3.6:35b");
		expect(kq.config.permissionMode).toBe("permissive");
		expect(kq.config.maxTurns).toBe(12);
		expect(kq.loi).toBeNull();
	});

	it("JSON hỏng phải BÁO LỖI, không lặng lẽ dùng mặc định", async () => {
		// Lặng lẽ rơi về mặc định là kiểu hỏng khó chịu nhất: người dùng sửa
		// cấu hình rồi tưởng đã có hiệu lực.
		await mkdir(join(goc, ".agentweave"), { recursive: true });
		await writeFile(join(goc, ".agentweave/agent.json"), "{ hong roi");

		const kq = await docCauHinhAgent(goc);
		expect(kq.loi).toContain("JSON hỏng");
		expect(kq.nguon).not.toBeNull();
	});

	it("giá trị sai kiểu bị từ chối kèm tên trường", async () => {
		await mkdir(join(goc, ".agentweave"), { recursive: true });
		await writeFile(
			join(goc, ".agentweave/agent.json"),
			JSON.stringify({ maxTurns: -5, permissionMode: "sieu-quyen" }),
		);

		const kq = await docCauHinhAgent(goc);
		expect(kq.loi).toContain("maxTurns");
		expect(kq.loi).toContain("permissionMode");
	});

	it("luật quyền sai định dạng bị chỉ đúng vị trí", async () => {
		await mkdir(join(goc, ".agentweave"), { recursive: true });
		await writeFile(
			join(goc, ".agentweave/agent.json"),
			JSON.stringify({ rules: [{ pattern: "Bash(ls *)", behavior: "cho-phep-het" }] }),
		);

		const kq = await docCauHinhAgent(goc);
		expect(kq.loi).toContain("rules[0].behavior");
	});
});
