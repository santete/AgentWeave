/**
 * MessageStore — Manages the conversation message history.
 * Handles threading of user, assistant, and tool_result messages.
 */

import type { Message, ContentBlock } from "@agentweave/types";

export class MessageStore {
	private messages: Message[] = [];

	append(message: Message): void {
		this.messages.push(message);
	}

	appendAssistant(content: string | ContentBlock[]): void {
		this.messages.push({ role: "assistant", content });
	}

	appendToolResult(toolUseId: string, content: string, isError = false): void {
		this.messages.push({
			role: "user",
			content: [
				{
					type: "tool_result",
					tool_use_id: toolUseId,
					content,
					is_error: isError,
				},
			],
		});
	}

	getMessages(): ReadonlyArray<Message> {
		return this.messages;
	}

	getMessageCount(): number {
		return this.messages.length;
	}

	/** Replace all messages (used after compaction). */
	setMessages(messages: Message[]): void {
		this.messages = [...messages];
	}

	/**
	 * Get messages as CoreMessage format for Vercel AI SDK.
	 * TODO: Align with Vercel AI SDK CoreMessage format when wiring real provider.
	 * Tool results currently use role:"user" with ContentBlock — SDK expects role:"tool".
	 */
	toCoreMessages(): Array<{ role: "user" | "assistant" | "system"; content: string }> {
		return this.messages.map((m) => ({
			role: m.role === "system" ? "system" : m.role,
			content: typeof m.content === "string" ? m.content : JSON.stringify(m.content),
		}));
	}

	clear(): void {
		this.messages = [];
	}
}
