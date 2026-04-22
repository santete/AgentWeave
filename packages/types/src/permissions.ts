/**
 * Permission engine types: rules, modes, and configuration.
 */

export type PermissionMode = "default" | "strict" | "permissive" | "plan";

export interface RateLimit {
	maxCalls: number;
	windowMs: number; // Sliding window
}

export interface PermissionRule {
	pattern: string; // "Bash(git *)", "FileWrite(*.env)", "*"
	behavior: "allow" | "deny" | "ask";
	source: "policy" | "project" | "user" | "runtime";
	priority: number; // Higher = more important
	condition?: string; // Contextual: "request.isReadOnly == true"
	message?: string; // Shown when ask/deny
	group?: string; // Rule group for enable/disable
	rateLimit?: RateLimit; // Sliding window rate limiting
	/**
	 * Marks the rule as un-overridable by lower levels or runtime additions.
	 * VALID ONLY when `source === "policy"` (org level). PolicyLoader rejects
	 * files that set this flag on team/user rules. Immutable rules evaluate
	 * BEFORE mutable rules regardless of priority number — see P3.1 design doc.
	 */
	immutable?: boolean;
}

export interface PermissionAuditRecord {
	toolName: string;
	serializedInput: string;
	matchedRule: PermissionRule | null; // null = default fallback
	behavior: "allow" | "deny" | "ask";
	reason: string;
	mode: PermissionMode;
	timestamp: number;
	dryRun: boolean;
}

export interface RuleConflict {
	ruleA: PermissionRule;
	ruleB: PermissionRule;
	type: "conflict" | "shadow";
	description: string;
}

export interface RuleAnalysis {
	conflicts: RuleConflict[];
}

export interface PermissionConfig {
	mode: PermissionMode;
	rules: PermissionRule[];
	failMode: "open" | "closed"; // On timeout/error
	timeoutMs: number; // Permission evaluation timeout
	askTimeoutMs: number; // User interaction timeout (default 60000)
	/**
	 * Env var names exposed to rule conditions via `env.*`. Any var NOT in this
	 * list resolves to `undefined` inside conditions (fail-closed; prevents
	 * accidental secret reads in audit trail). Default: `[]` (no env access).
	 */
	envAllowlist?: readonly string[];
}
