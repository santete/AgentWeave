/**
 * Tests for all 8 SDLC modules.
 * Each module tested in isolation with mock context.
 */

import { describe, it, expect } from "vitest";
import { TaskNormalizerModule } from "../../src/sdlc/modules/task-normalizer";
import { ContextBuilderModule } from "../../src/sdlc/modules/context-builder";
import { PlanGeneratorModule } from "../../src/sdlc/modules/plan-generator";
import { PatchValidatorModule } from "../../src/sdlc/modules/patch-validator";
import { QualityGateModule } from "../../src/sdlc/modules/quality-gate";
import { RetryEngineModule } from "../../src/sdlc/modules/retry-engine";
import { OutputStandardizerModule } from "../../src/sdlc/modules/output-standardizer";
import { MetricsCollector } from "../../src/sdlc/metrics-collector";
import { getDefaultSDLCConfig } from "../../src/sdlc/sdlc-config";
import { createEmptyTokenUsage } from "@agentweave/types";
import type {
	SDLCModuleContext,
	SDLCTask,
	SDLCExecutionResult,
	SDLCValidationResult,
} from "@agentweave/types";

// ─── Helpers ─────────────────────────────────────────────────────

function makeContext(overrides: Partial<SDLCModuleContext> = {}): SDLCModuleContext {
	const mc = new MetricsCollector("task_test");
	return {
		sessionId: "ses_test",
		cwd: process.cwd(),
		signal: new AbortController().signal,
		config: getDefaultSDLCConfig(),
		metrics: mc.createHandle(),
		...overrides,
	};
}

function makeTask(overrides: Partial<SDLCTask> = {}): SDLCTask {
	return {
		id: "task_1",
		rawInput: "Fix the login bug in AuthService",
		goal: "Fix the login bug in AuthService",
		context: ["src/auth-service.ts"],
		constraints: ["No breaking changes"],
		definitionOfDone: ["Tests pass"],
		metadata: {},
		...overrides,
	};
}

function makeExecResult(overrides: Partial<SDLCExecutionResult> = {}): SDLCExecutionResult {
	return {
		success: true,
		changedFiles: ["src/auth-service.ts"],
		output: "Fixed the null check in login method",
		usage: { ...createEmptyTokenUsage(), totalCost: 0.05 },
		durationMs: 2000,
		terminalReason: "completed",
		...overrides,
	};
}

// ─── TaskNormalizer ──────────────────────────────────────────────

describe("TaskNormalizerModule", () => {
	const mod = new TaskNormalizerModule();

	it("should normalize raw input into structured task (template fallback)", async () => {
		const task = await mod.execute("Fix the login bug in AuthService.ts", makeContext());

		expect(task.id).toMatch(/^task_/);
		expect(task.rawInput).toBe("Fix the login bug in AuthService.ts");
		expect(task.goal).toBe("Fix the login bug in AuthService");
		expect(task.context).toContain("AuthService.ts");
	});

	it("should extract file paths from input", async () => {
		const task = await mod.execute("Update src/utils/helper.ts and tests/helper.test.ts", makeContext());
		expect(task.context).toContain("src/utils/helper.ts");
		expect(task.context).toContain("tests/helper.test.ts");
	});

	it("should extract constraints from input", async () => {
		const task = await mod.execute("Fix bug. Must include unit test. Don't change the API.", makeContext());
		expect(task.constraints.length).toBeGreaterThanOrEqual(1);
	});

	it("should use LLM when llmCaller provided", async () => {
		const mockLLM = async () => JSON.stringify({
			goal: "Fix login null check",
			context: ["src/auth.ts"],
			constraints: ["backward compatible"],
			definitionOfDone: ["tests pass"],
		});

		const task = await mod.execute("Fix login", makeContext({ llmCaller: mockLLM }));
		expect(task.goal).toBe("Fix login null check");
		expect(task.context).toContain("src/auth.ts");
	});

	it("should fall back to template on LLM error", async () => {
		const failLLM = async () => { throw new Error("API error"); };
		const task = await mod.execute("Fix login bug", makeContext({ llmCaller: failLLM }));
		expect(task.goal).toBeTruthy(); // template fallback still works
	});
});

// ─── ContextBuilder ──────────────────────────────────────────────

describe("ContextBuilderModule", () => {
	const mod = new ContextBuilderModule();

	it("should preserve existing task context", async () => {
		const task = makeTask({ context: ["existing/file.ts"] });
		const enriched = await mod.execute(task, makeContext());
		expect(enriched.context).toContain("existing/file.ts");
	});

	it("should return task with context array", async () => {
		const task = makeTask();
		const enriched = await mod.execute(task, makeContext());
		expect(Array.isArray(enriched.context)).toBe(true);
		expect(enriched.id).toBe(task.id);
		expect(enriched.goal).toBe(task.goal);
	});
});

// ─── PlanGenerator ───────────────────────────────────────────────

describe("PlanGeneratorModule", () => {
	const mod = new PlanGeneratorModule();

	it("should generate template plan without LLM", async () => {
		const plan = await mod.execute(makeTask(), makeContext());

		expect(plan.taskId).toBe("task_1");
		expect(plan.steps.length).toBeGreaterThanOrEqual(2);
		expect(plan.steps[0]!.type).toBe("read");
		expect(plan.steps.every((s) => typeof s.description === "string")).toBe(true);
		expect(plan.steps.every((s) => s.done === false)).toBe(true);
	});

	it("should use LLM when available", async () => {
		const mockLLM = async () => JSON.stringify({
			steps: [
				{ description: "Read auth service", type: "read", files: ["src/auth.ts"] },
				{ description: "Fix null check", type: "write", files: ["src/auth.ts"] },
			],
			estimatedFiles: ["src/auth.ts"],
		});

		const plan = await mod.execute(makeTask(), makeContext({ llmCaller: mockLLM }));
		expect(plan.steps).toHaveLength(2);
		expect(plan.steps[0]!.description).toBe("Read auth service");
		expect(plan.estimatedFiles).toContain("src/auth.ts");
	});

	it("should fall back on LLM error", async () => {
		const failLLM = async () => "not json";
		const plan = await mod.execute(makeTask(), makeContext({ llmCaller: failLLM }));
		expect(plan.steps.length).toBeGreaterThanOrEqual(2);
	});
});

// ─── PatchValidator ──────────────────────────────────────────────

describe("PatchValidatorModule", () => {
	const mod = new PatchValidatorModule();

	it("should pass when changes match scope", async () => {
		const result = await mod.execute(
			{ result: makeExecResult({ changedFiles: ["src/auth-service.ts"] }), estimatedFiles: ["src/auth-service.ts"] },
			makeContext(),
		);
		expect(result.passed).toBe(true);
	});

	it("should warn on out-of-scope files (non-strict)", async () => {
		const result = await mod.execute(
			{ result: makeExecResult({ changedFiles: ["src/auth-service.ts", "src/unrelated.ts"] }), estimatedFiles: ["src/auth-service.ts"] },
			makeContext(),
		);
		// Non-strict: warnings don't fail
		expect(result.passed).toBe(true);
		const scopeCheck = result.checks.find((c) => c.name === "scope");
		expect(scopeCheck?.passed).toBe(false);
		expect(scopeCheck?.severity).toBe("warning");
	});

	it("should fail on too many files changed", async () => {
		const manyFiles = Array.from({ length: 50 }, (_, i) => `file${i}.ts`);
		const ctx = makeContext();
		ctx.config.modules.patchValidator.maxFilesChanged = 10;
		ctx.config.modules.patchValidator.scopeStrict = true;

		const result = await mod.execute(
			{ result: makeExecResult({ changedFiles: manyFiles }), estimatedFiles: [] },
			ctx,
		);
		const fileCheck = result.checks.find((c) => c.name === "file_count");
		expect(fileCheck?.passed).toBe(false);
	});

	it("should warn on empty changes", async () => {
		const result = await mod.execute(
			{ result: makeExecResult({ changedFiles: [], success: true }), estimatedFiles: ["src/app.ts"] },
			makeContext(),
		);
		const emptyCheck = result.checks.find((c) => c.name === "empty_patch");
		expect(emptyCheck?.passed).toBe(false);
	});
});

// ─── QualityGate ─────────────────────────────────────────────────

describe("QualityGateModule", () => {
	const mod = new QualityGateModule();

	it("should pass with no checks configured", async () => {
		const result = await mod.execute(makeExecResult(), makeContext());
		expect(result.passed).toBe(true);
		expect(result.checks).toHaveLength(0);
	});

	it("should pass when node command succeeds", async () => {
		const ctx = makeContext();
		ctx.config.modules.qualityGate.checks = [
			{ type: "test", command: "node --version", required: true },
		];

		const result = await mod.execute(makeExecResult(), ctx);
		expect(result.passed).toBe(true);
		expect(result.checks[0]!.name).toBe("test");
		expect(result.checks[0]!.passed).toBe(true);
	});

	it("should fail when required check fails", async () => {
		const ctx = makeContext();
		ctx.config.modules.qualityGate.checks = [
			{ type: "test", command: "node --invalid-flag-that-fails", required: true },
		];

		const result = await mod.execute(makeExecResult(), ctx);
		expect(result.passed).toBe(false);
	});

	it("should pass when non-required check fails", async () => {
		const ctx = makeContext();
		ctx.config.modules.qualityGate.checks = [
			{ type: "lint", command: "node -e \"process.exit(1)\"", required: false },
		];

		const result = await mod.execute(makeExecResult(), ctx);
		expect(result.passed).toBe(true); // lint is not required
		expect(result.checks[0]!.passed).toBe(false);
	});

	it("should calculate score from check results", async () => {
		const ctx = makeContext();
		ctx.config.modules.qualityGate.checks = [
			{ type: "compile", command: "node --version", required: true },
			{ type: "test", command: "node --version", required: true },
		];

		const result = await mod.execute(makeExecResult(), ctx);
		expect(result.score).toBe(1);
	});
});

// ─── RetryEngine ─────────────────────────────────────────────────

describe("RetryEngineModule", () => {
	const mod = new RetryEngineModule();

	const failedQA: SDLCValidationResult = {
		passed: false,
		checks: [
			{ name: "test", passed: false, message: "2 tests failed", severity: "error" },
			{ name: "lint", passed: true, severity: "info" },
		],
	};

	it("should decide to retry on test failure", async () => {
		const decision = await mod.execute(
			{ result: makeExecResult({ success: false }), validation: failedQA, attempt: 0 },
			makeContext(),
		);
		expect(decision.shouldRetry).toBe(true);
		expect(decision.strategy).toBe("fix_specific");
		expect(decision.fixInstructions).toContain("test");
	});

	it("should stop retrying after max attempts", async () => {
		const decision = await mod.execute(
			{ result: makeExecResult({ success: false }), validation: failedQA, attempt: 3 },
			makeContext(),
		);
		expect(decision.shouldRetry).toBe(false);
		expect(decision.strategy).toBe("escalate");
	});

	it("should classify compile errors", async () => {
		const compileFailQA: SDLCValidationResult = {
			passed: false,
			checks: [{ name: "compile", passed: false, message: "TS2322: Type error", severity: "error" }],
		};

		const decision = await mod.execute(
			{ result: makeExecResult({ success: false }), validation: compileFailQA, attempt: 0 },
			makeContext(),
		);
		expect(decision.shouldRetry).toBe(true);
		expect(decision.fixInstructions).toContain("compile");
	});

	it("should respect custom maxRetries config", async () => {
		const ctx = makeContext();
		ctx.config.modules.retryEngine.maxRetries = 1;

		const decision = await mod.execute(
			{ result: makeExecResult({ success: false }), validation: failedQA, attempt: 1 },
			ctx,
		);
		expect(decision.shouldRetry).toBe(false);
	});
});

// ─── OutputStandardizer ──────────────────────────────────────────

describe("OutputStandardizerModule", () => {
	const mod = new OutputStandardizerModule();

	it("should generate template output without LLM", async () => {
		const output = await mod.execute(
			makeExecResult({ changedFiles: ["src/auth.ts", "src/utils.ts"] }),
			makeContext(),
		);

		expect(output.commitMessage).toMatch(/^feat\(/);
		expect(output.prTitle).toContain("2 file(s)");
		expect(output.prDescription).toContain("src/auth.ts");
		expect(output.changedFiles).toHaveLength(2);
	});

	it("should use LLM when available", async () => {
		const mockLLM = async () => JSON.stringify({
			commitMessage: "fix(auth): handle null login",
			prTitle: "Fix login null check",
			prDescription: "## Summary\n- Fixed null check",
			summary: "Fixed the login bug",
		});

		const output = await mod.execute(makeExecResult(), makeContext({ llmCaller: mockLLM }));
		expect(output.commitMessage).toBe("fix(auth): handle null login");
		expect(output.prTitle).toBe("Fix login null check");
	});

	it("should fall back on LLM error", async () => {
		const failLLM = async () => { throw new Error("API error"); };
		const output = await mod.execute(makeExecResult(), makeContext({ llmCaller: failLLM }));
		expect(output.commitMessage).toBeTruthy();
	});

	it("should handle empty changedFiles", async () => {
		const output = await mod.execute(makeExecResult({ changedFiles: [] }), makeContext());
		expect(output.commitMessage).toBe("chore: update code");
	});
});
