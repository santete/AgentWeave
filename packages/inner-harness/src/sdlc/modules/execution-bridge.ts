/**
 * ExecutionBridge — Delegate execution to AgentLoop, ProcessAdapter, or direct API.
 * The bridge between SDLC planning and actual code generation.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type {
	SDLCModule,
	SDLCModuleContext,
	SDLCTask,
	SDLCPlan,
	SDLCExecutionResult,
	InnerEvent,
	InnerHarnessProvider,
} from "@agentweave/types";
import { createEmptyTokenUsage } from "@agentweave/types";

const execFileAsync = promisify(execFile);

export interface ExecutionBridgeInput {
	task: SDLCTask;
	plan?: SDLCPlan;
}

export class ExecutionBridgeModule implements SDLCModule<ExecutionBridgeInput, SDLCExecutionResult> {
	readonly name = "ExecutionBridge";

	/** Optional pre-constructed provider (avoids dynamic import). */
	private provider: InnerHarnessProvider | null = null;

	/** Set a pre-constructed provider to use instead of creating one. */
	setProvider(provider: InnerHarnessProvider): void {
		this.provider = provider;
	}

	async execute(input: ExecutionBridgeInput, context: SDLCModuleContext): Promise<SDLCExecutionResult> {
		const prompt = this.buildPrompt(input.task, input.plan);
		const mode = context.config.execution.mode;
		const timer = context.metrics.startTimer("execution");

		try {
			switch (mode) {
				case "agent-loop":
					return await this.runWithProvider(prompt, context, () => this.createAgentLoop(context));
				case "process-adapter":
					return await this.runWithProvider(prompt, context, () => this.createProcessAdapter(context));
				case "api-direct":
					return await this.runApiDirect(prompt, context);
			}
		} finally {
			timer();
		}
	}

	private async runWithProvider(
		prompt: string,
		context: SDLCModuleContext,
		factory: () => Promise<InnerHarnessProvider>,
	): Promise<SDLCExecutionResult> {
		const provider = this.provider ?? await factory();
		const events: InnerEvent[] = [];
		const changedFiles: string[] = [];

		// Capture HEAD SHA before execution so git diff can catch committed changes too
		const preExecSha = await this.getHeadSha(context.cwd);
		const gen = provider.run(prompt, { signal: context.signal });
		let terminalReason = "completed";

		for (;;) {
			const { value, done } = await gen.next();
			if (done) {
				terminalReason = value.reason;
				break;
			}
			events.push(value);

			// Track changed files from tool events
			if (value.type === "tool:completed") {
				const toolEvent = value as unknown as Record<string, unknown>;
				const toolName = toolEvent.toolName as string ?? "";
				if (["FileWrite", "FileEdit"].includes(toolName)) {
					const input = toolEvent.toolInput as Record<string, string> | undefined;
					const path = input?.path ?? input?.file_path;
					if (path && !changedFiles.includes(path)) changedFiles.push(path);
				}
			}
		}

		// Fallback: use git diff if no tool events captured changed files (e.g. process-adapter mode)
		const resolvedFiles = changedFiles.length > 0 ? changedFiles : await this.getGitChangedFiles(context.cwd, preExecSha);

		const usage = provider.getUsage();
		return {
			success: terminalReason === "completed",
			changedFiles: resolvedFiles,
			output: this.extractOutput(events),
			usage,
			durationMs: 0, // filled by timer in execute()
			terminalReason,
		};
	}

	private async runApiDirect(prompt: string, context: SDLCModuleContext): Promise<SDLCExecutionResult> {
		if (!context.llmCaller) {
			return {
				success: false,
				changedFiles: [],
				output: "No LLM caller available for api-direct mode",
				usage: createEmptyTokenUsage(),
				durationMs: 0,
				terminalReason: "error",
			};
		}

		const model = context.config.execution.apiDirect?.model ?? "claude-sonnet-4-6";
		const response = await context.llmCaller(prompt, model);

		return {
			success: true,
			changedFiles: [],
			output: response,
			usage: createEmptyTokenUsage(),
			durationMs: 0,
			terminalReason: "completed",
		};
	}

	private buildPrompt(task: SDLCTask, plan?: SDLCPlan): string {
		let prompt = `Task: ${task.goal}\n`;

		if (task.constraints.length > 0) {
			prompt += `\nConstraints:\n${task.constraints.map((c) => `- ${c}`).join("\n")}\n`;
		}

		if (task.context.length > 0) {
			prompt += `\nRelevant files:\n${task.context.map((c) => `- ${c}`).join("\n")}\n`;
		}

		if (task.definitionOfDone.length > 0) {
			prompt += `\nDefinition of Done:\n${task.definitionOfDone.map((d) => `- ${d}`).join("\n")}\n`;
		}

		if (plan) {
			prompt += `\nPlan:\n${plan.steps.map((s) => `${s.index + 1}. ${s.description}`).join("\n")}\n`;
		}

		return prompt;
	}

	private extractOutput(events: InnerEvent[]): string {
		return events
			.filter((e) => e.type === "message:assistant")
			.map((e) => {
				const content = (e as unknown as Record<string, unknown>).content;
				if (Array.isArray(content)) {
					return content
						.filter((b: { type: string }) => b.type === "text")
						.map((b: { text: string }) => b.text)
						.join("");
				}
				return "";
			})
			.join("\n");
	}

	private async createAgentLoop(context: SDLCModuleContext): Promise<InnerHarnessProvider> {
		const config = context.config.execution.agentLoop;
		if (!config) throw new Error("execution.agentLoop config required for agent-loop mode");

		const { AgentLoop } = await import("../../agent-loop");
		const { BUILT_IN_TOOLS } = await import("../../built-in-tools");

		// AgentLoop uses noop control plane by default when none provided (standalone mode)
		return new AgentLoop({
			model: config.model,
			fallbackModel: config.fallbackModel,
			maxTurns: config.maxTurns ?? 50,
			systemPrompt: config.systemPrompt,
			tools: BUILT_IN_TOOLS,
		});
	}

	private async getHeadSha(cwd: string): Promise<string | null> {
		try {
			const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd });
			return stdout.trim();
		} catch {
			return null;
		}
	}

	private async getGitChangedFiles(cwd: string, preExecSha: string | null): Promise<string[]> {
		try {
			const files = new Set<string>();

			// Uncommitted changes (staged + unstaged vs HEAD)
			const { stdout: uncommitted } = await execFileAsync("git", ["diff", "--name-only", "HEAD"], { cwd });
			for (const f of uncommitted.trim().split("\n").filter(Boolean)) files.add(f);

			// Committed changes since pre-execution snapshot (handles agents that commit during execution)
			if (preExecSha) {
				const currentSha = await this.getHeadSha(cwd);
				if (currentSha && currentSha !== preExecSha) {
					const { stdout: committed } = await execFileAsync("git", ["diff", "--name-only", preExecSha, "HEAD"], { cwd });
					for (const f of committed.trim().split("\n").filter(Boolean)) files.add(f);
				}
			}

			return [...files];
		} catch {
			return [];
		}
	}

	private async createProcessAdapter(context: SDLCModuleContext): Promise<InnerHarnessProvider> {
		const config = context.config.execution.processAdapter;
		if (!config) throw new Error("execution.processAdapter config required for process-adapter mode");

		// Dynamic import — @agentweave/adapters is optional peer dependency
		const { ProcessAdapter } = await import("@agentweave/adapters");
		return new ProcessAdapter({
			command: config.command,
			args: config.args,
			cwd: config.cwd ?? context.cwd,
			promptMode: config.promptMode,
			env: config.env,
		});
	}
}
