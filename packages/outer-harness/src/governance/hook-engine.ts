/**
 * HookEngine — Executes automation hooks at lifecycle points.
 *
 * 5 hook types: command, prompt, agent, http, function.
 * Hooks are matched by event type + optional matcher pattern.
 * Executed sequentially with timeout per hook. Results aggregated.
 *
 * Product-grade features:
 * - Function hooks with dynamic import (handler path)
 * - Hook execution metrics (pass/block/modify/error counts, timing)
 * - HTTP hook retry with exponential backoff on 5xx
 */

import { exec } from "node:child_process";
import { promisify } from "node:util";
import { resolve, normalize } from "node:path";
import type {
	HookDefinition,
	HookEvent,
	HookResult,
	HookMetrics,
} from "@agentweave/types";
import { fetchWithRetry } from "../shared/http-retry";

const execAsync = promisify(exec);

export interface HookEngineConfig {
	hooks: Record<string, HookDefinition[]>;
}

export class HookEngine {
	private hooksByEvent = new Map<string, HookDefinition[]>();

	// Metrics
	private metrics: HookMetrics = {
		totalExecutions: 0,
		passCount: 0,
		blockCount: 0,
		modifyCount: 0,
		errorCount: 0,
		totalDurationMs: 0,
		avgDurationMs: 0,
		byEvent: {},
	};

	constructor(config: HookEngineConfig) {
		for (const [eventKey, hooks] of Object.entries(config.hooks)) {
			this.hooksByEvent.set(eventKey, [...hooks]);
		}
	}

	/** Execute all matching hooks for an event. Returns aggregated result. */
	async execute(event: HookEvent): Promise<HookResult> {
		const hooks = this.getMatchingHooks(event);
		if (hooks.length === 0) {
			return { outcome: "pass" };
		}

		const aggregated: HookResult = { outcome: "pass" };

		for (const hook of hooks) {
			const start = performance.now();
			const result = await this.executeSingle(hook, event);
			const elapsed = performance.now() - start;
			this.recordMetrics(event.type, result.outcome, elapsed);

			// Merge result into aggregate
			if (result.outcome === "block") {
				aggregated.outcome = "block";
				aggregated.message = result.message;
				aggregated.stopReason = result.stopReason;
				if (result.permissionDecision) aggregated.permissionDecision = result.permissionDecision;
				break; // Block stops the chain
			}
			if (result.outcome === "modify") {
				aggregated.outcome = "modify";
				if (result.modifiedInput !== undefined) aggregated.modifiedInput = result.modifiedInput;
				if (result.modifiedOutput !== undefined) aggregated.modifiedOutput = result.modifiedOutput;
			}
			if (result.outcome === "error") {
				aggregated.outcome = "error";
				aggregated.message = result.message;
			}
			if (result.permissionDecision) {
				aggregated.permissionDecision = result.permissionDecision;
			}
			if (result.additionalContext) {
				aggregated.additionalContext =
					(aggregated.additionalContext ? `${aggregated.additionalContext}\n` : "") +
					result.additionalContext;
			}
			if (result.preventContinuation) {
				aggregated.preventContinuation = true;
				aggregated.stopReason = result.stopReason;
				break;
			}
		}

		return aggregated;
	}

	/** Register hooks at runtime. */
	addHook(eventType: string, hook: HookDefinition): void {
		const existing = this.hooksByEvent.get(eventType) ?? [];
		existing.push(hook);
		this.hooksByEvent.set(eventType, existing);
	}

	/** Get registered hooks for an event type. */
	getHooks(eventType: string): ReadonlyArray<HookDefinition> {
		return this.hooksByEvent.get(eventType) ?? [];
	}

	/** Get execution metrics. */
	getMetrics(): HookMetrics {
		return { ...this.metrics, byEvent: { ...this.metrics.byEvent } };
	}

	// ─── Internal ────────────────────────────────────────────────

	private getMatchingHooks(event: HookEvent): HookDefinition[] {
		const hooks = this.hooksByEvent.get(event.type) ?? [];

		return hooks.filter((hook) => {
			// Check matcher pattern (if specified)
			if (hook.matcher && event.toolName) {
				if (!this.matchesPattern(hook.matcher, event.toolName)) {
					return false;
				}
			}
			return true;
		});
	}

	private matchesPattern(matcher: string, toolName: string): boolean {
		// Support pipe-separated matchers: "Write|Edit"
		const patterns = matcher.split("|");
		return patterns.some((p) => {
			const trimmed = p.trim();
			if (trimmed === "*") return true;
			return toolName === trimmed || toolName.startsWith(trimmed);
		});
	}

	private async executeSingle(
		hook: HookDefinition,
		event: HookEvent,
	): Promise<HookResult> {
		const timeout = hook.timeout ?? 30_000;
		let timer: ReturnType<typeof setTimeout> | undefined;

		try {
			const result = await Promise.race([
				this.dispatch(hook, event),
				new Promise<HookResult>((_, reject) => {
					timer = setTimeout(
						() => reject(new Error(`Hook timeout (${timeout}ms)`)),
						timeout,
					);
				}),
			]);
			return result;
		} catch (err) {
			return {
				outcome: "error",
				message: err instanceof Error ? err.message : "Hook execution error",
			};
		} finally {
			if (timer !== undefined) clearTimeout(timer);
		}
	}

	private async dispatch(
		hook: HookDefinition,
		event: HookEvent,
	): Promise<HookResult> {
		switch (hook.type) {
			case "command":
				return this.executeCommandHook(hook, event);
			case "function":
				return this.executeFunctionHook(hook, event);
			case "http":
				return this.executeHttpHook(hook, event);
			case "prompt":
				return this.executePromptHook(hook, event);
			case "agent":
				return this.executeAgentHook(hook, event);
		}
	}

	private async executeCommandHook(
		hook: Extract<HookDefinition, { type: "command" }>,
		event: HookEvent,
	): Promise<HookResult> {
		// SECURITY: Only pass safe env vars to hook shell.
		const env = buildSafeEnv();
		env.TOOL_NAME = event.toolName ?? "";
		env.TOOL_INPUT = JSON.stringify(event.toolInput ?? {});
		env.TOOL_USE_ID = event.toolUseId ?? "";
		env.SESSION_ID = event.sessionId ?? "";

		try {
			const shellOpt =
				hook.shell === "powershell"
					? "powershell"
					: process.platform === "win32"
						? "cmd.exe"
						: "/bin/bash";

			const { stdout, stderr } = await execAsync(hook.command, {
				timeout: hook.timeout ?? 30_000,
				env,
				shell: shellOpt,
			});

			return this.parseHookOutput(stdout.trim(), stderr.trim());
		} catch (err) {
			const message = err instanceof Error ? err.message : "Command hook failed";
			return { outcome: "error", message };
		}
	}

	private async executeFunctionHook(
		hook: Extract<HookDefinition, { type: "function" }>,
		event: HookEvent,
	): Promise<HookResult> {
		if (hook.inline) {
			// SECURITY: new Function() executes arbitrary code.
			// Require explicit trusted flag — reject unsigned inline hooks.
			if (!(hook as unknown as Record<string, unknown>).trusted) {
				return {
					outcome: "error",
					message: `Inline function hook blocked: "trusted: true" required. ` +
						"Set trusted flag only for hooks from verified sources (user config).",
				};
			}

			if (typeof hook.inline !== "string" || hook.inline.trim().length === 0) {
				return { outcome: "error", message: "Inline function hook has empty code" };
			}

			try {
				const fn = new Function("input", "output", "event", hook.inline) as (
					input: unknown,
					output: unknown,
					event: HookEvent,
				) => unknown;

				const result = await fn(event.toolInput, event.toolResult, event);
				return this.normalizeFunctionResult(result);
			} catch (err) {
				return {
					outcome: "error",
					message: err instanceof Error ? err.message : "Inline function error",
				};
			}
		}

		// Handler path — dynamic import
		if (hook.handler) {
			return this.executeFunctionHandlerHook(hook.handler, event);
		}

		return { outcome: "pass" };
	}

	private async executeFunctionHandlerHook(
		handlerPath: string,
		event: HookEvent,
	): Promise<HookResult> {
		// SECURITY: validate path — reject traversal, require .js/.ts extension
		const error = validateHandlerPath(handlerPath);
		if (error) {
			return { outcome: "error", message: error };
		}

		try {
			const absPath = resolve(handlerPath);
			const mod = await import(absPath);
			const fn = mod.default ?? mod;

			if (typeof fn !== "function") {
				return { outcome: "error", message: `Handler at "${handlerPath}" does not export a function` };
			}

			const result = await fn(event.toolInput, event.toolResult, event);
			return this.normalizeFunctionResult(result);
		} catch (err) {
			return {
				outcome: "error",
				message: err instanceof Error ? err.message : `Failed to import handler: ${handlerPath}`,
			};
		}
	}

	private normalizeFunctionResult(result: unknown): HookResult {
		if (!result || typeof result !== "object") return { outcome: "pass" };
		const obj = result as Record<string, unknown>;

		if ("decision" in obj) {
			const decision = obj.decision;
			if (decision === "deny" || decision === "block") {
				return {
					outcome: "block",
					permissionDecision: "deny",
					message: typeof obj.reason === "string" ? obj.reason : undefined,
				};
			}
			return { outcome: "pass" };
		}

		// Validate outcome field before trusting
		if ("outcome" in obj) {
			const outcome = obj.outcome;
			if (outcome === "pass" || outcome === "block" || outcome === "modify" || outcome === "error") {
				return {
					outcome,
					message: typeof obj.message === "string" ? obj.message : undefined,
					additionalContext: typeof obj.additionalContext === "string" ? obj.additionalContext : undefined,
					stopReason: typeof obj.stopReason === "string" ? obj.stopReason : undefined,
					permissionDecision: obj.permissionDecision === "allow" || obj.permissionDecision === "deny"
						? obj.permissionDecision : undefined,
				};
			}
		}

		return { outcome: "pass" };
	}

	private async executeHttpHook(
		hook: Extract<HookDefinition, { type: "http" }>,
		event: HookEvent,
	): Promise<HookResult> {
		const body = JSON.stringify({
			event: event.type,
			toolName: event.toolName,
			toolInput: event.toolInput,
			sessionId: event.sessionId,
		});

		const result = await fetchWithRetry(
			hook.url,
			{
				method: (hook.method as string) ?? "POST",
				headers: {
					"Content-Type": "application/json",
					...(hook.headers ?? {}),
				},
				body,
			},
			{
				maxRetries: hook.retries ?? 0,
				timeoutMs: hook.timeout ?? 10_000,
			},
		);

		if (result.ok) {
			const text = await result.response.text();
			return this.parseHookOutput(text, "");
		}

		return { outcome: "error", message: result.error };
	}

	private async executePromptHook(
		_hook: Extract<HookDefinition, { type: "prompt" }>,
		_event: HookEvent,
	): Promise<HookResult> {
		// TODO: Requires LLM caller — defer until real provider is wired
		return { outcome: "pass", additionalContext: "Prompt hook skipped (no LLM provider in MVP)" };
	}

	private async executeAgentHook(
		_hook: Extract<HookDefinition, { type: "agent" }>,
		_event: HookEvent,
	): Promise<HookResult> {
		// TODO: Requires agent spawning — defer until Phase 4
		return { outcome: "pass", additionalContext: "Agent hook skipped (not available in MVP)" };
	}

	/** Parse hook stdout — try JSON first, fall back to plain text. */
	private parseHookOutput(stdout: string, stderr: string): HookResult {
		if (!stdout && !stderr) return { outcome: "pass" };

		// Try JSON parse
		try {
			const raw: unknown = JSON.parse(stdout);
			if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
				return { outcome: "pass", additionalContext: stdout };
			}
			const parsed = raw as Record<string, unknown>;

			const result: HookResult = { outcome: "pass" };

			if (parsed.continue === false || parsed.decision === "block") {
				result.outcome = "block";
				result.stopReason = typeof parsed.stopReason === "string" ? parsed.stopReason
					: typeof parsed.reason === "string" ? parsed.reason : undefined;
			}
			if (parsed.decision === "deny") {
				result.permissionDecision = "deny";
				result.outcome = "block";
			}
			if (parsed.decision === "allow") {
				result.permissionDecision = "allow";
			}
			if (typeof parsed.systemMessage === "string") {
				result.additionalContext = parsed.systemMessage;
			}
			if (typeof parsed.message === "string") {
				result.message = parsed.message;
			}

			return result;
		} catch {
			// Not JSON — treat as plain text context
			return {
				outcome: "pass",
				additionalContext: stdout || undefined,
				message: stderr || undefined,
			};
		}
	}

	// ─── Metrics ─────────────────────────────────────────────────

	private recordMetrics(eventType: string, outcome: string, durationMs: number): void {
		this.metrics.totalExecutions++;
		this.metrics.totalDurationMs += durationMs;
		this.metrics.avgDurationMs = this.metrics.totalDurationMs / this.metrics.totalExecutions;

		switch (outcome) {
			case "pass": this.metrics.passCount++; break;
			case "block": this.metrics.blockCount++; break;
			case "modify": this.metrics.modifyCount++; break;
			case "error": this.metrics.errorCount++; break;
		}

		const byEvent = this.metrics.byEvent[eventType];
		if (byEvent) {
			byEvent.count++;
			byEvent.durationMs += durationMs;
		} else {
			this.metrics.byEvent[eventType] = { count: 1, durationMs };
		}
	}
}

// ─── Handler Path Validation ─────────────────────────────────────

function validateHandlerPath(handlerPath: string): string | null {
	const normalized = normalize(handlerPath);

	// Reject path traversal
	if (normalized.includes("..")) {
		return `Handler path rejected: path traversal detected in "${handlerPath}"`;
	}

	// Require .js or .ts extension
	if (!normalized.endsWith(".js") && !normalized.endsWith(".ts") && !normalized.endsWith(".mjs")) {
		return `Handler path rejected: must end in .js, .ts, or .mjs ("${handlerPath}")`;
	}

	return null;
}

// ─── Safe Environment Filtering ─────────────────────────────────

const ENV_SAFE_KEYS = new Set([
	"PATH", "HOME", "USER", "SHELL", "LANG", "TERM", "EDITOR",
	"TMPDIR", "TMP", "TEMP", "PWD", "HOSTNAME", "LOGNAME",
	"NODE_ENV", "CI",
]);

const ENV_SECRET_PATTERNS = [
	/_KEY$/i, /_SECRET$/i, /_TOKEN$/i, /_PASSWORD$/i, /_CREDENTIAL$/i,
	/^API_/, /^AWS_/, /^GITHUB_TOKEN/, /^ANTHROPIC_/,
];

function buildSafeEnv(): Record<string, string> {
	const env: Record<string, string> = {};
	for (const [k, v] of Object.entries(process.env)) {
		if (v === undefined) continue;
		if (ENV_SAFE_KEYS.has(k)) {
			env[k] = v;
			continue;
		}
		if (ENV_SECRET_PATTERNS.some((p) => p.test(k))) continue;
		env[k] = v;
	}
	return env;
}
