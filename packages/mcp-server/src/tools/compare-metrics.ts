import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { SDLCMetricsSnapshot } from "@agentweave/types";
import { MetricsCollector } from "@agentweave/inner-harness";
import { resolve, isAbsolute } from "node:path";

const snapshotSchema = z.object({
	taskId: z.string(),
	timestamp: z.number().optional(),
	m1_firstPassSuccess: z.boolean(),
	m2_testPassRate: z.number(),
	m3_scopeAccuracy: z.number(),
	m4_retryCount: z.number(),
	m5_costUsd: z.number(),
	m6_timeToCompletionMs: z.number(),
	m7_regressionDetected: z.boolean(),
	m8_planAccuracy: z.number(),
	m9_contextUtilization: z.number().nullable(),
	m10_codeQualityDelta: z.number().nullable(),
});

const inputSchema = {
	current: snapshotSchema.describe("The current run's M1-M10 snapshot."),
	baselinePath: z.string().optional().describe("Path to a previously saved baseline JSON. Relative paths resolved from cwd."),
	baseline: snapshotSchema.optional().describe("Baseline snapshot passed inline. If both baselinePath and baseline provided, baselinePath wins."),
};

export function registerCompareMetrics(server: McpServer): void {
	server.registerTool(
		"compare_metrics",
		{
			title: "Compare Metrics vs Baseline",
			description:
				"Compute deltas between a current M1-M10 snapshot and a baseline. " +
				"Baseline can be loaded from a file (baselinePath) or passed inline. " +
				"Returns current, baseline, and deltas (signed differences per metric). " +
				"Use after record_metrics to see if this run improved or regressed against the prior best.",
			inputSchema,
		},
		async (args) => {
			const current = args.current as SDLCMetricsSnapshot;

			let baseline: SDLCMetricsSnapshot | null = null;
			if (args.baselinePath) {
				const absPath = isAbsolute(args.baselinePath)
					? args.baselinePath
					: resolve(process.cwd(), args.baselinePath);
				baseline = MetricsCollector.loadBaseline(absPath);
			} else if (args.baseline) {
				baseline = args.baseline as SDLCMetricsSnapshot;
			}

			const comparison = MetricsCollector.compare(current, baseline);

			return {
				content: [
					{
						type: "text",
						text: JSON.stringify(comparison, null, 2),
					},
				],
			};
		},
	);
}
