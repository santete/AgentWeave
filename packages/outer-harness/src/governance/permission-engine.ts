/**
 * PermissionEngine — Evaluates tool requests against layered permission rules.
 *
 * Rule matching: "Bash(git *)" matches tool="Bash" with input containing "git ..."
 * Priority: higher number = higher priority. Policy > Project > User > Runtime.
 * Returns PermissionDecision with allow/deny/ask.
 *
 * Patterns are pre-compiled at construction time for performance (no RegExp per-call).
 */

import type {
	PermissionConfig,
	PermissionRule,
	PermissionDecision,
	ToolRequest,
} from "@agentweave/types";

// ─── Compiled Rule ───────────────────────────────────────────────

interface CompiledRule {
	rule: PermissionRule;
	matchType: "wildcard" | "exact_tool" | "tool_wildcard_arg" | "tool_pattern_arg";
	toolName?: string;
	argRegex?: RegExp;
}

function compileRule(rule: PermissionRule): CompiledRule {
	const pattern = rule.pattern;

	// "*" — matches everything
	if (pattern === "*") {
		return { rule, matchType: "wildcard" };
	}

	const parenIdx = pattern.indexOf("(");

	// "Bash" — exact tool name, no arg constraint
	if (parenIdx === -1) {
		return { rule, matchType: "exact_tool", toolName: pattern };
	}

	const toolName = pattern.slice(0, parenIdx);
	const argPattern = pattern.slice(parenIdx + 1, -1);

	// "Bash(*)" — any arg
	if (argPattern === "*") {
		return { rule, matchType: "tool_wildcard_arg", toolName };
	}

	// "Bash(git *)" — compile to regex once
	const regexStr = argPattern
		.replace(/[.+^${}()|[\]\\]/g, "\\$&")
		.replace(/\*/g, ".*");

	return {
		rule,
		matchType: "tool_pattern_arg",
		toolName,
		argRegex: new RegExp(`^${regexStr}$`),
	};
}

// ─── Match ───────────────────────────────────────────────────────

function matchCompiled(compiled: CompiledRule, request: ToolRequest): boolean {
	switch (compiled.matchType) {
		case "wildcard":
			return true;
		case "exact_tool":
			return request.toolName === compiled.toolName;
		case "tool_wildcard_arg":
			return (
				request.toolName === compiled.toolName || compiled.toolName === "*"
			);
		case "tool_pattern_arg": {
			if (
				request.toolName !== compiled.toolName &&
				compiled.toolName !== "*"
			) {
				return false;
			}
			const inputStr = serializeInput(request.toolInput);
			return compiled.argRegex!.test(inputStr);
		}
	}
}

/** Public matchPattern for testing / external use. */
export function matchPattern(pattern: string, request: ToolRequest): boolean {
	return matchCompiled(compileRule({ pattern, behavior: "allow", source: "user", priority: 0 }), request);
}

/** Serialize tool input into a matchable string. */
function serializeInput(input: Record<string, unknown>): string {
	if ("command" in input && typeof input.command === "string") {
		return input.command;
	}
	if ("path" in input && typeof input.path === "string") {
		return input.path;
	}
	if ("file_path" in input && typeof input.file_path === "string") {
		return input.file_path;
	}
	if ("pattern" in input && typeof input.pattern === "string") {
		return input.pattern;
	}
	return JSON.stringify(input);
}

// ─── Permission Engine ───────────────────────────────────────────

export class PermissionEngine {
	private compiledRules: CompiledRule[];
	readonly config: PermissionConfig;

	constructor(config: PermissionConfig) {
		this.config = config;
		this.compiledRules = [...config.rules]
			.sort((a, b) => b.priority - a.priority)
			.map(compileRule);
	}

	async evaluate(request: ToolRequest): Promise<PermissionDecision> {
		for (const compiled of this.compiledRules) {
			if (matchCompiled(compiled, request)) {
				return {
					behavior: compiled.rule.behavior,
					reason: compiled.rule.message ?? `Matched rule: ${compiled.rule.pattern}`,
					source: `rule:${compiled.rule.source}`,
					askMessage:
						compiled.rule.behavior === "ask"
							? (compiled.rule.message ?? `Allow ${request.toolName}?`)
							: undefined,
				};
			}
		}
		return this.defaultDecision(request);
	}

	addRule(rule: PermissionRule): void {
		this.compiledRules.push(compileRule(rule));
		this.compiledRules.sort((a, b) => b.rule.priority - a.rule.priority);
	}

	removeRule(pattern: string, source: string): boolean {
		const idx = this.compiledRules.findIndex(
			(c) => c.rule.pattern === pattern && c.rule.source === source,
		);
		if (idx === -1) return false;
		this.compiledRules.splice(idx, 1);
		return true;
	}

	getRules(): ReadonlyArray<PermissionRule> {
		return this.compiledRules.map((c) => c.rule);
	}

	private defaultDecision(request: ToolRequest): PermissionDecision {
		switch (this.config.mode) {
			case "permissive":
				return {
					behavior: "allow",
					reason: "No matching rule (permissive mode)",
					source: "default",
				};
			case "strict":
				return {
					behavior: "deny",
					reason: "No matching rule (strict mode)",
					source: "default",
				};
			case "plan":
				return {
					behavior: request.isReadOnly ? "allow" : "deny",
					reason: request.isReadOnly
						? "Read-only allowed in plan mode"
						: "Write operations denied in plan mode",
					source: "default",
				};
			case "default":
			default:
				return {
					behavior: "ask",
					reason: "No matching rule — asking user",
					source: "default",
					askMessage: `Allow ${request.toolName}?`,
				};
		}
	}
}
