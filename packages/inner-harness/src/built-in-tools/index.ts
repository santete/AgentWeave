/**
 * Built-in tools — 6 standard tools for AI agent file/shell operations.
 */

import type { ToolDefinition } from "@agentweave/types";
import { BashTool } from "./bash";
import { FileReadTool } from "./file-read";
import { FileWriteTool } from "./file-write";
import { FileEditTool } from "./file-edit";
import { GrepTool } from "./grep";
import { GlobTool } from "./glob";

export { BashTool, FileReadTool, FileWriteTool, FileEditTool, GrepTool, GlobTool };

/** All 6 built-in tools as an array — register all at once. */
export const BUILT_IN_TOOLS: ToolDefinition[] = [
	BashTool,
	FileReadTool,
	FileWriteTool,
	FileEditTool,
	GrepTool,
	GlobTool,
];

/** Get a built-in tool by name. */
export function getBuiltInTool(name: string): ToolDefinition | undefined {
	return BUILT_IN_TOOLS.find((t) => t.name === name);
}
