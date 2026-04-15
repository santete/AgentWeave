/**
 * AgentLoop — Core execution engine implementing InnerHarnessProvider.
 * Runs as an AsyncGenerator that yields InnerEvents.
 * Uses Vercel AI SDK with maxSteps:1 (we control the loop).
 */

import { nanoid } from "nanoid";
import type {
	InnerHarnessProvider,
	RunOptions,
	InnerEvent,
	InnerEventPayload,
	InnerState,
	InnerConfig,
	TerminalResult,
	ControlPlane,
	ToolDefinition,
	ContentBlock,
	InjectableMessage,
	Message,
	ToolDecision,
} from "@agentweave/types";
import { createEmptyTokenUsage, createEmptyContextUsage } from "@agentweave/types";
import type { ContextUsage, TokenUsage } from "@agentweave/types";
import { ToolRegistry } from "./tool-registry";
import { ToolExecutor } from "./tool-executor";
import type { ToolCall } from "./tool-executor";
import { MessageStore } from "./message-store";
import { TokenCounter } from "./token-counter";

export interface AgentLoopConfig {
	controlPlane: ControlPlane;
	model: string;
	fallbackModel?: string;
	tools?: ToolDefinition[];
	systemPrompt?: string;
	maxTurns?: number;
	thinkingEnabled?: boolean;
}

export class AgentLoop implements InnerHarnessProvider {
	private controlPlane: ControlPlane;
	private model: string;
	private fallbackModel?: string;
	private systemPrompt: string;
	private maxTurns: number;
	private thinkingEnabled: boolean;

	private registry = new ToolRegistry();
	private messages = new MessageStore();
	private tokenCounter = new TokenCounter();
	private abortController: AbortController | null = null;
	private sessionId = "";
	private agentId: string;

	private state: InnerState = {
		status: "idle",
		turnIndex: 0,
		model: "",
		usage: createEmptyTokenUsage(),
		contextUsage: createEmptyContextUsage(200_000),
		activeTool: null,
		messageCount: 0,
		recoveryAttempts: 0,
	};

	constructor(config: AgentLoopConfig) {
		this.controlPlane = config.controlPlane;
		this.model = config.model;
		this.fallbackModel = config.fallbackModel;
		this.systemPrompt = config.systemPrompt ?? "";
		this.maxTurns = config.maxTurns ?? 100;
		this.thinkingEnabled = config.thinkingEnabled ?? true;
		this.agentId = `agent_${nanoid(8)}`;
		this.state.model = this.model;

		if (config.tools) {
			for (const tool of config.tools) {
				this.registry.register(tool);
			}
		}

		this.setupCommandHandler();
	}

	async *run(
		prompt: string | ContentBlock[],
		options?: RunOptions,
	): AsyncGenerator<InnerEvent, TerminalResult, void> {
		if (this.state.status !== "idle") {
			throw new Error(
				"AgentLoop.run() can only be called once per instance. Create a new harness with createHarness() for a new session.",
			);
		}

		this.abortController = new AbortController();
		this.sessionId = `ses_${nanoid(12)}`;
		this.state.status = "running";
		this.state.turnIndex = 0;

		const maxTurns = options?.maxTurns ?? this.maxTurns;
		const maxBudget = options?.maxBudgetUsd;
		const signal = options?.signal;

		// Abort if external signal fires
		if (signal) {
			signal.addEventListener("abort", () => this.abortController?.abort(), { once: true });
		}

		// Load initial messages if resuming
		if (options?.initialMessages) {
			this.messages.setMessages([...options.initialMessages]);
		}

		// Input gate (via Control Plane)
		const inputText = typeof prompt === "string" ? prompt : JSON.stringify(prompt);
		const inputDecision = await this.controlPlane.intercept("input_received", {
			text: inputText,
			sessionId: this.sessionId,
			timestamp: Date.now(),
		});

		if (inputDecision.action === "reject") {
			this.state.status = "completed";
			return { reason: "input_rejected" };
		}

		const effectivePrompt = inputDecision.transformedInput ?? inputText;
		this.messages.append({ role: "user", content: effectivePrompt });

		// ─── Main Agent Loop ─────────────────────────────────────────
		while (this.state.turnIndex < maxTurns) {
			if (this.abortController.signal.aborted) {
				this.state.status = "aborted";
				return { reason: "aborted", usage: this.tokenCounter.getUsage() };
			}

			// Pause support — status may be changed by command handler
			while ((this.state.status as string) === "paused") {
				await new Promise((r) => setTimeout(r, 100));
				if (this.abortController.signal.aborted) {
					this.state.status = "aborted";
					return { reason: "aborted", usage: this.tokenCounter.getUsage() };
				}
			}

			this.state.turnIndex++;

			yield this.makeEvent({ type: "turn:start", turnIndex: this.state.turnIndex });

			// ── LLM Call (simulated — real Vercel AI SDK integration later) ──
			// For now, yield request_start event. Actual streamText() call
			// will be wired when providers are configured.
			yield this.makeEvent({
				type: "llm:request_start",
				model: this.model,
				estimatedInputTokens: this.messages.getMessageCount() * 100, // rough estimate
			});

			// The LLM response will be injected via the adapter pattern.
			// For the MVP, we use a pluggable LLM caller interface.
			const llmResult = await this.callLLM();

			// Track usage
			if (llmResult.usage) {
				this.tokenCounter.add(llmResult.usage);
				this.tokenCounter.recalculateCost(this.model);
			}

			this.state.usage = this.tokenCounter.getUsage();
			this.state.messageCount = this.messages.getMessageCount();

			yield this.makeEvent({
				type: "llm:stream_end",
				usage: this.tokenCounter.getUsage(),
				stopReason: llmResult.stopReason,
			});

			// ── Check for tool calls ──
			const toolCalls = llmResult.toolCalls;

			if (!toolCalls || toolCalls.length === 0) {
				// Terminal: LLM did not request any tools
				if (llmResult.text) {
					this.messages.appendAssistant(llmResult.text);
					yield this.makeEvent({
						type: "message:assistant",
						content: [{ type: "text", text: llmResult.text }],
					});
				}

				// Output gate
				await this.controlPlane.intercept("output_ready", {
					text: llmResult.text ?? "",
					contentBlocks: llmResult.text
						? [{ type: "text", text: llmResult.text }]
						: [],
					usage: this.tokenCounter.getUsage(),
					turnIndex: this.state.turnIndex,
					toolCallCount: 0,
					model: this.model,
				});

				this.state.status = "completed";
				const finalUsage = this.tokenCounter.getUsage();
				yield this.makeEvent({ type: "terminal", reason: "completed", usage: finalUsage });
				return { reason: "completed", usage: finalUsage };
			}

			// ── Append assistant message with tool_use blocks ──
			const assistantContent: ContentBlock[] = [];
			if (llmResult.text) {
				assistantContent.push({ type: "text", text: llmResult.text });
			}
			for (const tc of toolCalls) {
				assistantContent.push({
					type: "tool_use",
					id: tc.toolUseId,
					name: tc.toolName,
					input: tc.toolInput as Record<string, unknown>,
				});
			}
			this.messages.appendAssistant(assistantContent);

			// ── Process each tool call ──
			const executor = new ToolExecutor(this.registry, {
				sessionId: this.sessionId,
				agentId: this.agentId,
				cwd: process.cwd(),
				signal: this.abortController.signal,
			});

			const permittedCalls: ToolCall[] = [];

			for (const tc of toolCalls) {
				yield this.makeEvent({
					type: "tool:requested",
					toolName: tc.toolName,
					toolInput: tc.toolInput,
					toolUseId: tc.toolUseId,
				});

				// Permission check via Control Plane
				const tool = this.registry.get(tc.toolName);
				const decision: ToolDecision = await this.controlPlane.intercept(
					"tool_request",
					{
						toolName: tc.toolName,
						toolInput: tc.toolInput as Record<string, unknown>,
						toolUseId: tc.toolUseId,
						turnIndex: this.state.turnIndex,
						isReadOnly: tool?.metadata.isReadOnly ?? false,
						isDestructive: tool?.metadata.isDestructive ?? false,
					},
				);

				if (decision.behavior === "deny") {
					yield this.makeEvent({
						type: "permission:denied",
						toolName: tc.toolName,
						toolUseId: tc.toolUseId,
						reason: decision.reason,
						source: decision.source,
					});
					// Send denied result back to LLM
					this.messages.appendToolResult(
						tc.toolUseId,
						`Permission denied: ${decision.reason}`,
						true,
					);
					yield this.makeEvent({
						type: "message:tool_result",
						toolUseId: tc.toolUseId,
						content: `Permission denied: ${decision.reason}`,
						isError: true,
					});
				} else {
					yield this.makeEvent({
						type: "permission:allowed",
						toolName: tc.toolName,
						toolUseId: tc.toolUseId,
						source: decision.source,
					});
					permittedCalls.push(tc);
				}
			}

			// ── Execute permitted tools ──
			if (permittedCalls.length > 0) {
				const results = await executor.execute(permittedCalls);

				for (const result of results) {
					if (result.isError) {
						yield this.makeEvent({
							type: "tool:failed",
							toolUseId: result.toolUseId,
							error: String(result.result),
							durationMs: result.durationMs,
						});
					} else {
						yield this.makeEvent({
							type: "tool:completed",
							toolUseId: result.toolUseId,
							result: result.result,
							durationMs: result.durationMs,
						});
					}

					const content =
						typeof result.result === "string"
							? result.result
							: JSON.stringify(result.result);
					this.messages.appendToolResult(result.toolUseId, content, result.isError);

					yield this.makeEvent({
						type: "message:tool_result",
						toolUseId: result.toolUseId,
						content,
						isError: result.isError,
					});
				}
			}

			// ── Budget check ──
			if (maxBudget !== undefined && this.tokenCounter.getUsage().totalCost >= maxBudget) {
				this.state.status = "completed";
				const usage = this.tokenCounter.getUsage();
				yield this.makeEvent({ type: "terminal", reason: "budget_exceeded", usage });
				return { reason: "budget_exceeded", usage };
			}

			yield this.makeEvent({
				type: "turn:end",
				turnIndex: this.state.turnIndex,
				stopReason: "continue",
			});
		}

		// Max turns reached
		this.state.status = "completed";
		const usage = this.tokenCounter.getUsage();
		yield this.makeEvent({ type: "terminal", reason: "max_turns", usage });
		return { reason: "max_turns", usage };
	}

	// ─── LLM Caller (pluggable) ──────────────────────────────────

	/** Override this for real LLM integration or mock in tests. */
	protected llmCaller:
		| ((messages: ReadonlyArray<Message>, model: string) => Promise<LLMCallResult>)
		| null = null;

	setLLMCaller(
		caller: (messages: ReadonlyArray<Message>, model: string) => Promise<LLMCallResult>,
	): void {
		this.llmCaller = caller;
	}

	private async callLLM(): Promise<LLMCallResult> {
		if (this.llmCaller) {
			return this.llmCaller(this.messages.getMessages(), this.model);
		}
		// Default: return empty (no tools, no text) — will cause terminal
		return { text: "", toolCalls: [], stopReason: "end_turn", usage: undefined };
	}

	// ─── InnerHarnessProvider interface ──────────────────────────

	abort(reason?: string): void {
		this.abortController?.abort(reason);
		this.state.status = "aborted";
	}

	getState(): InnerState {
		return { ...this.state };
	}

	getMessages(): ReadonlyArray<Message> {
		return this.messages.getMessages();
	}

	getContextUsage(): ContextUsage {
		return { ...this.state.contextUsage };
	}

	getUsage(): TokenUsage {
		return this.tokenCounter.getUsage();
	}

	getTools(): ReadonlyArray<ToolDefinition> {
		return this.registry.getAll();
	}

	registerTool(tool: ToolDefinition): void {
		this.registry.register(tool);
	}

	unregisterTool(name: string): void {
		this.registry.unregister(name);
	}

	injectMessage(message: InjectableMessage): void {
		this.messages.append({
			role: message.role === "tool_result" ? "user" : message.role,
			content: message.content,
		});
	}

	setSystemPromptSection(name: string, content: string | null): void {
		const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		if (content === null) {
			this.systemPrompt = this.systemPrompt.replace(
				new RegExp(`\\[${escaped}\\][\\s\\S]*?(?=\\[|$)`),
				"",
			);
		} else {
			this.systemPrompt += `\n[${name}]\n${content}\n`;
		}
	}

	setModel(model: string): void {
		this.model = model;
		this.state.model = model;
	}

	getConfig(): InnerConfig {
		return {
			model: this.model,
			fallbackModel: this.fallbackModel,
			maxTurns: this.maxTurns,
			thinkingEnabled: this.thinkingEnabled,
			tools: this.registry.names(),
		};
	}

	// ─── Internal ────────────────────────────────────────────────

	private makeEvent(payload: InnerEventPayload): InnerEvent {
		return {
			id: nanoid(),
			timestamp: Date.now(),
			sessionId: this.sessionId,
			agentId: this.agentId,
			...payload,
		} as InnerEvent;
	}

	private setupCommandHandler(): void {
		this.controlPlane.onCommand(async (cmd) => {
			switch (cmd.type) {
				case "pause":
					this.state.status = "paused";
					return { accepted: true };
				case "resume":
					this.state.status = "running";
					return { accepted: true };
				case "abort":
					this.abort(cmd.reason);
					return { accepted: true };
				case "set_model":
					this.setModel(cmd.model);
					return { accepted: true };
				case "set_max_turns":
					this.maxTurns = cmd.maxTurns;
					return { accepted: true };
				case "inject":
					this.injectMessage(cmd.message);
					return { accepted: true };
				default:
					return { accepted: false, reason: `Unknown command: ${cmd.type}` };
			}
		});
	}
}

export interface LLMCallResult {
	text?: string;
	toolCalls?: ToolCall[];
	stopReason: string;
	usage?: {
		inputTokens?: number;
		outputTokens?: number;
		thinkingTokens?: number;
	};
}
