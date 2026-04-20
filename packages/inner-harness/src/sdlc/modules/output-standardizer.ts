/**
 * OutputStandardizer — Generate commit message, PR title/description.
 * Uses LLM if available, falls back to template.
 */

import type {
	SDLCModule,
	SDLCModuleContext,
	SDLCExecutionResult,
	SDLCOutput,
} from "@agentweave/types";

const OUTPUT_PROMPT = `Given this execution result, generate standardized git output.
Respond in EXACTLY this JSON format (no markdown):
{
  "commitMessage": "type(scope): description",
  "prTitle": "short title",
  "prDescription": "## Summary\\n- bullet points",
  "summary": "one sentence"
}

Changed files: {files}
Output: {output}
`;

export class OutputStandardizerModule implements SDLCModule<SDLCExecutionResult, SDLCOutput> {
	readonly name = "OutputStandardizer";

	async execute(input: SDLCExecutionResult, context: SDLCModuleContext): Promise<SDLCOutput> {
		if (context.llmCaller) {
			return this.standardizeWithLLM(input, context);
		}
		return this.standardizeWithTemplate(input, context);
	}

	private async standardizeWithLLM(input: SDLCExecutionResult, context: SDLCModuleContext): Promise<SDLCOutput> {
		const prompt = OUTPUT_PROMPT
			.replace("{files}", input.changedFiles.join(", ") || "none")
			.replace("{output}", input.output.slice(0, 2000));

		try {
			const model = context.config.modules.outputStandardizer.commitFormat === "conventional"
				? "claude-haiku-4-5"
				: "claude-haiku-4-5";
			const response = await context.llmCaller!(prompt, model);
			const parsed = JSON.parse(response);

			return {
				commitMessage: parsed.commitMessage ?? this.templateCommitMessage(input),
				prTitle: parsed.prTitle ?? "Update code",
				prDescription: parsed.prDescription ?? "",
				summary: parsed.summary ?? "",
				changedFiles: input.changedFiles,
			};
		} catch {
			return this.standardizeWithTemplate(input, context);
		}
	}

	private standardizeWithTemplate(input: SDLCExecutionResult, _context: SDLCModuleContext): SDLCOutput {
		return {
			commitMessage: this.templateCommitMessage(input),
			prTitle: `Update ${input.changedFiles.length} file(s)`,
			prDescription: `## Changes\n${input.changedFiles.map((f) => `- ${f}`).join("\n")}`,
			summary: `Modified ${input.changedFiles.length} file(s)`,
			changedFiles: input.changedFiles,
		};
	}

	private templateCommitMessage(input: SDLCExecutionResult): string {
		if (input.changedFiles.length === 0) return "chore: update code";
		const scope = input.changedFiles[0]!.split("/").pop()?.replace(/\.\w+$/, "") ?? "code";
		return `feat(${scope}): update ${input.changedFiles.length} file(s)`;
	}
}
