/**
 * Message and content block types for agent conversations.
 */

export type ContentBlock =
	| { type: "text"; text: string }
	| { type: "thinking"; thinking: string }
	| {
			type: "tool_use";
			id: string;
			name: string;
			input: Record<string, unknown>;
	  }
	| {
			type: "tool_result";
			tool_use_id: string;
			content: string;
			is_error?: boolean;
	  };

export type MessageRole = "user" | "assistant" | "system";

export interface Message {
	role: MessageRole;
	content: string | ContentBlock[];
}

export interface InjectableMessage {
	role: "user" | "system" | "tool_result";
	content: string;
	/** Where to inject: before next LLM call, or immediately */
	position: "next_turn" | "immediate";
	/** For tool_result messages */
	toolUseId?: string;
}

export interface Attachment {
	type: "file" | "image" | "url";
	name: string;
	content: string;
	mimeType?: string;
}
