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
}
