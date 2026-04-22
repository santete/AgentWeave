import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { QualityGateModule } from "@agentweave/inner-harness";
import type { SDLCExecutionResult, QualityGateCheck } from "@agentweave/types";
import { buildStandaloneContext } from "../context";

const checkSchema = z.object({
	type: z.enum(["compile", "test", "lint", "typecheck", "custom"]),
	command: z.string().describe("Shell command, e.g. 'npm test' or 'tsc --noEmit'. Binary must be in safe allowlist."),
	required: z.boolean().describe("If true, failing this check fails the gate. If false, it's a warning only."),
});

const inputSchema = {
	checks: z.array(checkSchema).describe("List of checks to run. Commands are validated against a safe binary allowlist."),
	cwd: z.string().optional().describe("Working directory for commands. Defaults to the MCP server's cwd."),
};

export function registerRunQualityGate(server: McpServer): void {
	server.registerTool(
		"run_quality_gate",
		{
			title: "Run Quality Gate",
			description:
				"Run test/lint/typecheck/compile/custom commands as a quality gate. " +
				"Each check's command is validated against an allowlist of safe binaries " +
				"(npm, pnpm, vitest, jest, tsc, eslint, biome, etc.) and shell metacharacters are rejected. " +
				"Returns per-check pass/fail, aggregate passed, and M10 lint warning count if a 'lint' check runs. " +
				"Use this after editing files to verify no regressions.",
			inputSchema,
		},
		async (args) => {
			const checks = (args.checks ?? []) as QualityGateCheck[];

			const { context, collector } = buildStandaloneContext({
				cwd: args.cwd,
				configOverrides: {
					qualityGate: { enabled: true, checks },
				},
			});

			const fakeExec: SDLCExecutionResult = {
				success: true,
				changedFiles: [],
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

			const gate = new QualityGateModule();
			const result = await gate.execute(fakeExec, context);

			const lintWarnings = collector.get("lintWarnings");

			return {
				content: [
					{
						type: "text",
						text: JSON.stringify(
							{
								passed: result.passed,
								score: result.score,
								lintWarnings: typeof lintWarnings === "number" ? lintWarnings : null,
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
