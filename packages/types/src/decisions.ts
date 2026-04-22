/**
 * Gate decisions: Permission, Output, and Input gates.
 *
 * PermissionDecision has 3 values (allow/deny/ask).
 * ToolDecision has 2 values (allow/deny) — 'ask' is resolved by Outer before returning.
 */

import type { Attachment, ContentBlock } from "./messages";
import type { TokenUsage } from "./metrics";

// ─── Permission Decision (from PermissionEngine) ────────────────

export interface PermissionDecision {
	behavior: "allow" | "deny" | "ask";
	reason: string;
	source: string; // 'rule:policy', 'rule:project', 'hook', 'classifier'
	modifiedInput?: unknown;
	riskScore?: number;
	/** Only when behavior='ask': message shown to user */
	askMessage?: string;
	suggestions?: PermissionUpdate[];
	/** The rule that matched this decision (null if default fallback) */
	matchedRule?: import("./permissions").PermissionRule | null;
}

export interface PermissionUpdate {
	pattern: string; // "Bash(git *)"
	behavior: "allow" | "deny";
	scope: "session" | "project" | "user";
}

// ─── Tool Decision (final, returned to Inner) ───────────────────

export interface ToolDecision {
	behavior: "allow" | "deny";
	modifiedInput?: unknown;
	reason: string;
	source: string; // 'rule:policy', 'rule:project', 'hook', 'classifier', 'user', 'timeout', 'budget'
	/** True if resolved from an 'ask' prompt */
	resolvedFromAsk?: boolean;
	/** User feedback when approving (e.g. "Always allow this") */
	userFeedback?: string;
}

// ─── Tool Request ────────────────────────────────────────────────

export interface ToolRequest {
	toolName: string;
	toolInput: Record<string, unknown>;
	toolUseId: string;
	turnIndex: number;
	isReadOnly: boolean;
	isDestructive: boolean;
}

// ─── Output Decision ─────────────────────────────────────────────

export interface OutputDecision {
	action: "approve" | "reject" | "modify" | "retry";
	modifiedContent?: string;
	retryPrompt?: string;
	reason?: string;
	stages: OutputStageResult[];
}

export interface OutputStageResult {
	stage: "validate" | "filter" | "transform" | "review";
	passed: boolean;
	details?: string;
}

// ─── Raw Output ──────────────────────────────────────────────────

export interface RawOutput {
	text: string;
	contentBlocks: ContentBlock[];
	usage: TokenUsage;
	turnIndex: number;
	toolCallCount: number;
	model: string;
}

// ─── Input Decision ──────────────────────────────────────────────

export interface InputDecision {
	action: "pass" | "transform" | "reject";
	transformedInput?: string;
	injectedContext?: string[];
	reason?: string;
}

// ─── User Input ──────────────────────────────────────────────────

export interface UserInput {
	text: string;
	attachments?: Attachment[];
	sessionId: string;
	timestamp: number;
}
