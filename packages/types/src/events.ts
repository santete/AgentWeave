/**
 * Inner Harness events and Outer Harness commands.
 * Events flow Inner -> Control Plane -> Outer (non-blocking).
 * Commands flow Outer -> Control Plane -> Inner (async with ack).
 */

import type { ContentBlock, InjectableMessage } from "./messages";
import type { TokenUsage } from "./metrics";
import type { AgentMessage } from "./multi-agent";

// ─── Terminal Reasons ────────────────────────────────────────────

export type TerminalReason =
	| "completed" // LLM stopped calling tools
	| "aborted" // User/Outer abort
	| "max_turns" // Turn limit reached
	| "budget_exceeded" // Cost limit reached
	| "timeout" // Time limit reached
	| "error" // Unrecoverable error
	| "loop" // Model kẹt lặp cùng một lệnh — harness cắt để khỏi đốt lượt
	| "input_rejected"; // Input gate rejected

// ─── Inner Events ────────────────────────────────────────────────

export type InnerEventPayload =
	// Turn lifecycle
	| { type: "turn:start"; turnIndex: number }
	| { type: "turn:end"; turnIndex: number; stopReason: string }
	// LLM streaming
	| { type: "llm:request_start"; model: string; estimatedInputTokens: number }
	| {
			type: "llm:stream_delta";
			delta: string;
			blockType: "text" | "thinking" | "tool_use";
	  }
	| { type: "llm:stream_end"; usage: TokenUsage; stopReason: string }
	/**
	 * Chữ vừa chảy ra hoá ra là tool-call viết dạng văn bản. Giao diện phải
	 * THAY THẾ phần đã hiện bằng `text` — nếu không người dùng thấy nguyên
	 * khối JSON thô lẫn giữa câu trả lời.
	 */
	| { type: "llm:text_corrected"; text: string }
	// Tool lifecycle
	| {
			type: "tool:requested";
			toolName: string;
			toolInput: unknown;
			toolUseId: string;
	  }
	| { type: "tool:started"; toolUseId: string }
	| {
			type: "tool:completed";
			toolUseId: string;
			result: unknown;
			durationMs: number;
	  }
	| { type: "tool:failed"; toolUseId: string; error: string; durationMs: number }
	// Permission (emitted by Outer, observed by monitors)
	| {
			type: "permission:allowed";
			toolName: string;
			toolUseId: string;
			source: string;
	  }
	| {
			type: "permission:denied";
			toolName: string;
			toolUseId: string;
			reason: string;
			source: string;
	  }
	| {
			type: "permission:asking";
			toolName: string;
			toolUseId: string;
			askMessage: string;
	  }
	| {
			type: "permission:ask_resolved";
			toolName: string;
			toolUseId: string;
			behavior: "allow" | "deny";
			source: string;
	  }
	| {
			type: "permission:ask_timeout";
			toolName: string;
			toolUseId: string;
			fallback: "allow" | "deny";
	  }
	// Messages
	| { type: "message:assistant"; content: ContentBlock[] }
	| {
			type: "message:tool_result";
			toolUseId: string;
			content: string;
			isError: boolean;
	  }
	// Context
	// strategy/messagesRemoved tuỳ chọn để không phá bản dùng cũ, nhưng có thì
	// nhật ký kiểm toán biết ngữ cảnh đã bị cắt theo cách nào.
	| {
			type: "context:compacted";
			freedTokens: number;
			strategy?: string;
			messagesRemoved?: number;
	  }
	| { type: "context:usage"; usedTokens: number; maxTokens: number }
	/**
	 * Đã bơm một khối `<system-reminder>` vào giữa hội thoại.
	 *
	 * Chữ bơm ngầm mà không có dấu vết là thứ khó gỡ rối nhất: model đột nhiên
	 * đổi hành vi và không ai truy được vì sao. Sự kiện này để mọi lần bơm đều
	 * nằm trong nhật ký kiểm toán.
	 */
	| { type: "context:reminder"; loai: string[]; bytes: number }
	// Recovery
	| { type: "recovery:retry"; reason: string; attempt: number }
	| { type: "recovery:fallback"; fromModel: string; toModel: string }
	// Terminal
	| { type: "terminal"; reason: TerminalReason; usage: TokenUsage }
	// Error
	| { type: "error"; error: string; recoverable: boolean }
	// SDLC stage lifecycle
	| { type: "sdlc:stage_start"; stage: SDLCStageName; phase: number }
	| {
			type: "sdlc:stage_end";
			stage: SDLCStageName;
			phase: number;
			durationMs: number;
			status: "success" | "failure" | "skipped";
	  }
	// Multi-agent
	| {
			type: "agent:spawned";
			childAgentId: string;
			name: string;
			parentId: string;
	  }
	| {
			type: "agent:completed";
			childAgentId: string;
			name: string;
			result?: unknown;
	  }
	| {
			type: "agent:failed";
			childAgentId: string;
			name: string;
			error: string;
	  }
	| { type: "agent:aborted"; childAgentId: string; name: string }
	| { type: "agent:message"; message: AgentMessage };

export type SDLCStageName =
	| "taskNormalizer"
	| "contextBuilder"
	| "planGenerator"
	| "executionBridge"
	| "patchValidator"
	| "qualityGate"
	| "retryEngine"
	| "outputStandardizer";

export type InnerEvent = {
	id: string;
	timestamp: number;
	sessionId: string;
	agentId: string;
} & InnerEventPayload;

// ─── Outer Commands ──────────────────────────────────────────────

export type OuterCommand =
	| { type: "pause" }
	| { type: "resume" }
	| { type: "abort"; reason?: string }
	| { type: "inject"; message: InjectableMessage }
	| { type: "set_model"; model: string }
	| { type: "set_max_turns"; maxTurns: number }
	| { type: "set_budget"; budgetUsd: number }
	| { type: "force_compact" };

export interface CommandAck {
	accepted: boolean;
	reason?: string;
}

// ─── Terminal Result ─────────────────────────────────────────────

export interface TerminalResult {
	reason: TerminalReason;
	usage?: TokenUsage;
}
