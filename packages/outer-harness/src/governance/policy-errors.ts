/**
 * Errors thrown by PolicyLoader + PermissionEngine when policy hierarchy rules
 * are violated. All classes subclass Error and set `name` for instanceof-free
 * narrowing via `err.name === "PolicyLoadError"`.
 */

import type { PermissionRule } from "@agentweave/types";

export type PolicyLoadReason =
	| "parse"
	| "schema"
	| "immutable-level"
	| "size-cap"
	| "count-cap"
	| "io";

export class PolicyLoadError extends Error {
	readonly name = "PolicyLoadError";
	constructor(
		public readonly path: string,
		public readonly reason: PolicyLoadReason,
		public readonly detail: string,
	) {
		super(`Policy load failed [${reason}] at ${path}: ${detail}`);
	}
}

export class InvalidImmutableLevel extends Error {
	readonly name = "InvalidImmutableLevel";
	constructor(
		public readonly path: string,
		public readonly pattern: string,
		public readonly level: "team" | "user",
	) {
		super(
			`Rule "${pattern}" in ${path} has immutable:true but source level is "${level}". ` +
				`Only org-level (source:"policy") rules may be immutable.`,
		);
	}
}

export class PermissionRuleConflictError extends Error {
	readonly name = "PermissionRuleConflictError";
	constructor(
		public readonly immutable: PermissionRule,
		public readonly attempted: PermissionRule,
	) {
		super(
			`Cannot add rule "${attempted.pattern}" (${attempted.behavior}): ` +
				`conflicts with immutable rule "${immutable.pattern}" (${immutable.behavior}) from ${immutable.source}`,
		);
	}
}
