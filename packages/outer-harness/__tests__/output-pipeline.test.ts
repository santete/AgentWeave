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
