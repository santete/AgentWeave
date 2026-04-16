/**
 * SessionManager — Persist and resume agent sessions.
 * Stores transcripts as JSONL (one event per line) for streaming-friendly I/O.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import type { InnerEvent, SessionInfo, TerminalResult } from "@agentweave/types";

export interface SessionManagerConfig {
	/** Directory to store sessions. Default: ~/.agentweave/sessions/ */
	sessionsDir?: string;
	/** Auto-save events as they arrive */
	autoSave?: boolean;
}

export interface SessionRecord {
	sessionId: string;
	startTime: number;
	endTime?: number;
	model: string;
	eventCount: number;
	/** Size in bytes of the JSONL file */
	fileSize?: number;
}

export class SessionManager {
	private sessionsDir: string;
	private autoSave: boolean;
	private currentSessionId = "";
	private eventBuffer: InnerEvent[] = [];

	constructor(config?: SessionManagerConfig) {
		this.sessionsDir =
			config?.sessionsDir ??
			path.join(os.homedir(), ".agentweave", "sessions");
		this.autoSave = config?.autoSave ?? true;
	}

	async onSessionStart(session: SessionInfo): Promise<void> {
		this.currentSessionId = session.sessionId;
		this.eventBuffer = [];
		await this.ensureDir();
	}

	async onEvent(event: InnerEvent): Promise<void> {
		this.eventBuffer.push(event);
		if (this.autoSave) {
			await this.appendEvent(event);
		}
	}

	async onSessionEnd(
		session: SessionInfo,
		result: TerminalResult,
	): Promise<void> {
		// Write a final summary line
		const summary = {
			type: "session_end",
			sessionId: session.sessionId,
			result,
			eventCount: this.eventBuffer.length,
			timestamp: Date.now(),
		};
		await this.appendLine(
			session.sessionId,
			JSON.stringify(summary),
		);
	}

	/** Save all buffered events at once (if autoSave was off). */
	async saveSession(): Promise<void> {
		if (!this.currentSessionId) return;
		const lines = this.eventBuffer.map((e) => JSON.stringify(e));
		const filePath = this.sessionFilePath(this.currentSessionId);
		await this.ensureDir();
		await fs.writeFile(filePath, `${lines.join("\n")}\n`, "utf-8");
	}

	/** Load a session's events from JSONL file. */
	async loadSession(sessionId: string): Promise<InnerEvent[]> {
		const filePath = this.sessionFilePath(sessionId);
		try {
			const content = await fs.readFile(filePath, "utf-8");
			return content
				.trim()
				.split("\n")
				.filter((line) => line.length > 0)
				.map((line) => JSON.parse(line) as InnerEvent);
		} catch {
			return [];
		}
	}

	/** List all saved sessions. */
	async listSessions(): Promise<SessionRecord[]> {
		try {
			await this.ensureDir();
			const files = await fs.readdir(this.sessionsDir);
			const records: SessionRecord[] = [];

			for (const file of files) {
				if (!file.endsWith(".jsonl")) continue;
				const sessionId = file.replace(".jsonl", "");
				const filePath = path.join(this.sessionsDir, file);
				const stat = await fs.stat(filePath);

				// Read first line to get session start info
				const content = await fs.readFile(filePath, "utf-8");
				const lines = content.trim().split("\n");
				const firstEvent = lines[0]
					? (JSON.parse(lines[0]) as Record<string, unknown>)
					: null;

				records.push({
					sessionId,
					startTime: (firstEvent?.timestamp as number) ?? stat.mtimeMs,
					model: (firstEvent?.model as string) ?? "unknown",
					eventCount: lines.length,
					fileSize: stat.size,
				});
			}

			return records.sort((a, b) => b.startTime - a.startTime);
		} catch {
			return [];
		}
	}

	/** Delete a session transcript. */
	async deleteSession(sessionId: string): Promise<boolean> {
		try {
			await fs.unlink(this.sessionFilePath(sessionId));
			return true;
		} catch {
			return false;
		}
	}

	/** Export session as formatted markdown. */
	async exportAsMarkdown(sessionId: string): Promise<string> {
		const events = await this.loadSession(sessionId);
		if (events.length === 0) return `# Session ${sessionId}\n\nNo events found.`;

		const lines: string[] = [`# Session ${sessionId}\n`];

		for (const event of events) {
			switch (event.type) {
				case "turn:start":
					lines.push(`\n## Turn ${event.turnIndex}\n`);
					break;
				case "message:assistant":
					for (const block of event.content) {
						if (block.type === "text") {
							lines.push(`**Assistant:** ${block.text}\n`);
						}
					}
					break;
				case "tool:requested":
					lines.push(
						`**Tool:** \`${event.toolName}\`(${JSON.stringify(event.toolInput).slice(0, 100)})\n`,
					);
					break;
				case "tool:completed":
					lines.push(`**Result:** completed in ${event.durationMs.toFixed(0)}ms\n`);
					break;
				case "tool:failed":
					lines.push(`**Error:** ${event.error}\n`);
					break;
				case "permission:denied":
					lines.push(`**Denied:** ${event.toolName} — ${event.reason}\n`);
					break;
				case "terminal":
					lines.push(`\n---\n**Terminal:** ${event.reason}\n`);
					break;
			}
		}

		return lines.join("\n");
	}

	getSessionsDir(): string {
		return this.sessionsDir;
	}

	getBufferedEventCount(): number {
		return this.eventBuffer.length;
	}

	// ─── Internal ────────────────────────────────────────────────

	private sessionFilePath(sessionId: string): string {
		return path.join(this.sessionsDir, `${sessionId}.jsonl`);
	}

	private async ensureDir(): Promise<void> {
		await fs.mkdir(this.sessionsDir, { recursive: true });
	}

	private async appendEvent(event: InnerEvent): Promise<void> {
		await this.appendLine(this.currentSessionId, JSON.stringify(event));
	}

	private async appendLine(
		sessionId: string,
		line: string,
	): Promise<void> {
		const filePath = this.sessionFilePath(sessionId);
		await fs.appendFile(filePath, `${line}\n`, "utf-8");
	}
}
