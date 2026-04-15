/**
 * Session lifecycle and persistence types.
 */

import type { TokenUsage } from "./metrics";
import type { TerminalReason } from "./events";

export interface SessionInfo {
	sessionId: string;
	agentId: string;
	userId?: string;
	projectId?: string;
	model: string;
	startTime: number;
	cwd: string;
}

export interface SessionState {
	status: "active" | "paused" | "completed" | "aborted" | "error";
	turnCount: number;
	usage: TokenUsage;
	lastActivityTime: number;
}

export interface SessionEndInfo {
	sessionId: string;
	reason: TerminalReason;
	usage: TokenUsage;
	endTime: number;
	turnCount: number;
}
