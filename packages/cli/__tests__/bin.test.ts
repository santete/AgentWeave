import { describe, it, expect } from "vitest";
import { parseArgs } from "../src/bin";

describe("CLI bin", () => {
	it("should export as ESM module", async () => {
		const mod = await import("../src/commands/run.js");
		expect(mod.runCommand).toBeDefined();
		expect(typeof mod.runCommand).toBe("function");
	});
});

describe("parseArgs", () => {
	it("should parse 'run' command with prompt", () => {
		const result = parseArgs(["run", "Fix the bug"]);
		expect(result.command).toBe("run");
		expect(result.prompt).toBe("Fix the bug");
		expect(result.model).toBe(""); // default nằm ở từng lệnh (cục bộ), không ở parseArgs // default
	});

	it("should parse --model flag", () => {
		const result = parseArgs(["run", "prompt", "--model", "claude-opus-4-6"]);
		expect(result.model).toBe("claude-opus-4-6");
	});

	it("should parse --budget flag", () => {
		const result = parseArgs(["run", "prompt", "--budget", "10.50"]);
		expect(result.budget).toBe(10.5);
	});

	it("should parse --max-turns flag", () => {
		const result = parseArgs(["run", "prompt", "--max-turns", "25"]);
		expect(result.maxTurns).toBe(25);
	});

	it("should parse --mode flag with valid mode", () => {
		for (const mode of ["default", "strict", "permissive", "plan"] as const) {
			const result = parseArgs(["run", "prompt", "--mode", mode]);
			expect(result.permissionMode).toBe(mode);
		}
	});

	it("should parse multiple flags together", () => {
		const result = parseArgs([
			"run",
			"Refactor auth",
			"--model",
			"claude-opus-4-6",
			"--budget",
			"5",
			"--max-turns",
			"30",
			"--mode",
			"strict",
		]);
		expect(result.command).toBe("run");
		expect(result.prompt).toBe("Refactor auth");
		expect(result.model).toBe("claude-opus-4-6");
		expect(result.budget).toBe(5);
		expect(result.maxTurns).toBe(30);
		expect(result.permissionMode).toBe("strict");
	});

	it("parseArgs không đặt model mặc định — để agent.json/lệnh tự quyết", () => {
		const result = parseArgs(["run", "test"]);
		expect(result.model).toBe(""); // default nằm ở từng lệnh (cục bộ), không ở parseArgs
	});

	it("should leave budget undefined when not specified", () => {
		const result = parseArgs(["run", "test"]);
		expect(result.budget).toBeUndefined();
	});

	it("should leave maxTurns undefined when not specified", () => {
		const result = parseArgs(["run", "test"]);
		expect(result.maxTurns).toBeUndefined();
	});

	it("should leave permissionMode undefined when not specified", () => {
		const result = parseArgs(["run", "test"]);
		expect(result.permissionMode).toBeUndefined();
	});

	it("should handle empty args", () => {
		const result = parseArgs([]);
		expect(result.command).toBe("");
		expect(result.prompt).toBe("");
	});

	it("should parse unknown command", () => {
		const result = parseArgs(["deploy", "something"]);
		expect(result.command).toBe("deploy");
		expect(result.prompt).toBe("something");
	});
});

describe("runCommand", () => {
	it("should be importable and callable", async () => {
		const { runCommand } = await import("../src/commands/run.js");
		expect(typeof runCommand).toBe("function");
	});
});
