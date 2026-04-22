import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PermissionRule } from "@agentweave/types";
import { AskStore } from "../src/governance/ask-store";

let workDir: string;
let storePath: string;

beforeEach(() => {
	workDir = mkdtempSync(join(tmpdir(), "aw-askstore-"));
	storePath = join(workDir, ".agentweave", "ask-approvals.json");
});

afterEach(() => {
	rmSync(workDir, { recursive: true, force: true });
});

function rule(pattern: string, behavior: "allow" | "deny" = "allow"): PermissionRule {
	return { pattern, behavior, source: "runtime", priority: 75 };
}

describe("AskStore", () => {
	it("returns empty array when no store file exists", () => {
		const store = new AskStore({ cwd: workDir });
		expect(store.load()).toEqual([]);
	});

	it("persists a rule and loads it back on a fresh instance", () => {
		const store1 = new AskStore({ cwd: workDir });
		store1.persist(rule("Bash(*)"));

		const store2 = new AskStore({ cwd: workDir });
		const loaded = store2.load();
		expect(loaded).toHaveLength(1);
		expect(loaded[0]!.pattern).toBe("Bash(*)");
		expect(loaded[0]!.behavior).toBe("allow");
	});

	it("dedupes when the same pattern+behavior is persisted twice", () => {
		const store = new AskStore({ cwd: workDir });
		store.persist(rule("Bash(*)"));
		store.persist(rule("Bash(*)"));
		expect(store.load()).toHaveLength(1);
	});

	it("keeps distinct entries for different patterns", () => {
		const store = new AskStore({ cwd: workDir });
		store.persist(rule("Bash(*)"));
		store.persist(rule("Write(*)"));
		const loaded = store.load();
		expect(loaded).toHaveLength(2);
		expect(new Set(loaded.map((r) => r.pattern))).toEqual(new Set(["Bash(*)", "Write(*)"]));
	});

	it("creates missing parent directories when persisting", () => {
		const store = new AskStore({ cwd: workDir });
		expect(existsSync(storePath)).toBe(false);
		store.persist(rule("Glob(*)"));
		expect(existsSync(storePath)).toBe(true);
	});

	it("returns empty array when store file is corrupt", () => {
		// Write the dir + corrupt content directly
		const corruptPath = join(workDir, "corrupt.json");
		writeFileSync(corruptPath, "this is not JSON", "utf-8");
		const store = new AskStore({ path: corruptPath });
		expect(store.load()).toEqual([]);
	});

	it("records savedAt timestamp on every persist", () => {
		const store = new AskStore({ cwd: workDir });
		store.persist(rule("Bash(*)"));
		const raw = JSON.parse(readFileSync(storePath, "utf-8")) as Array<{ savedAt: string }>;
		expect(raw).toHaveLength(1);
		expect(typeof raw[0]!.savedAt).toBe("string");
		expect(() => new Date(raw[0]!.savedAt).toISOString()).not.toThrow();
	});
});
