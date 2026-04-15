/**
 * Hook event types, definitions, and results.
 * 5 canonical hook types: command, prompt, agent, http, function.
 */

export type HookEventType =
	| "PreToolUse"
	| "PostToolUse"
	| "PostToolUseFailure"
	| "InputReceived"
	| "OutputRaw"
	| "OutputDelivered"
	| "SessionStart"
	| "SessionEnd"
	| "TurnStart"
	| "TurnEnd"
	| "BudgetWarning"
	| "BudgetExceeded"
	| "ContextCompacted"
	| "AlertTriggered";

export type HookType = "command" | "prompt" | "agent" | "http" | "function";

// ─── Discriminated Union for Hook Definitions ────────────────────

interface BaseHook {
	event: HookEventType;
	matcher?: string; // "Bash", "FileWrite(*.ts)", "*"
	condition?: string; // "Bash(sudo *)", "session.cost > 5"
	timeout?: number; // ms
	async?: boolean;
	once?: boolean;
}

export interface CommandHook extends BaseHook {
	type: "command";
	command: string;
	shell?: "bash" | "powershell";
}

export interface PromptHook extends BaseHook {
	type: "prompt";
	prompt: string;
	model?: string;
}

export interface AgentHook extends BaseHook {
	type: "agent";
	prompt: string;
	model?: string;
	tools?: string[];
	maxTurns?: number;
}

export interface HttpHook extends BaseHook {
	type: "http";
	url: string;
	method?: string;
	headers?: Record<string, string>;
	allowedEnvVars?: string[];
}

export interface FunctionHook extends BaseHook {
	type: "function";
	handler?: string; // path to module
	inline?: string; // inline code
}

export type HookDefinition =
	| CommandHook
	| PromptHook
	| AgentHook
	| HttpHook
	| FunctionHook;

// ─── Hook Event & Result ─────────────────────────────────────────

export interface HookEvent {
	type: HookEventType;
	toolName?: string;
	toolInput?: unknown;
	toolUseId?: string;
	toolResult?: unknown;
	output?: string;
	sessionId?: string;
	turnIndex?: number;
}

export interface HookResult {
	outcome: "pass" | "block" | "modify" | "error";
	message?: string;
	modifiedInput?: unknown;
	modifiedOutput?: unknown;
	additionalContext?: string;
	permissionDecision?: "allow" | "deny";
	preventContinuation?: boolean;
	stopReason?: string;
}
