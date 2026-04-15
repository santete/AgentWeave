/**
 * Outer Harness Consumer interface.
 * Inner Harness calls these methods VIA the Control Plane (never directly).
 */

import type { InnerEvent, TerminalResult } from "./events";
import type {
	ToolDecision,
	OutputDecision,
	InputDecision,
	ToolRequest,
	RawOutput,
	UserInput,
} from "./decisions";
import type { HookEvent, HookResult } from "./hooks";
import type { SessionInfo } from "./sessions";

export interface OuterHarnessConsumer {
	/**
	 * BLOCKING: Decide whether a tool is allowed to execute.
	 *
	 * Internal flow:
	 *   1. PermissionEngine.evaluate() -> PermissionDecision (allow|deny|ask)
	 *   2. If allow/deny -> return ToolDecision immediately
	 *   3. If ask -> UserInteractionGate.waitForResponse() -> resolve to allow/deny
	 *
	 * Inner Harness does NOT know about 'ask' — it only receives ToolDecision.
	 */
	onToolRequested(request: ToolRequest): Promise<ToolDecision>;

	/** BLOCKING: Decide about output (batch mode) or post-stream validate. */
	onOutputReady(output: RawOutput): Promise<OutputDecision>;

	/** BLOCKING: Validate and transform user input. */
	onInputReceived(input: UserInput): Promise<InputDecision>;

	/** NON-BLOCKING: Observe events from Inner Harness. */
	onEvent(event: InnerEvent): void;

	/** SEMI-BLOCKING: Execute hooks with timeout. */
	executeHooks(event: HookEvent): Promise<HookResult>;

	/** Lifecycle callbacks. */
	onSessionStart(session: SessionInfo): Promise<void>;
	onSessionEnd(
		session: SessionInfo,
		result: TerminalResult,
	): Promise<void>;
}
