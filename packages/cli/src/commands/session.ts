/**
 * 'session' command — List and inspect agent sessions.
 *
 * Usage:
 *   agentweave session list [--dir ~/.agentweave/sessions]
 */

import { join } from "node:path";
import { lietKePhien } from "../lib/session-store.js";

export interface SessionArgs {
	action: "list";
	dir?: string;
}

export async function sessionCommand(args: SessionArgs): Promise<void> {
	// Mặc định là thư mục phiên CỦA DỰ ÁN — đúng chỗ `chat` ghi vào.
	// Bản trước mặc định `~/.agentweave/sessions`, nên `session list` không bao
	// giờ thấy phiên nào trong khi `chat --list-sessions` liệt kê đầy đủ. Hai
	// lệnh cùng nói về một thứ mà trả lời khác nhau là kiểu hỏng làm người dùng
	// mất niềm tin vào cả hai.
	const dir = args.dir ?? join(process.cwd(), ".agentweave", "sessions");

	if (args.action === "list") {
		await listSessions(dir);
	}
}

async function listSessions(dir: string): Promise<void> {
	console.log(`\n  Sessions directory: ${dir}\n`);

	// Dùng chung `lietKePhien` với `chat --list-sessions`. Bản trước tự đọc thư
	// mục và lọc đuôi ".jsonl" trong khi phiên được lưu dạng ".json", nên lệnh
	// này chưa bao giờ liệt kê được gì — kiểu hỏng im lặng: nó báo "No sessions
	// found" y hệt lúc thật sự chưa có phiên nào.
	const goc = dir.endsWith(join(".agentweave", "sessions"))
		? dir.slice(0, -(join(".agentweave", "sessions").length + 1))
		: dir;

	const ds = await lietKePhien(goc);
	if (ds.length === 0) {
		console.log("  No sessions found.\n");
		return;
	}

	console.log(`  ${"Session ID".padEnd(20)} ${"Turns".padEnd(7)} ${"Model".padEnd(24)} Updated`);
	console.log(`  ${"─".repeat(20)} ${"─".repeat(7)} ${"─".repeat(24)} ${"─".repeat(19)}`);
	for (const p of ds) {
		const luc = p.capNhat.slice(0, 19).replace("T", " ");
		console.log(
			`  ${p.id.padEnd(20)} ${String(p.soLuot).padEnd(7)} ${p.model.slice(0, 24).padEnd(24)} ${luc}`,
		);
		if (p.tomTat) console.log(`  ${" ".repeat(20)} ${p.tomTat.slice(0, 70)}`);
	}
	console.log(`\n  Total: ${ds.length} session(s)\n`);
}
