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
import type { PermissionContext } from "./permission-context";
import { buildPermissionContext } from "./permission-context";

// ─── Safety bounds (P2.2 §2.5) ───────────────────────────────────

const MAX_CONDITION_LEN = 512;
const MAX_REGEX_LEN = 256;
const MAX_FIELD_DEPTH = 4;
/**
 * Per-field value length cap when feeding a resolved context value into
 * `matches()`, `pathMatches()`, or `contains()`. Caps ReDoS blast radius
 * against user-supplied regexes — the pattern is bounded by MAX_REGEX_LEN
 * but the subject string (e.g. `request.toolInput.command`) is not.
 * Strings longer than this cap are treated as a non-match (fail-safe).
 */
const MAX_FIELD_VALUE_LEN = 8192;

// ─── Compiled Rule ───────────────────────────────────────────────

interface CompiledRule {
	rule: PermissionRule;
	matchType: "wildcard" | "exact_tool" | "tool_wildcard_arg" | "tool_pattern_arg";
	toolName?: string;
	argRegex?: RegExp;
	/** Pre-parsed condition; null = no condition; "invalid" = rule dropped. */
	condition: CompiledCondition | null | "invalid";
}

function compileRule(rule: PermissionRule): CompiledRule {
	const pattern = rule.pattern;
	const condition = compileCondition(rule.condition);

	// "*" — matches everything
	if (pattern === "*") {
		return { rule, matchType: "wildcard", condition };
	}

	const parenIdx = pattern.indexOf("(");

	// "Bash" — exact tool name, no arg constraint
	if (parenIdx === -1) {
		return { rule, matchType: "exact_tool", toolName: pattern, condition };
	}

	const toolName = pattern.slice(0, parenIdx);
	const argPattern = pattern.slice(parenIdx + 1, -1);

	// "Bash(*)" — any arg
	if (argPattern === "*") {
		return { rule, matchType: "tool_wildcard_arg", toolName, condition };
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
		condition,
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

/**
 * Scrub common secret shapes from a serialized input string before it enters
 * the engine's audit buffer. The buffer is in-memory today, but `getAuditLog()`
 * is public — any consumer that flushes it to disk inherits these redactions.
 * Applied ONLY in `recordAudit`; `matchCompiled` continues to use the raw.
 */
function redactForAudit(s: string): string {
	return s
		// OpenAI / Anthropic-style API keys — `sk-` / `sk-ant-` prefix, 20+ tail chars
		.replace(/sk-(ant-)?[A-Za-z0-9_-]{20,}/g, "sk-***")
		// Bearer tokens in headers or env-like strings
		.replace(/Bearer\s+[A-Za-z0-9._-]{16,}/gi, "Bearer ***")
		// Inline password=, token=, secret=, apikey= assignments
		.replace(/(password|token|secret|api[_-]?key)\s*=\s*["']?[^"'\s]+["']?/gi, "$1=***");
}

// ─── Condition Compiler + Evaluator (safe mini-DSL, NO eval) ────

/**
 * Supported context fields (dot-paths on PermissionContext):
 *  - request.*      (toolName, toolInput.<key>, isReadOnly, isDestructive, turnIndex, toolUseId)
 *  - session.*      (sessionId, agentId, userId, projectId, model, cwd) — set via onSessionStart
 *  - time.*         (hour, minute, weekday, iso, epochMs) — server clock
 *  - env.<VAR>      (only vars in PermissionConfig.envAllowlist — others resolve to undefined)
 *
 * Operators: ==, !=, >, <, >=, <=, contains(f, "s"), matches(f, /re/flags), pathMatches(f, "glob")
 * Logical:   &&, ||    (|| has lowest precedence; left-to-right within each group)
 *
 * Fail-safe: any parse failure, length-cap violation, or unresolvable field
 * causes the containing expression to evaluate `false` — the rule is skipped,
 * not crashed.
 */

type CompiledExpr =
	| { kind: "contains"; field: string; value: string }
	| { kind: "matches"; field: string; regex: RegExp }
	| { kind: "pathMatches"; field: string; glob: RegExp; negate: boolean }
	| {
			kind: "cmp";
			field: string;
			op: "==" | "!=" | ">" | "<" | ">=" | "<=";
			value: string | number | boolean;
	  }
	| { kind: "invalid" };

interface CompiledCondition {
	/** OR-of-ANDs (disjunctive normal form over the two logical ops). */
	orGroups: CompiledExpr[][];
}

/** Compile a condition string to its DNF form. Returns null for no condition,
 *  "invalid" for a condition that violates length caps or fails to parse. */
function compileCondition(
	condition: string | undefined,
): CompiledCondition | null | "invalid" {
	if (!condition) return null;
	if (condition.length > MAX_CONDITION_LEN) return "invalid";

	try {
		const orParts = splitLogical(condition, "||").map((s) => s.trim());
		const orGroups: CompiledExpr[][] = [];
		for (const orPart of orParts) {
			const andParts = splitLogical(orPart, "&&").map((s) => s.trim());
			const andExprs = andParts.map(compileExpr);
			orGroups.push(andExprs);
		}
		return { orGroups };
	} catch {
		return "invalid";
	}
}

/**
 * Split `str` by the 2-char operator `op` (`&&` or `||`), IGNORING occurrences
 * that fall inside `/.../flags` regex literals or `"..."` / `'...'` string
 * literals. Prevents rules like `matches(x, /a||b/)` from being mangled by a
 * naive top-level split.
 */
function splitLogical(str: string, op: "&&" | "||"): string[] {
	const out: string[] = [];
	let start = 0;
	let i = 0;
	// State: 'normal' | 'in-string-single' | 'in-string-double' | 'in-regex'
	let state: "normal" | "s1" | "s2" | "re" = "normal";
	while (i < str.length) {
		const c = str[i]!;
		const prev = i > 0 ? str[i - 1] : "";
		if (state === "normal") {
			if (c === "'") state = "s1";
			else if (c === '"') state = "s2";
			else if (c === "/") state = "re";
			else if (c === op[0] && str[i + 1] === op[1]) {
				out.push(str.slice(start, i));
				i += 2;
				start = i;
				continue;
			}
		} else if (state === "s1") {
			if (c === "'" && prev !== "\\") state = "normal";
		} else if (state === "s2") {
			if (c === '"' && prev !== "\\") state = "normal";
		} else if (state === "re") {
			if (c === "/" && prev !== "\\") state = "normal";
		}
		i++;
	}
	out.push(str.slice(start));
	return out;
}

function compileExpr(raw: string): CompiledExpr {
	const expr = raw.trim();

	// matches(field, /pattern/flags) — flags: i, m, s (no g)
	const matchesMatch = expr.match(
		/^matches\(\s*([\w.]+)\s*,\s*\/(.+)\/([ims]*)\s*\)$/,
	);
	if (matchesMatch) {
		const [, field, pattern, flags] = matchesMatch;
		if (!field || !pattern) return { kind: "invalid" };
		if (pattern.length > MAX_REGEX_LEN) return { kind: "invalid" };
		try {
			return { kind: "matches", field, regex: new RegExp(pattern, flags) };
		} catch {
			return { kind: "invalid" };
		}
	}

	// pathMatches(field, "glob") — leading "!" in glob = negation
	const pathMatch = expr.match(
		/^pathMatches\(\s*([\w.]+)\s*,\s*["']([^"']*)["']\s*\)$/,
	);
	if (pathMatch) {
		const [, field, rawGlob] = pathMatch;
		if (!field || rawGlob === undefined) return { kind: "invalid" };
		const negate = rawGlob.startsWith("!");
		const glob = negate ? rawGlob.slice(1) : rawGlob;
		if (glob.length > MAX_REGEX_LEN) return { kind: "invalid" };
		const regex = compileGlob(glob);
		if (!regex) return { kind: "invalid" };
		return { kind: "pathMatches", field, glob: regex, negate };
	}

	// contains(field, "value")
	const containsMatch = expr.match(
		/^contains\(\s*([\w.]+)\s*,\s*["']([^"']*)["']\s*\)$/,
	);
	if (containsMatch) {
		const [, field, value] = containsMatch;
		if (!field || value === undefined) return { kind: "invalid" };
		return { kind: "contains", field, value };
	}

	// Comparison: field op value
	const cmpMatch = expr.match(/^([\w.]+)\s*(==|!=|>=|<=|>|<)\s*(.+)$/);
	if (!cmpMatch) return { kind: "invalid" };
	const [, field, op, rawRight] = cmpMatch;
	if (!field || !op) return { kind: "invalid" };
	return {
		kind: "cmp",
		field,
		op: op as "==" | "!=" | ">" | "<" | ">=" | "<=",
		value: parseValue(rawRight!.trim()),
	};
}

/** Glob → anchored RegExp. Supports `**` (cross-slash), `*` (non-slash), `?` (single non-slash). */
function compileGlob(glob: string): RegExp | null {
	try {
		// Escape regex specials, then re-introduce glob semantics with placeholders.
		const DOUBLESTAR = "\u0000DS\u0000";
		const STAR = "\u0000S\u0000";
		const QMARK = "\u0000Q\u0000";
		let pattern = glob
			.replace(/\*\*/g, DOUBLESTAR)
			.replace(/\*/g, STAR)
			.replace(/\?/g, QMARK)
			.replace(/[.+^${}()|[\]\\]/g, "\\$&")
			.replace(new RegExp(DOUBLESTAR, "g"), ".*")
			.replace(new RegExp(STAR, "g"), "[^/]*")
			.replace(new RegExp(QMARK, "g"), "[^/]");
		// `src/**` should also match exactly `src` — allow trailing `/.*` to be optional.
		pattern = pattern.replace(/\/\.\*$/, "(/.*)?");
		return new RegExp(`^${pattern}$`);
	} catch {
		return null;
	}
}

function evaluateCondition(
	compiled: CompiledCondition,
	ctx: PermissionContext,
): boolean {
	return compiled.orGroups.some((andGroup) =>
		andGroup.every((expr) => evaluateExpr(expr, ctx)),
	);
}

function evaluateExpr(expr: CompiledExpr, ctx: PermissionContext): boolean {
	switch (expr.kind) {
		case "invalid":
			return false;
		case "contains": {
			const v = resolveField(expr.field, ctx);
			if (typeof v !== "string" || v.length > MAX_FIELD_VALUE_LEN) return false;
			return v.includes(expr.value);
		}
		case "matches": {
			const v = resolveField(expr.field, ctx);
			if (typeof v !== "string" || v.length > MAX_FIELD_VALUE_LEN) return false;
			return expr.regex.test(v);
		}
		case "pathMatches": {
			const v = resolveField(expr.field, ctx);
			if (typeof v !== "string" || v.length > MAX_FIELD_VALUE_LEN) return false;
			const normalized = normalizePosix(v);
			const hit = expr.glob.test(normalized);
			return expr.negate ? !hit : hit;
		}
		case "cmp": {
			const left = resolveField(expr.field, ctx);
			const right = expr.value;
			switch (expr.op) {
				case "==": return left === right;
				case "!=": return left !== right;
				case ">":
					return (
						typeof left === "number" && typeof right === "number" && left > right
					);
				case "<":
					return (
						typeof left === "number" && typeof right === "number" && left < right
					);
				case ">=":
					return (
						typeof left === "number" &&
						typeof right === "number" &&
						left >= right
					);
				case "<=":
					return (
						typeof left === "number" &&
						typeof right === "number" &&
						left <= right
					);
			}
		}
	}
}

/** Dot-path walker. Returns primitive leaves only; non-primitive → undefined. */
function resolveField(
	field: string,
	ctx: PermissionContext,
): string | number | boolean | undefined {
	const parts = field.split(".");
	if (parts.length > MAX_FIELD_DEPTH) return undefined;
	let cur: unknown = ctx;
	for (const part of parts) {
		if (cur == null || typeof cur !== "object") return undefined;
		cur = (cur as Record<string, unknown>)[part];
	}
	if (typeof cur === "string" || typeof cur === "number" || typeof cur === "boolean") {
		return cur;
	}
	return undefined;
}

/** Normalize a POSIX-style path without resolving against cwd.
 *  Collapses `//`, `.`, and interior `..` segments but preserves leading `..`. */
function normalizePosix(p: string): string {
	const isAbs = p.startsWith("/");
	const segs = p.split(/[\\/]+/);
	const out: string[] = [];
	for (const seg of segs) {
		if (seg === "" || seg === ".") continue;
		if (seg === "..") {
			if (out.length > 0 && out[out.length - 1] !== "..") out.pop();
			else if (!isAbs) out.push("..");
		} else {
			out.push(seg);
		}
	}
	const joined = out.join("/");
	return isAbs ? "/" + joined : joined || ".";
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

	async evaluate(
		request: ToolRequest,
		context?: PermissionContext,
	): Promise<PermissionDecision> {
		const ctx = context ?? buildPermissionContext(request, {
			envAllowlist: this.config.envAllowlist,
		});

		for (const compiled of this.compiledRules) {
			// Skip disabled groups
			if (compiled.rule.group && this.disabledGroups.has(compiled.rule.group)) {
				continue;
			}

			if (!matchCompiled(compiled, request)) continue;

			// Condition check — precompiled at rule-compile time.
			if (compiled.condition === "invalid") continue;
			if (compiled.condition && !evaluateCondition(compiled.condition, ctx)) {
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
			serializedInput: redactForAudit(serializeInput(request.toolInput)),
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
