/**
 * AskStore — file-backed persistence for "always allow" PermissionRules
 * created via the ask flow. Keeps user approvals across process restarts.
 *
 * Layout: a single JSON array at `.agentweave/ask-approvals.json` (default).
 * Each entry wraps a PermissionRule + an ISO savedAt timestamp for audit.
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

interface PersistedEntry {
	rule: PermissionRule;
	savedAt: string;
}

export class AskStore {
	readonly path: string;

	constructor(opts: AskStoreOptions = {}) {
		const cwd = opts.cwd ?? process.cwd();
		const rel = opts.path ?? ".agentweave/ask-approvals.json";
		this.path = isAbsolute(rel) ? rel : resolve(cwd, rel);
	}

	load(): PermissionRule[] {
		return this.readEntries().map((e) => e.rule);
	}

	persist(rule: PermissionRule): void {
		const existing = this.readEntries();
		const filtered = existing.filter(
			(e) => !(e.rule.pattern === rule.pattern && e.rule.behavior === rule.behavior),
		);
		filtered.push({ rule, savedAt: new Date().toISOString() });
		try {
			mkdirSync(dirname(this.path), { recursive: true });
			writeFileSync(this.path, JSON.stringify(filtered, null, 2), "utf-8");
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
