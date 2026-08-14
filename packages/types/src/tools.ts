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
	/**
	 * Cô lập ở tầng NHÂN hệ điều hành cho tool chạy tiến trình.
	 *
	 * Khác `sandbox` ở trên: trường kia là chính sách đường dẫn, so khớp chuỗi
	 * trong tham số tool nên luật viết sót là lọt. Trường này bọc lệnh bằng
	 * bubblewrap/sandbox-exec — chặn được cả thứ không lường trước, kể cả khi
	 * chính sách viết sai.
	 *
	 * Khai kiểu tối thiểu ở đây để `@agentweave/types` không phụ thuộc ngược
	 * vào inner-harness.
	 */
	processSandbox?: ProcessSandboxBinding;
}

export interface ProcessSandboxBinding {
	/** Định danh cơ chế: "bubblewrap" | "seatbelt" | "none". */
	id: string;
	/** Bọc argv theo chính sách đã gắn sẵn. Trả về argv mới, chưa chạy. */
	wrap(argv: string[]): string[];
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
