/**
 * Tool definition and result types.
 * Compatible with Vercel AI SDK tool() format.
 */

import type { z } from "zod";
import type { Message } from "./messages";

export interface ToolDefinition<TInput = unknown, TOutput = unknown> {
	name: string;
	description: string;
	parameters: z.ZodType<TInput>;

	execute(input: TInput, context: ToolContext): Promise<TOutput>;

	metadata: {
		isReadOnly: boolean;
		isDestructive: boolean;
		isConcurrencySafe: boolean;
		category: "file" | "shell" | "search" | "network" | "agent" | "custom";
		maxDurationMs?: number;
		maxOutputSize?: number;
	};
}

export interface ToolContext {
	sessionId: string;
	agentId: string;
	cwd: string;
	signal: AbortSignal;
	onProgress?: (progress: unknown) => void;
	/** Sandbox constraints for tool execution. */
	sandbox?: SandboxConfig;
}

export interface SandboxConfig {
	/** Allowed filesystem paths (globs). Tool rejected if accessing outside. */
	allowedPaths?: string[];
	/** Denied filesystem paths (checked first, overrides allowed). */
	deniedPaths?: string[];
	/** Allow network access (default true). */
	networkAccess?: boolean;
}

export interface ToolResult<T = unknown> {
	data: T;
	newMessages?: Message[];
	contextModifier?: (ctx: ToolContext) => ToolContext;
}
