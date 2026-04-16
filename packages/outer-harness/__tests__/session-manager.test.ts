import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { SessionManager } from "../src/observability/session-manager";
import type { InnerEvent } from "@agentweave/types";

const TEST_DIR = path.join(os.tmpdir(), "agentweave-test-sessions");

function makeEvent(type: string, extra: Record<string, unknown> = {}): InnerEvent {
	return {
		id: "e1",
		timestamp: Date.now(),
		sessionId: "ses_test",
		agentId: "a1",
		type,
		...extra,
	} as InnerEvent;
}

describe("SessionManager", () => {
	let sm: SessionManager;

	beforeEach(async () => {
		sm = new SessionManager({ sessionsDir: TEST_DIR, autoSave: true });
	});

	afterEach(async () => {
		try {
			await fs.rm(TEST_DIR, { recursive: true, force: true });
		} catch { /* ignore */ }
	});

	it("should save events to JSONL file on autoSave", async () => {
		await sm.onSessionStart({
			sessionId: "ses_1", agentId: "a1", model: "mock", startTime: Date.now(), cwd: "/tmp",
		});

		await sm.onEvent(makeEvent("turn:start", { turnIndex: 1 }));
		await sm.onEvent(makeEvent("turn:end", { turnIndex: 1, stopReason: "continue" }));

		const events = await sm.loadSession("ses_1");
		expect(events).toHaveLength(2);
		expect(events[0]!.type).toBe("turn:start");
	});

	it("should load session from JSONL", async () => {
		await sm.onSessionStart({
			sessionId: "ses_load", agentId: "a1", model: "mock", startTime: Date.now(), cwd: "/tmp",
		});
		await sm.onEvent(makeEvent("turn:start", { turnIndex: 1 }));
		await sm.onEvent(makeEvent("tool:requested", { toolName: "Bash", toolInput: {}, toolUseId: "tu_1" }));

		const loaded = await sm.loadSession("ses_load");
		expect(loaded).toHaveLength(2);
	});

	it("should return empty array for non-existent session", async () => {
		const events = await sm.loadSession("nonexistent");
		expect(events).toEqual([]);
	});

	it("should list saved sessions", async () => {
		await sm.onSessionStart({
			sessionId: "ses_a", agentId: "a1", model: "mock", startTime: Date.now(), cwd: "/tmp",
		});
		await sm.onEvent(makeEvent("turn:start", { turnIndex: 1 }));

		// Create second session with new manager instance
		const sm2 = new SessionManager({ sessionsDir: TEST_DIR, autoSave: true });
		await sm2.onSessionStart({
			sessionId: "ses_b", agentId: "a1", model: "mock", startTime: Date.now(), cwd: "/tmp",
		});
		await sm2.onEvent(makeEvent("turn:start", { turnIndex: 1 }));

		const sessions = await sm.listSessions();
		expect(sessions).toHaveLength(2);
		expect(sessions.map((s) => s.sessionId).sort()).toEqual(["ses_a", "ses_b"]);
	});

	it("should delete a session", async () => {
		await sm.onSessionStart({
			sessionId: "ses_del", agentId: "a1", model: "mock", startTime: Date.now(), cwd: "/tmp",
		});
		await sm.onEvent(makeEvent("turn:start", { turnIndex: 1 }));

		const deleted = await sm.deleteSession("ses_del");
		expect(deleted).toBe(true);

		const events = await sm.loadSession("ses_del");
		expect(events).toEqual([]);
	});

	it("should export session as markdown", async () => {
		await sm.onSessionStart({
			sessionId: "ses_md", agentId: "a1", model: "mock", startTime: Date.now(), cwd: "/tmp",
		});
		await sm.onEvent(makeEvent("turn:start", { turnIndex: 1 }));
		await sm.onEvent(makeEvent("tool:requested", { toolName: "FileRead", toolInput: { path: "x.ts" }, toolUseId: "tu_1" }));
		await sm.onEvent(makeEvent("tool:completed", { toolUseId: "tu_1", result: "ok", durationMs: 15 }));

		const md = await sm.exportAsMarkdown("ses_md");
		expect(md).toContain("# Session ses_md");
		expect(md).toContain("## Turn 1");
		expect(md).toContain("FileRead");
	});

	it("should write session_end summary", async () => {
		await sm.onSessionStart({
			sessionId: "ses_end", agentId: "a1", model: "mock", startTime: Date.now(), cwd: "/tmp",
		});
		await sm.onEvent(makeEvent("turn:start", { turnIndex: 1 }));
		await sm.onSessionEnd(
			{ sessionId: "ses_end", agentId: "a1", model: "mock", startTime: Date.now(), cwd: "/tmp" },
			{ reason: "completed" },
		);

		const content = await fs.readFile(
			path.join(TEST_DIR, "ses_end.jsonl"),
			"utf-8",
		);
		const lines = content.trim().split("\n");
		const lastLine = JSON.parse(lines.at(-1)!);
		expect(lastLine.type).toBe("session_end");
		expect(lastLine.result.reason).toBe("completed");
	});

	it("should track buffered event count", async () => {
		await sm.onSessionStart({
			sessionId: "ses_buf", agentId: "a1", model: "mock", startTime: Date.now(), cwd: "/tmp",
		});
		expect(sm.getBufferedEventCount()).toBe(0);

		await sm.onEvent(makeEvent("turn:start", { turnIndex: 1 }));
		await sm.onEvent(makeEvent("turn:end", { turnIndex: 1, stopReason: "x" }));

		expect(sm.getBufferedEventCount()).toBe(2);
	});
});
