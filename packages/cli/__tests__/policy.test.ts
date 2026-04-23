/**
 * P3.1 Step 8 — `agentweave policy show|lint` tests.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { policyLintCommand, policyShowCommand } from "../src/commands/policy";

let workDir: string;
let stdoutBuf: string;
let stderrBuf: string;
let logSpy: ReturnType<typeof vi.spyOn>;
let errSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
	workDir = mkdtempSync(join(tmpdir(), "aw-policy-"));
	stdoutBuf = "";
	stderrBuf = "";
	logSpy = vi
		.spyOn(console, "log")
		.mockImplementation((...parts: unknown[]) => {
			stdoutBuf += parts.join(" ") + "\n";
		});
	errSpy = vi
		.spyOn(console, "error")
		.mockImplementation((...parts: unknown[]) => {
			stderrBuf += parts.join(" ") + "\n";
		});
});

afterEach(() => {
	logSpy.mockRestore();
	errSpy.mockRestore();
	rmSync(workDir, { recursive: true, force: true });
});

function writePolicyFile(
	path: string,
	rules: Array<Record<string, unknown>>,
): void {
	writeFileSync(path, JSON.stringify({ version: 1, rules }, null, 2));
}

// ─── show ────────────────────────────────────────────────────────

describe("policyShowCommand", () => {
	it("prints table with resolved paths, rule counts, and hashes", () => {
		const orgPath = join(workDir, "policy.org.yaml");
		const userPath = join(workDir, "policy.user.yaml");
		writePolicyFile(orgPath, [
			{ pattern: "Bash(rm *)", behavior: "deny", priority: 100, immutable: true },
		]);
		writePolicyFile(userPath, [
			{ pattern: "Bash(ls)", behavior: "allow", priority: 50 },
			{ pattern: "Bash(pwd)", behavior: "allow", priority: 50 },
		]);

		const code = policyShowCommand({ paths: { org: orgPath, user: userPath } });
		expect(code).toBe(0);
		expect(stdoutBuf).toContain("2/3 levels resolved");
		expect(stdoutBuf).toContain("org");
		expect(stdoutBuf).toContain("user");
		expect(stdoutBuf).toContain(orgPath);
		expect(stdoutBuf).toContain(userPath);
		expect(stdoutBuf).toContain("Total rules merged: 3");
		expect(stdoutBuf).toContain("Immutable rules:    1");
	});

	it("json format emits structured cascade data", () => {
		const orgPath = join(workDir, "policy.org.yaml");
		writePolicyFile(orgPath, [
			{ pattern: "Bash(*)", behavior: "deny", priority: 1, immutable: true },
		]);

		const code = policyShowCommand({
			paths: { org: orgPath },
			format: "json",
		});
		expect(code).toBe(0);
		const parsed = JSON.parse(stdoutBuf);
		expect(parsed.sources.orgPath).toBe(orgPath);
		expect(parsed.ruleCounts.policy).toBe(1);
		expect(parsed.totalRules).toBe(1);
		expect(parsed.hashes.org).toMatch(/^[a-f0-9]{64}$/);
	});

	it("returns exit code 1 and prints error on malformed file", () => {
		const badPath = join(workDir, "policy.org.yaml");
		writeFileSync(badPath, ":\n  bad: [yaml: : syntax");

		const code = policyShowCommand({ paths: { org: badPath } });
		expect(code).toBe(1);
		expect(stderrBuf).toMatch(/Policy load failed/);
	});
});

// ─── lint ────────────────────────────────────────────────────────

describe("policyLintCommand", () => {
	it("passes on valid file and infers level from filename", () => {
		const path = join(workDir, "policy.org.yaml");
		writePolicyFile(path, [
			{ pattern: "Bash(*)", behavior: "deny", priority: 1, immutable: true },
		]);
		const code = policyLintCommand({ file: path });
		expect(code).toBe(0);
		expect(stdoutBuf).toContain("level:     org (inferred from filename)");
		expect(stdoutBuf).toContain("rules:     1");
		expect(stdoutBuf).toContain("immutable: 1");
		expect(stdoutBuf).toMatch(/sha256:\s+[a-f0-9]{64}/);
	});

	it("explicit --as overrides filename inference", () => {
		const path = join(workDir, "draft.yaml"); // no infer hint
		writePolicyFile(path, [
			{ pattern: "Bash(ls)", behavior: "allow", priority: 50 },
		]);
		const code = policyLintCommand({ file: path, as: "team" });
		expect(code).toBe(0);
		expect(stdoutBuf).toContain("level:     team");
		expect(stdoutBuf).not.toContain("inferred from filename");
	});

	it("rejects immutable rule at user level (exit 1)", () => {
		const path = join(workDir, "draft.user.yaml");
		writePolicyFile(path, [
			{
				pattern: "Bash(*)",
				behavior: "deny",
				priority: 1,
				immutable: true,
			},
		]);
		const code = policyLintCommand({ file: path });
		expect(code).toBe(1);
		expect(stderrBuf).toMatch(/immutable/i);
	});

	it("returns exit 1 on malformed YAML", () => {
		const path = join(workDir, "policy.user.yaml");
		writeFileSync(path, ":\n  bad: [yaml: : syntax");
		const code = policyLintCommand({ file: path });
		expect(code).toBe(1);
		expect(stderrBuf).toMatch(/Policy load failed/);
	});

	it("returns exit 1 on missing file", () => {
		const code = policyLintCommand({ file: join(workDir, "missing.yaml") });
		expect(code).toBe(1);
		expect(stderrBuf).toMatch(/Policy load failed/);
	});
});
