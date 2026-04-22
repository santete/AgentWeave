import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import {
	StdoutSink,
	FileSink,
	WebhookSink,
	type AlertSink,
} from "../src/observability/alert-sink";
import { AlertEngine } from "../src/observability/alert-engine";
import type { AlertEvent, MonitorSnapshot } from "@agentweave/types";
import { createEmptyTokenUsage } from "@agentweave/types";

function makeSnapshot(overrides: Partial<MonitorSnapshot> = {}): MonitorSnapshot {
	return {
		sessionId: "ses_1",
		timestamp: Date.now(),
		turnCount: 3,
		totalUsage: { ...createEmptyTokenUsage(), totalCost: 0.5 },
		turnMetrics: [],
		toolMetrics: new Map(),
		errorCount: 0,
		permissionDeniedCount: 0,
		sessionDurationMs: 1000,
		...overrides,
	};
}

function makeAlert(overrides: Partial<AlertEvent> = {}): AlertEvent {
	return {
		ruleId: "r1",
		ruleName: "budget_warning",
		severity: "warning",
		message: "test alert",
		timestamp: Date.now(),
		sessionId: "ses_1",
		snapshot: makeSnapshot(),
		...overrides,
	};
}

// ─── StdoutSink ────────────────────────────────────────────────────

describe("StdoutSink", () => {
	it("writes a formatted line to the given stream", async () => {
		const chunks: string[] = [];
		const stream = new Writable({
			write(chunk, _enc, cb) {
				chunks.push(chunk.toString());
				cb();
			},
		});

		const sink = new StdoutSink({ stream });
		await sink.publish(makeAlert());

		expect(chunks.length).toBe(1);
		expect(chunks[0]).toContain("[WARNING]");
		expect(chunks[0]).toContain("budget_warning");
		expect(chunks[0]).toContain("ses_1");
	});

	it("filters by severity when severityFilter set", async () => {
		const chunks: string[] = [];
		const stream = new Writable({
			write(chunk, _enc, cb) {
				chunks.push(chunk.toString());
				cb();
			},
		});

		const sink = new StdoutSink({ stream, severityFilter: ["critical"] });
		await sink.publish(makeAlert({ severity: "warning" }));
		await sink.publish(makeAlert({ severity: "critical" }));

		expect(chunks.length).toBe(1);
		expect(chunks[0]).toContain("[CRITICAL]");
	});
});

// ─── FileSink ──────────────────────────────────────────────────────

describe("FileSink", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "alert-sink-"));
	});

	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true });
	});

	it("appends one JSONL entry per publish", async () => {
		const path = join(tmpDir, "alerts.jsonl");
		const sink = new FileSink({ path });

		await sink.publish(makeAlert({ ruleName: "a" }));
		await sink.publish(makeAlert({ ruleName: "b" }));

		const content = readFileSync(path, "utf8");
		const lines = content.trim().split("\n");
		expect(lines).toHaveLength(2);

		const first = JSON.parse(lines[0]!);
		expect(first.ruleName).toBe("a");
		expect(first.severity).toBe("warning");
		expect(first.cost).toBe(0.5);
	});

	it("creates parent directories on first publish", async () => {
		const path = join(tmpDir, "nested", "dir", "alerts.jsonl");
		const sink = new FileSink({ path });

		await sink.publish(makeAlert());
		expect(existsSync(path)).toBe(true);
	});

	it("does not throw on unwritable path", async () => {
		// An invalid path segment that mkdir can't create on both platforms.
		const path = "\0invalid\0/file.jsonl";
		const sink = new FileSink({ path });

		await expect(sink.publish(makeAlert())).resolves.toBeUndefined();
	});
});

// ─── WebhookSink ───────────────────────────────────────────────────

describe("WebhookSink", () => {
	beforeEach(() => {
		vi.restoreAllMocks();
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("POSTs alert body on matching severity", async () => {
		const fetchSpy = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValue(new Response("", { status: 200 }));

		const sink = new WebhookSink({
			url: "http://x/",
			severityFilter: ["warning", "critical"],
			maxRetries: 0,
		});

		await sink.publish(makeAlert({ severity: "warning" }));
		expect(fetchSpy).toHaveBeenCalledTimes(1);

		const [url, init] = fetchSpy.mock.calls[0]!;
		expect(url).toBe("http://x/");
		const body = JSON.parse(String((init as RequestInit).body));
		expect(body.ruleName).toBe("budget_warning");
	});

	it("skips publishing when severity is filtered out", async () => {
		const fetchSpy = vi.spyOn(globalThis, "fetch");

		const sink = new WebhookSink({
			url: "http://x/",
			severityFilter: ["critical"],
		});
		await sink.publish(makeAlert({ severity: "info" }));

		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it("retries on 5xx and swallows final failure", async () => {
		const fetchSpy = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValue(new Response("", { status: 503 }));

		const sink = new WebhookSink({
			url: "http://x/",
			severityFilter: ["warning"],
			maxRetries: 2,
			timeoutMs: 100,
		});

		// publish() must not throw even when all retries fail.
		await expect(sink.publish(makeAlert({ severity: "warning" }))).resolves.toBeUndefined();
		// 1 initial + 2 retries = 3
		expect(fetchSpy).toHaveBeenCalledTimes(3);
	}, 20_000);

	it("does not throw on network error", async () => {
		vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("ECONNREFUSED"));

		const sink = new WebhookSink({
			url: "http://x/",
			severityFilter: ["warning"],
			maxRetries: 0,
		});

		await expect(sink.publish(makeAlert({ severity: "warning" }))).resolves.toBeUndefined();
	});
});

// ─── AlertEngine sink dispatch ─────────────────────────────────────

describe("AlertEngine.addSink — dispatch semantics", () => {
	it("dispatches fired alerts to every registered sink", async () => {
		const engine = new AlertEngine();
		const a: AlertSink = { name: "a", publish: vi.fn().mockResolvedValue(undefined) };
		const b: AlertSink = { name: "b", publish: vi.fn().mockResolvedValue(undefined) };
		engine.addSink(a);
		engine.addSink(b);

		engine.addRule({ name: "x", severity: "info", cooldownMs: 0, check: () => true });
		engine.check(makeSnapshot());

		// Fire-and-forget: wait a macrotask so the .catch() microtasks resolve.
		await new Promise((r) => setImmediate(r));

		expect(a.publish).toHaveBeenCalledOnce();
		expect(b.publish).toHaveBeenCalledOnce();
	});

	it("one sink throwing does not block the other sink", async () => {
		const engine = new AlertEngine();
		const bad: AlertSink = { name: "bad", publish: vi.fn().mockRejectedValue(new Error("down")) };
		const good: AlertSink = { name: "good", publish: vi.fn().mockResolvedValue(undefined) };
		engine.addSink(bad);
		engine.addSink(good);

		engine.addRule({ name: "x", severity: "info", cooldownMs: 0, check: () => true });
		// Must not throw despite bad sink rejecting
		expect(() => engine.check(makeSnapshot())).not.toThrow();

		await new Promise((r) => setImmediate(r));

		expect(bad.publish).toHaveBeenCalledOnce();
		expect(good.publish).toHaveBeenCalledOnce();
	});

	it("closeSinks() invokes close() on each sink", async () => {
		const engine = new AlertEngine();
		const closeFn = vi.fn().mockResolvedValue(undefined);
		engine.addSink({ name: "s", publish: async () => {}, close: closeFn });

		await engine.closeSinks();
		expect(closeFn).toHaveBeenCalledOnce();
	});
});
