import { describe, it, expect } from "vitest";
import { HookEngine } from "../src/governance/hook-engine";
import type { HookEvent, HookDefinition, FunctionHook } from "@agentweave/types";

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
					{
						type: "function",
						event: "PreToolUse",
						inline: 'if (input.command === "rm -rf /") return { decision: "deny", reason: "dangerous" }; return { decision: "pass" }',
						timeout: 5000,
					} as FunctionHook,
				],
			},
		});

		// Safe command — should pass
		const result1 = await engine.execute(makeEvent({ toolInput: { command: "ls" } }));
		expect(result1.outcome).toBe("pass");

		// Dangerous command — should block
		const result2 = await engine.execute(makeEvent({ toolInput: { command: "rm -rf /" } }));
		expect(result2.outcome).toBe("block");
		expect(result2.permissionDecision).toBe("deny");
	});

	it("should match hooks by event type", async () => {
		const engine = new HookEngine({
			hooks: {
				PreToolUse: [
					{ type: "function", event: "PreToolUse", inline: 'return { decision: "deny" }' } as FunctionHook,
				],
				PostToolUse: [
					{ type: "function", event: "PostToolUse", inline: 'return { outcome: "pass", additionalContext: "post" }' } as FunctionHook,
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
					{
						type: "function",
						event: "PreToolUse",
						matcher: "FileWrite|FileEdit",
						inline: 'return { outcome: "block", message: "write blocked" }',
					} as FunctionHook,
				],
			},
		});

		// Non-matching tool — should pass
		const result1 = await engine.execute(makeEvent({ toolName: "FileRead" }));
		expect(result1.outcome).toBe("pass");

		// Matching tool — should block
		const result2 = await engine.execute(makeEvent({ toolName: "FileWrite" }));
		expect(result2.outcome).toBe("block");
	});

	it("should chain multiple hooks — block stops the chain", async () => {
		const engine = new HookEngine({
			hooks: {
				PreToolUse: [
					{ type: "function", event: "PreToolUse", inline: 'return { outcome: "block", message: "first blocks" }' } as FunctionHook,
					{ type: "function", event: "PreToolUse", inline: 'return { outcome: "pass", additionalContext: "second ran" }' } as FunctionHook,
				],
			},
		});

		const result = await engine.execute(makeEvent());
		expect(result.outcome).toBe("block");
		// Second hook should NOT have run
		expect(result.additionalContext).toBeUndefined();
	});

	it("should aggregate additionalContext from multiple hooks", async () => {
		const engine = new HookEngine({
			hooks: {
				PostToolUse: [
					{ type: "function", event: "PostToolUse", inline: 'return { outcome: "pass", additionalContext: "context A" }' } as FunctionHook,
					{ type: "function", event: "PostToolUse", inline: 'return { outcome: "pass", additionalContext: "context B" }' } as FunctionHook,
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
				PreToolUse: [
					{ type: "function", event: "PreToolUse", inline: 'throw new Error("hook crashed")' } as FunctionHook,
				],
			},
		});

		const result = await engine.execute(makeEvent());
		expect(result.outcome).toBe("error");
		expect(result.message).toContain("hook crashed");
	});

	it("should add hooks at runtime", async () => {
		const engine = new HookEngine({ hooks: {} });

		engine.addHook("SessionEnd", {
			type: "function",
			event: "SessionEnd",
			inline: 'return { outcome: "pass", additionalContext: "session ended" }',
		} as FunctionHook);

		const hooks = engine.getHooks("SessionEnd");
		expect(hooks).toHaveLength(1);

		const result = await engine.execute(makeEvent({ type: "SessionEnd" }));
		expect(result.additionalContext).toBe("session ended");
	});

	it("should handle hook timeout", async () => {
		const engine = new HookEngine({
			hooks: {
				PreToolUse: [
					{
						type: "function",
						event: "PreToolUse",
						timeout: 50, // 50ms timeout
						inline: 'return new Promise(r => setTimeout(() => r({ outcome: "pass" }), 5000))',
					} as FunctionHook,
				],
			},
		});

		const result = await engine.execute(makeEvent());
		expect(result.outcome).toBe("error");
		expect(result.message).toContain("timeout");
	}, 5000);
});
