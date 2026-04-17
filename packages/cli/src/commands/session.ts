/**
 * 'session' command — List and inspect agent sessions.
 *
 * Usage:
 *   agentweave session list [--dir ~/.agentweave/sessions]
 */

import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

export interface SessionArgs {
	action: "list";
	dir?: string;
}

export async function sessionCommand(args: SessionArgs): Promise<void> {
	const dir = args.dir ?? join(homedir(), ".agentweave", "sessions");

	if (args.action === "list") {
		await listSessions(dir);
	}
}

async function listSessions(dir: string): Promise<void> {
	console.log(`\n  Sessions directory: ${dir}\n`);

	try {
		const files = await readdir(dir);
		const jsonlFiles = files.filter((f) => f.endsWith(".jsonl"));

		if (jsonlFiles.length === 0) {
			console.log("  No sessions found.\n");
			return;
		}

		console.log(`  ${"Session ID".padEnd(40)} ${"Size".padEnd(10)} Modified`);
		console.log(`  ${"─".repeat(40)} ${"─".repeat(10)} ${"─".repeat(20)}`);

		for (const file of jsonlFiles) {
			const filePath = join(dir, file);
			const info = await stat(filePath);
			const sessionId = file.replace(".jsonl", "");
			const size = info.size < 1024 ? `${info.size}B` : `${(info.size / 1024).toFixed(1)}KB`;
			const modified = info.mtime.toISOString().slice(0, 19).replace("T", " ");

			console.log(`  ${sessionId.padEnd(40)} ${size.padEnd(10)} ${modified}`);
		}

		console.log(`\n  Total: ${jsonlFiles.length} session(s)\n`);
	} catch {
		console.log("  Directory not found or empty.\n");
	}
}
