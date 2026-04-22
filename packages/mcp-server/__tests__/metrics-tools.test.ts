import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { registerRecordMetrics } from "../src/tools/record-metrics";
import { registerCompareMetrics } from "../src/tools/compare-metrics";

let TMP: string;

beforeAll(() => {
	TMP = mkdtempSync(join(tmpdir(), "aw-mcp-metrics-"));
});

afterAll(() => {
	rmSync(TMP, { recursive: true, force: true });
});

async function setup() {
	const server = new McpServer({ name: "test", version: "0.0.0" });
	registerRecordMetrics(server);
	registerCompareMetrics(server);
	const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
	const client = new Client({ name: "test-client", version: "0.0.0" });
	await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
	return { client };
}

function parseToolResult(result: unknown): Record<string, unknown> {
	const r = result as { content: Array<{ type: string; text: string }> };
	return JSON.parse(r.content[0]!.text) as Record<string, unknown>;
}

const sampleSnapshot = {
	taskId: "T1",
	m1_firstPassSuccess: true,
	m2_testPassRate: 1.0,
	m3_scopeAccuracy: 0.95,
	m4_retryCount: 0,
	m5_costUsd: 0.02,
	m6_timeToCompletionMs: 41000,
	m7_regressionDetected: false,
	m8_planAccuracy: 1.0,
	m9_contextUtilization: null,
	m10_codeQualityDelta: null,
};

describe("record_metrics + compare_metrics round-trip", () => {
	it("persists a snapshot to disk and loads it back via compare_metrics", async () => {
		const { client } = await setup();
		const filePath = join(TMP, "baseline.json");

		const saveResult = await client.callTool({
			name: "record_metrics",
			arguments: { snapshot: sampleSnapshot, path: filePath },
		});
		const saveParsed = parseToolResult(saveResult);
		expect(saveParsed.saved).toBe(true);
		expect(existsSync(filePath)).toBe(true);

		const onDisk = JSON.parse(readFileSync(filePath, "utf-8"));
		expect(onDisk.taskId).toBe("T1");
		expect(onDisk.m2_testPassRate).toBe(1.0);

		const currentWithRetries = { ...sampleSnapshot, m4_retryCount: 2, m6_timeToCompletionMs: 60000 };
		const compareResult = await client.callTool({
			name: "compare_metrics",
			arguments: { current: currentWithRetries, baselinePath: filePath },
		});
		const compareParsed = parseToolResult(compareResult);
		expect(compareParsed.baseline).not.toBeNull();
		const deltas = compareParsed.deltas as Record<string, number>;
		expect(deltas.m4_retryCount).toBe(2);
		expect(deltas.m6_timeToCompletionMs).toBe(19000);
	});

	it("compare_metrics accepts inline baseline", async () => {
		const { client } = await setup();
		const result = await client.callTool({
			name: "compare_metrics",
			arguments: {
				current: { ...sampleSnapshot, m2_testPassRate: 0.8 },
				baseline: sampleSnapshot,
			},
		});
		const parsed = parseToolResult(result);
		const deltas = parsed.deltas as Record<string, number>;
		expect(deltas.m2_testPassRate).toBeCloseTo(-0.2, 5);
	});

	it("compare_metrics with no baseline returns empty deltas", async () => {
		const { client } = await setup();
		const result = await client.callTool({
			name: "compare_metrics",
			arguments: {
				current: sampleSnapshot,
				baselinePath: join(TMP, "does-not-exist.json"),
			},
		});
		const parsed = parseToolResult(result);
		expect(parsed.baseline).toBeNull();
		expect(parsed.deltas).toEqual({});
	});
});
