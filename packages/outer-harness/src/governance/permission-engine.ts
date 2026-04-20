/**
 * PermissionEngine — Evaluates tool requests against layered permission rules.
 *
 * Rule matching: "Bash(git *)" matches tool="Bash" with input containing "git ..."
 * Priority: higher number = higher priority. Policy > Project > User > Runtime.
 * Returns PermissionDecision with allow/deny/ask.
 *
 * Product-grade features:
 * - Condition evaluation (safe mini-DSL, no eval)
 * - Decision audit trail (bounded, toggleable)
 * - Rule groups (enable/disable at runtime)
 * - Rate limiting (sliding window per pattern)
 * - Dry-run mode (audit without enforcement)
 * - Conflict/shadow detection (static analysis)
 *
 * Patterns are pre-compiled at construction time for performance (no RegExp per-call).
 */

import type {
	PermissionConfig,
	PermissionRule,
	PermissionDecision,
	PermissionAuditRecord,
	RuleAnalysis,
	RuleConflict,
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

// ─── Condition Evaluator (safe mini-DSL, NO eval) ───────────────

/**
 * Evaluate a simple condition string against a ToolRequest.
 * Supported: request.toolName, request.isReadOnly, request.isDestructive, request.turnIndex
 * Operators: ==, !=, >, <, >=, <=, contains()
 * Logical: &&, ||
 */
function evaluateCondition(condition: string, request: ToolRequest): boolean {
	try {
		// Split on || first (lower precedence), then && within each
		const orParts = condition.split("||").map((s) => s.trim());
		return orParts.some((orPart) => {
			const andParts = orPart.split("&&").map((s) => s.trim());
			return andParts.every((expr) => evaluateSingleExpr(expr, request));
		});
	} catch {
		return false; // Invalid condition → skip rule (fail-safe)
	}
}

function evaluateSingleExpr(expr: string, request: ToolRequest): boolean {
	const trimmed = expr.trim();

	// contains(field, "value")
	const containsMatch = trimmed.match(
		/^contains\(\s*([\w.]+)\s*,\s*["']([^"']*)["']\s*\)$/,
	);
	if (containsMatch) {
		const val = resolveField(containsMatch[1]!, request);
		return typeof val === "string" && val.includes(containsMatch[2]!);
	}

	// Comparison: field op value
	const cmpMatch = trimmed.match(
		/^([\w.]+)\s*(==|!=|>=|<=|>|<)\s*(.+)$/,
	);
	if (!cmpMatch) return false;

	const left = resolveField(cmpMatch[1]!, request);
	const op = cmpMatch[2]!;
	const rawRight = cmpMatch[3]!.trim();
	const right = parseValue(rawRight);

	switch (op) {
		case "==": return left === right;
		case "!=": return left !== right;
		case ">": return typeof left === "number" && typeof right === "number" && left > right;
		case "<": return typeof left === "number" && typeof right === "number" && left < right;
		case ">=": return typeof left === "number" && typeof right === "number" && left >= right;
		case "<=": return typeof left === "number" && typeof right === "number" && left <= right;
		default: return false;
	}
}

function resolveField(field: string, request: ToolRequest): string | number | boolean | undefined {
	switch (field) {
		case "request.toolName": return request.toolName;
		case "request.isReadOnly": return request.isReadOnly;
		case "request.isDestructive": return request.isDestructive;
		case "request.turnIndex": return request.turnIndex;
		case "request.toolUseId": return request.toolUseId;
		default: return undefined;
	}
}

function parseValue(raw: string): string | number | boolean {
	// Boolean
	if (raw === "true") return true;
	if (raw === "false") return false;
	// Quoted string
	const strMatch = raw.match(/^["'](.*)["']$/);
	if (strMatch) return strMatch[1]!;
	// Number
	const num = Number(raw);
	if (!Number.isNaN(num)) return num;
	return raw;
}

// ─── Rate Limiter ───────────────────────────────────────────────

const AUDIT_CAP = 10_000;

// ─── Permission Engine ───────────────────────────────────────────

export class PermissionEngine {
	private compiledRules: CompiledRule[];
	readonly config: PermissionConfig;

	// Audit trail
	private auditLog: PermissionAuditRecord[] = [];
	private auditEnabled = true;

	// Rule groups
	private disabledGroups = new Set<string>();

	// Dry-run
	private dryRunMode = false;

	// Rate limiting: key = "pattern:toolName" → timestamps of allowed calls
	private rateBuckets = new Map<string, number[]>();

	constructor(config: PermissionConfig) {
		this.config = config;
		this.compiledRules = [...config.rules]
			.sort((a, b) => b.priority - a.priority)
			.map(compileRule);
	}

	async evaluate(request: ToolRequest): Promise<PermissionDecision> {
		for (const compiled of this.compiledRules) {
			// Skip disabled groups
			if (compiled.rule.group && this.disabledGroups.has(compiled.rule.group)) {
				continue;
			}

			if (!matchCompiled(compiled, request)) continue;

			// Condition check
			if (compiled.rule.condition && !evaluateCondition(compiled.rule.condition, request)) {
				continue;
			}

			// Rate limit check (only for allow rules)
			if (compiled.rule.behavior === "allow" && compiled.rule.rateLimit) {
				if (!this.checkRateLimit(compiled.rule, request)) {
					const decision: PermissionDecision = {
						behavior: "deny",
						reason: `Rate limit exceeded: ${compiled.rule.rateLimit.maxCalls} calls per ${compiled.rule.rateLimit.windowMs}ms`,
						source: `rule:${compiled.rule.source}`,
						matchedRule: compiled.rule,
					};
					this.recordAudit(request, compiled.rule, decision);
					return this.applyDryRun(decision);
				}
			}

			const decision: PermissionDecision = {
				behavior: compiled.rule.behavior,
				reason: compiled.rule.message ?? `Matched rule: ${compiled.rule.pattern}`,
				source: `rule:${compiled.rule.source}`,
				matchedRule: compiled.rule,
				askMessage:
					compiled.rule.behavior === "ask"
						? (compiled.rule.message ?? `Allow ${request.toolName}?`)
						: undefined,
			};
			this.recordAudit(request, compiled.rule, decision);
			return this.applyDryRun(decision);
		}

		const decision = this.defaultDecision(request);
		this.recordAudit(request, null, decision);
		return this.applyDryRun(decision);
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

	// ─── Rule Groups ────────────────────────────────────────────

	enableGroup(group: string): void {
		this.disabledGroups.delete(group);
	}

	disableGroup(group: string): void {
		this.disabledGroups.add(group);
	}

	isGroupEnabled(group: string): boolean {
		return !this.disabledGroups.has(group);
	}

	getGroups(): string[] {
		const groups = new Set<string>();
		for (const c of this.compiledRules) {
			if (c.rule.group) groups.add(c.rule.group);
		}
		return [...groups];
	}

	getRulesByGroup(group: string): ReadonlyArray<PermissionRule> {
		return this.compiledRules
			.filter((c) => c.rule.group === group)
			.map((c) => c.rule);
	}

	// ─── Audit Trail ────────────────────────────────────────────

	setAuditEnabled(enabled: boolean): void {
		this.auditEnabled = enabled;
	}

	getAuditLog(): ReadonlyArray<PermissionAuditRecord> {
		return this.auditLog;
	}

	getAuditForTool(toolName: string): PermissionAuditRecord[] {
		return this.auditLog.filter((r) => r.toolName === toolName);
	}

	clearAuditLog(): void {
		this.auditLog = [];
	}

	// ─── Dry-Run ────────────────────────────────────────────────

	setDryRun(enabled: boolean): void {
		this.dryRunMode = enabled;
	}

	isDryRun(): boolean {
		return this.dryRunMode;
	}

	// ─── Conflict/Shadow Detection ──────────────────────────────

	analyzeRules(): RuleAnalysis {
		const warnings: RuleConflict[] = [];
		const rules = this.compiledRules;

		for (let i = 0; i < rules.length; i++) {
			for (let j = i + 1; j < rules.length; j++) {
				const a = rules[i]!.rule;
				const b = rules[j]!.rule;

				// Conflict: same pattern, same priority, different behavior
				if (a.pattern === b.pattern && a.priority === b.priority && a.behavior !== b.behavior) {
					warnings.push({
						ruleA: a,
						ruleB: b,
						type: "conflict",
						description: `Rules with pattern "${a.pattern}" at priority ${a.priority} have conflicting behaviors: ${a.behavior} vs ${b.behavior}`,
					});
				}

				// Shadow: wildcard at higher priority shadows specific rule
				if (a.priority > b.priority && a.pattern === "*" && a.behavior !== b.behavior) {
					warnings.push({
						ruleA: a,
						ruleB: b,
						type: "shadow",
						description: `Wildcard rule "*" (priority ${a.priority}, ${a.behavior}) shadows "${b.pattern}" (priority ${b.priority}, ${b.behavior})`,
					});
				}

				// Shadow: same tool wildcard at higher priority
				if (a.priority > b.priority && a.behavior !== b.behavior) {
					const aToolWild = a.pattern.match(/^(\w+)\(\*\)$/);
					const bToolPattern = b.pattern.match(/^(\w+)\(.+\)$/);
					if (aToolWild && bToolPattern && aToolWild[1] === bToolPattern[1]) {
						warnings.push({
							ruleA: a,
							ruleB: b,
							type: "shadow",
							description: `"${a.pattern}" (priority ${a.priority}, ${a.behavior}) shadows "${b.pattern}" (priority ${b.priority}, ${b.behavior})`,
						});
					}
				}
			}
		}

		return { conflicts: warnings };
	}

	// ─── Internal ───────────────────────────────────────────────

	private applyDryRun(decision: PermissionDecision): PermissionDecision {
		if (!this.dryRunMode) return decision;
		return {
			...decision,
			behavior: "allow",
			reason: `[dry-run] ${decision.reason}`,
		};
	}

	private recordAudit(
		request: ToolRequest,
		matchedRule: PermissionRule | null,
		decision: PermissionDecision,
	): void {
		if (!this.auditEnabled) return;

		this.auditLog.push({
			toolName: request.toolName,
			serializedInput: serializeInput(request.toolInput),
			matchedRule,
			behavior: decision.behavior,
			reason: decision.reason,
			mode: this.config.mode,
			timestamp: Date.now(),
			dryRun: this.dryRunMode,
		});

		// Bounded — evict oldest when over cap
		if (this.auditLog.length > AUDIT_CAP) {
			this.auditLog = this.auditLog.slice(-AUDIT_CAP);
		}
	}

	private checkRateLimit(rule: PermissionRule, request: ToolRequest): boolean {
		const rl = rule.rateLimit!;
		const key = `${rule.pattern}:${request.toolName}`;
		const now = Date.now();

		let timestamps = this.rateBuckets.get(key);
		if (!timestamps) {
			timestamps = [];
			this.rateBuckets.set(key, timestamps);
		}

		// Evict expired entries
		const windowStart = now - rl.windowMs;
		while (timestamps.length > 0 && timestamps[0]! < windowStart) {
			timestamps.shift();
		}

		if (timestamps.length >= rl.maxCalls) {
			return false; // Rate limited
		}

		timestamps.push(now);
		return true;
	}

	private defaultDecision(request: ToolRequest): PermissionDecision {
		switch (this.config.mode) {
			case "permissive":
				return {
					behavior: "allow",
					reason: "No matching rule (permissive mode)",
					source: "default",
					matchedRule: null,
				};
			case "strict":
				return {
					behavior: "deny",
					reason: "No matching rule (strict mode)",
					source: "default",
					matchedRule: null,
				};
			case "plan":
				return {
					behavior: request.isReadOnly ? "allow" : "deny",
					reason: request.isReadOnly
						? "Read-only allowed in plan mode"
						: "Write operations denied in plan mode",
					source: "default",
					matchedRule: null,
				};
			case "default":
			default:
				return {
					behavior: "ask",
					reason: "No matching rule — asking user",
					source: "default",
					askMessage: `Allow ${request.toolName}?`,
					matchedRule: null,
				};
		}
	}
}
