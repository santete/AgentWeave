import { describe, it, expect } from "vitest";
import { z } from "zod";
import { ToolExecutor } from "../src/tool-executor";
import { ToolRegistry } from "../src/tool-registry";
import type { ToolDefinition, ToolContext } from "@agentweave/types";

function makeRegistry(): ToolRegistry {
	const reg = new ToolRegistry();
	const tool: ToolDefinition = {
		name: "FileRead",
		description: "Read a file",
		parameters: z.object({ path: z.string() }),
		execute: async ({ path }) => `contents of ${path}`,
		metadata: { isReadOnly: true, isDestructive: false, isConcurrencySafe: true, category: "file" },
	};
	reg.register(tool);
	return reg;
}

function makeContext(sandbox?: ToolContext["sandbox"]): ToolContext {
	return {
		sessionId: "ses_1",
		agentId: "agent_1",
		cwd: "/home/user/project",
		signal: new AbortController().signal,
		sandbox,
	};
}

describe("Tool Sandbox", () => {
	it("should allow access when no sandbox configured", async () => {
		const executor = new ToolExecutor(makeRegistry(), makeContext());
		const [result] = await executor.execute([
			{ toolUseId: "t1", toolName: "FileRead", toolInput: { path: "/etc/passwd" } },
		]);
		expect(result!.isError).toBe(false);
	});

	it("should deny access to default denied paths", async () => {
		const executor = new ToolExecutor(makeRegistry(), makeContext({ deniedPaths: [] }));
		const [result] = await executor.execute([
			{ toolUseId: "t1", toolName: "FileRead", toolInput: { path: "/etc/passwd" } },
		]);
		expect(result!.isError).toBe(true);
		expect(String(result!.result)).toContain("Sandbox violation");
		expect(String(result!.result)).toContain("/etc");
	});

	it("should deny access to sensitive file patterns (.env)", async () => {
		const executor = new ToolExecutor(makeRegistry(), makeContext({ deniedPaths: [] }));
		const [result] = await executor.execute([
			{ toolUseId: "t1", toolName: "FileRead", toolInput: { path: ".env.local" } },
		]);
		expect(result!.isError).toBe(true);
		expect(String(result!.result)).toContain(".env");
	});

	it("should deny access to .ssh directory", async () => {
		const executor = new ToolExecutor(makeRegistry(), makeContext({ deniedPaths: [] }));
		const [result] = await executor.execute([
			{ toolUseId: "t1", toolName: "FileRead", toolInput: { path: "/home/user/.ssh/id_rsa" } },
		]);
		expect(result!.isError).toBe(true);
		expect(String(result!.result)).toContain(".ssh");
	});

	it("should deny access to custom denied paths", async () => {
		const executor = new ToolExecutor(makeRegistry(), makeContext({ deniedPaths: ["/tmp/secrets"] }));
		const [result] = await executor.execute([
			{ toolUseId: "t1", toolName: "FileRead", toolInput: { path: "/tmp/secrets/key.pem" } },
		]);
		expect(result!.isError).toBe(true);
	});

	it("should allow access within allowed paths", async () => {
		const executor = new ToolExecutor(makeRegistry(), makeContext({
			allowedPaths: ["/home/user/project/src"],
		}));
		const [result] = await executor.execute([
			{ toolUseId: "t1", toolName: "FileRead", toolInput: { path: "src/index.ts" } },
		]);
		expect(result!.isError).toBe(false);
	});

	it("should deny access outside allowed paths", async () => {
		const executor = new ToolExecutor(makeRegistry(), makeContext({
			allowedPaths: ["/home/user/project/src"],
		}));
		const [result] = await executor.execute([
			{ toolUseId: "t1", toolName: "FileRead", toolInput: { path: "/tmp/other.txt" } },
		]);
		expect(result!.isError).toBe(true);
		expect(String(result!.result)).toContain("not in allowed paths");
	});

	it("should pass when input has no path fields", async () => {
		const reg = new ToolRegistry();
		reg.register({
			name: "Echo",
			description: "Echo",
			parameters: z.object({ message: z.string() }),
			execute: async ({ message }) => message,
			metadata: { isReadOnly: true, isDestructive: false, isConcurrencySafe: true, category: "custom" },
		});
		const executor = new ToolExecutor(reg, makeContext({ deniedPaths: ["/etc"] }));
		const [result] = await executor.execute([
			{ toolUseId: "t1", toolName: "Echo", toolInput: { message: "hello" } },
		]);
		expect(result!.isError).toBe(false);
	});
});
