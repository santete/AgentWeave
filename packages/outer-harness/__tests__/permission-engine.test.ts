import { describe, it, expect, beforeEach } from "vitest";
import { PermissionEngine, matchPattern } from "../src/governance/permission-engine";
import type { ToolRequest, PermissionConfig, PermissionRule } from "@agentweave/types";

function makeRequest(
	toolName: string,
	input: Record<string, unknown> = {},
	opts: Partial<Pick<ToolRequest, "isReadOnly" | "isDestructive" | "turnIndex">> = {},
): ToolRequest {
	return {
		toolName,
		toolInput: input,
		toolUseId: "tu_1",
		turnIndex: opts.turnIndex ?? 1,
		isReadOnly: opts.isReadOnly ?? true,
		isDestructive: opts.isDestructive ?? false,
	};
}

const baseConfig: PermissionConfig = {
	mode: "default",
	rules: [],
	failMode: "closed",
	timeoutMs: 5000,
	askTimeoutMs: 60000,
};

// ─── matchPattern (unchanged from v1.1.0) ────────────────────────

describe("matchPattern", () => {
	it("should match wildcard *", () => {
		expect(matchPattern("*", makeRequest("Bash"))).toBe(true);
		expect(matchPattern("*", makeRequest("FileRead"))).toBe(true);
	});

	it("should match exact tool name", () => {
		expect(matchPattern("Bash", makeRequest("Bash"))).toBe(true);
		expect(matchPattern("Bash", makeRequest("FileRead"))).toBe(false);
	});

	it("should match tool name with wildcard args", () => {
		expect(matchPattern("Bash(*)", makeRequest("Bash", { command: "ls" }))).toBe(true);
		expect(matchPattern("Bash(*)", makeRequest("FileRead", { path: "x" }))).toBe(false);
	});

	it("should match tool name with prefix pattern", () => {
		expect(matchPattern("Bash(git *)", makeRequest("Bash", { command: "git status" }))).toBe(true);
		expect(matchPattern("Bash(git *)", makeRequest("Bash", { command: "git push" }))).toBe(true);
		expect(matchPattern("Bash(git *)", makeRequest("Bash", { command: "npm test" }))).toBe(false);
	});

	it("should match file extension patterns", () => {
		expect(matchPattern("FileWrite(*.env)", makeRequest("FileWrite", { path: ".env" }))).toBe(true);
		expect(matchPattern("FileWrite(*.env)", makeRequest("FileWrite", { path: "config.env" }))).toBe(true);
		expect(matchPattern("FileWrite(*.env)", makeRequest("FileWrite", { path: "src/app.ts" }))).toBe(false);
	});

	it("should match path patterns", () => {
		expect(matchPattern("FileEdit(src/*)", makeRequest("FileEdit", { file_path: "src/app.ts" }))).toBe(true);
		expect(matchPattern("FileEdit(src/*)", makeRequest("FileEdit", { file_path: "test/app.ts" }))).toBe(false);
	});

	it("should match dangerous patterns", () => {
		expect(matchPattern("Bash(rm -rf *)", makeRequest("Bash", { command: "rm -rf /" }))).toBe(true);
		expect(matchPattern("Bash(rm -rf *)", makeRequest("Bash", { command: "rm file.txt" }))).toBe(false);
	});
});

// ─── Core PermissionEngine (v1.1.0 tests, preserved) ────────────

describe("PermissionEngine", () => {
	it("should allow matching allow rule", async () => {
		const engine = new PermissionEngine({
			...baseConfig,
			rules: [
				{ pattern: "Bash(git *)", behavior: "allow", source: "project", priority: 50 },
			],
		});

		const result = await engine.evaluate(makeRequest("Bash", { command: "git status" }));
		expect(result.behavior).toBe("allow");
		expect(result.source).toBe("rule:project");
	});

	it("should deny matching deny rule", async () => {
		const engine = new PermissionEngine({
			...baseConfig,
			rules: [
				{ pattern: "Bash(rm -rf *)", behavior: "deny", source: "policy", priority: 100, message: "Destructive!" },
			],
		});

		const result = await engine.evaluate(makeRequest("Bash", { command: "rm -rf /" }));
		expect(result.behavior).toBe("deny");
		expect(result.reason).toBe("Destructive!");
	});

	it("should respect priority — higher priority wins", async () => {
		const engine = new PermissionEngine({
			...baseConfig,
			rules: [
				{ pattern: "Bash(*)", behavior: "allow", source: "user", priority: 10 },
				{ pattern: "Bash(rm -rf *)", behavior: "deny", source: "policy", priority: 100 },
			],
		});

		// rm -rf matches both rules — policy (100) should win over user (10)
		const result = await engine.evaluate(makeRequest("Bash", { command: "rm -rf /" }));
		expect(result.behavior).toBe("deny");
		expect(result.source).toBe("rule:policy");
	});

	it("should ask when no rule matches in default mode", async () => {
		const engine = new PermissionEngine(baseConfig);

		const result = await engine.evaluate(makeRequest("Bash", { command: "echo hello" }));
		expect(result.behavior).toBe("ask");
		expect(result.askMessage).toBeDefined();
	});

	it("should allow when no rule matches in permissive mode", async () => {
		const engine = new PermissionEngine({ ...baseConfig, mode: "permissive" });

		const result = await engine.evaluate(makeRequest("Bash", { command: "echo hello" }));
		expect(result.behavior).toBe("allow");
	});

	it("should deny when no rule matches in strict mode", async () => {
		const engine = new PermissionEngine({ ...baseConfig, mode: "strict" });

		const result = await engine.evaluate(makeRequest("Bash", { command: "echo hello" }));
		expect(result.behavior).toBe("deny");
	});

	it("should allow read-only in plan mode, deny writes", async () => {
		const engine = new PermissionEngine({ ...baseConfig, mode: "plan" });

		const readResult = await engine.evaluate(makeRequest("FileRead", { path: "x.ts" }, { isReadOnly: true }));
		expect(readResult.behavior).toBe("allow");

		const writeResult = await engine.evaluate(makeRequest("FileWrite", { path: "x.ts" }, { isReadOnly: false }));
		expect(writeResult.behavior).toBe("deny");
	});

	it("should add rules at runtime", async () => {
		const engine = new PermissionEngine(baseConfig);
		engine.addRule({ pattern: "Bash(npm *)", behavior: "allow", source: "runtime", priority: 50 });

		const result = await engine.evaluate(makeRequest("Bash", { command: "npm test" }));
		expect(result.behavior).toBe("allow");
	});

	it("should remove rules", () => {
		const engine = new PermissionEngine({
			...baseConfig,
			rules: [
				{ pattern: "Bash(*)", behavior: "allow", source: "user", priority: 10 },
			],
		});

		expect(engine.getRules()).toHaveLength(1);
		engine.removeRule("Bash(*)", "user");
		expect(engine.getRules()).toHaveLength(0);
	});
});

// ─── Condition Evaluation ────────────────────────────────────────

describe("PermissionEngine — conditions", () => {
	it("should evaluate isReadOnly condition", async () => {
		const engine = new PermissionEngine({
			...baseConfig,
			rules: [
				{ pattern: "*", behavior: "allow", source: "user", priority: 50, condition: "request.isReadOnly == true" },
			],
		});

		const readResult = await engine.evaluate(makeRequest("FileRead", {}, { isReadOnly: true }));
		expect(readResult.behavior).toBe("allow");
		expect(readResult.matchedRule).toBeDefined();

		// Write request: condition fails, falls through to default
		const writeResult = await engine.evaluate(makeRequest("FileWrite", {}, { isReadOnly: false }));
		expect(writeResult.behavior).toBe("ask"); // default mode
		expect(writeResult.matchedRule).toBeNull();
	});

	it("should evaluate isDestructive condition", async () => {
		const engine = new PermissionEngine({
			...baseConfig,
			rules: [
				{ pattern: "Bash(*)", behavior: "deny", source: "policy", priority: 100, condition: "request.isDestructive == true", message: "Destructive denied" },
				{ pattern: "Bash(*)", behavior: "allow", source: "user", priority: 50 },
			],
		});

		const safeResult = await engine.evaluate(makeRequest("Bash", { command: "ls" }, { isDestructive: false }));
		expect(safeResult.behavior).toBe("allow"); // condition false on deny rule → skip → allow rule

		const dangerResult = await engine.evaluate(makeRequest("Bash", { command: "rm -rf /" }, { isDestructive: true }));
		expect(dangerResult.behavior).toBe("deny");
	});

	it("should evaluate turnIndex numeric comparison", async () => {
		const engine = new PermissionEngine({
			...baseConfig,
			rules: [
				{ pattern: "*", behavior: "deny", source: "policy", priority: 100, condition: "request.turnIndex > 10", message: "Too many turns" },
			],
		});

		const early = await engine.evaluate(makeRequest("Bash", {}, { turnIndex: 5 }));
		expect(early.behavior).toBe("ask"); // condition false → default

		const late = await engine.evaluate(makeRequest("Bash", {}, { turnIndex: 15 }));
		expect(late.behavior).toBe("deny");
	});

	it("should evaluate && (AND) conditions", async () => {
		const engine = new PermissionEngine({
			...baseConfig,
			rules: [
				{
					pattern: "Bash(*)",
					behavior: "deny",
					source: "policy",
					priority: 100,
					condition: "request.isDestructive == true && request.turnIndex > 5",
				},
				{ pattern: "*", behavior: "allow", source: "user", priority: 10 },
			],
		});

		// Destructive but early turn → condition partially false → skip deny → allow
		const result1 = await engine.evaluate(makeRequest("Bash", { command: "rm x" }, { isDestructive: true, turnIndex: 2 }));
		expect(result1.behavior).toBe("allow");

		// Destructive and late turn → both true → deny
		const result2 = await engine.evaluate(makeRequest("Bash", { command: "rm x" }, { isDestructive: true, turnIndex: 10 }));
		expect(result2.behavior).toBe("deny");
	});

	it("should evaluate || (OR) conditions", async () => {
		const engine = new PermissionEngine({
			...baseConfig,
			rules: [
				{
					pattern: "*",
					behavior: "deny",
					source: "policy",
					priority: 100,
					condition: "request.isDestructive == true || request.turnIndex > 20",
				},
			],
		});

		const destructive = await engine.evaluate(makeRequest("Bash", {}, { isDestructive: true, turnIndex: 1 }));
		expect(destructive.behavior).toBe("deny");

		const lateTurn = await engine.evaluate(makeRequest("Bash", {}, { isDestructive: false, turnIndex: 25 }));
		expect(lateTurn.behavior).toBe("deny");

		const safe = await engine.evaluate(makeRequest("Bash", {}, { isDestructive: false, turnIndex: 5 }));
		expect(safe.behavior).toBe("ask"); // default
	});

	it("should evaluate contains() condition", async () => {
		const engine = new PermissionEngine({
			...baseConfig,
			rules: [
				{
					pattern: "*",
					behavior: "allow",
					source: "user",
					priority: 50,
					condition: 'contains(request.toolName, "Read")',
				},
			],
		});

		const read = await engine.evaluate(makeRequest("FileRead"));
		expect(read.behavior).toBe("allow");

		const write = await engine.evaluate(makeRequest("FileWrite"));
		expect(write.behavior).toBe("ask"); // default — "Write" doesn't contain "Read"
	});

	it("should gracefully skip rules with invalid conditions", async () => {
		const engine = new PermissionEngine({
			...baseConfig,
			rules: [
				{ pattern: "*", behavior: "deny", source: "policy", priority: 100, condition: "this.is.garbage!!!" },
				{ pattern: "*", behavior: "allow", source: "user", priority: 50 },
			],
		});

		// Invalid condition → skip deny rule → fall to allow
		const result = await engine.evaluate(makeRequest("Bash"));
		expect(result.behavior).toBe("allow");
	});
});

// ─── Decision Audit Trail ────────────────────────────────────────

describe("PermissionEngine — audit trail", () => {
	let engine: PermissionEngine;

	beforeEach(() => {
		engine = new PermissionEngine({
			...baseConfig,
			rules: [
				{ pattern: "Bash(git *)", behavior: "allow", source: "project", priority: 50 },
				{ pattern: "Bash(rm *)", behavior: "deny", source: "policy", priority: 100 },
			],
		});
	});

	it("should record audit entry on evaluate", async () => {
		await engine.evaluate(makeRequest("Bash", { command: "git status" }));
		const log = engine.getAuditLog();
		expect(log).toHaveLength(1);
		expect(log[0]!.toolName).toBe("Bash");
		expect(log[0]!.behavior).toBe("allow");
		expect(log[0]!.matchedRule?.pattern).toBe("Bash(git *)");
	});

	it("should include matchedRule in returned decision", async () => {
		const decision = await engine.evaluate(makeRequest("Bash", { command: "rm -rf /" }));
		expect(decision.matchedRule?.pattern).toBe("Bash(rm *)");
		expect(decision.matchedRule?.behavior).toBe("deny");
	});

	it("should record null matchedRule for default fallback", async () => {
		await engine.evaluate(makeRequest("FileRead", { path: "x.ts" }));
		const log = engine.getAuditLog();
		expect(log[0]!.matchedRule).toBeNull();
	});

	it("should filter audit by tool name", async () => {
		await engine.evaluate(makeRequest("Bash", { command: "git status" }));
		await engine.evaluate(makeRequest("FileRead", { path: "x.ts" }));
		await engine.evaluate(makeRequest("Bash", { command: "rm file" }));

		expect(engine.getAuditForTool("Bash")).toHaveLength(2);
		expect(engine.getAuditForTool("FileRead")).toHaveLength(1);
	});

	it("should clear audit log", async () => {
		await engine.evaluate(makeRequest("Bash", { command: "git status" }));
		expect(engine.getAuditLog()).toHaveLength(1);
		engine.clearAuditLog();
		expect(engine.getAuditLog()).toHaveLength(0);
	});

	it("should disable audit recording", async () => {
		engine.setAuditEnabled(false);
		await engine.evaluate(makeRequest("Bash", { command: "git status" }));
		expect(engine.getAuditLog()).toHaveLength(0);

		engine.setAuditEnabled(true);
		await engine.evaluate(makeRequest("Bash", { command: "git status" }));
		expect(engine.getAuditLog()).toHaveLength(1);
	});
});

// ─── Rule Groups ─────────────────────────────────────────────────

describe("PermissionEngine — rule groups", () => {
	const groupConfig: PermissionConfig = {
		...baseConfig,
		rules: [
			{ pattern: "Bash(git *)", behavior: "allow", source: "project", priority: 50, group: "git" },
			{ pattern: "Bash(npm *)", behavior: "allow", source: "project", priority: 50, group: "npm" },
			{ pattern: "Bash(rm *)", behavior: "deny", source: "policy", priority: 100, group: "safety" },
			{ pattern: "FileRead(*)", behavior: "allow", source: "user", priority: 30 }, // no group
		],
	};

	it("should list unique groups", () => {
		const engine = new PermissionEngine(groupConfig);
		const groups = engine.getGroups();
		expect(groups).toContain("git");
		expect(groups).toContain("npm");
		expect(groups).toContain("safety");
		expect(groups).toHaveLength(3);
	});

	it("should get rules by group", () => {
		const engine = new PermissionEngine(groupConfig);
		expect(engine.getRulesByGroup("git")).toHaveLength(1);
		expect(engine.getRulesByGroup("safety")).toHaveLength(1);
		expect(engine.getRulesByGroup("nonexistent")).toHaveLength(0);
	});

	it("should skip disabled group rules", async () => {
		const engine = new PermissionEngine(groupConfig);

		// git group enabled → allow
		const before = await engine.evaluate(makeRequest("Bash", { command: "git status" }));
		expect(before.behavior).toBe("allow");

		// Disable git group → falls to default
		engine.disableGroup("git");
		expect(engine.isGroupEnabled("git")).toBe(false);

		const after = await engine.evaluate(makeRequest("Bash", { command: "git status" }));
		expect(after.behavior).toBe("ask"); // default mode

		// Re-enable
		engine.enableGroup("git");
		expect(engine.isGroupEnabled("git")).toBe(true);
		const restored = await engine.evaluate(makeRequest("Bash", { command: "git status" }));
		expect(restored.behavior).toBe("allow");
	});

	it("should always evaluate rules without a group", async () => {
		const engine = new PermissionEngine(groupConfig);
		engine.disableGroup("git");
		engine.disableGroup("npm");
		engine.disableGroup("safety");

		// FileRead rule has no group → always active
		const result = await engine.evaluate(makeRequest("FileRead", { path: "x.ts" }));
		expect(result.behavior).toBe("allow");
	});
});

// ─── Rate Limiting ───────────────────────────────────────────────

describe("PermissionEngine — rate limiting", () => {
	it("should allow calls within rate limit", async () => {
		const engine = new PermissionEngine({
			...baseConfig,
			rules: [
				{ pattern: "Bash(*)", behavior: "allow", source: "user", priority: 50, rateLimit: { maxCalls: 3, windowMs: 10_000 } },
			],
		});

		const r1 = await engine.evaluate(makeRequest("Bash", { command: "echo 1" }));
		const r2 = await engine.evaluate(makeRequest("Bash", { command: "echo 2" }));
		const r3 = await engine.evaluate(makeRequest("Bash", { command: "echo 3" }));
		expect(r1.behavior).toBe("allow");
		expect(r2.behavior).toBe("allow");
		expect(r3.behavior).toBe("allow");
	});

	it("should deny when rate limit exceeded", async () => {
		const engine = new PermissionEngine({
			...baseConfig,
			rules: [
				{ pattern: "Bash(*)", behavior: "allow", source: "user", priority: 50, rateLimit: { maxCalls: 2, windowMs: 10_000 } },
			],
		});

		await engine.evaluate(makeRequest("Bash", { command: "echo 1" }));
		await engine.evaluate(makeRequest("Bash", { command: "echo 2" }));

		const r3 = await engine.evaluate(makeRequest("Bash", { command: "echo 3" }));
		expect(r3.behavior).toBe("deny");
		expect(r3.reason).toContain("Rate limit exceeded");
	});

	it("should reset after window expires", async () => {
		const engine = new PermissionEngine({
			...baseConfig,
			rules: [
				{ pattern: "Bash(*)", behavior: "allow", source: "user", priority: 50, rateLimit: { maxCalls: 1, windowMs: 50 } },
			],
		});

		const r1 = await engine.evaluate(makeRequest("Bash", { command: "echo 1" }));
		expect(r1.behavior).toBe("allow");

		const r2 = await engine.evaluate(makeRequest("Bash", { command: "echo 2" }));
		expect(r2.behavior).toBe("deny");

		// Wait for window to expire
		await new Promise((r) => setTimeout(r, 60));

		const r3 = await engine.evaluate(makeRequest("Bash", { command: "echo 3" }));
		expect(r3.behavior).toBe("allow");
	});
});

// ─── Dry-Run Mode ────────────────────────────────────────────────

describe("PermissionEngine — dry-run", () => {
	it("should return allow for all decisions in dry-run", async () => {
		const engine = new PermissionEngine({
			...baseConfig,
			rules: [
				{ pattern: "Bash(rm *)", behavior: "deny", source: "policy", priority: 100 },
			],
		});

		engine.setDryRun(true);
		expect(engine.isDryRun()).toBe(true);

		const result = await engine.evaluate(makeRequest("Bash", { command: "rm -rf /" }));
		expect(result.behavior).toBe("allow");
		expect(result.reason).toContain("[dry-run]");
	});

	it("should still record the real behavior in audit", async () => {
		const engine = new PermissionEngine({
			...baseConfig,
			rules: [
				{ pattern: "Bash(rm *)", behavior: "deny", source: "policy", priority: 100 },
			],
		});

		engine.setDryRun(true);
		await engine.evaluate(makeRequest("Bash", { command: "rm -rf /" }));

		const log = engine.getAuditLog();
		expect(log[0]!.behavior).toBe("deny"); // Real behavior in audit
		expect(log[0]!.dryRun).toBe(true);
	});

	it("should enforce normally when dry-run disabled", async () => {
		const engine = new PermissionEngine({
			...baseConfig,
			rules: [
				{ pattern: "Bash(rm *)", behavior: "deny", source: "policy", priority: 100 },
			],
		});

		engine.setDryRun(true);
		engine.setDryRun(false);

		const result = await engine.evaluate(makeRequest("Bash", { command: "rm -rf /" }));
		expect(result.behavior).toBe("deny");
	});
});

// ─── Conflict/Shadow Detection ───────────────────────────────────

describe("PermissionEngine — analyzeRules", () => {
	it("should detect conflicting rules at same priority", () => {
		const engine = new PermissionEngine({
			...baseConfig,
			rules: [
				{ pattern: "Bash(*)", behavior: "allow", source: "user", priority: 50 },
				{ pattern: "Bash(*)", behavior: "deny", source: "project", priority: 50 },
			],
		});

		const analysis = engine.analyzeRules();
		expect(analysis.conflicts.length).toBeGreaterThan(0);
		expect(analysis.conflicts[0]!.type).toBe("conflict");
	});

	it("should detect wildcard shadow", () => {
		const engine = new PermissionEngine({
			...baseConfig,
			rules: [
				{ pattern: "*", behavior: "deny", source: "policy", priority: 100 },
				{ pattern: "Bash(git *)", behavior: "allow", source: "user", priority: 50 },
			],
		});

		const analysis = engine.analyzeRules();
		const shadows = analysis.conflicts.filter((c) => c.type === "shadow");
		expect(shadows.length).toBeGreaterThan(0);
		expect(shadows[0]!.description).toContain("shadows");
	});

	it("should detect tool wildcard shadowing tool pattern", () => {
		const engine = new PermissionEngine({
			...baseConfig,
			rules: [
				{ pattern: "Bash(*)", behavior: "deny", source: "policy", priority: 100 },
				{ pattern: "Bash(git *)", behavior: "allow", source: "user", priority: 50 },
			],
		});

		const analysis = engine.analyzeRules();
		const shadows = analysis.conflicts.filter((c) => c.type === "shadow");
		expect(shadows.length).toBeGreaterThan(0);
	});

	it("should report no issues for clean rules", () => {
		const engine = new PermissionEngine({
			...baseConfig,
			rules: [
				{ pattern: "Bash(git *)", behavior: "allow", source: "project", priority: 50 },
				{ pattern: "Bash(rm *)", behavior: "deny", source: "policy", priority: 100 },
				{ pattern: "FileRead(*)", behavior: "allow", source: "user", priority: 30 },
			],
		});

		const analysis = engine.analyzeRules();
		expect(analysis.conflicts).toHaveLength(0);
	});
});
