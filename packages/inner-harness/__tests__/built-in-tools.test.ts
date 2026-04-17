import { describe, it, expect } from "vitest";
import { writeFile, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { BUILT_IN_TOOLS, BashTool, FileReadTool, FileWriteTool, FileEditTool, GrepTool, GlobTool } from "../src/built-in-tools/index";
import type { ToolContext } from "@agentweave/types";

const testDir = join(tmpdir(), "agentweave-tool-test-" + Date.now());

function ctx(): ToolContext {
	return {
		sessionId: "s1", agentId: "a1", cwd: testDir,
		signal: new AbortController().signal,
	};
}

describe("Built-in Tools", () => {
	// Setup test directory
	it("setup: create test dir and file", async () => {
		await mkdir(testDir, { recursive: true });
		await writeFile(join(testDir, "hello.txt"), "Hello World\nLine 2\nLine 3");
	});

	it("should have 6 built-in tools", () => {
		expect(BUILT_IN_TOOLS).toHaveLength(6);
		const names = BUILT_IN_TOOLS.map((t) => t.name);
		expect(names).toEqual(["Bash", "FileRead", "FileWrite", "FileEdit", "Grep", "Glob"]);
	});

	it("Bash: should execute echo command", async () => {
		const result = await BashTool.execute({ command: "echo hi" }, ctx());
		expect(result).toContain("hi");
	});

	it("FileRead: should read file contents", async () => {
		const result = await FileReadTool.execute({ path: "hello.txt" }, ctx());
		expect(result).toContain("Hello World");
	});

	it("FileRead: should support offset + limit", async () => {
		const result = await FileReadTool.execute({ path: "hello.txt", offset: 1, limit: 1 }, ctx());
		expect(result).toContain("Line 2");
		expect(result).not.toContain("Hello World");
	});

	it("FileWrite: should create new file", async () => {
		await FileWriteTool.execute({ path: "new-file.txt", content: "Created!" }, ctx());
		const read = await FileReadTool.execute({ path: "new-file.txt" }, ctx());
		expect(read).toBe("Created!");
	});

	it("FileEdit: should replace string in file", async () => {
		await FileEditTool.execute({ path: "hello.txt", old_string: "Hello World", new_string: "Goodbye World" }, ctx());
		const read = await FileReadTool.execute({ path: "hello.txt" }, ctx());
		expect(read).toContain("Goodbye World");
	});

	it("FileEdit: should reject non-unique string", async () => {
		await writeFile(join(testDir, "dup.txt"), "aaa\naaa");
		await expect(FileEditTool.execute({ path: "dup.txt", old_string: "aaa", new_string: "bbb" }, ctx()))
			.rejects.toThrow("found 2 times");
	});

	it("Grep: should find pattern in files", async () => {
		const result = await GrepTool.execute({ pattern: "Goodbye" }, ctx());
		expect(result).toContain("Goodbye");
	});

	it("Glob: should find files", async () => {
		const result = await GlobTool.execute({ pattern: "*.txt" }, ctx());
		expect(result).toContain(".txt");
	});

	// Cleanup
	it("cleanup: remove test dir", async () => {
		await rm(testDir, { recursive: true, force: true });
	});
});
