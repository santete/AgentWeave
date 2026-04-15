import { describe, it, expect } from "vitest";
import { PermissionEngine, matchPattern } from "../src/governance/permission-engine";
import type { ToolRequest, PermissionConfig } from "@agentweave/types";

function makeRequest(
	toolName: string,
	input: Record<string, unknown> = {},
	readOnly = true,
): ToolRequest {
	return {
		toolName,
		toolInput: input,
		toolUseId: "tu_1",
		turnIndex: 1,
		isReadOnly: readOnly,
		isDestructive: false,
	};
}

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

describe("PermissionEngine", () => {
	const baseConfig: PermissionConfig = {
		mode: "default",
		rules: [],
		failMode: "closed",
		timeoutMs: 5000,
		askTimeoutMs: 60000,
	};

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

		const readResult = await engine.evaluate(makeRequest("FileRead", { path: "x.ts" }, true));
		expect(readResult.behavior).toBe("allow");

		const writeResult = await engine.evaluate(makeRequest("FileWrite", { path: "x.ts" }, false));
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
