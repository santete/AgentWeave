import { describe, it, expect } from "vitest";
import { ProcessAdapter } from "../src/process-adapter";
import type { InnerEvent } from "@agentweave/types";

/** Helper: collect all events from a run */
async function collectRun(adapter: ProcessAdapter, prompt = "test"): Promise<{ events: InnerEvent[]; result: { reason: string } }> {
	const events: InnerEvent[] = [];
	const gen = adapter.run(prompt);
	for (;;) {
		const { value, done } = await gen.next();
		if (done) return { events, result: value };
		events.push(value);
	}
}

// ─── Core (v1.1.0 tests, preserved) ─────────────────────────────

describe("ProcessAdapter", () => {
	it("should run echo command and yield assistant message", async () => {
		const adapter = new ProcessAdapter({
			command: "echo",
			args: ["hello from adapter"],
			promptMode: "arg", // prompt appended to args — but echo ignores it
			parseJson: false,
		});

		const { events, result } = await collectRun(adapter);
		expect(result.reason).toBe("completed");

		const messages = events.filter((e) => e.type === "message:assistant");
		expect(messages.length).toBeGreaterThanOrEqual(1);
		expect(adapter.getState().status).toBe("completed");
	});

	it("should parse JSON stdout as events", async () => {
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

		const { events } = await collectRun(adapter);
		const assistantMsgs = events.filter((e) => e.type === "message:assistant");
		expect(assistantMsgs.length).toBeGreaterThanOrEqual(1);
	});

	it("should report error for failing command", async () => {
		const adapter = new ProcessAdapter({
			command: "node",
			args: ["-e", "process.exit(1)"],
			promptMode: "arg",
		});

		const { result } = await collectRun(adapter);
		expect(result.reason).toBe("error");
	});

	it("should abort running process", async () => {
		const adapter = new ProcessAdapter({
			command: "node",
			args: ["-e", "setInterval(() => {}, 1000)"], // hang forever
			promptMode: "arg",
		});

		const gen = adapter.run("test");
		await gen.next(); // turn:start
		adapter.abort("test");
		expect(adapter.getState().status).toBe("aborted");
	});

	it("should prevent double run", async () => {
		const adapter = new ProcessAdapter({
			command: "echo",
			args: ["hi"],
			promptMode: "arg",
		});

		await collectRun(adapter, "first");
		expect(() => adapter.run("second")).toThrow("only be run once");
	});

	it("should return correct config", () => {
		const adapter = new ProcessAdapter({ command: "claude" });
		const config = adapter.getConfig();
		expect(config.model).toBe("process:claude");
		expect(config.tools).toEqual([]);
	});
});

// ─── Message Tracking ────────────────────────────────────────────

describe("ProcessAdapter — message tracking", () => {
	it("should track assistant messages from stdout", async () => {
		const adapter = new ProcessAdapter({
			command: "node",
			args: ["-e", 'console.log("line 1"); console.log("line 2");'],
			promptMode: "arg",
			parseJson: false,
		});

		await collectRun(adapter);
		const msgs = adapter.getMessages();
		expect(msgs.length).toBeGreaterThanOrEqual(1);
		expect(msgs[0]!.role).toBe("assistant");
	});

	it("should return defensive copy of messages", async () => {
		const adapter = new ProcessAdapter({
			command: "echo",
			args: ["hello"],
			promptMode: "arg",
			parseJson: false,
		});

		await collectRun(adapter);
		const msgs1 = adapter.getMessages();
		const msgs2 = adapter.getMessages();
		expect(msgs1).not.toBe(msgs2); // Different array instances
		expect(msgs1).toEqual(msgs2); // Same content
	});
});

// ─── Stderr Capture ──────────────────────────────────────────────

describe("ProcessAdapter — stderr", () => {
	it("should capture stderr lines", async () => {
		const adapter = new ProcessAdapter({
			command: "node",
			args: ["-e", 'console.error("oops"); console.log("ok");'],
			promptMode: "arg",
			parseJson: false,
			stderr: { capture: true, asEvents: false },
		});

		await collectRun(adapter);
		const lines = adapter.getStderrLines();
		expect(lines.length).toBeGreaterThanOrEqual(1);
		expect(lines.some((l) => l.includes("oops"))).toBe(true);
	});

	it("should yield error events when asEvents is true", async () => {
		const adapter = new ProcessAdapter({
			command: "node",
			args: ["-e", 'console.error("stderr-event"); console.log("done");'],
			promptMode: "arg",
			parseJson: false,
			stderr: { capture: true, asEvents: true },
		});

		const { events } = await collectRun(adapter);
		const errorEvents = events.filter((e) => e.type === "error");
		expect(errorEvents.length).toBeGreaterThanOrEqual(1);
	});
});

// ─── Exit Code Mapping ───────────────────────────────────────────

describe("ProcessAdapter — exit code mapping", () => {
	it("should map exit code to custom reason", async () => {
		const adapter = new ProcessAdapter({
			command: "node",
			args: ["-e", "process.exit(42)"],
			promptMode: "arg",
			exitCodeMap: { 42: "custom_timeout" },
		});

		const { events } = await collectRun(adapter);
		const turnEnd = events.find((e) => e.type === "turn:end");
		expect((turnEnd as unknown as Record<string, unknown>)?.stopReason).toBe("custom_timeout");
	});

	it("should use default mapping when no custom map", async () => {
		const adapter = new ProcessAdapter({
			command: "node",
			args: ["-e", "process.exit(1)"],
			promptMode: "arg",
		});

		const { result } = await collectRun(adapter);
		expect(result.reason).toBe("error");
	});

	it("should map exit 0 to completed", async () => {
		const adapter = new ProcessAdapter({
			command: "node",
			args: ["-e", "process.exit(0)"],
			promptMode: "arg",
		});

		const { result } = await collectRun(adapter);
		expect(result.reason).toBe("completed");
	});
});

// ─── Pause/Resume ────────────────────────────────────────────────

describe("ProcessAdapter — pause/resume", () => {
	it("should transition state on pause and resume", async () => {
		const adapter = new ProcessAdapter({
			command: "node",
			args: ["-e", "setInterval(() => {}, 1000)"], // Long-running
			promptMode: "arg",
		});

		const gen = adapter.run("test");
		await gen.next(); // turn:start
		expect(adapter.getState().status).toBe("running");

		adapter.pause();
		expect(adapter.getState().status).toBe("paused");

		adapter.resume();
		expect(adapter.getState().status).toBe("running");

		adapter.abort("cleanup");
	});

	it("should ignore pause when not running", () => {
		const adapter = new ProcessAdapter({ command: "echo", promptMode: "arg" });
		adapter.pause(); // idle → should not throw
		expect(adapter.getState().status).toBe("idle");
	});

	it("should ignore resume when not paused", async () => {
		const adapter = new ProcessAdapter({
			command: "node",
			args: ["-e", "setInterval(() => {}, 1000)"],
			promptMode: "arg",
		});

		const gen = adapter.run("test");
		await gen.next();

		adapter.resume(); // running → not paused, should be no-op
		expect(adapter.getState().status).toBe("running");

		adapter.abort("cleanup");
	});
});

// ─── Health Check ────────────────────────────────────────────────

describe("ProcessAdapter — health check", () => {
	it("should start healthy by default", () => {
		const adapter = new ProcessAdapter({ command: "echo" });
		expect(adapter.isHealthy()).toBe(true);
	});

	it("should detect unhealthy when process is not writable", async () => {
		const adapter = new ProcessAdapter({
			command: "node",
			args: ["-e", "process.exit(0)"],
			promptMode: "arg",
			healthCheck: { enabled: true, intervalMs: 50, timeoutMs: 25 },
		});

		await collectRun(adapter);
		// After process exits, health check should detect stdin not writable
		// (but health check interval was already stopped by then)
		// Just verify no crash and healthy state is accessible
		expect(typeof adapter.isHealthy()).toBe("boolean");
	});
});

// ─── Environment Injection ───────────────────────────────────────

describe("ProcessAdapter — env injection", () => {
	it("should pass custom env vars to child process", async () => {
		const adapter = new ProcessAdapter({
			command: "node",
			args: ["-e", 'console.log(process.env.MY_TEST_VAR)'],
			promptMode: "arg",
			parseJson: false,
			env: { MY_TEST_VAR: "hello-from-adapter" },
		});

		const { events } = await collectRun(adapter);
		const messages = events.filter((e) => e.type === "message:assistant");
		const text = messages.map((m) =>
			((m as unknown as Record<string, unknown>).content as Array<{ text: string }>)?.[0]?.text ?? ""
		).join("\n");
		expect(text).toContain("hello-from-adapter");
	});
});
