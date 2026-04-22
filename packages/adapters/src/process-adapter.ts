/**
 * ProcessAdapter — Wraps any CLI process as InnerHarnessProvider.
 * Spawns a child process, sends prompt via stdin, reads JSON events from stdout.
 *
 * Product-grade features:
 * - Message tracking (getMessages returns actual messages)
 * - Stderr capture and structured error events
 * - Exit code mapping (configurable code → reason)
 * - Pause/Resume via stdin protocol
 * - Health check heartbeat (periodic ping, detect hung processes)
 */

import { spawn, type ChildProcess } from "node:child_process";
import { execSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import type {
	InnerHarnessProvider,
	RunOptions,
	InnerEvent,
	InnerEventPayload,
	InnerState,
	InnerConfig,
	TerminalResult,
	ToolDefinition,
	ContentBlock,
	InjectableMessage,
	Message,
} from "@agentweave/types";
import { createEmptyTokenUsage, createEmptyContextUsage } from "@agentweave/types";
import type { ContextUsage, TokenUsage } from "@agentweave/types";

// ─── Config ─────────────────────────────────────────────────────

export interface ProcessAdapterConfig {
	/** Command to execute (e.g. "claude", "node", "python"). */
	command: string;
	/** Arguments to pass to the command. */
	args?: string[];
	/** Working directory. */
	cwd?: string;
	/** How to send the prompt: "stdin" (write to stdin) or "arg" (append to args). */
	promptMode?: "stdin" | "arg";
	/** Parse stdout lines as JSON InnerEvents (default true). */
	parseJson?: boolean;
	/** Stderr handling. */
	stderr?: {
		capture: boolean;
		asEvents: boolean; // Yield error events for each stderr line
	};
	/** Map exit codes to terminal reasons. Default: 0="completed", non-zero="error". */
	exitCodeMap?: Record<number, string>;
	/**
	 * Wall-clock timeout on the child process lifetime (ms).
	 * When exceeded: SIGTERM, then SIGKILL after 5s grace, exit reason="timeout".
	 * Health-check ping/pong only works for adapters that speak the JSON protocol;
	 * this is the hard stop for CLIs that do not (Cursor/Aider/Claude headless).
	 */
	processTimeoutMs?: number;
	/** Health check heartbeat configuration. */
	healthCheck?: {
		enabled: boolean;
		intervalMs?: number; // Default 30000
		timeoutMs?: number; // Default 5000
		pingMessage?: string; // Default '{"type":"ping"}'
		pongPattern?: string; // Regex to match pong, default '"type":\\s*"pong"'
	};
	/** Extra environment variables to inject. */
	env?: Record<string, string>;
}

/** Double-quote an arg and escape any embedded double quotes. */
function quoteArg(s: string): string {
	return `"${s.replace(/"/g, '\\"')}"`;
}

/**
 * Kill a child process tree. On Windows, `child.kill()` with `shell: true`
 * only kills cmd.exe — not the grand-children (e.g. node). Use taskkill /T
 * to kill the whole tree.
 */
function killTree(child: ChildProcess, signal: "SIGTERM" | "SIGKILL" = "SIGTERM"): void {
	if (child.killed || child.pid == null) return;
	if (process.platform === "win32") {
		try {
			execSync(`taskkill /pid ${child.pid} /T /F`, { stdio: "ignore" });
		} catch {
			// Already exited or permission denied — fall back to node's kill
			try { child.kill(signal); } catch { /* already exited */ }
		}
	} else {
		try { child.kill(signal); } catch { /* already exited */ }
	}
}

// ─── Adapter ────────────────────────────────────────────────────

export class ProcessAdapter implements InnerHarnessProvider {
	private config: ProcessAdapterConfig;
	private process: ChildProcess | null = null;
	private sessionId = "";
	private agentId: string;
	private state: InnerState;

	// Message tracking
	private messages: Message[] = [];

	// Stderr
	private stderrLines: string[] = [];

	// Health check
	private healthy = true;
	private healthCheckInterval: ReturnType<typeof setInterval> | null = null;
	private pongResolvers: Array<() => void> = [];
	private pongPattern: RegExp | null = null;

	// Lifetime timeout
	private lifetimeTimer: ReturnType<typeof setTimeout> | null = null;
	private killTimer: ReturnType<typeof setTimeout> | null = null;
	private timedOut = false;

	constructor(config: ProcessAdapterConfig) {
		this.config = config;
		this.agentId = `adapter_${randomUUID().slice(0, 8)}`;
		this.state = {
			status: "idle",
			turnIndex: 0,
			model: `process:${config.command}`,
			usage: createEmptyTokenUsage(),
			contextUsage: createEmptyContextUsage(0),
			activeTool: null,
			messageCount: 0,
			recoveryAttempts: 0,
		};
	}

	run(
		prompt: string | ContentBlock[],
		options?: RunOptions,
	): AsyncGenerator<InnerEvent, TerminalResult, void> {
		if (this.state.status !== "idle") {
			throw new Error("ProcessAdapter can only be run once per instance");
		}
		this.state.status = "running";
		return this.executeRun(prompt, options);
	}

	private async *executeRun(
		prompt: string | ContentBlock[],
		options?: RunOptions,
	): AsyncGenerator<InnerEvent, TerminalResult, void> {

		this.sessionId = `ses_${randomUUID().slice(0, 12)}`;
		this.state.turnIndex = 1;

		const promptText = typeof prompt === "string" ? prompt : JSON.stringify(prompt);
		const args = [...(this.config.args ?? [])];
		if (this.config.promptMode === "arg") {
			args.push(promptText);
		}

		yield this.makeEvent({ type: "turn:start", turnIndex: 1 });

		// Merge: parent env (provides PATH, system vars) + config.env (credentials override)
		const childEnv = this.config.env
			? { ...process.env, ...this.config.env }
			: process.env;
		// Windows: shell is needed to resolve .cmd wrappers (npm global bins), but
		// spawn+shell:true auto-quotes args incorrectly when they contain spaces/newlines/colons,
		// truncating the prompt. Pre-quote into a single command string and pass as shell input.
		const isWin = process.platform === "win32";
		const spawnFile = isWin
			? `${quoteArg(this.config.command)} ${args.map(quoteArg).join(" ")}`
			: this.config.command;
		const spawnArgs = isWin ? [] : args;
		const child = spawn(spawnFile, spawnArgs, {
			cwd: this.config.cwd ?? process.cwd(),
			stdio: ["pipe", "pipe", "pipe"],
			signal: options?.signal,
			env: childEnv,
			shell: isWin,
		});
		this.process = child;

		// Arm the lifetime timeout — SIGTERM, then SIGKILL after 5s grace.
		// Cleared in the exit handler below when the process exits naturally.
		// Uses killTree() so Windows shell spawns propagate to the grand-child.
		if (this.config.processTimeoutMs && this.config.processTimeoutMs > 0) {
			this.lifetimeTimer = setTimeout(() => {
				if (child.killed) return;
				this.timedOut = true;
				killTree(child, "SIGTERM");
				this.killTimer = setTimeout(() => {
					if (!child.killed) {
						killTree(child, "SIGKILL");
					}
				}, 5_000);
			}, this.config.processTimeoutMs);
		}

		// Send prompt via stdin if in stdin mode
		if (this.config.promptMode !== "arg") {
			child.stdin.write(promptText + "\n");
			child.stdin.end();
		}

		// Start health check if configured
		this.startHealthCheck();

		// Setup pong pattern for health check
		if (this.config.healthCheck?.enabled) {
			const pongStr = this.config.healthCheck.pongPattern ?? '"type":\\s*"pong"';
			this.pongPattern = new RegExp(pongStr);
		}

		// Stderr capture (non-blocking, collected in background)
		const pendingStderrEvents: InnerEvent[] = [];
		const stderrCapture = this.config.stderr?.capture;
		const stderrAsEvents = this.config.stderr?.asEvents;

		if (child.stderr && stderrCapture) {
			const stderrStream = child.stderr;
			// Process stderr in background — don't await
			(async () => {
				let buf = "";
				for await (const chunk of stderrStream) {
					buf += String(chunk);
					const lines = buf.split("\n");
					buf = lines.pop() ?? "";
					for (const line of lines) {
						const trimmed = line.trim();
						if (!trimmed) continue;
						this.stderrLines.push(trimmed);
						if (stderrAsEvents) {
							pendingStderrEvents.push(
								this.makeEvent({ type: "error", error: trimmed, recoverable: true }),
							);
						}
					}
				}
				if (buf.trim()) {
					this.stderrLines.push(buf.trim());
					if (stderrAsEvents) {
						pendingStderrEvents.push(
							this.makeEvent({ type: "error", error: buf.trim(), recoverable: true }),
						);
					}
				}
			})().catch(() => {});
		}

		// Collect stdout and parse events
		const parseJson = this.config.parseJson !== false;
		let buffer = "";

		const stdout = child.stdout;
		if (stdout) {
			for await (const chunk of stdout) {
				buffer += String(chunk);

				// Process complete lines
				const lines = buffer.split("\n");
				buffer = lines.pop() ?? ""; // Keep incomplete last line

				for (const line of lines) {
					const trimmed = line.trim();
					if (!trimmed) continue;

					// Check for pong response (health check)
					if (this.pongPattern?.test(trimmed)) {
						this.resolvePong();
					}

					if (parseJson) {
						const event = this.tryParseEvent(trimmed);
						if (event) {
							yield event;
							continue;
						}
					}

					// Non-JSON line → treat as assistant text
					const msg: Message = { role: "assistant", content: [{ type: "text", text: trimmed }] };
					this.messages.push(msg);
					this.state.messageCount++;
					yield this.makeEvent({
						type: "message:assistant",
						content: [{ type: "text", text: trimmed }],
					});
				}

				// Drain pending stderr events
				while (pendingStderrEvents.length > 0) {
					yield pendingStderrEvents.shift()!;
				}
			}
		}

		// Process remaining buffer
		if (buffer.trim()) {
			const msg: Message = { role: "assistant", content: [{ type: "text", text: buffer.trim() }] };
			this.messages.push(msg);
			this.state.messageCount++;
			yield this.makeEvent({
				type: "message:assistant",
				content: [{ type: "text", text: buffer.trim() }],
			});
		}

		// Drain remaining stderr events
		while (pendingStderrEvents.length > 0) {
			yield pendingStderrEvents.shift()!;
		}

		// Stop health check
		this.stopHealthCheck();

		// Wait for process exit
		const exitCode = await new Promise<number>((resolve) => {
			child.on("close", (code) => resolve(code ?? 0));
			child.on("error", () => resolve(1));
		});

		// Clear lifetime timers — process either exited naturally or was killed by timeout
		if (this.lifetimeTimer) { clearTimeout(this.lifetimeTimer); this.lifetimeTimer = null; }
		if (this.killTimer) { clearTimeout(this.killTimer); this.killTimer = null; }

		const reason = this.timedOut ? "timeout" : this.mapExitCode(exitCode);
		// Only "completed" is a success status; anything else is terminal-non-success.
		// Preserve the specific reason ("timeout", "error", etc.) on both the event and the returned result.
		this.state.status = reason === "completed" ? "completed" : "error";
		const terminalReason = reason as TerminalResult["reason"];

		yield this.makeEvent({
			type: "turn:end",
			turnIndex: 1,
			stopReason: reason,
		});

		yield this.makeEvent({
			type: "terminal",
			reason: terminalReason,
			usage: this.state.usage,
		});

		return { reason: terminalReason, usage: this.state.usage };
	}

	abort(_reason?: string): void {
		if (this.process && !this.process.killed) {
			killTree(this.process, "SIGTERM");
		}
		this.state.status = "aborted";
		this.stopHealthCheck();
		if (this.lifetimeTimer) { clearTimeout(this.lifetimeTimer); this.lifetimeTimer = null; }
		if (this.killTimer) { clearTimeout(this.killTimer); this.killTimer = null; }
	}

	// ─── Pause/Resume via stdin protocol ────────────────────────

	pause(): void {
		if (this.state.status !== "running") return;
		if (this.process?.stdin?.writable) {
			this.process.stdin.write(JSON.stringify({ type: "pause" }) + "\n");
		}
		this.state.status = "paused";
	}

	resume(): void {
		if (this.state.status !== "paused") return;
		if (this.process?.stdin?.writable) {
			this.process.stdin.write(JSON.stringify({ type: "resume" }) + "\n");
		}
		this.state.status = "running";
	}

	// ─── Health Check ───────────────────────────────────────────

	isHealthy(): boolean {
		return this.healthy;
	}

	getStderrLines(): ReadonlyArray<string> {
		return this.stderrLines;
	}

	// ─── InnerHarnessProvider interface ──────────────────────────

	getState(): InnerState {
		return { ...this.state };
	}

	getMessages(): ReadonlyArray<Message> {
		return [...this.messages];
	}

	getContextUsage(): ContextUsage {
		return { ...this.state.contextUsage };
	}

	getUsage(): TokenUsage {
		return { ...this.state.usage };
	}

	getTools(): ReadonlyArray<ToolDefinition> {
		return []; // External process manages its own tools
	}

	registerTool(_tool: ToolDefinition): void {
		// No-op — external process manages tools
	}

	unregisterTool(_name: string): void {
		// No-op
	}

	injectMessage(_message: InjectableMessage): void {
		// Limited: write to stdin if process still running
		if (this.process?.stdin?.writable) {
			const text = typeof _message.content === "string"
				? _message.content
				: JSON.stringify(_message.content);
			this.process.stdin.write(text + "\n");
		}
	}

	setSystemPromptSection(_name: string, _content: string | null): void {
		// No-op — external process manages its own system prompt
	}

	setModel(_model: string): void {
		// No-op — model is determined by the external process
	}

	getConfig(): InnerConfig {
		return {
			model: `process:${this.config.command}`,
			maxTurns: 1,
			thinkingEnabled: false,
			tools: [],
		};
	}

	// ─── Internal ───────────────────────────────────────────────

	private makeEvent(payload: InnerEventPayload): InnerEvent {
		return {
			id: randomUUID(),
			timestamp: Date.now(),
			sessionId: this.sessionId,
			agentId: this.agentId,
			...payload,
		} as InnerEvent;
	}

	private tryParseEvent(line: string): InnerEvent | null {
		try {
			const parsed: unknown = JSON.parse(line);
			if (typeof parsed !== "object" || parsed === null) return null;
			const obj = parsed as Record<string, unknown>;

			// Check if it looks like an InnerEvent (has type field + sessionId)
			if (typeof obj.type === "string" && typeof obj.sessionId === "string") {
				return parsed as InnerEvent;
			}

			// Check for common agent output formats (type field only)
			if (typeof obj.type === "string") {
				return this.makeEvent({
					type: "message:assistant",
					content: [{ type: "text", text: line }],
				});
			}

			return null;
		} catch {
			return null;
		}
	}

	private mapExitCode(exitCode: number): string {
		if (this.config.exitCodeMap && exitCode in this.config.exitCodeMap) {
			return this.config.exitCodeMap[exitCode]!;
		}
		return exitCode === 0 ? "completed" : "error";
	}

	private startHealthCheck(): void {
		if (!this.config.healthCheck?.enabled) return;

		const interval = this.config.healthCheck.intervalMs ?? 30_000;
		const timeout = this.config.healthCheck.timeoutMs ?? 5_000;
		const ping = this.config.healthCheck.pingMessage ?? '{"type":"ping"}';

		this.healthCheckInterval = setInterval(() => {
			if (!this.process?.stdin?.writable) {
				this.healthy = false;
				return;
			}

			this.process.stdin.write(ping + "\n");

			// Wait for pong within timeout
			const pongPromise = new Promise<boolean>((resolve) => {
				const timer = setTimeout(() => resolve(false), timeout);
				this.pongResolvers.push(() => {
					clearTimeout(timer);
					resolve(true);
				});
			});

			pongPromise.then((gotPong) => {
				this.healthy = gotPong;
			});
		}, interval);
	}

	private stopHealthCheck(): void {
		if (this.healthCheckInterval) {
			clearInterval(this.healthCheckInterval);
			this.healthCheckInterval = null;
		}
	}

	private resolvePong(): void {
		const resolver = this.pongResolvers.shift();
		if (resolver) resolver();
	}
}
