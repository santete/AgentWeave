/**
 * REFERENCE IMPLEMENTATION — not production path (post-pivot 2026-04-22).
 *
 * AgentWeave's production positioning (see product-spec/POSITIONING.md) is
 * a governance + QA layer that delegates agent-loop execution to Claude Code,
 * Cursor, or any MCP-compatible agent via packages/adapters/. This file is
 * kept for: (1) offline/local use, (2) teaching the agent-loop contract,
 * (3) test infrastructure for the outer-harness.
 *
 * New feature work should extend Pillar 2 (packages/inner-harness/src/sdlc/)
 * or an adapter — NOT this loop.
 *
 * ---
 *
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
	ProcessSandboxBinding,
} from "@agentweave/types";
import { createEmptyTokenUsage, createEmptyContextUsage } from "@agentweave/types";
import type { ContextUsage, TokenUsage } from "@agentweave/types";
import { ToolRegistry } from "./tool-registry";
import { createDefaultRegistry, type ModelProvider, type ProviderRegistry } from "./provider-registry";
import { ToolExecutor } from "./tool-executor";
import type { ToolCall } from "./tool-executor";
import { MessageStore } from "./message-store";
import { TokenCounter } from "./token-counter";
import { createNoopControlPlane } from "./noop-control-plane";
import { cuuToolCall } from "./tool-call-recovery";
import { canNen, capNhatDoDay, mucNen, nenManhTay, suyRaCuaSo } from "./context-manager";

export interface AgentLoopConfig {
	/** Control plane for governance integration. If omitted, runs standalone (all tools allowed, no output filtering). */
	controlPlane?: ControlPlane;
	model: string;
	fallbackModel?: string;
	tools?: ToolDefinition[];
	systemPrompt?: string;
	maxTurns?: number;
	thinkingEnabled?: boolean;
	/**
	 * Cửa sổ ngữ cảnh của model, tính bằng token. Không khai thì suy ra: model
	 * cục bộ lấy theo OLLAMA_CONTEXT_LENGTH (mặc định 65.536), model đám mây
	 * 200.000. Khai sai làm cơ chế nén kích hoạt nhầm lúc.
	 */
	contextWindow?: number;
	/** Tự nén khi ngữ cảnh đầy tới ngưỡng. Mặc định bật. */
	autoCompact?: boolean;
	/**
	 * Cô lập tool chạy tiến trình bằng sandbox tầng nhân (bubblewrap/seatbelt).
	 * Không khai thì KHÔNG cô lập — giữ nguyên hành vi cũ để không phá bản dùng
	 * sẵn có; nơi nào cần thì bật tường minh.
	 */
	processSandbox?: ProcessSandboxBinding;
}

export class AgentLoop implements InnerHarnessProvider {
	private controlPlane: ControlPlane;
	private model: string;
	private fallbackModel?: string;
	private systemPrompt: string;
	/** Các mục prompt đặt qua setSystemPromptSection(), giữ theo tên để không lặp. */
	private promptSections = new Map<string, string>();
	private maxTurns: number;
	private thinkingEnabled: boolean;

	private registry = new ToolRegistry();
	private providers: ProviderRegistry = createDefaultRegistry();
	private messages = new MessageStore();
	private tokenCounter = new TokenCounter();
	private abortController: AbortController | null = null;
	private sessionId = "";
	private agentId: string;
	private autoCompact = true;
	private processSandbox?: ProcessSandboxBinding;
	/** Đặt bởi lệnh force_compact — nén ở đầu lượt kế tiếp. */
	private yeuCauNen = false;
	/** Mức nén hiện tại. Tăng khi nén xong vẫn chưa đủ chỗ. */
	private mucNenHienTai = 0;

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
		this.controlPlane = config.controlPlane ?? createNoopControlPlane();
		this.model = config.model;
		this.fallbackModel = config.fallbackModel;
		this.systemPrompt = config.systemPrompt ?? "";
		this.maxTurns = config.maxTurns ?? 100;
		this.thinkingEnabled = config.thinkingEnabled ?? true;
		this.autoCompact = config.autoCompact ?? true;
		this.processSandbox = config.processSandbox;
		this.agentId = `agent_${nanoid(8)}`;
		this.state.model = this.model;
		// Cửa sổ ngữ cảnh THẬT của model. Mặc định cũ là 200.000 — cửa sổ của
		// Claude — nên với model cục bộ 64K thì số đo sai gấp ba lần.
		this.state.contextUsage = createEmptyContextUsage(
			suyRaCuaSo(this.model, config.contextWindow),
		);

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

			// ── Nén ngữ cảnh TRƯỚC khi gọi LLM ──
			// Phải nén trước chứ không phải sau: gọi khi đã tràn thì Ollama lặng
			// lẽ cắt phần đầu hội thoại, agent quên đề bài mà không báo gì.
			if (this.yeuCauNen || (this.autoCompact && canNen(this.state.contextUsage))) {
				const truoc = this.messages.getMessageCount();
				// Leo thang: nén ở mức hiện tại. Nếu lượt trước đã nén mà vẫn chật
				// thì mức tăng lên, giữ ít lượt hơn và cắt tool result ngắn hơn.
				const muc = mucNen(this.mucNenHienTai);
				const kq = nenManhTay(this.messages.getMessages(), muc.giuGanNhat, muc.tranToolResult);
				this.yeuCauNen = false;
				this.mucNenHienTai++;

				if (kq.daNen) {
					this.messages.setMessages(kq.messages);
					this.state.contextUsage = {
						...this.state.contextUsage,
						compactionCount: this.state.contextUsage.compactionCount + 1,
					};
					this.state.messageCount = this.messages.getMessageCount();

					yield this.makeEvent({
						type: "context:compacted",
						// ~4 ký tự một token — ước lượng thô, đủ để người vận hành
						// thấy quy mô. Số chính xác sẽ có ở lượt gọi LLM kế tiếp.
						freedTokens: Math.round(kq.kyTuBoDi / 4),
						strategy: kq.cach,
						messagesRemoved: truoc - kq.messages.length,
					});
				}
			}

			// ── LLM Call ──
			// Provider được phân giải qua ProviderRegistry (xem provider-registry.ts).
			// Có thể tiêm llmCaller để test tất định mà không gọi mạng.
			yield this.makeEvent({
				type: "llm:request_start",
				model: this.model,
				estimatedInputTokens: this.messages.getMessageCount() * 100, // rough estimate
			});

			// The LLM response will be injected via the adapter pattern.
			// For the MVP, we use a pluggable LLM caller interface.
			//
			// Lỗi gọi LLM PHẢI kết thúc bằng reason "error". Bản trước nuốt lỗi và
			// trả về kết quả rỗng, nên endpoint sai vẫn báo "completed" với 0 token —
			// nhìn y hệt một câu trả lời rỗng hợp lệ.
			let llmResult: LLMCallResult;
			try {
				llmResult = await this.callLLM();
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				this.state.status = "completed";
				const usage = this.tokenCounter.getUsage();
				yield this.makeEvent({ type: "error", error: msg, recoverable: false });
				yield this.makeEvent({ type: "terminal", reason: "error", usage });
				return { reason: "error", usage };
			}

			// Track usage
			if (llmResult.usage) {
				this.tokenCounter.add(llmResult.usage);
				this.tokenCounter.recalculateCost(this.model);
			}

			this.state.usage = this.tokenCounter.getUsage();
			this.state.messageCount = this.messages.getMessageCount();

			// Độ đầy ngữ cảnh THẬT: số token đầu vào provider vừa báo chính là
			// lượng ngữ cảnh đang dùng. Trước đây trường này luôn bằng 0, nên
			// không có tín hiệu nào để biết khi nào cần nén.
			this.state.contextUsage = capNhatDoDay(
				this.state.contextUsage,
				llmResult.usage?.inputTokens,
			);
			// Đã xuống dưới ngưỡng thì hạ mức nén về mặc định, để lượt sau không
			// bị cắt gắt hơn mức cần thiết.
			if (!canNen(this.state.contextUsage)) this.mucNenHienTai = 0;
			yield this.makeEvent({
				type: "context:usage",
				usedTokens: this.state.contextUsage.usedTokens,
				maxTokens: this.state.contextUsage.maxTokens,
			});

			yield this.makeEvent({
				type: "llm:stream_end",
				usage: this.tokenCounter.getUsage(),
				stopReason: llmResult.stopReason,
			});

			// ── Check for tool calls ──
			let toolCalls = llmResult.toolCalls;

			// Model cục bộ đôi khi nhả tool-call ra dạng CHỮ (khuôn Hermes XML
			// hoặc JSON) thay vì tool call thật. Không cứu thì vòng lặp tưởng
			// model đã trả lời xong và kết thúc "completed" mà chưa làm gì.
			if ((!toolCalls || toolCalls.length === 0) && llmResult.text) {
				const cuu = cuuToolCall(llmResult.text, this.registry.names());
				if (cuu.toolCalls.length > 0) {
					toolCalls = cuu.toolCalls;
					llmResult.text = cuu.conLai;
					// Phát sự kiện để việc cứu nằm trong nhật ký kiểm toán.
					yield this.makeEvent({
						type: "recovery:retry",
						reason: `tool-call dang chu (khuon ${cuu.khuon}) — da cuu ${cuu.toolCalls.length} loi goi`,
						attempt: this.state.turnIndex,
					});
				}
			}

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
				processSandbox: this.processSandbox,
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

		// Default: try real Vercel AI SDK. KHÔNG bắt lỗi ở đây — vòng lặp chính
		// phải thấy được lỗi để kết thúc với reason "error".
		if (process.env.AGENTWEAVE_DEBUG) {
			console.error(`[AgentWeave:debug] goi LLM that voi model: ${this.model}`);
		}
		return await this.callRealLLM();
	}

	private async callRealLLM(): Promise<LLMCallResult> {
		// Dynamic import — avoids crash if provider SDK not installed
		const { generateText, tool } = await import("ai");

		// Auto-detect provider from model name
		const llmModel = await this.resolveModel();

		const tools: Record<string, unknown> = {};
		for (const toolDef of this.registry.getAll()) {
			tools[toolDef.name] = tool({
				description: toolDef.description,
				parameters: toolDef.parameters,
			});
		}

		const system = this.getSystemPrompt();

		const result = await generateText({
			model: llmModel,
			// Trước đây systemPrompt được lưu nhưng không bao giờ gửi đi: mọi thứ
			// đặt qua setSystemPromptSection() (kể cả chỉ mục skill) đều vô hình
			// với model mà không có dấu hiệu nào báo sai.
			system: system.trim() === "" ? undefined : system,
			messages: this.messages.getMessages().map((m) => ({
				role: m.role as "user" | "assistant",
				content: typeof m.content === "string" ? m.content : JSON.stringify(m.content),
			})),
			tools: tools as Parameters<typeof generateText>[0]["tools"],
			maxSteps: 1,
			abortSignal: this.abortController?.signal,
		});

		// Debug: log raw result for troubleshooting
		if (process.env.AGENTWEAVE_DEBUG) {
			console.error(`[AgentWeave:debug] text=${(result.text ?? "").slice(0, 100)}`);
			console.error(`[AgentWeave:debug] toolCalls=${JSON.stringify(result.toolCalls ?? [])}`);
			console.error(`[AgentWeave:debug] finishReason=${result.finishReason}`);
			console.error(`[AgentWeave:debug] usage=${JSON.stringify(result.usage)}`);
		}

		const toolCalls = (result.toolCalls ?? []).map((tc) => ({
			toolUseId: tc.toolCallId,
			toolName: tc.toolName,
			toolInput: tc.args as Record<string, unknown>,
		}));

		return {
			text: result.text ?? "",
			toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
			stopReason: result.finishReason ?? "end_turn",
			usage: result.usage ? {
				inputTokens: result.usage.promptTokens,
				outputTokens: result.usage.completionTokens,
			} : undefined,
		};
	}

	/**
	 * Auto-detect LLM provider from model name.
	 * Supports: gemini-* → @ai-sdk/google, gpt-* → @ai-sdk/openai, default → @ai-sdk/anthropic
	 */
	private async resolveModel(): Promise<Parameters<typeof import("ai").generateText>[0]["model"]> {
		return (await this.providers.resolve(this.model)) as Parameters<
			typeof import("ai").generateText
		>[0]["model"];
	}

	/** Đăng ký provider tuỳ chỉnh (vd: endpoint nội bộ của công ty). */
	registerProvider(provider: ModelProvider): void {
		this.providers.register(provider);
	}

	/** Provider nào sẽ xử lý model hiện tại — dùng để chẩn đoán. */
	whichProvider(): string | null {
		return this.providers.whichProvider(this.model);
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

	/**
	 * Đặt/xoá một mục có tên trong system prompt.
	 *
	 * Giữ theo Map thay vì nối chuỗi rồi cắt bằng regex, vì bản cũ có hai lỗi:
	 * đặt lại cùng một tên thì mục bị lặp, và nội dung chứa "[" làm regex xoá
	 * cắt nhầm chỗ. Chỉ mục skill dính cả hai.
	 */
	setSystemPromptSection(name: string, content: string | null): void {
		if (content === null) {
			this.promptSections.delete(name);
		} else {
			this.promptSections.set(name, content);
		}
	}

	/**
	 * System prompt thật sự gửi tới model — prompt gốc cộng các mục đã đặt.
	 * Công khai để bộ tự kiểm tra xác nhận được chỉ mục skill đã vào prompt,
	 * thay vì tin là đã vào.
	 */
	getSystemPrompt(): string {
		let out = this.systemPrompt;
		for (const [name, content] of this.promptSections) {
			out += `\n[${name}]\n${content}\n`;
		}
		return out;
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
				case "force_compact":
					// Lệnh này đã có trong kiểu dữ liệu từ lâu nhưng KHÔNG có nhánh
					// xử lý, nên gọi vào chỉ nhận "Unknown command". Nén ngay giữa
					// lượt sẽ đụng danh sách tin nhắn đang dùng, nên đặt cờ và nén
					// ở đầu lượt kế tiếp.
					this.yeuCauNen = true;
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
