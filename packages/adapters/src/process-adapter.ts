/**
 * ProcessAdapter — Wraps any CLI process as InnerHarnessProvider.
 * Spawns a child process, sends prompt via stdin, reads JSON events from stdout.
 * Limited control: can abort (SIGTERM), but cannot pause/resume or inject messages.
 */

import { spawn, type ChildProcess } from "node:child_process";
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
}

// ─── Adapter ────────────────────────────────────────────────────

export class ProcessAdapter implements InnerHarnessProvider {
	private config: ProcessAdapterConfig;
	private process: ChildProcess | null = null;
	private sessionId = "";
	private agentId: string;
	private state: InnerState;

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

		const child = spawn(this.config.command, args, {
			cwd: this.config.cwd ?? process.cwd(),
			stdio: ["pipe", "pipe", "pipe"],
			signal: options?.signal,
		});
		this.process = child;

		// Send prompt via stdin if in stdin mode
		if (this.config.promptMode !== "arg") {
			child.stdin.write(promptText + "\n");
			child.stdin.end();
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

					if (parseJson) {
						const event = this.tryParseEvent(trimmed);
						if (event) {
							yield event;
							continue;
						}
					}

					// Non-JSON line → treat as assistant text
					yield this.makeEvent({
						type: "message:assistant",
						content: [{ type: "text", text: trimmed }],
					});
				}
			}
		}

		// Process remaining buffer
		if (buffer.trim()) {
			yield this.makeEvent({
				type: "message:assistant",
				content: [{ type: "text", text: buffer.trim() }],
			});
		}

		// Wait for process exit
		const exitCode = await new Promise<number>((resolve) => {
			child.on("close", (code) => resolve(code ?? 0));
			child.on("error", () => resolve(1));
		});

		const reason = exitCode === 0 ? "completed" : "error";
		this.state.status = exitCode === 0 ? "completed" : "error";

		yield this.makeEvent({
			type: "turn:end",
			turnIndex: 1,
			stopReason: reason,
		});

		yield this.makeEvent({
			type: "terminal",
			reason: reason === "error" ? "error" : "completed",
			usage: this.state.usage,
		});

		return { reason: reason === "error" ? "error" : "completed", usage: this.state.usage };
	}

	abort(_reason?: string): void {
		if (this.process && !this.process.killed) {
			this.process.kill("SIGTERM");
		}
		this.state.status = "aborted";
	}

	getState(): InnerState {
		return { ...this.state };
	}

	getMessages(): ReadonlyArray<Message> {
		return []; // Process adapter doesn't track messages
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

			// Check if it looks like an InnerEvent (has type field)
			if (typeof obj.type === "string" && typeof obj.sessionId === "string") {
				return parsed as InnerEvent;
			}

			// Check for common agent output formats
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
}
