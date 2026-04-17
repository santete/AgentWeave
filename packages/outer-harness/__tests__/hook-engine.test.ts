import { describe, it, expect } from "vitest";
import { HookEngine } from "../src/governance/hook-engine";
import type { HookEvent, FunctionHook } from "@agentweave/types";

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
