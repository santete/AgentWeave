import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAdapterGovernance } from "../src/lib/adapter-governance";

function tmpAuditDir(): string {
	return mkdtempSync(join(tmpdir(), "aw-gov-"));
}

describe("createAdapterGovernance — filterText", () => {
	it("should redact OpenAI-style secret keys by default", () => {
		const g = createAdapterGovernance({
			sessionId: "s1",
			auditDir: tmpAuditDir(),
			persist: false,
		});

		const fake = "sk-" + "a".repeat(48);
		const { text, redacted } = g.filterText(`run with key ${fake} please`);

		expect(redacted).toBe(true);
		expect(text).not.toContain(fake);
		expect(text).toContain("[REDACTED:SECRET]");
	});

	it("should redact email PII by default", () => {
		const g = createAdapterGovernance({
			sessionId: "s2",
			auditDir: tmpAuditDir(),
			persist: false,
		});

		const { text, redacted } = g.filterText("contact me at user@example.com for help");

		expect(redacted).toBe(true);
		expect(text).not.toContain("user@example.com");
	});

	it("should NOT redact when disableRedaction is true", () => {
		const g = createAdapterGovernance({
			sessionId: "s3",
			auditDir: tmpAuditDir(),
			persist: false,
			disableRedaction: true,
		});

		const original = "sk-" + "b".repeat(48);
		const { text, redacted } = g.filterText(original);

		expect(redacted).toBe(false);
		expect(text).toBe(original);
	});

	it("should leave clean text untouched", () => {
		const g = createAdapterGovernance({
			sessionId: "s4",
			auditDir: tmpAuditDir(),
			persist: false,
		});

		const { text, redacted } = g.filterText("hello world, no secrets here");

		expect(redacted).toBe(false);
		expect(text).toBe("hello world, no secrets here");
	});
});

describe("createAdapterGovernance — audit log", () => {
	it("should record spawn, message, and exit in order", () => {
		const g = createAdapterGovernance({
			sessionId: "s5",
			auditDir: tmpAuditDir(),
			persist: false,
		});

		g.logSpawn("cursor-agent", ["--force", "-p"], ["CURSOR_API_KEY"]);
		g.logMessage("hi there", "hi there", false);
		g.logExit("completed", 1234, 0);

		const entries = g.getAuditEntries();
		expect(entries).toHaveLength(3);
		expect(entries[0]!.action).toBe("adapter:spawn");
		expect(entries[0]!.details.command).toBe("cursor-agent");
		expect(entries[0]!.details.argsCount).toBe(2);
		expect(entries[0]!.details.envKeys).toEqual(["CURSOR_API_KEY"]);

		expect(entries[1]!.action).toBe("adapter:message");
		expect(entries[1]!.details.redacted).toBe(false);

		expect(entries[2]!.action).toBe("adapter:exit");
		expect(entries[2]!.details.reason).toBe("completed");
		expect(entries[2]!.details.durationMs).toBe(1234);
	});

	it("should mark redacted=true on messages with redactions", () => {
		const g = createAdapterGovernance({
			sessionId: "s6",
			auditDir: tmpAuditDir(),
			persist: false,
		});

		const raw = "sk-" + "c".repeat(48);
		const { text, redacted } = g.filterText(raw);
		g.logMessage(raw, text, redacted);

		const [entry] = g.getAuditEntries();
		expect(entry!.details.redacted).toBe(true);
		expect(entry!.details.length).toBe(raw.length);
	});

	it("should tag every entry with the session id", () => {
		const g = createAdapterGovernance({
			sessionId: "ses_abc",
			auditDir: tmpAuditDir(),
			persist: false,
		});

		g.logSpawn("claude", [], []);
		g.logExit("completed", 10);

		for (const e of g.getAuditEntries()) {
			expect(e.sessionId).toBe("ses_abc");
		}
	});
});

describe("createAdapterGovernance — persistence", () => {
	it("should append audit to adapter-audit.jsonl in the configured dir", () => {
		const dir = tmpAuditDir();
		const g = createAdapterGovernance({ sessionId: "s7", auditDir: dir });

		g.logSpawn("aider", ["--message"], []);
		g.logExit("completed", 50);
		g.flush();

		const logPath = join(dir, "adapter-audit.jsonl");
		expect(existsSync(logPath)).toBe(true);

		const lines = readFileSync(logPath, "utf8").trim().split("\n");
		expect(lines).toHaveLength(2);

		const spawn = JSON.parse(lines[0]!);
		expect(spawn.action).toBe("adapter:spawn");
		expect(spawn.sessionId).toBe("s7");
	});

	it("should not throw when auditDir is on a read-only path (best-effort)", () => {
		const g = createAdapterGovernance({
			sessionId: "s8",
			// Non-existent deep path that mkdirSync should handle; even if it fails,
			// best-effort means no exception bubbles out.
			auditDir: "/definitely/not/a/real/path/aw-test",
		});

		expect(() => g.logExit("completed", 1)).not.toThrow();
		expect(() => g.flush()).not.toThrow();
	});
});
