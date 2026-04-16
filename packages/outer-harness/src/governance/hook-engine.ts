/**
 * HookEngine — Executes automation hooks at lifecycle points.
 *
 * 5 hook types: command, prompt, agent, http, function.
 * Hooks are matched by event type + optional matcher pattern.
 * Executed sequentially with timeout per hook. Results aggregated.
 */

import { exec } from "node:child_process";
import { promisify } from "node:util";
import type {
	HookDefinition,
	HookEvent,
	HookResult,
} from "@agentweave/types";

const execAsync = promisify(exec);

export interface HookEngineConfig {
	hooks: Record<string, HookDefinition[]>;
}

export class HookEngine {
	private hooksByEvent = new Map<string, HookDefinition[]>();

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
			const result = await this.executeSingle(hook, event);

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
		const env: Record<string, string> = {};
		for (const [k, v] of Object.entries(process.env)) {
			if (v !== undefined) env[k] = v;
		}
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
			try {
				// SECURITY: new Function() executes arbitrary code from config.
				// Only enable function hooks from trusted sources (user config).
				// Phase 5 will add trust dialog + sandbox isolation for project-level hooks.
				const fn = new Function("input", "output", "event", hook.inline) as (
					input: unknown,
					output: unknown,
					event: HookEvent,
				) => HookResult | { decision: string } | Promise<unknown> | undefined;

				// Await in case inline code returns a Promise
				const result = await fn(event.toolInput, event.toolResult, event);
				if (!result || typeof result !== "object") return { outcome: "pass" };

				// Normalize decision-style return
				const obj = result as Record<string, unknown>;
				if ("decision" in obj) {
					if (obj.decision === "deny" || obj.decision === "block") {
						return { outcome: "block", permissionDecision: "deny", message: obj.reason as string | undefined };
					}
					return { outcome: "pass" };
				}
				return result as HookResult;
			} catch (err) {
				return {
					outcome: "error",
					message: err instanceof Error ? err.message : "Inline function error",
				};
			}
		}

		// Handler path — not implemented in MVP (requires dynamic import)
		return { outcome: "pass" };
	}

	private async executeHttpHook(
		hook: Extract<HookDefinition, { type: "http" }>,
		event: HookEvent,
	): Promise<HookResult> {
		try {
			const body = JSON.stringify({
				event: event.type,
				toolName: event.toolName,
				toolInput: event.toolInput,
				sessionId: event.sessionId,
			});

			const response = await fetch(hook.url, {
				method: (hook.method as string) ?? "POST",
				headers: {
					"Content-Type": "application/json",
					...(hook.headers ?? {}),
				},
				body,
				signal: AbortSignal.timeout(hook.timeout ?? 10_000),
			});

			if (!response.ok) {
				return { outcome: "error", message: `HTTP ${response.status}: ${response.statusText}` };
			}

			const text = await response.text();
			return this.parseHookOutput(text, "");
		} catch (err) {
			return {
				outcome: "error",
				message: err instanceof Error ? err.message : "HTTP hook failed",
			};
		}
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
			const parsed = JSON.parse(stdout) as Record<string, unknown>;

			const result: HookResult = { outcome: "pass" };

			if (parsed.continue === false || parsed.decision === "block") {
				result.outcome = "block";
				result.stopReason = (parsed.stopReason as string) ?? (parsed.reason as string);
			}
			if (parsed.decision === "deny") {
				result.permissionDecision = "deny";
				result.outcome = "block";
			}
			if (parsed.decision === "allow") {
				result.permissionDecision = "allow";
			}
			if (parsed.systemMessage) {
				result.additionalContext = parsed.systemMessage as string;
			}
			if (parsed.message) {
				result.message = parsed.message as string;
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
}
