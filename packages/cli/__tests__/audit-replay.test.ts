import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { auditReplayCommand } from "../src/commands/audit";

let workDir: string;
let logPath: string;
let stdoutBuf: string;
let stderrBuf: string;
let logSpy: ReturnType<typeof vi.spyOn>;
let errSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
	workDir = mkdtempSync(join(tmpdir(), "aw-replay-"));
	mkdirSync(join(workDir, ".agentweave"), { recursive: true });
	logPath = join(workDir, ".agentweave", "audit.log");
	stdoutBuf = "";
	stderrBuf = "";
	logSpy = vi.spyOn(console, "log").mockImplementation((...parts: unknown[]) => {
		stdoutBuf += parts.join(" ") + "\n";
	});
	errSpy = vi.spyOn(console, "error").mockImplementation((...parts: unknown[]) => {
		stderrBuf += parts.join(" ") + "\n";
	});
});

afterEach(() => {
	logSpy.mockRestore();
	errSpy.mockRestore();
	rmSync(workDir, { recursive: true, force: true });
});

function writeLog(entries: Array<Record<string, unknown>>): void {
	const lines = entries.map((e) => JSON.stringify(e)).join("\n") + "\n";
	writeFileSync(logPath, lines, "utf-8");
}

function fixture(overrides: Record<string, unknown>): Record<string, unknown> {
	return {
		ts: "2026-04-22T10:00:00.000Z",
		phase: "pre",
		tool: "Bash",
		decision: "approve",
		session_id: "ses_a",
		...overrides,
	};
}

describe("auditReplayCommand — session filter", () => {
	it("returns only entries for the requested session, in chronological order", async () => {
		writeLog([
			fixture({ session_id: "ses_a", ts: "2026-04-22T10:00:02.000Z", tool: "Bash" }),
			fixture({ session_id: "ses_b", ts: "2026-04-22T10:00:01.000Z", tool: "Write" }),
			fixture({ session_id: "ses_a", ts: "2026-04-22T10:00:00.500Z", tool: "Read" }),
		]);
		const code = await auditReplayCommand({ sessionId: "ses_a", cwd: workDir, format: "json" });
		expect(code).toBe(0);
		const lines = stdoutBuf.trim().split("\n").filter(Boolean);
		expect(lines).toHaveLength(2);
		const parsed = lines.map((l) => JSON.parse(l) as Record<string, unknown>);
		expect(parsed[0]!.tool).toBe("Read");
		expect(parsed[1]!.tool).toBe("Bash");
	});
});

describe("auditReplayCommand — format", () => {
	it("emits one JSON object per entry when --format json", async () => {
		writeLog([
			fixture({ session_id: "ses_a", ts: "2026-04-22T10:00:00.000Z" }),
			fixture({ session_id: "ses_a", ts: "2026-04-22T10:00:01.000Z", tool: "Write" }),
		]);
		await auditReplayCommand({ sessionId: "ses_a", cwd: workDir, format: "json" });
		const lines = stdoutBuf.trim().split("\n").filter(Boolean);
		expect(lines).toHaveLength(2);
		for (const l of lines) expect(() => JSON.parse(l)).not.toThrow();
	});

	it("renders timeline table with OFFSET column when default format", async () => {
		writeLog([
			fixture({ session_id: "ses_a", ts: "2026-04-22T10:00:00.000Z" }),
			fixture({
				session_id: "ses_a",
				ts: "2026-04-22T10:00:00.250Z",
				tool: "Write",
				decision: "block",
				reason: "deny",
			}),
		]);
		await auditReplayCommand({ sessionId: "ses_a", cwd: workDir });
		const stripped = stdoutBuf.replace(/\x1b\[[0-9;]*m/g, "");
		expect(stripped).toContain("OFFSET");
		expect(stripped).toContain("+0ms");
		expect(stripped).toContain("+250ms");
		expect(stripped).toContain("ses_a");
		expect(stripped).toContain("deny");
	});
});

describe("auditReplayCommand — time window", () => {
	it("filters by --since and --until ISO window", async () => {
		writeLog([
			fixture({ session_id: "ses_a", ts: "2026-04-22T09:00:00.000Z" }),
			fixture({ session_id: "ses_a", ts: "2026-04-22T10:30:00.000Z" }),
			fixture({ session_id: "ses_a", ts: "2026-04-22T11:30:00.000Z" }),
			fixture({ session_id: "ses_a", ts: "2026-04-22T12:30:00.000Z" }),
		]);
		await auditReplayCommand({
			sessionId: "ses_a",
			cwd: workDir,
			since: "2026-04-22T10:00:00.000Z",
			until: "2026-04-22T12:00:00.000Z",
			format: "json",
		});
		const lines = stdoutBuf.trim().split("\n").filter(Boolean);
		expect(lines).toHaveLength(2);
		expect((JSON.parse(lines[0]!) as Record<string, unknown>).ts).toBe("2026-04-22T10:30:00.000Z");
		expect((JSON.parse(lines[1]!) as Record<string, unknown>).ts).toBe("2026-04-22T11:30:00.000Z");
	});
});

describe("auditReplayCommand — empty / missing", () => {
	it("exits 1 with stderr when no entries match session", async () => {
		writeLog([fixture({ session_id: "ses_b" })]);
		const code = await auditReplayCommand({ sessionId: "ses_missing", cwd: workDir });
		expect(code).toBe(1);
		expect(stderrBuf).toContain("No entries for session ses_missing");
	});

	it("exits 0 with friendly message when log file is missing", async () => {
		const code = await auditReplayCommand({ sessionId: "ses_a", cwd: workDir });
		expect(code).toBe(0);
		expect(stdoutBuf).toContain("No audit log");
	});
});

describe("auditReplayCommand — resilience", () => {
	it("skips malformed lines and still renders valid entries", async () => {
		writeFileSync(
			logPath,
			[
				JSON.stringify(fixture({ session_id: "ses_a", ts: "2026-04-22T10:00:00.000Z" })),
				"not json",
				"",
				JSON.stringify(
					fixture({ session_id: "ses_a", ts: "2026-04-22T10:00:01.000Z", tool: "Write" }),
				),
			].join("\n"),
			"utf-8",
		);
		const code = await auditReplayCommand({ sessionId: "ses_a", cwd: workDir, format: "json" });
		expect(code).toBe(0);
		const lines = stdoutBuf.trim().split("\n").filter(Boolean);
		expect(lines).toHaveLength(2);
	});
});
