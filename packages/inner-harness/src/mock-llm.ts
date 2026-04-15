/**
 * MockLLM — Deterministic LLM responses for testing.
 * Returns pre-defined responses in sequence.
 */

import type { Message } from "@agentweave/types";
import type { LLMCallResult } from "./agent-loop";
import type { ToolCall } from "./tool-executor";

export interface MockResponse {
	text?: string;
	toolCalls?: Array<{
		toolName: string;
		toolInput: Record<string, unknown>;
	}>;
}

/**
 * Create a mock LLM caller that returns responses in sequence.
 * After all responses are consumed, returns empty (terminal).
 */
export function createMockLLMCaller(
	responses: MockResponse[],
): (messages: ReadonlyArray<Message>, model: string) => Promise<LLMCallResult> {
	let index = 0;
	let callCounter = 0; // per-caller to avoid cross-test interference

	return async (_messages, _model) => {
		const response = responses[index];
		index++;

		if (!response) {
			return { text: "", toolCalls: [], stopReason: "end_turn" };
		}

		const toolCalls: ToolCall[] | undefined = response.toolCalls?.map((tc) => ({
			toolUseId: `tu_${++callCounter}`,
			toolName: tc.toolName,
			toolInput: tc.toolInput,
		}));

		return {
			text: response.text,
			toolCalls,
			stopReason: toolCalls && toolCalls.length > 0 ? "tool_use" : "end_turn",
			usage: { inputTokens: 100, outputTokens: 50 },
		};
	};
}

/** Pre-built scenarios for common test cases. */
export const MockScenarios = {
	/** Agent responds with text only (no tools). */
	simpleResponse: [{ text: "Done." }] satisfies MockResponse[],

	/** Agent reads a file, then responds. */
	readThenRespond: [
		{ toolCalls: [{ toolName: "FileRead", toolInput: { path: "test.ts" } }] },
		{ text: "File content looks good." },
	] satisfies MockResponse[],

	/** Agent tries dangerous command (test permission deny path). */
	dangerousCommand: [
		{ toolCalls: [{ toolName: "Bash", toolInput: { command: "rm -rf /" } }] },
		{ text: "I was denied. Let me try a safer approach." },
		{ toolCalls: [{ toolName: "Bash", toolInput: { command: "ls" } }] },
		{ text: "Done." },
	] satisfies MockResponse[],

	/** Agent makes multiple tool calls in one turn. */
	multiTool: [
		{
			toolCalls: [
				{ toolName: "FileRead", toolInput: { path: "a.ts" } },
				{ toolName: "FileRead", toolInput: { path: "b.ts" } },
			],
		},
		{ text: "Both files read." },
	] satisfies MockResponse[],
};
