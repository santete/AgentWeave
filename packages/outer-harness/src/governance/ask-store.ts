/**
 * AskStore — file-backed persistence for "always allow" PermissionRules
 * created via the ask flow. Keeps user approvals across process restarts.
 *
 * Layout: a single JSON array at `.agentweave/ask-approvals.json` (default).
 * Each entry wraps a PermissionRule + an ISO savedAt timestamp for audit.
 *
 * Orphaning (P3.1 §4): when an immutable org rule starts denying a pattern
 * that a previously-persisted user approval had allowed, OuterHarness calls
 * `markOrphaned()` on reload. The entry is kept on disk for audit but is
 * EXCLUDED from `load()` so PermissionEngine never re-imports it.
 *
 * Fail-safe: corrupt file or permission errors → treated as empty store.
 * Callers should keep behavior working even if persistence is unavailable.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import type { PermissionRule } from "@agentweave/types";

export interface AskStoreOptions {
	/** Absolute or cwd-relative path. Default: `.agentweave/ask-approvals.json`. */
	path?: string;
	cwd?: string;
}

export interface OrphanedRecord {
	rule: PermissionRule;
	savedAt: string;
	orphaned: {
		reason: string;
		conflictWith: string;
		at: string;
	};
}

interface PersistedEntry {
	rule: PermissionRule;
	savedAt: string;
	/** When set, the entry is kept on disk for audit but excluded from `load()`. */
	orphaned?: {
		reason: string;
		/** Pattern of the immutable rule that masked this approval. */
		conflictWith: string;
		at: string;
	};
}

export class AskStore {
	readonly path: string;

	constructor(opts: AskStoreOptions = {}) {
		const cwd = opts.cwd ?? process.cwd();
		const rel = opts.path ?? ".agentweave/ask-approvals.json";
		this.path = isAbsolute(rel) ? rel : resolve(cwd, rel);
	}

	/** Active (non-orphaned) rules only. Orphaned entries are kept on disk
	 *  for audit but never returned here — callers that want the full list
	 *  should use `listOrphaned()`. */
	load(): PermissionRule[] {
		return this.readEntries()
			.filter((e) => !e.orphaned)
			.map((e) => e.rule);
	}

	/** All orphaned entries (for audit / CLI surface). */
	listOrphaned(): OrphanedRecord[] {
		return this.readEntries()
			.filter((e): e is PersistedEntry & { orphaned: NonNullable<PersistedEntry["orphaned"]> } =>
				e.orphaned !== undefined,
			)
			.map((e) => ({ rule: e.rule, savedAt: e.savedAt, orphaned: e.orphaned }));
	}

	persist(rule: PermissionRule): void {
		const existing = this.readEntries();
		const filtered = existing.filter(
			(e) => !(e.rule.pattern === rule.pattern && e.rule.behavior === rule.behavior),
		);
		filtered.push({ rule, savedAt: new Date().toISOString() });
		this.writeAll(filtered);
	}

	/**
	 * Mark a persisted approval as orphaned. Idempotent: calling twice keeps
	 * the first orphan timestamp. No-op if no entry matches `pattern`.
	 */
	markOrphaned(
		pattern: string,
		info: { reason: string; conflictWith: string },
	): boolean {
		const existing = this.readEntries();
		let changed = false;
		const updated = existing.map((e) => {
			if (e.rule.pattern !== pattern) return e;
			if (e.orphaned) return e; // already orphaned — keep original at-timestamp
			changed = true;
			return {
				...e,
				orphaned: {
					reason: info.reason,
					conflictWith: info.conflictWith,
					at: new Date().toISOString(),
				},
			};
		});
		if (changed) this.writeAll(updated);
		return changed;
	}

	private writeAll(entries: PersistedEntry[]): void {
		try {
			mkdirSync(dirname(this.path), { recursive: true });
			writeFileSync(this.path, JSON.stringify(entries, null, 2), "utf-8");
		} catch {
			// Fail-safe: persistence failure must not break the ask flow.
		}
	}

	private readEntries(): PersistedEntry[] {
		if (!existsSync(this.path)) return [];
		try {
			const raw = readFileSync(this.path, "utf-8");
			const parsed = JSON.parse(raw) as unknown;
			if (!Array.isArray(parsed)) return [];
			return parsed.filter(
				(e): e is PersistedEntry =>
					typeof e === "object" &&
					e !== null &&
					"rule" in e &&
					typeof (e as PersistedEntry).rule?.pattern === "string",
			);
		} catch {
			return [];
		}
	}
}
