import { describe, it, expect } from "vitest";
import { ProcessAdapter } from "../src/process-adapter";
import type { InnerEvent } from "@agentweave/types";

describe("ProcessAdapter", () => {
	it("should run echo command and yield assistant message", async () => {
		const adapter = new ProcessAdapter({
			command: "echo",
			args: ["hello from adapter"],
			promptMode: "arg", // prompt appended to args — but echo ignores it
			parseJson: false,
		});

		const events: InnerEvent[] = [];
		const gen = adapter.run("ignored");

		for (;;) {
			const { value, done } = await gen.next();
			if (done) {
				expect(value.reason).toBe("completed");
				break;
			}
			events.push(value);
		}

		const messages = events.filter((e) => e.type === "message:assistant");
		expect(messages.length).toBeGreaterThanOrEqual(1);

		expect(adapter.getState().status).toBe("completed");
	});

	it("should parse JSON stdout as events", async () => {
		// Use node -e to output a JSON line
		const jsonLine = JSON.stringify({
			type: "message:assistant",
			sessionId: "ses_x",
			agentId: "agent_x",
			id: "e1",
			timestamp: Date.now(),
			content: [{ type: "text", text: "parsed!" }],
		});

		const adapter = new ProcessAdapter({
			command: "node",
			args: ["-e", `console.log('${jsonLine.replace(/'/g, "\\'")}')`],
			promptMode: "arg",
			parseJson: true,
		});

		const events: InnerEvent[] = [];
		const gen = adapter.run("test");

		for (;;) {
			const { value, done } = await gen.next();
			if (done) break;
			events.push(value);
		}

		// Should have parsed the JSON event
		const assistantMsgs = events.filter((e) => e.type === "message:assistant");
		expect(assistantMsgs.length).toBeGreaterThanOrEqual(1);
	});

	it("should report error for failing command", async () => {
		const adapter = new ProcessAdapter({
			command: "node",
			args: ["-e", "process.exit(1)"],
			promptMode: "arg",
		});

		const gen = adapter.run("test");

		for (;;) {
			const { value, done } = await gen.next();
			if (done) {
				expect(value.reason).toBe("error");
				break;
			}
		}
	});

	it("should abort running process", async () => {
		const adapter = new ProcessAdapter({
			command: "node",
			args: ["-e", "setInterval(() => {}, 1000)"], // hang forever
			promptMode: "arg",
		});

		// Start and immediately abort
		const gen = adapter.run("test");

		// Read first event (turn:start)
		await gen.next();

		// Abort
		adapter.abort("test");
		expect(adapter.getState().status).toBe("aborted");
	});

	it("should prevent double run", async () => {
		const adapter = new ProcessAdapter({
			command: "echo",
			args: ["hi"],
			promptMode: "arg",
		});

		// Run once to completion
		const gen = adapter.run("first");
		for (;;) {
			const { done } = await gen.next();
			if (done) break;
		}

		// Second run should throw
		expect(() => adapter.run("second")).toThrow("only be run once");
	});

	it("should return correct config", () => {
		const adapter = new ProcessAdapter({ command: "claude" });
		const config = adapter.getConfig();
		expect(config.model).toBe("process:claude");
		expect(config.tools).toEqual([]);
	});

	it("should return empty tools/messages", () => {
		const adapter = new ProcessAdapter({ command: "echo" });
		expect(adapter.getTools()).toEqual([]);
		expect(adapter.getMessages()).toEqual([]);
	});
});
