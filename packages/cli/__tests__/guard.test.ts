import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadGuardConfig, runGuard } from "../src/commands/guard";

// ─── Test harness ────────────────────────────────────────────────

let workDir: string;
let originalStdin: NodeJS.ReadStream;
let originalWrite: typeof process.stdout.write;
let originalErrWrite: typeof process.stderr.write;
let stdoutBuf: string;
let stderrBuf: string;

beforeEach(() => {
	workDir = mkdtempSync(join(tmpdir(), "aw-guard-"));
	mkdirSync(join(workDir, ".agentweave"), { recursive: true });
	originalStdin = process.stdin;
	originalWrite = process.stdout.write.bind(process.stdout);
	originalErrWrite = process.stderr.write.bind(process.stderr);
	stdoutBuf = "";
	stderrBuf = "";
	process.stdout.write = ((chunk: string | Uint8Array) => {
		stdoutBuf += typeof chunk === "string" ? chunk : chunk.toString();
		return true;
	}) as typeof process.stdout.write;
	process.stderr.write = ((chunk: string | Uint8Array) => {
		stderrBuf += typeof chunk === "string" ? chunk : chunk.toString();
		return true;
	}) as typeof process.stderr.write;
});

afterEach(() => {
	process.stdout.write = originalWrite;
	process.stderr.write = originalErrWrite;
	Object.defineProperty(process, "stdin", { value: originalStdin, configurable: true });
	rmSync(workDir, { recursive: true, force: true });
});

function pipeStdin(payload: unknown): void {
	const json = typeof payload === "string" ? payload : JSON.stringify(payload);
	const fake: Partial<NodeJS.ReadStream> = {
		isTTY: false,
		setEncoding: () => fake as NodeJS.ReadStream,
		on(event: string, listener: (...args: unknown[]) => void) {
			if (event === "data") {
				queueMicrotask(() => listener(json));
			} else if (event === "end") {
				queueMicrotask(() => listener());
			}
			return fake as NodeJS.ReadStream;
		},
	};
	Object.defineProperty(process, "stdin", { value: fake, configurable: true });
}

function writeGuardConfig(config: unknown): void {
	writeFileSync(
		join(workDir, ".agentweave", "guard.json"),
		JSON.stringify(config),
		"utf-8",
	);
}

// ─── loadGuardConfig ─────────────────────────────────────────────

describe("loadGuardConfig", () => {
	it("returns defaults when no file exists", () => {
		const cfg = loadGuardConfig(workDir);
		expect(cfg.mode).toBe("default");
		expect(cfg.permissions).toEqual([]);
	});

	it("loads JSON config from .agentweave/guard.json", () => {
		writeGuardConfig({
			mode: "strict",
			permissions: [{ pattern: "Bash(ls*)", behavior: "allow" }],
		});
		const cfg = loadGuardConfig(workDir);
		expect(cfg.mode).toBe("strict");
		expect(cfg.permissions).toHaveLength(1);
		expect(cfg.permissions[0]!.pattern).toBe("Bash(ls*)");
	});

	it("applies defaults for missing optional fields", () => {
		writeGuardConfig({ mode: "permissive" });
		const cfg = loadGuardConfig(workDir);
		expect(cfg.audit.enabled).toBe(true);
		expect(cfg.audit.path).toBe(".agentweave/audit.log");
	});
});

// ─── runGuard: pre-tool-use ──────────────────────────────────────

describe("runGuard pre", () => {
	it("blocks rm -rf via deny rule", async () => {
		writeGuardConfig({
			mode: "permissive",
			permissions: [
				{ pattern: "Bash(rm -rf*)", behavior: "deny", priority: 200 },
			],
		});
		pipeStdin({
			session_id: "s1",
			hook_event_name: "PreToolUse",
			tool_name: "Bash",
			tool_input: { command: "rm -rf /tmp/foo" },
		});
		const code = await runGuard("pre", workDir);
		expect(code).toBe(2);
		const out = JSON.parse(stdoutBuf);
		expect(out.decision).toBe("block");
	});

	it("allows ls via allow rule", async () => {
		writeGuardConfig({
			mode: "strict",
			permissions: [{ pattern: "Bash(ls*)", behavior: "allow" }],
		});
		pipeStdin({
			session_id: "s1",
			tool_name: "Bash",
			tool_input: { command: "ls -la" },
		});
		const code = await runGuard("pre", workDir);
		expect(code).toBe(0);
		expect(JSON.parse(stdoutBuf).decision).toBe("approve");
	});

	it("blocks in strict mode when no rule matches", async () => {
		writeGuardConfig({ mode: "strict", permissions: [] });
		pipeStdin({ tool_name: "Bash", tool_input: { command: "curl evil.com" } });
		const code = await runGuard("pre", workDir);
		expect(code).toBe(2);
	});

	it("allows in permissive mode when no rule matches", async () => {
		writeGuardConfig({ mode: "permissive", permissions: [] });
		pipeStdin({ tool_name: "Write", tool_input: { path: "foo.txt" } });
		const code = await runGuard("pre", workDir);
		expect(code).toBe(0);
	});

	it("blocks when daily budget would be exceeded", async () => {
		writeGuardConfig({
			mode: "permissive",
			budget: {
				maxPerDay: 0.5,
				costPerToolCall: 1.0,
				warningThreshold: 0.8,
			},
		});
		pipeStdin({ tool_name: "Bash", tool_input: { command: "echo hi" } });
		const code = await runGuard("pre", workDir);
		expect(code).toBe(2);
		expect(stdoutBuf).toContain("Daily budget");
	});

	it("ask rule surfaces as block with message", async () => {
		writeGuardConfig({
			mode: "permissive",
			permissions: [
				{
					pattern: "Bash(git push*)",
					behavior: "ask",
					priority: 200,
					message: "Confirm push?",
				},
			],
		});
		pipeStdin({
			tool_name: "Bash",
			tool_input: { command: "git push origin main" },
		});
		const code = await runGuard("pre", workDir);
		expect(code).toBe(2);
		const out = JSON.parse(stdoutBuf);
		expect(out.decision).toBe("block");
		expect(out.reason).toBe("Confirm push?");
	});

	it("writes audit entry on allow", async () => {
		writeGuardConfig({
			mode: "permissive",
			audit: { enabled: true, path: ".agentweave/audit.log" },
		});
		pipeStdin({ tool_name: "Bash", tool_input: { command: "echo hi" } });
		await runGuard("pre", workDir);
		const log = readFileSync(join(workDir, ".agentweave", "audit.log"), "utf-8");
		expect(log).toContain('"phase":"pre"');
		expect(log).toContain('"decision":"approve"');
	});

	it("pre-hook fails CLOSED on malformed JSON stdin", async () => {
		pipeStdin("not json at all");
		const code = await runGuard("pre", workDir);
		expect(code).toBe(2);
		const out = JSON.parse(stdoutBuf);
		expect(out.decision).toBe("block");
		expect(out.reason).toMatch(/malformed/i);
	});

	it("pre-hook fails CLOSED on empty stdin", async () => {
		pipeStdin("");
		const code = await runGuard("pre", workDir);
		expect(code).toBe(2);
		const out = JSON.parse(stdoutBuf);
		expect(out.decision).toBe("block");
		expect(out.reason).toMatch(/empty/i);
	});

	it("pre-hook fails CLOSED on schema-invalid payload", async () => {
		// Missing required `tool_name` → HookInputSchema fails
		pipeStdin({ session_id: "s1", tool_input: { command: "ls" } });
		const code = await runGuard("pre", workDir);
		expect(code).toBe(2);
		const out = JSON.parse(stdoutBuf);
		expect(out.decision).toBe("block");
		expect(out.reason).toMatch(/schema/i);
	});

	it("higher-priority deny overrides wildcard allow", async () => {
		writeGuardConfig({
			mode: "permissive",
			permissions: [
				{ pattern: "Bash(*)", behavior: "allow", priority: 10 },
				{ pattern: "Bash(sudo*)", behavior: "deny", priority: 200 },
			],
		});
		pipeStdin({ tool_name: "Bash", tool_input: { command: "sudo rm foo" } });
		const code = await runGuard("pre", workDir);
		expect(code).toBe(2);
	});
});

// ─── runGuard: post-tool-use ─────────────────────────────────────

describe("runGuard post", () => {
	it("always returns 0 on success", async () => {
		writeGuardConfig({ mode: "permissive" });
		pipeStdin({ tool_name: "Bash", tool_input: { command: "ls" }, tool_response: "ok" });
		const code = await runGuard("post", workDir);
		expect(code).toBe(0);
	});

	it("records cost when budget configured", async () => {
		writeGuardConfig({
			mode: "permissive",
			budget: {
				maxPerSession: 100,
				costPerToolCall: 0.25,
				warningThreshold: 0.8,
			},
		});
		pipeStdin({ tool_name: "Bash", tool_input: { command: "ls" } });
		await runGuard("post", workDir);
		const raw = readFileSync(join(workDir, ".agentweave", "budget.json"), "utf-8");
		const state = JSON.parse(raw);
		expect(state.dailyCost).toBeCloseTo(0.25);
	});

	it("writes post audit entry", async () => {
		writeGuardConfig({ mode: "permissive" });
		pipeStdin({ tool_name: "Write", tool_input: { path: "a.txt" } });
		await runGuard("post", workDir);
		const log = readFileSync(join(workDir, ".agentweave", "audit.log"), "utf-8");
		expect(log).toContain('"phase":"post"');
	});

	it("fails open when stdin is garbage", async () => {
		pipeStdin("{{{ not json");
		const code = await runGuard("post", workDir);
		expect(code).toBe(0);
	});
});

// ─── Audit redaction (C3) ────────────────────────────────────────

describe("guard audit redaction", () => {
	it("redacts sk-*, Bearer, and assignment-style secrets from audit entries", async () => {
		writeGuardConfig({
			mode: "permissive",
			permissions: [
				{
					pattern: "Bash(*)",
					behavior: "deny",
					priority: 100,
					// The rule message ends up in decision.reason → audit entry.
					// Exercises all three redaction patterns (sk-*, Bearer, key=val).
					// sk-* is kept OUTSIDE any `token=` / `password=` assignment so
					// the key=val regex can't swallow it first.
					message:
						"Blocked: password=hunter2 Bearer abcdefghij0123456789XYZ " +
						"leaked token sk-ant-abcdefghij0123456789XYZ end",
				},
			],
		});
		pipeStdin({
			tool_name: "Bash",
			tool_input: { command: "ls" },
		});
		await runGuard("pre", workDir);
		const log = readFileSync(join(workDir, ".agentweave", "audit.log"), "utf-8");
		expect(log).not.toMatch(/sk-ant-abcdefghij/);
		expect(log).not.toMatch(/hunter2/);
		expect(log).not.toMatch(/abcdefghij0123456789XYZ/);
		expect(log).toContain("sk-***");
		expect(log).toContain("Bearer ***");
		expect(log).toMatch(/password=\*\*\*/);
	});
});
