/**
 * Permission engine types: rules, modes, and configuration.
 */

export type PermissionMode = "default" | "strict" | "permissive" | "plan";

export interface PermissionRule {
	pattern: string; // "Bash(git *)", "FileWrite(*.env)", "*"
	behavior: "allow" | "deny" | "ask";
	source: "policy" | "project" | "user" | "runtime";
	priority: number; // Higher = more important
	condition?: string; // Contextual: "git.branch == 'main'"
	message?: string; // Shown when ask/deny
}

export interface PermissionConfig {
	mode: PermissionMode;
	rules: PermissionRule[];
	failMode: "open" | "closed"; // On timeout/error
	timeoutMs: number; // Permission evaluation timeout
	askTimeoutMs: number; // User interaction timeout (default 60000)
}
