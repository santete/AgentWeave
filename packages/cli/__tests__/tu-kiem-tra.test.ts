/**
 * Hồi quy cho đợt tự kiểm tra trước khi bàn giao.
 *
 * Mọi test ở đây ứng với một lỗi ĐÃ TÁI HIỆN ĐƯỢC, không phải giả định. Điểm
 * chung của chúng: hệ thống báo xanh trong khi sai — thứ nguy hiểm nhất trong
 * air-gap, vì sau khi bàn giao không ai gỡ rối được.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHarness } from "@agentweave/sdk";
import { luuPhien, lietKePhien, taoIdPhien } from "../src/lib/session-store";

const root = join(tmpdir(), `agentweave-tkt-${Date.now()}`);

beforeAll(async () => {
	await mkdir(root, { recursive: true });
});
afterAll(async () => {
	await rm(root, { recursive: true, force: true });
});

describe("contextWindow phai di het chuoi toi AgentLoop", () => {
	it("khai bao bao nhieu thi AgentLoop dung dung bay nhieu", () => {
		for (const cw of [16_384, 32_768, 131_072]) {
			const h = createHarness({ model: "qwen3-coder:30b", contextWindow: cw });
			expect(h.inner.getState().contextUsage.maxTokens).toBe(cw);
		}
	});

	it("khong khai thi van suy ra duoc (khong vo)", () => {
		const h = createHarness({ model: "qwen3-coder:30b" });
		expect(h.inner.getState().contextUsage.maxTokens).toBeGreaterThan(0);
	});

	it("suy SAI theo huong lon hon la kieu hong te nhat — nen phai khop tuyet doi", () => {
		// Model 32K ma tuong 64K thi nguong nen (0,8) khong bao gio cham, Ollama
		// am tham cat phan dau hoi thoai, agent quen de bai ma khong bao gi.
		const h = createHarness({ model: "qwen3-coder:30b", contextWindow: 32_768 });
		expect(h.inner.getState().contextUsage.maxTokens).not.toBe(65_536);
	});
});

describe("session list va chat --list-sessions phai noi cung mot thu", () => {
	it("phien luu boi chat duoc lietKePhien tim thay", async () => {
		const duAn = join(root, "duan-phien");
		await mkdir(duAn, { recursive: true });
		const id = taoIdPhien(new Date());
		await luuPhien(duAn, {
			id,
			capNhat: new Date().toISOString(),
			model: "qwen3-coder:30b",
			cwd: duAn,
			tomTat: "thu nghiem",
			soLuot: 1,
			tokenVao: 10,
			tokenRa: 20,
			messages: [{ role: "user", content: "hi" }],
		});

		const ds = await lietKePhien(duAn);
		expect(ds.map((p) => p.id)).toContain(id);
		// Duoi tep phai la .json — ban truoc `session list` loc ".jsonl" nen
		// khong bao gio thay gi, ma van in "No sessions found" y het luc that su rong.
		const { readdir } = await import("node:fs/promises");
		const tep = await readdir(join(duAn, ".agentweave", "sessions"));
		expect(tep.some((t) => t.endsWith(".json"))).toBe(true);
		expect(tep.some((t) => t.endsWith(".jsonl"))).toBe(false);
	});
});
