/**
 * TaskNormalizer — Convert raw input into structured SDLCTask.
 * Uses LLM if available, falls back to template parsing.
 */

import { randomUUID } from "node:crypto";
import type {
	SDLCModule,
	SDLCModuleContext,
	SDLCTask,
} from "@agentweave/types";

const NORMALIZE_PROMPT = `You are a task normalizer. Given a raw developer request, extract a structured task.
Respond in EXACTLY this JSON format (no markdown, no explanation):
{
  "goal": "one sentence describing what to achieve",
  "context": ["relevant file paths or schemas mentioned"],
  "constraints": ["constraints mentioned or implied"],
  "definitionOfDone": ["criteria for success"]
}

Raw request:
`;

export class TaskNormalizerModule implements SDLCModule<string, SDLCTask> {
	readonly name = "TaskNormalizer";

	async execute(input: string, context: SDLCModuleContext): Promise<SDLCTask> {
		const taskId = `task_${randomUUID().slice(0, 8)}`;

		if (context.llmCaller) {
			return this.normalizeWithLLM(taskId, input, context);
		}

		return this.normalizeWithTemplate(taskId, input);
	}

	private async normalizeWithLLM(taskId: string, input: string, context: SDLCModuleContext): Promise<SDLCTask> {
		const model = context.config.modules.taskNormalizer.model ?? "claude-haiku-4-5";

		try {
			const response = await context.llmCaller!(NORMALIZE_PROMPT + input, model);
			const parsed = JSON.parse(response);

			return {
				id: taskId,
				rawInput: input,
				goal: parsed.goal ?? input,
				context: Array.isArray(parsed.context) ? parsed.context : [],
				constraints: Array.isArray(parsed.constraints) ? parsed.constraints : [],
				definitionOfDone: Array.isArray(parsed.definitionOfDone) ? parsed.definitionOfDone : [],
				metadata: {},
			};
		} catch {
			// LLM failed — fall back to template
			return this.normalizeWithTemplate(taskId, input);
		}
	}

	private normalizeWithTemplate(taskId: string, input: string): SDLCTask {
		// Extract file paths mentioned in input
		const filePatterns = input.match(/[\w./-]+\.\w{1,10}/g) ?? [];

		// Extract constraints (lines starting with "must", "don't", "no", etc.)
		const constraints: string[] = [];
		for (const line of input.split(/[.\n]/).map((l) => l.trim())) {
			if (/^(must|don't|do not|no |never |always )/i.test(line) && line.length > 5) {
				constraints.push(line);
			}
		}

		return {
			id: taskId,
			rawInput: input,
			goal: input.split(/[.\n]/)[0]?.trim() || input,
			context: filePatterns,
			constraints,
			definitionOfDone: ["Task completed successfully"],
			metadata: {},
		};
	}
}
