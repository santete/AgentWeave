/**
 * `agentweave guard pre-tool-use|post-tool-use` — `.claude/hooks/` backend.
 *
 * Reads a Claude Code hook payload from stdin, runs it through Outer Harness
 * (PermissionEngine + BudgetManager + audit log), and emits a decision on
 * stdout. Exit code 2 = block (per Claude Code contract).
 *
 * Pre-hook = fail-closed: crash, malformed JSON, schema failure, and empty
 * stdin all return exit 2 with `{decision:"block"}`. Post-hook = fail-open
 * (crash → 0) so a tool that already ran cannot be un-run by a hook bug.
 * The process is short-lived per invocation; all state lives on disk.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import {
	BudgetManager,
	buildPermissionContext,
	PermissionEngine,
} from "@agentweave/outer-harness";
import {
	GuardConfigSchema,
	HookInputSchema,
	type GuardConfig,
	type GuardDecision,
	type HookInput,
	type PermissionConfig,
	type PermissionRule,
	type ToolRequest,
} from "@agentweave/types";

export type GuardPhase = "pre" | "post";

const CONFIG_FILENAMES = [
	".agentweave/guard.json",
	".agentweave/guard.yaml",
	".agentweave/guard.yml",
];

// Tools whose result is observable without side effects — allowed even in strict
// mode when no rule matches. Kept minimal; users override via config.
const READ_ONLY_TOOLS = new Set(["Read", "Glob", "Grep", "LS", "NotebookRead"]);

// Heuristic: which tools write state?
const DESTRUCTIVE_TOOLS = new Set(["Bash", "Write", "Edit", "NotebookEdit"]);

// ─── Public API ──────────────────────────────────────────────────

/**
 * Run the guard for a hook phase. Reads stdin, writes decision to stdout,
 * and returns the exit code the caller should use.
 */
export async function runGuard(phase: GuardPhase, cwd = process.cwd()): Promise<number> {
	try {
		const raw = await readStdin();
		if (!raw.trim()) {
			return earlyExit(phase, "empty hook payload");
		}

		const parsedJson = safeJsonParse(raw);
		if (!parsedJson) {
			return earlyExit(phase, "malformed hook payload: not valid JSON");
		}

		const hookResult = HookInputSchema.safeParse(parsedJson);
		if (!hookResult.success) {
			return earlyExit(phase, "malformed hook payload: schema validation failed");
		}
		const hook = hookResult.data;

		const config = loadGuardConfig(cwd);

		if (phase === "pre") {
			return await handlePre(hook, config, cwd);
		}
		return await handlePost(hook, config, cwd);
	} catch (err) {
		writeStderr(`[agentweave guard ${phase}] ${errorMessage(err)}`);
		return phase === "pre" ? 2 : 0; // fail-closed pre, fail-open post
	}
}

// ─── Pre-tool-use ────────────────────────────────────────────────

async function handlePre(hook: HookInput, config: GuardConfig, cwd: string): Promise<number> {
	const engine = buildPermissionEngine(config);
	const request = toToolRequest(hook);
	// Build context so rules using `session.*` / `env.*` resolve (P2.2 DSL).
	// Session info is whatever Claude Code hands us in the hook payload —
	// agents cannot forge this path since Claude Code owns the stdin pipe.
	const ctx = buildPermissionContext(request, {
		session: {
			sessionId: hook.session_id,
			cwd: hook.cwd ?? cwd,
		},
		envAllowlist: config.envAllowlist,
	});
	const decision = await engine.evaluate(request, ctx);

	// Budget pre-check only when we have limits
	if (config.budget && (config.budget.maxPerSession || config.budget.maxPerDay)) {
		const budget = buildBudgetManager(config, cwd);
		const est = budget.estimateCost(config.budget.costPerToolCall);
		if (est.wouldExceedSession || est.wouldExceedDaily) {
			const reason = est.wouldExceedSession
				? "Session budget would be exceeded"
				: "Daily budget would be exceeded";
			writeAudit(config, cwd, {
				phase: "pre",
				tool: hook.tool_name,
				decision: "block",
				reason,
				session_id: hook.session_id,
			});
			emit({ decision: "block", reason });
			return 2;
		}
	}

	if (decision.behavior === "allow") {
		writeAudit(config, cwd, {
			phase: "pre",
			tool: hook.tool_name,
			decision: "approve",
			reason: decision.reason,
			matched: decision.matchedRule?.pattern,
			source: decision.matchedRule?.source,
			immutable: decision.matchedRule?.immutable === true ? true : undefined,
			session_id: hook.session_id,
		});
		emit({ decision: "approve", reason: decision.reason });
		return 0;
	}

	// deny or ask → block. Ask surfaces as block with a reason so the user
	// can edit config or rerun; Claude Code does not have an "ask" return.
	const reason =
		decision.behavior === "ask"
			? (decision.askMessage ?? decision.reason)
			: decision.reason;
	writeAudit(config, cwd, {
		phase: "pre",
		tool: hook.tool_name,
		decision: "block",
		reason,
		matched: decision.matchedRule?.pattern,
		source: decision.matchedRule?.source,
		immutable: decision.matchedRule?.immutable === true ? true : undefined,
		session_id: hook.session_id,
	});
	emit({ decision: "block", reason });
	return 2;
}

// ─── Post-tool-use ───────────────────────────────────────────────

async function handlePost(hook: HookInput, config: GuardConfig, cwd: string): Promise<number> {
	// Record cost if budget configured
	if (config.budget && config.budget.costPerToolCall > 0) {
		const budget = buildBudgetManager(config, cwd);
		budget.addCost(config.budget.costPerToolCall, { toolName: hook.tool_name });
		budget.flush();
	}

	writeAudit(config, cwd, {
		phase: "post",
		tool: hook.tool_name,
		session_id: hook.session_id,
	});

	// Post hook does not block by default; emit empty object so Claude Code
	// does not interpret stray bytes.
	emit({ decision: "approve" });
	return 0;
}

// ─── Config loader ───────────────────────────────────────────────

export function loadGuardConfig(cwd: string): GuardConfig {
	for (const rel of CONFIG_FILENAMES) {
		const abs = resolve(cwd, rel);
		if (!existsSync(abs)) continue;
		const raw = readFileSync(abs, "utf-8");
		const parsed = parseConfigText(raw);
		if (!parsed) continue;
		const result = GuardConfigSchema.safeParse(parsed);
		if (result.success) return result.data;
	}
	return GuardConfigSchema.parse({});
}

function parseConfigText(raw: string): unknown {
	// JSON first (YAML is a JSON superset); most reliable.
	const json = safeJsonParse(raw);
	if (json) return json;
	// Ultra-minimal YAML fallback: strip comments + JSON parse attempt.
	const stripped = raw
		.split("\n")
		.filter((l) => !l.trim().startsWith("#"))
		.join("\n");
	return safeJsonParse(stripped);
}

// ─── Builders ────────────────────────────────────────────────────

function buildPermissionEngine(config: GuardConfig): PermissionEngine {
	const rules: PermissionRule[] = config.permissions.map((r) => ({
		pattern: r.pattern,
		behavior: r.behavior,
		priority: r.priority,
		source: "project",
		message: r.message,
		group: r.group,
	}));

	const permissionConfig: PermissionConfig = {
		mode: config.mode,
		rules,
		failMode: "closed",
		timeoutMs: 5_000,
		askTimeoutMs: 60_000,
		envAllowlist: config.envAllowlist,
	};
	return new PermissionEngine(permissionConfig);
}

function buildBudgetManager(config: GuardConfig, cwd: string): BudgetManager {
	const b = config.budget!;
	const persistPath = isAbsolute(b.persistPath) ? b.persistPath : resolve(cwd, b.persistPath);
	const manager = new BudgetManager({
		maxPerSession: b.maxPerSession,
		maxPerDay: b.maxPerDay,
		warningThreshold: b.warningThreshold,
		persistPath,
	});
	manager.loadPersistedState();
	return manager;
}

function toToolRequest(hook: HookInput): ToolRequest {
	return {
		toolName: hook.tool_name,
		toolInput: hook.tool_input,
		toolUseId: String(hook.session_id ?? "guard"),
		turnIndex: 0,
		isReadOnly: READ_ONLY_TOOLS.has(hook.tool_name),
		isDestructive: DESTRUCTIVE_TOOLS.has(hook.tool_name),
	};
}

// ─── Audit writer ────────────────────────────────────────────────

/**
 * Scrub common secret shapes out of any string that's about to be persisted.
 * Mirrors `redactForAudit` in outer-harness/permission-engine — the guard
 * writes to disk directly so redaction must happen here, not only in memory.
 * Applied per-field (string values in the entry object) right before serialize.
 */
function redactForAudit(s: string): string {
	return s
		.replace(/sk-(ant-)?[A-Za-z0-9_-]{20,}/g, "sk-***")
		.replace(/Bearer\s+[A-Za-z0-9._-]{16,}/gi, "Bearer ***")
		.replace(/(password|token|secret|api[_-]?key)\s*=\s*["']?[^"'\s]+["']?/gi, "$1=***");
}

function redactEntry(entry: Record<string, unknown>): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(entry)) {
		out[k] = typeof v === "string" ? redactForAudit(v) : v;
	}
	return out;
}

function writeAudit(config: GuardConfig, cwd: string, entry: Record<string, unknown>): void {
	if (!config.audit.enabled) return;
	const path = isAbsolute(config.audit.path) ? config.audit.path : resolve(cwd, config.audit.path);
	try {
		mkdirSync(dirname(path), { recursive: true });
		const redacted = redactEntry(entry);
		const line = JSON.stringify({ ts: new Date().toISOString(), ...redacted }) + "\n";
		appendFileSync(path, line, "utf-8");
	} catch {
		// Best-effort; audit failure must not brick the agent.
	}
}

// ─── IO helpers ──────────────────────────────────────────────────

function readStdin(): Promise<string> {
	return new Promise((resolvePromise, rejectPromise) => {
		let data = "";
		// Non-TTY stdin — Claude Code pipes JSON in.
		if (process.stdin.isTTY) {
			resolvePromise("");
			return;
		}
		process.stdin.setEncoding("utf-8");
		process.stdin.on("data", (chunk) => {
			data += chunk;
		});
		process.stdin.on("end", () => resolvePromise(data));
		process.stdin.on("error", rejectPromise);
	});
}

function emit(decision: GuardDecision): void {
	process.stdout.write(JSON.stringify(decision));
}

function writeStderr(msg: string): void {
	process.stderr.write(msg.endsWith("\n") ? msg : `${msg}\n`);
}

function safeJsonParse(raw: string): unknown {
	try {
		return JSON.parse(raw);
	} catch {
		return null;
	}
}

function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

/**
 * Pre-hook fail-closed, post-hook fail-open. Used for invalid-input paths
 * (empty stdin, malformed JSON, schema failure). Crash paths are handled
 * by the `catch` block in runGuard itself.
 */
function earlyExit(phase: GuardPhase, reason: string): number {
	if (phase === "pre") {
		emit({ decision: "block", reason });
		return 2;
	}
	emit({ decision: "approve" });
	return 0;
}
