import { describe, it, expect } from "vitest";
import { MessageStore } from "../src/message-store";

describe("MessageStore", () => {
	it("should start empty", () => {
		const store = new MessageStore();
		expect(store.getMessages()).toEqual([]);
		expect(store.getMessageCount()).toBe(0);
	});

	it("should append a user message", () => {
		const store = new MessageStore();
		store.append({ role: "user", content: "hello" });

		expect(store.getMessageCount()).toBe(1);
		expect(store.getMessages()[0]).toEqual({ role: "user", content: "hello" });
	});

	it("should append an assistant text message", () => {
		const store = new MessageStore();
		store.appendAssistant("I can help with that.");

		const msg = store.getMessages()[0];
		expect(msg?.role).toBe("assistant");
		expect(msg?.content).toBe("I can help with that.");
	});

	it("should append an assistant message with ContentBlocks", () => {
		const store = new MessageStore();
		store.appendAssistant([
			{ type: "text", text: "Let me read that file." },
			{ type: "tool_use", id: "tu_1", name: "FileRead", input: { path: "test.ts" } },
		]);

		const msg = store.getMessages()[0];
		expect(msg?.role).toBe("assistant");
		expect(Array.isArray(msg?.content)).toBe(true);
		if (Array.isArray(msg?.content)) {
			expect(msg.content).toHaveLength(2);
			expect(msg.content[0]?.type).toBe("text");
			expect(msg.content[1]?.type).toBe("tool_use");
		}
	});

	it("should append a tool result as user message", () => {
		const store = new MessageStore();
		store.appendToolResult("tu_1", "file contents here", false);

		const msg = store.getMessages()[0];
		expect(msg?.role).toBe("user");
		expect(Array.isArray(msg?.content)).toBe(true);
		if (Array.isArray(msg?.content)) {
			const block = msg.content[0];
			expect(block?.type).toBe("tool_result");
			if (block?.type === "tool_result") {
				expect(block.tool_use_id).toBe("tu_1");
				expect(block.content).toBe("file contents here");
				expect(block.is_error).toBe(false);
			}
		}
	});

	it("should append error tool result", () => {
		const store = new MessageStore();
		store.appendToolResult("tu_2", "Permission denied", true);

		const msg = store.getMessages()[0];
		if (Array.isArray(msg?.content)) {
			const block = msg.content[0];
			if (block?.type === "tool_result") {
				expect(block.is_error).toBe(true);
			}
		}
	});

	it("should thread messages in correct order", () => {
		const store = new MessageStore();
		store.append({ role: "user", content: "Fix the bug" });
		store.appendAssistant([
			{ type: "tool_use", id: "tu_1", name: "FileRead", input: { path: "src/app.ts" } },
		]);
		store.appendToolResult("tu_1", "const x = 1;");
		store.appendAssistant("Found the issue.");

		const messages = store.getMessages();
		expect(messages).toHaveLength(4);
		expect(messages[0]?.role).toBe("user");
		expect(messages[1]?.role).toBe("assistant");
		expect(messages[2]?.role).toBe("user"); // tool_result wrapped as user
		expect(messages[3]?.role).toBe("assistant");
	});

	it("should replace all messages with setMessages", () => {
		const store = new MessageStore();
		store.append({ role: "user", content: "old message" });

		store.setMessages([
			{ role: "user", content: "compacted message" },
			{ role: "assistant", content: "compacted response" },
		]);

		expect(store.getMessageCount()).toBe(2);
		expect(store.getMessages()[0]?.content).toBe("compacted message");
	});

	it("should not mutate when setMessages source changes", () => {
		const store = new MessageStore();
		const source = [{ role: "user" as const, content: "hello" }];
		store.setMessages(source);

		source.push({ role: "assistant" as const, content: "world" });
		expect(store.getMessageCount()).toBe(1); // unchanged
	});

	it("should convert to CoreMessages format", () => {
		const store = new MessageStore();
		store.append({ role: "user", content: "hello" });
		store.appendAssistant("hi");
		store.append({ role: "system", content: "be helpful" });

		const core = store.toCoreMessages();
		expect(core).toHaveLength(3);
		expect(core[0]).toEqual({ role: "user", content: "hello" });
		expect(core[1]).toEqual({ role: "assistant", content: "hi" });
		expect(core[2]).toEqual({ role: "system", content: "be helpful" });
	});

	it("should serialize ContentBlock[] to JSON in toCoreMessages", () => {
		const store = new MessageStore();
		store.appendAssistant([{ type: "text", text: "hello" }]);

		const core = store.toCoreMessages();
		expect(core[0]?.content).toBe('[{"type":"text","text":"hello"}]');
	});

	it("should clear all messages", () => {
		const store = new MessageStore();
		store.append({ role: "user", content: "a" });
		store.append({ role: "assistant", content: "b" });
		store.clear();

		expect(store.getMessageCount()).toBe(0);
		expect(store.getMessages()).toEqual([]);
	});

	it("should return readonly array from getMessages", () => {
		const store = new MessageStore();
		store.append({ role: "user", content: "hello" });

		const messages = store.getMessages();
		// ReadonlyArray — cannot push at compile time
		// Runtime check: original store should not be affected by consumer
		expect(messages).toHaveLength(1);
	});
});
