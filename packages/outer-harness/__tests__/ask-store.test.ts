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

// ─── Orphaning (P3.1 step 5) ─────────────────────────────────────

describe("AskStore.markOrphaned", () => {
	it("excludes orphaned entries from load() but keeps them on disk", () => {
		const store = new AskStore({ cwd: workDir });
		store.persist(rule("Bash(git push *)"));
		store.persist(rule("Write(*)"));

		const changed = store.markOrphaned("Bash(git push *)", {
			reason: "masked by immutable org deny",
			conflictWith: "Bash(*)",
		});

		expect(changed).toBe(true);
		const active = store.load();
		expect(active.map((r) => r.pattern)).toEqual(["Write(*)"]);

		// On-disk JSON still has 2 entries
		const raw = JSON.parse(readFileSync(storePath, "utf-8")) as unknown[];
		expect(raw).toHaveLength(2);
	});

	it("listOrphaned() returns only orphaned entries with metadata", () => {
		const store = new AskStore({ cwd: workDir });
		store.persist(rule("Bash(sudo *)"));
		store.persist(rule("Grep(*)"));
		store.markOrphaned("Bash(sudo *)", {
			reason: "immutable deny added",
			conflictWith: "Bash(*)",
		});

		const orphaned = store.listOrphaned();
		expect(orphaned).toHaveLength(1);
		expect(orphaned[0]!.rule.pattern).toBe("Bash(sudo *)");
		expect(orphaned[0]!.orphaned.reason).toBe("immutable deny added");
		expect(orphaned[0]!.orphaned.conflictWith).toBe("Bash(*)");
		expect(() => new Date(orphaned[0]!.orphaned.at).toISOString()).not.toThrow();
	});

	it("is idempotent: second call returns false and preserves original at-timestamp", async () => {
		const store = new AskStore({ cwd: workDir });
		store.persist(rule("Bash(*)"));

		const first = store.markOrphaned("Bash(*)", { reason: "r1", conflictWith: "*" });
		expect(first).toBe(true);
		const firstAt = store.listOrphaned()[0]!.orphaned.at;

		// Nudge the clock forward so a second timestamp would differ
		await new Promise((r) => setTimeout(r, 10));

		const second = store.markOrphaned("Bash(*)", { reason: "r2", conflictWith: "*" });
		expect(second).toBe(false);
		expect(store.listOrphaned()[0]!.orphaned.at).toBe(firstAt);
	});

	it("returns false when the pattern is not persisted", () => {
		const store = new AskStore({ cwd: workDir });
		store.persist(rule("Write(*)"));
		const changed = store.markOrphaned("Bash(missing)", {
			reason: "x",
			conflictWith: "*",
		});
		expect(changed).toBe(false);
		expect(store.listOrphaned()).toEqual([]);
	});
});
