import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { PatchValidatorModule } from "@agentweave/inner-harness";
import type { SDLCExecutionResult } from "@agentweave/types";
import { buildStandaloneContext } from "../context";

const inputSchema = {
	changedFiles: z.array(z.string()).describe("Files modified by the agent (relative paths)."),
	estimatedFiles: z.array(z.string()).optional().describe("Files the plan said would change. Used for scope accuracy."),
	maxFilesChanged: z.number().int().positive().optional().describe("Hard limit on number of changed files. Default 30."),
	scopeStrict: z.boolean().optional().describe("If true, scope violations are errors (hard gate). Default false (warnings)."),
	executionSucceeded: z.boolean().optional().describe("Whether the agent reported success. Default true."),
};

export function registerValidatePatch(server: McpServer): void {
	server.registerTool(
		"validate_patch",
		{
			title: "Validate Patch Scope",
			description:
				"Validate that a set of changed files matches the expected scope of a task. " +
				"Runs three checks: file count limit, out-of-scope detection (vs estimatedFiles), " +
				"and empty-patch guard. Returns pass/fail, per-check details, and M3 scope accuracy score. " +
				"Pure static analysis — does not run any code.",
			inputSchema,
		},
		async (args) => {
			const changedFiles = args.changedFiles ?? [];
			const estimatedFiles = args.estimatedFiles ?? [];

			const { context, collector } = buildStandaloneContext({
				configOverrides: {
					patchValidator: {
						enabled: true,
						maxFilesChanged: args.maxFilesChanged ?? 30,
						scopeStrict: args.scopeStrict ?? false,
					},
				},
			});

			const fakeExec: SDLCExecutionResult = {
				success: args.executionSucceeded ?? true,
				changedFiles,
				output: "",
				usage: {
					inputTokens: 0,
					outputTokens: 0,
					thinkingTokens: 0,
					cacheReadTokens: 0,
					cacheCreationTokens: 0,
					totalCost: 0,
				},
				durationMs: 0,
				terminalReason: "mcp_invocation",
			};

			const validator = new PatchValidatorModule();
			const result = await validator.execute(
				{ result: fakeExec, estimatedFiles },
				context,
			);

			const scopeAccuracy = collector.get("scopeAccuracy");

			return {
				content: [
					{
						type: "text",
						text: JSON.stringify(
							{
								passed: result.passed,
								score: result.score,
								scopeAccuracy: typeof scopeAccuracy === "number" ? scopeAccuracy : null,
								checks: result.checks,
							},
							null,
							2,
						),
					},
				],
			};
		},
	);
}
