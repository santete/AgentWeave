import { describe, it, expect } from "vitest";
import { OutputPipeline } from "../src/governance/output-pipeline";
import type { RawOutput } from "@agentweave/types";
import { createEmptyTokenUsage } from "@agentweave/types";

function makeOutput(text: string): RawOutput {
	return {
		text,
		contentBlocks: [{ type: "text", text }],
		usage: createEmptyTokenUsage(),
		turnIndex: 1,
		toolCallCount: 0,
		model: "test",
	};
}

// ─── Core filter tests (v1.1.0, preserved) ──────────────────────

describe("OutputPipeline", () => {
	it("should pass through clean text unchanged", async () => {
		const pipeline = new OutputPipeline({
			gateMode: "batch",
			filters: [],
		});

		const result = await pipeline.process(makeOutput("Hello world"));
		expect(result.action).toBe("approve");
		expect(result.modifiedContent).toBeUndefined();
	});

	it("should redact OpenAI API keys", async () => {
		const pipeline = new OutputPipeline({
			gateMode: "batch",
			filters: [
				{ type: "secret", name: "secrets", patterns: [], replacement: "[SECRET]" },
			],
		});

		const result = await pipeline.process(
			makeOutput("Key is sk-1234567890abcdef1234567890abcdef"),
		);
		expect(result.action).toBe("approve");
		expect(result.modifiedContent).toContain("[SECRET]");
		expect(result.modifiedContent).not.toContain("sk-1234567890");
	});

	it("should redact AWS access keys", async () => {
		const pipeline = new OutputPipeline({
			gateMode: "batch",
			filters: [
				{ type: "secret", name: "secrets", patterns: [], replacement: "[SECRET]" },
			],
		});

		const result = await pipeline.process(
			makeOutput("AWS key: AKIAIOSFODNN7EXAMPLE"),
		);
		expect(result.modifiedContent).toContain("[SECRET]");
		expect(result.modifiedContent).not.toContain("AKIAIOSFODNN7EXAMPLE");
	});

	it("should redact GitHub tokens", async () => {
		const pipeline = new OutputPipeline({
			gateMode: "batch",
			filters: [
				{ type: "secret", name: "secrets", patterns: [], replacement: "[SECRET]" },
			],
		});

		const result = await pipeline.process(
			makeOutput("Token: ghp_ABCDEFghijklmnopqrstuvwxyz0123456789"),
		);
		expect(result.modifiedContent).toContain("[SECRET]");
	});

	it("should redact emails (PII filter)", async () => {
		const pipeline = new OutputPipeline({
			gateMode: "batch",
			filters: [
				{ type: "pii", name: "pii", entities: ["email"], replacement: "[EMAIL]" },
			],
		});

		const result = await pipeline.process(
			makeOutput("Contact: user@example.com for help"),
		);
		expect(result.modifiedContent).toContain("[EMAIL]");
		expect(result.modifiedContent).not.toContain("user@example.com");
	});

	it("should redact SSNs (PII filter)", async () => {
		const pipeline = new OutputPipeline({
			gateMode: "batch",
			filters: [
				{ type: "pii", name: "pii", entities: ["ssn"], replacement: "[SSN]" },
			],
		});

		const result = await pipeline.process(
			makeOutput("SSN: 123-45-6789"),
		);
		expect(result.modifiedContent).toContain("[SSN]");
	});

	it("should apply custom regex filter", async () => {
		const pipeline = new OutputPipeline({
			gateMode: "batch",
			filters: [
				{ type: "regex", name: "paths", pattern: "/home/[^/]+/", replacement: "/home/[USER]/" },
			],
		});

		const result = await pipeline.process(
			makeOutput("File at /home/john/documents"),
		);
		expect(result.modifiedContent).toContain("/home/[USER]/");
	});

	it("should apply denylist filter", async () => {
		const pipeline = new OutputPipeline({
			gateMode: "batch",
			filters: [
				{ type: "denylist", name: "denylist", words: ["confidential", "internal-only"], replacement: "[REDACTED]" },
			],
		});

		const result = await pipeline.process(
			makeOutput("This is confidential information for internal-only use"),
		);
		expect(result.modifiedContent).toContain("[REDACTED]");
		expect(result.modifiedContent).not.toContain("confidential");
		expect(result.modifiedContent).not.toContain("internal-only");
	});

	it("should apply multiple filters in sequence", async () => {
		const pipeline = new OutputPipeline({
			gateMode: "batch",
			filters: [
				{ type: "secret", name: "secrets", patterns: [], replacement: "[SECRET]" },
				{ type: "pii", name: "pii", entities: ["email"], replacement: "[EMAIL]" },
			],
		});

		const result = await pipeline.process(
			makeOutput("Key: sk-abcdefghijklmnopqrstuvwxyz1234 Email: test@test.com"),
		);
		expect(result.modifiedContent).toContain("[SECRET]");
		expect(result.modifiedContent).toContain("[EMAIL]");
	});

	it("should work in streaming mode (filterStreamBuffer)", () => {
		const pipeline = new OutputPipeline({
			gateMode: "streaming",
			filters: [
				{ type: "secret", name: "secrets", patterns: [], replacement: "[SECRET]" },
			],
		});

		const { text, redacted } = pipeline.filterStreamBuffer(
			"Key is sk-1234567890abcdef1234567890abcdef",
		);
		expect(redacted).toBe(true);
		expect(text).toContain("[SECRET]");
	});

	it("should report redaction count in stages", async () => {
		const pipeline = new OutputPipeline({
			gateMode: "batch",
			filters: [
				{ type: "pii", name: "pii", entities: ["email"], replacement: "[EMAIL]" },
			],
		});

		const result = await pipeline.process(
			makeOutput("user@a.com and user@b.com"),
		);
		const filterStage = result.stages.find((s) => s.stage === "filter");
		expect(filterStage?.details).toContain("redaction");
	});
});

// ─── Validate Stage ──────────────────────────────────────────────

describe("OutputPipeline — validate", () => {
	it("should reject output with safety violation", async () => {
		const pipeline = new OutputPipeline({
			gateMode: "batch",
			filters: [],
			validate: {
				enabled: true,
				rules: [{ type: "safety", name: "safety-check", action: "reject" }],
			},
		});

		const result = await pipeline.process(
			makeOutput("Here is how to make a bomb at home"),
		);
		expect(result.action).toBe("reject");
		expect(result.reason).toContain("Safety violation");
	});

	it("should pass clean text through safety check", async () => {
		const pipeline = new OutputPipeline({
			gateMode: "batch",
			filters: [],
			validate: {
				enabled: true,
				rules: [{ type: "safety", name: "safety-check", action: "reject" }],
			},
		});

		const result = await pipeline.process(
			makeOutput("Here is how to make a sandwich"),
		);
		expect(result.action).toBe("approve");
	});

	it("should reject output exceeding length limit", async () => {
		const pipeline = new OutputPipeline({
			gateMode: "batch",
			filters: [],
			validate: {
				enabled: true,
				rules: [{ type: "length", name: "max-length", action: "reject", maxChars: 50 }],
			},
		});

		const result = await pipeline.process(
			makeOutput("x".repeat(100)),
		);
		expect(result.action).toBe("reject");
		expect(result.reason).toContain("exceeds max length");
	});

	it("should pass output within length limit", async () => {
		const pipeline = new OutputPipeline({
			gateMode: "batch",
			filters: [],
			validate: {
				enabled: true,
				rules: [{ type: "length", name: "max-length", action: "reject", maxChars: 1000 }],
			},
		});

		const result = await pipeline.process(makeOutput("Short text"));
		expect(result.action).toBe("approve");
	});

	it("should validate JSON output against schema", async () => {
		const schema = JSON.stringify({
			type: "object",
			required: ["name", "age"],
			properties: {
				name: { type: "string" },
				age: { type: "number" },
			},
		});

		const pipeline = new OutputPipeline({
			gateMode: "batch",
			filters: [],
			validate: {
				enabled: true,
				rules: [{ type: "schema", name: "json-schema", action: "reject", schema }],
			},
		});

		// Valid JSON
		const valid = await pipeline.process(makeOutput('{"name":"Alice","age":30}'));
		expect(valid.action).toBe("approve");

		// Missing required field
		const missing = await pipeline.process(makeOutput('{"name":"Alice"}'));
		expect(missing.action).toBe("reject");
		expect(missing.reason).toContain("Missing required field");

		// Not JSON at all
		const notJson = await pipeline.process(makeOutput("not json"));
		expect(notJson.action).toBe("reject");
		expect(notJson.reason).toContain("not valid JSON");
	});

	it("should support retry action on validation failure", async () => {
		const pipeline = new OutputPipeline({
			gateMode: "batch",
			filters: [],
			validate: {
				enabled: true,
				rules: [{
					type: "length",
					name: "too-long",
					action: "retry",
					maxChars: 10,
					retryPrompt: "Please shorten your response",
				}],
			},
		});

		const result = await pipeline.process(makeOutput("x".repeat(100)));
		expect(result.action).toBe("retry");
		expect(result.retryPrompt).toBe("Please shorten your response");
	});

	it("should short-circuit on first validation failure", async () => {
		const pipeline = new OutputPipeline({
			gateMode: "batch",
			filters: [
				{ type: "pii", name: "pii", entities: ["email"], replacement: "[EMAIL]" },
			],
			validate: {
				enabled: true,
				rules: [{ type: "length", name: "max-length", action: "reject", maxChars: 5 }],
			},
		});

		const result = await pipeline.process(
			makeOutput("user@example.com is the contact"),
		);
		expect(result.action).toBe("reject");
		// Filter stage should NOT be in stages (short-circuited)
		const filterStage = result.stages.find((s) => s.stage === "filter");
		expect(filterStage).toBeUndefined();
	});

	it("should skip validation when not enabled", async () => {
		const pipeline = new OutputPipeline({
			gateMode: "batch",
			filters: [],
			validate: { enabled: false, rules: [{ type: "length", name: "test", action: "reject", maxChars: 1 }] },
		});

		const result = await pipeline.process(makeOutput("long text here"));
		expect(result.action).toBe("approve");
	});
});

// ─── Transform Stage ─────────────────────────────────────────────

describe("OutputPipeline — transform", () => {
	it("should prepend header template", async () => {
		const pipeline = new OutputPipeline({
			gateMode: "batch",
			filters: [],
			transform: {
				enabled: true,
				transforms: [{ type: "template", name: "header", position: "header", content: "--- START ---" }],
			},
		});

		const result = await pipeline.process(makeOutput("Hello world"));
		expect(result.modifiedContent).toBe("--- START ---\nHello world");
	});

	it("should append footer template", async () => {
		const pipeline = new OutputPipeline({
			gateMode: "batch",
			filters: [],
			transform: {
				enabled: true,
				transforms: [{ type: "template", name: "footer", position: "footer", content: "--- END ---" }],
			},
		});

		const result = await pipeline.process(makeOutput("Hello world"));
		expect(result.modifiedContent).toBe("Hello world\n--- END ---");
	});

	it("should apply header + footer in order", async () => {
		const pipeline = new OutputPipeline({
			gateMode: "batch",
			filters: [],
			transform: {
				enabled: true,
				transforms: [
					{ type: "template", name: "header", position: "header", content: "HEADER" },
					{ type: "template", name: "footer", position: "footer", content: "FOOTER" },
				],
			},
		});

		const result = await pipeline.process(makeOutput("body"));
		expect(result.modifiedContent).toBe("HEADER\nbody\nFOOTER");
	});

	it("should skip transform when not enabled", async () => {
		const pipeline = new OutputPipeline({
			gateMode: "batch",
			filters: [],
			transform: { enabled: false, transforms: [{ type: "template", name: "h", position: "header", content: "X" }] },
		});

		const result = await pipeline.process(makeOutput("Hello"));
		expect(result.modifiedContent).toBeUndefined();
	});
});

// ─── Pipeline Metrics ────────────────────────────────────────────

describe("OutputPipeline — metrics", () => {
	it("should track totalProcessed", async () => {
		const pipeline = new OutputPipeline({ gateMode: "batch", filters: [] });
		await pipeline.process(makeOutput("a"));
		await pipeline.process(makeOutput("b"));
		expect(pipeline.getMetrics().totalProcessed).toBe(2);
	});

	it("should track totalRedactions", async () => {
		const pipeline = new OutputPipeline({
			gateMode: "batch",
			filters: [
				{ type: "pii", name: "pii", entities: ["email"], replacement: "[EMAIL]" },
			],
		});
		await pipeline.process(makeOutput("user@a.com"));
		await pipeline.process(makeOutput("clean text"));
		expect(pipeline.getMetrics().totalRedactions).toBe(1);
	});

	it("should track totalRejections", async () => {
		const pipeline = new OutputPipeline({
			gateMode: "batch",
			filters: [],
			validate: {
				enabled: true,
				rules: [{ type: "length", name: "short", action: "reject", maxChars: 5 }],
			},
		});
		await pipeline.process(makeOutput("short")); // passes
		await pipeline.process(makeOutput("this is too long")); // rejected
		expect(pipeline.getMetrics().totalRejections).toBe(1);
	});

	it("should track stage timing", async () => {
		const pipeline = new OutputPipeline({ gateMode: "batch", filters: [] });
		await pipeline.process(makeOutput("test"));
		const timing = pipeline.getMetrics().stageTiming;
		expect(timing.validate).toBeDefined();
		expect(timing.validate!.count).toBe(1);
		expect(timing.validate!.totalMs).toBeGreaterThanOrEqual(0);
		expect(timing.filter).toBeDefined();
		expect(timing.transform).toBeDefined();
	});

	it("should track per-filter redaction counts", async () => {
		const pipeline = new OutputPipeline({
			gateMode: "batch",
			filters: [
				{ type: "pii", name: "pii-filter", entities: ["email"], replacement: "[EMAIL]" },
				{ type: "secret", name: "secret-filter", patterns: [], replacement: "[SECRET]" },
			],
		});
		await pipeline.process(makeOutput("user@a.com and sk-abcdefghijklmnopqrstuvwxyz1234"));
		const counts = pipeline.getMetrics().filterRedactionCounts;
		expect(counts["pii-filter"]).toBeGreaterThanOrEqual(1);
		expect(counts["secret-filter"]).toBeGreaterThanOrEqual(1);
	});
});

// ─── Full Pipeline Integration ───────────────────────────────────

describe("OutputPipeline — full pipeline", () => {
	it("validate pass → filter redacts → transform adds footer → approve", async () => {
		const pipeline = new OutputPipeline({
			gateMode: "batch",
			filters: [
				{ type: "secret", name: "secrets", patterns: [], replacement: "[SECRET]" },
			],
			validate: {
				enabled: true,
				rules: [{ type: "length", name: "max", action: "reject", maxChars: 1000 }],
			},
			transform: {
				enabled: true,
				transforms: [{ type: "template", name: "footer", position: "footer", content: "-- AgentWeave governed" }],
			},
		});

		const result = await pipeline.process(
			makeOutput("API key: sk-1234567890abcdef1234567890abcdef"),
		);
		expect(result.action).toBe("approve");
		expect(result.modifiedContent).toContain("[SECRET]");
		expect(result.modifiedContent).toContain("-- AgentWeave governed");
		expect(result.stages).toHaveLength(4); // validate, filter, transform, review
		expect(result.stages.every((s) => s.passed)).toBe(true);
	});
});
