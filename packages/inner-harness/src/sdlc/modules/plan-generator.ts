/**
 * PlanGenerator — Generate step-by-step plan from structured task.
 * Uses LLM if available, falls back to simple template plan.
 */

import type {
	SDLCModule,
	SDLCModuleContext,
	SDLCTask,
	SDLCPlan,
	SDLCPlanStep,
} from "@agentweave/types";

const PLAN_PROMPT = `You are a coding plan generator. Given a structured task, create a step-by-step execution plan.
Respond in EXACTLY this JSON format (no markdown, no explanation):
{
  "steps": [
    { "description": "what to do", "type": "read|write|test|validate|shell", "files": ["file paths"] }
  ],
  "estimatedFiles": ["all files that will be changed"]
}

Task:
Goal: {goal}
Context files: {context}
Constraints: {constraints}
Definition of Done: {dod}
`;

export class PlanGeneratorModule implements SDLCModule<SDLCTask, SDLCPlan> {
	readonly name = "PlanGenerator";

	async execute(input: SDLCTask, context: SDLCModuleContext): Promise<SDLCPlan> {
		const maxSteps = context.config.modules.planGenerator.maxSteps ?? 15;

		if (context.llmCaller) {
			return this.planWithLLM(input, context, maxSteps);
		}

		return this.planWithTemplate(input, maxSteps);
	}

	private async planWithLLM(task: SDLCTask, context: SDLCModuleContext, maxSteps: number): Promise<SDLCPlan> {
		const model = context.config.modules.planGenerator.model ?? "claude-haiku-4-5";
		const prompt = PLAN_PROMPT
			.replace("{goal}", task.goal)
			.replace("{context}", task.context.join(", ") || "none")
			.replace("{constraints}", task.constraints.join(", ") || "none")
			.replace("{dod}", task.definitionOfDone.join(", ") || "none");

		try {
			const response = await context.llmCaller!(prompt, model);
			const parsed = JSON.parse(response);

			const steps: SDLCPlanStep[] = (parsed.steps ?? [])
				.slice(0, maxSteps)
				.map((s: { description?: string; type?: string; files?: string[] }, i: number) => ({
					index: i,
					description: s.description ?? `Step ${i + 1}`,
					type: validateStepType(s.type),
					files: Array.isArray(s.files) ? s.files : undefined,
					done: false,
				}));

			return {
				taskId: task.id,
				steps,
				estimatedFiles: Array.isArray(parsed.estimatedFiles) ? parsed.estimatedFiles : [],
			};
		} catch {
			return this.planWithTemplate(task, maxSteps);
		}
	}

	private planWithTemplate(task: SDLCTask, _maxSteps: number): SDLCPlan {
		const steps: SDLCPlanStep[] = [
			{ index: 0, description: `Read relevant files: ${task.context.join(", ") || "explore codebase"}`, type: "read", files: task.context.length > 0 ? task.context : undefined, done: false },
			{ index: 1, description: `Implement: ${task.goal}`, type: "write", done: false },
			{ index: 2, description: "Run tests to verify", type: "test", done: false },
		];

		return {
			taskId: task.id,
			steps,
			estimatedFiles: task.context.filter((c) => c.includes(".")),
		};
	}
}

function validateStepType(type: unknown): SDLCPlanStep["type"] {
	const valid = ["read", "write", "test", "validate", "shell"];
	return typeof type === "string" && valid.includes(type)
		? (type as SDLCPlanStep["type"])
		: "write";
}
