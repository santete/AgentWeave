import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { HookEngine } from "../src/governance/hook-engine";
import type { HookEvent, FunctionHook } from "@agentweave/types";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

/** Helper: create a trusted inline function hook for testing */
function inlineHook(inline: string, overrides: Partial<FunctionHook> = {}): FunctionHook {
	return {
		type: "function",
		event: "PreToolUse",
		inline,
		trusted: true, // security: required for inline code execution
		...overrides,
	} as FunctionHook;
}

function makeEvent(overrides: Partial<HookEvent> = {}): HookEvent {
	return {
		type: "PreToolUse",
		toolName: "Bash",
		toolInput: { command: "ls" },
		toolUseId: "tu_1",
		sessionId: "ses_1",
		...overrides,
	};
}

// ─── Core (v1.1.0 tests, preserved) ─────────────────────────────

describe("HookEngine", () => {
	it("should pass through when no hooks registered", async () => {
		const engine = new HookEngine({ hooks: {} });
		const result = await engine.execute(makeEvent());
		expect(result.outcome).toBe("pass");
	});

	it("should execute function hook with inline code", async () => {
		const engine = new HookEngine({
			hooks: {
				PreToolUse: [
					inlineHook(
						'if (input.command === "rm -rf /") return { decision: "deny", reason: "dangerous" }; return { decision: "pass" }',
					),
				],
			},
		});

		const result1 = await engine.execute(makeEvent({ toolInput: { command: "ls" } }));
		expect(result1.outcome).toBe("pass");

		const result2 = await engine.execute(makeEvent({ toolInput: { command: "rm -rf /" } }));
		expect(result2.outcome).toBe("block");
		expect(result2.permissionDecision).toBe("deny");
	});

	it("should block inline function hook without trusted flag", async () => {
		const engine = new HookEngine({
			hooks: {
				PreToolUse: [
					{ type: "function", event: "PreToolUse", inline: 'return { outcome: "pass" }' } as FunctionHook,
				],
			},
		});

		const result = await engine.execute(makeEvent());
		expect(result.outcome).toBe("error");
		expect(result.message).toContain("trusted: true");
	});

	it("should match hooks by event type", async () => {
		const engine = new HookEngine({
			hooks: {
				PreToolUse: [inlineHook('return { decision: "deny" }')],
				PostToolUse: [
					inlineHook('return { outcome: "pass", additionalContext: "post" }', { event: "PostToolUse" }),
				],
			},
		});

		const pre = await engine.execute(makeEvent({ type: "PreToolUse" }));
		expect(pre.outcome).toBe("block");

		const post = await engine.execute(makeEvent({ type: "PostToolUse" }));
		expect(post.outcome).toBe("pass");
		expect(post.additionalContext).toBe("post");
	});

	it("should match hooks by tool name matcher", async () => {
		const engine = new HookEngine({
			hooks: {
				PreToolUse: [
					inlineHook('return { outcome: "block", message: "write blocked" }', { matcher: "FileWrite|FileEdit" }),
				],
			},
		});

		const result1 = await engine.execute(makeEvent({ toolName: "FileRead" }));
		expect(result1.outcome).toBe("pass");

		const result2 = await engine.execute(makeEvent({ toolName: "FileWrite" }));
		expect(result2.outcome).toBe("block");
	});

	it("should chain multiple hooks — block stops the chain", async () => {
		const engine = new HookEngine({
			hooks: {
				PreToolUse: [
					inlineHook('return { outcome: "block", message: "first blocks" }'),
					inlineHook('return { outcome: "pass", additionalContext: "second ran" }'),
				],
			},
		});

		const result = await engine.execute(makeEvent());
		expect(result.outcome).toBe("block");
		expect(result.additionalContext).toBeUndefined();
	});

	it("should aggregate additionalContext from multiple hooks", async () => {
		const engine = new HookEngine({
			hooks: {
				PostToolUse: [
					inlineHook('return { outcome: "pass", additionalContext: "context A" }', { event: "PostToolUse" }),
					inlineHook('return { outcome: "pass", additionalContext: "context B" }', { event: "PostToolUse" }),
				],
			},
		});

		const result = await engine.execute(makeEvent({ type: "PostToolUse" }));
		expect(result.outcome).toBe("pass");
		expect(result.additionalContext).toContain("context A");
		expect(result.additionalContext).toContain("context B");
	});

	it("should handle function hook errors gracefully", async () => {
		const engine = new HookEngine({
			hooks: {
				PreToolUse: [inlineHook('throw new Error("hook crashed")')],
			},
		});

		const result = await engine.execute(makeEvent());
		expect(result.outcome).toBe("error");
		expect(result.message).toContain("hook crashed");
	});

	it("should add hooks at runtime", async () => {
		const engine = new HookEngine({ hooks: {} });

		engine.addHook("SessionEnd", inlineHook(
			'return { outcome: "pass", additionalContext: "session ended" }',
			{ event: "SessionEnd" },
		));

		const hooks = engine.getHooks("SessionEnd");
		expect(hooks).toHaveLength(1);

		const result = await engine.execute(makeEvent({ type: "SessionEnd" }));
		expect(result.additionalContext).toBe("session ended");
	});

	it("should handle hook timeout", async () => {
		const engine = new HookEngine({
			hooks: {
				PreToolUse: [
					inlineHook(
						'return new Promise(r => setTimeout(() => r({ outcome: "pass" }), 5000))',
						{ timeout: 50 },
					),
				],
			},
		});

		const result = await engine.execute(makeEvent());
		expect(result.outcome).toBe("error");
		expect(result.message).toContain("timeout");
	}, 5000);

	it("should resolve async inline function hooks", async () => {
		const engine = new HookEngine({
			hooks: {
				PreToolUse: [
					inlineHook('return Promise.resolve({ outcome: "pass", additionalContext: "async worked" })'),
				],
			},
		});

		const result = await engine.execute(makeEvent());
		expect(result.outcome).toBe("pass");
		expect(result.additionalContext).toBe("async worked");
	});

	it("should execute command hook (echo)", async () => {
		const engine = new HookEngine({
			hooks: {
				PreToolUse: [
					{
						type: "command",
						event: "PreToolUse",
						command: "echo ok",
						timeout: 5000,
					} as import("@agentweave/types").CommandHook,
				],
			},
		});

		const result = await engine.execute(makeEvent());
		expect(result.outcome).toBe("pass");
	}, 10000);
});

// ─── Function Hook Handler Path ──────────────────────────────────

describe("HookEngine — function handler path", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = join(tmpdir(), `agentweave-hook-test-${randomUUID().slice(0, 8)}`);
		mkdirSync(tmpDir, { recursive: true });
	});

	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true });
	});

	it("should execute handler from .js file", async () => {
		const handlerPath = join(tmpDir, "test-handler.mjs");
		writeFileSync(handlerPath, `
			export default function(input, output, event) {
				return { outcome: "pass", additionalContext: "handler-ran" };
			}
		`);

		const engine = new HookEngine({
			hooks: {
				PreToolUse: [{
					type: "function",
					event: "PreToolUse",
					handler: handlerPath,
				} as FunctionHook],
			},
		});

		const result = await engine.execute(makeEvent());
		expect(result.outcome).toBe("pass");
		expect(result.additionalContext).toBe("handler-ran");
	});

	it("should reject path traversal in handler path", async () => {
		const engine = new HookEngine({
			hooks: {
				PreToolUse: [{
					type: "function",
					event: "PreToolUse",
					handler: "../../etc/passwd.js",
				} as FunctionHook],
			},
		});

		const result = await engine.execute(makeEvent());
		expect(result.outcome).toBe("error");
		expect(result.message).toContain("path traversal");
	});

	it("should reject handler without .js/.ts/.mjs extension", async () => {
		const engine = new HookEngine({
			hooks: {
				PreToolUse: [{
					type: "function",
					event: "PreToolUse",
					handler: "/some/path/handler.py",
				} as FunctionHook],
			},
		});

		const result = await engine.execute(makeEvent());
		expect(result.outcome).toBe("error");
		expect(result.message).toContain("must end in");
	});

	it("should return error when handler module not found", async () => {
		const engine = new HookEngine({
			hooks: {
				PreToolUse: [{
					type: "function",
					event: "PreToolUse",
					handler: join(tmpDir, "nonexistent.js"),
				} as FunctionHook],
			},
		});

		const result = await engine.execute(makeEvent());
		expect(result.outcome).toBe("error");
	});

	it("should return error when handler export is not a function", async () => {
		const handlerPath = join(tmpDir, "bad-handler.mjs");
		writeFileSync(handlerPath, `export default "not a function";`);

		const engine = new HookEngine({
			hooks: {
				PreToolUse: [{
					type: "function",
					event: "PreToolUse",
					handler: handlerPath,
				} as FunctionHook],
			},
		});

		const result = await engine.execute(makeEvent());
		expect(result.outcome).toBe("error");
		expect(result.message).toContain("does not export a function");
	});
});

// ─── Hook Execution Metrics ──────────────────────────────────────

describe("HookEngine — metrics", () => {
	it("should track pass count", async () => {
		const engine = new HookEngine({
			hooks: {
				PreToolUse: [inlineHook('return { outcome: "pass" }')],
			},
		});

		await engine.execute(makeEvent());
		await engine.execute(makeEvent());
		await engine.execute(makeEvent());

		const metrics = engine.getMetrics();
		expect(metrics.totalExecutions).toBe(3);
		expect(metrics.passCount).toBe(3);
	});

	it("should track block count", async () => {
		const engine = new HookEngine({
			hooks: {
				PreToolUse: [inlineHook('return { outcome: "block" }')],
			},
		});

		await engine.execute(makeEvent());
		expect(engine.getMetrics().blockCount).toBe(1);
	});

	it("should track error count", async () => {
		const engine = new HookEngine({
			hooks: {
				PreToolUse: [inlineHook('throw new Error("fail")')],
			},
		});

		await engine.execute(makeEvent());
		expect(engine.getMetrics().errorCount).toBe(1);
	});

	it("should track timing", async () => {
		const engine = new HookEngine({
			hooks: {
				PreToolUse: [inlineHook('return { outcome: "pass" }')],
			},
		});

		await engine.execute(makeEvent());
		const metrics = engine.getMetrics();
		expect(metrics.totalDurationMs).toBeGreaterThanOrEqual(0);
		expect(metrics.avgDurationMs).toBeGreaterThanOrEqual(0);
	});

	it("should track by event type", async () => {
		const engine = new HookEngine({
			hooks: {
				PreToolUse: [inlineHook('return { outcome: "pass" }')],
				PostToolUse: [inlineHook('return { outcome: "pass" }', { event: "PostToolUse" })],
			},
		});

		await engine.execute(makeEvent({ type: "PreToolUse" }));
		await engine.execute(makeEvent({ type: "PreToolUse" }));
		await engine.execute(makeEvent({ type: "PostToolUse" }));

		const metrics = engine.getMetrics();
		expect(metrics.byEvent.PreToolUse?.count).toBe(2);
		expect(metrics.byEvent.PostToolUse?.count).toBe(1);
	});
});
