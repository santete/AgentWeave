import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { auditReplayCommand, auditViewCommand, parseSince } from "../src/commands/audit";

// ─── Test harness ────────────────────────────────────────────────

let workDir: string;
let logPath: string;
let stdoutBuf: string;
let stderrBuf: string;
let logSpy: ReturnType<typeof vi.spyOn>;
let errSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
	workDir = mkdtempSync(join(tmpdir(), "aw-audit-"));
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
		session_id: "s1",
		...overrides,
	};
}

// ─── parseSince ──────────────────────────────────────────────────

describe("parseSince", () => {
	it("parses seconds/minutes/hours/days", () => {
		const now = Date.now();
		expect(parseSince("30s")!).toBeGreaterThan(now - 31_000);
		expect(parseSince("5m")!).toBeGreaterThan(now - 301_000);
		expect(parseSince("1h")!).toBeGreaterThan(now - 3_601_000);
		expect(parseSince("2d")!).toBeGreaterThan(now - 2 * 86_400_000 - 1000);
	});

	it("parses ISO timestamp", () => {
		const iso = "2026-04-22T10:00:00.000Z";
		expect(parseSince(iso)).toBe(Date.parse(iso));
	});

	it("returns null for garbage", () => {
		expect(parseSince("not a duration")).toBeNull();
		expect(parseSince("10x")).toBeNull();
	});
});

// ─── auditViewCommand: empty / missing ───────────────────────────

describe("auditViewCommand — empty cases", () => {
	it("prints friendly message when log file missing", async () => {
		const code = await auditViewCommand({ cwd: workDir });
		expect(code).toBe(0);
		expect(stdoutBuf).toContain("No audit log");
	});

	it("prints 'no matching' when filter excludes all", async () => {
		writeLog([fixture({ tool: "Bash" })]);
		const code = await auditViewCommand({ cwd: workDir, tool: "Write" });
		expect(code).toBe(0);
		expect(stdoutBuf).toContain("No matching");
	});
});

// ─── auditViewCommand: JSON format ───────────────────────────────

describe("auditViewCommand — JSON format", () => {
	it("emits one JSON object per matching entry", async () => {
		writeLog([
			fixture({ tool: "Bash", ts: "2026-04-22T10:00:00.000Z" }),
			fixture({ tool: "Write", ts: "2026-04-22T10:01:00.000Z" }),
		]);
		const code = await auditViewCommand({ cwd: workDir, format: "json" });
		expect(code).toBe(0);
		const lines = stdoutBuf.trim().split("\n").filter(Boolean);
		expect(lines).toHaveLength(2);
		const parsed = lines.map((l) => JSON.parse(l));
		expect(parsed[0].tool).toBe("Bash");
		expect(parsed[1].tool).toBe("Write");
	});
});

// ─── auditViewCommand: filters ───────────────────────────────────

describe("auditViewCommand — filters", () => {
	beforeEach(() => {
		writeLog([
			fixture({ tool: "Bash", decision: "approve", ts: "2026-04-22T09:00:00.000Z" }),
			fixture({ tool: "Bash", decision: "block", ts: "2026-04-22T10:00:00.000Z" }),
			fixture({ tool: "Write", decision: "approve", ts: "2026-04-22T11:00:00.000Z" }),
			fixture({ tool: "Edit", decision: "block", ts: "2026-04-22T12:00:00.000Z" }),
		]);
	});

	it("filters by --tool", async () => {
		await auditViewCommand({ cwd: workDir, tool: "Bash", format: "json" });
		const lines = stdoutBuf.trim().split("\n");
		expect(lines).toHaveLength(2);
		for (const l of lines) expect(JSON.parse(l).tool).toBe("Bash");
	});

	it("filters by --decision", async () => {
		await auditViewCommand({ cwd: workDir, decision: "block", format: "json" });
		const lines = stdoutBuf.trim().split("\n");
		expect(lines).toHaveLength(2);
		for (const l of lines) expect(JSON.parse(l).decision).toBe("block");
	});

	it("combines --tool and --decision", async () => {
		await auditViewCommand({
			cwd: workDir,
			tool: "Bash",
			decision: "block",
			format: "json",
		});
		const lines = stdoutBuf.trim().split("\n");
		expect(lines).toHaveLength(1);
		expect(JSON.parse(lines[0]!).tool).toBe("Bash");
		expect(JSON.parse(lines[0]!).decision).toBe("block");
	});

	it("filters by --since ISO timestamp", async () => {
		await auditViewCommand({
			cwd: workDir,
			since: "2026-04-22T10:30:00.000Z",
			format: "json",
		});
		const lines = stdoutBuf.trim().split("\n").filter(Boolean);
		expect(lines).toHaveLength(2);
		for (const l of lines) {
			const ts = Date.parse(JSON.parse(l).ts);
			expect(ts).toBeGreaterThan(Date.parse("2026-04-22T10:30:00.000Z"));
		}
	});

	it("returns error code on malformed --since", async () => {
		const code = await auditViewCommand({
			cwd: workDir,
			since: "nonsense",
		});
		expect(code).toBe(1);
		expect(stderrBuf).toContain("--since must be");
	});
});

// ─── auditViewCommand: limit ─────────────────────────────────────

describe("auditViewCommand — limit", () => {
	it("shows last N entries when --limit set", async () => {
		const entries = [];
		for (let i = 0; i < 10; i++) {
			entries.push(fixture({ ts: `2026-04-22T10:0${i}:00.000Z`, session_id: `s${i}` }));
		}
		writeLog(entries);

		await auditViewCommand({ cwd: workDir, limit: 3, format: "json" });
		const lines = stdoutBuf.trim().split("\n");
		expect(lines).toHaveLength(3);
		expect(JSON.parse(lines[0]!).session_id).toBe("s7");
		expect(JSON.parse(lines[2]!).session_id).toBe("s9");
	});

	it("defaults to 50-entry limit", async () => {
		const entries = [];
		for (let i = 0; i < 100; i++) {
			entries.push(fixture({ ts: `2026-04-22T10:00:${String(i).padStart(2, "0")}.000Z` }));
		}
		writeLog(entries);

		await auditViewCommand({ cwd: workDir, format: "json" });
		const lines = stdoutBuf.trim().split("\n");
		expect(lines).toHaveLength(50);
	});
});

// ─── auditViewCommand: table rendering ──────────────────────────

describe("auditViewCommand — table format", () => {
	it("prints header + rows with timestamp/phase/tool/decision", async () => {
		writeLog([
			fixture({ tool: "Bash", decision: "approve" }),
			fixture({ tool: "Write", decision: "block", reason: "policy deny", ts: "2026-04-22T10:05:00.000Z" }),
		]);
		await auditViewCommand({ cwd: workDir });
		// strip ANSI for clarity
		const stripped = stdoutBuf.replace(/\x1b\[[0-9;]*m/g, "");
		expect(stripped).toContain("TIME");
		expect(stripped).toContain("PHASE");
		expect(stripped).toContain("TOOL");
		expect(stripped).toContain("DECISION");
		expect(stripped).toContain("Bash");
		expect(stripped).toContain("Write");
		expect(stripped).toContain("policy deny");
	});

	it("skips unparseable lines without crashing", async () => {
		writeFileSync(
			logPath,
			[
				JSON.stringify(fixture({ tool: "Bash" })),
				"not json at all",
				"",
				JSON.stringify(fixture({ tool: "Write", ts: "2026-04-22T10:01:00.000Z" })),
			].join("\n"),
			"utf-8",
		);
		const code = await auditViewCommand({ cwd: workDir, format: "json" });
		expect(code).toBe(0);
		const lines = stdoutBuf.trim().split("\n").filter(Boolean);
		expect(lines).toHaveLength(2);
	});
});

// ─── P3.1 step 9: LEVEL column + immutable marker ────────────────

describe("auditViewCommand — LEVEL column + immutable marker", () => {
	function strip(s: string): string {
		return s.replace(/\x1b\[[0-9;]*m/g, "");
	}

	it("renders LEVEL header and maps source → label (org/team/user/rt/hook/-)", async () => {
		writeLog([
			fixture({ tool: "Bash", decision: "approve", source: "policy", ts: "2026-04-22T10:00:00.000Z" }),
			fixture({ tool: "Bash", decision: "approve", source: "project", ts: "2026-04-22T10:01:00.000Z" }),
			fixture({ tool: "Bash", decision: "approve", source: "user", ts: "2026-04-22T10:02:00.000Z" }),
			fixture({ tool: "Bash", decision: "approve", source: "runtime", ts: "2026-04-22T10:03:00.000Z" }),
			fixture({ tool: "Bash", decision: "approve", source: "hook", ts: "2026-04-22T10:04:00.000Z" }),
			fixture({ tool: "Bash", decision: "approve", ts: "2026-04-22T10:05:00.000Z" }), // no source
		]);
		await auditViewCommand({ cwd: workDir });
		const out = strip(stdoutBuf);
		expect(out).toContain("LEVEL");
		// every label must appear at least once
		expect(out).toMatch(/\borg\b/);
		expect(out).toMatch(/\bteam\b/);
		expect(out).toMatch(/\buser\b/);
		expect(out).toMatch(/\brt\b/);
		expect(out).toMatch(/\bhook\b/);
	});

	it("appends (!) to decision when immutable=true, not when false/undefined", async () => {
		writeLog([
			fixture({ tool: "Bash", decision: "block", source: "policy", immutable: true, ts: "2026-04-22T10:00:00.000Z" }),
			fixture({ tool: "Bash", decision: "approve", source: "user", ts: "2026-04-22T10:01:00.000Z" }),
		]);
		await auditViewCommand({ cwd: workDir });
		const out = strip(stdoutBuf);
		expect(out).toContain("block(!)");
		// non-immutable approve must NOT have (!)
		expect(out).not.toContain("approve(!)");
		expect(out).toMatch(/\bapprove\b/);
	});

	it("JSON format preserves source + immutable fields intact", async () => {
		writeLog([
			fixture({ tool: "Bash", decision: "block", source: "policy", immutable: true }),
		]);
		await auditViewCommand({ cwd: workDir, format: "json" });
		const parsed = JSON.parse(stdoutBuf.trim());
		expect(parsed.source).toBe("policy");
		expect(parsed.immutable).toBe(true);
	});
});

describe("auditReplayCommand — LEVEL + immutable in replay", () => {
	function strip(s: string): string {
		return s.replace(/\x1b\[[0-9;]*m/g, "");
	}

	it("renders OFFSET + LEVEL columns and (!) marker for immutable decisions", async () => {
		writeLog([
			fixture({ session_id: "ses_r", decision: "approve", source: "user", ts: "2026-04-22T10:00:00.000Z" }),
			fixture({ session_id: "ses_r", decision: "block", source: "policy", immutable: true, reason: "rm denied", ts: "2026-04-22T10:00:01.500Z" }),
			fixture({ session_id: "ses_other", tool: "Bash", ts: "2026-04-22T10:00:02.000Z" }),
		]);
		const code = await auditReplayCommand({ cwd: workDir, sessionId: "ses_r" });
		expect(code).toBe(0);
		const out = strip(stdoutBuf);
		expect(out).toContain("OFFSET");
		expect(out).toContain("LEVEL");
		expect(out).toMatch(/\borg\b/);
		expect(out).toMatch(/\buser\b/);
		expect(out).toContain("block(!)");
		expect(out).toContain("+1.50s");
	});

	it("JSON format preserves source + immutable in replay output", async () => {
		writeLog([
			fixture({ session_id: "ses_j", decision: "block", source: "policy", immutable: true, ts: "2026-04-22T10:00:00.000Z" }),
		]);
		await auditReplayCommand({ cwd: workDir, sessionId: "ses_j", format: "json" });
		const parsed = JSON.parse(stdoutBuf.trim());
		expect(parsed.source).toBe("policy");
		expect(parsed.immutable).toBe(true);
	});
});
