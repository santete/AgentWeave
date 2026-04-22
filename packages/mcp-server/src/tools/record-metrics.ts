import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { SDLCMetricsSnapshot } from "@agentweave/types";
import { MetricsCollector } from "@agentweave/inner-harness";
import { resolve, isAbsolute } from "node:path";

const snapshotSchema = z.object({
	taskId: z.string(),
	timestamp: z.number().optional(),
	m1_firstPassSuccess: z.boolean(),
	m2_testPassRate: z.number().min(0).max(1),
	m3_scopeAccuracy: z.number().min(0).max(1),
	m4_retryCount: z.number().int().min(0),
	m5_costUsd: z.number().min(0),
	m6_timeToCompletionMs: z.number().min(0),
	m7_regressionDetected: z.boolean(),
	m8_planAccuracy: z.number().min(0).max(1),
	m9_contextUtilization: z.number().min(0).max(1).nullable(),
	m10_codeQualityDelta: z.number().nullable(),
});

const inputSchema = {
	snapshot: snapshotSchema.describe("M1-M10 snapshot for this task run."),
	path: z.string().describe("File path to persist JSON to. Relative paths resolved from cwd."),
};

export function registerRecordMetrics(server: McpServer): void {
	server.registerTool(
		"record_metrics",
		{
			title: "Record Metrics Snapshot",
			description:
				"Persist an M1-M10 metrics snapshot for a task run to a JSON file. " +
				"Used to capture outcomes the agent CAN observe (scope accuracy, test pass rate, retry count) " +
				"so later runs can compare against this baseline. Creates parent directories as needed.",
			inputSchema,
		},
		async (args) => {
			const snapshot: SDLCMetricsSnapshot = {
				taskId: args.snapshot.taskId,
				timestamp: args.snapshot.timestamp ?? Date.now(),
				m1_firstPassSuccess: args.snapshot.m1_firstPassSuccess,
				m2_testPassRate: args.snapshot.m2_testPassRate,
				m3_scopeAccuracy: args.snapshot.m3_scopeAccuracy,
				m4_retryCount: args.snapshot.m4_retryCount,
				m5_costUsd: args.snapshot.m5_costUsd,
				m6_timeToCompletionMs: args.snapshot.m6_timeToCompletionMs,
				m7_regressionDetected: args.snapshot.m7_regressionDetected,
				m8_planAccuracy: args.snapshot.m8_planAccuracy,
				m9_contextUtilization: args.snapshot.m9_contextUtilization,
				m10_codeQualityDelta: args.snapshot.m10_codeQualityDelta,
			};

			const absPath = isAbsolute(args.path) ? args.path : resolve(process.cwd(), args.path);
			MetricsCollector.saveBaseline(absPath, snapshot);

			return {
				content: [
					{
						type: "text",
						text: JSON.stringify({ saved: true, path: absPath, taskId: snapshot.taskId }, null, 2),
					},
				],
			};
		},
	);
}
