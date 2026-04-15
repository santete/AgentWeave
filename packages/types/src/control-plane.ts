/**
 * Control Plane interface — the bridge between Inner and Outer Harness.
 *
 * Three communication patterns:
 * 1. Event Bus: Inner -> Outer (fire-and-forget, non-blocking)
 * 2. Command Bus: Outer -> Inner (async request/ack)
 * 3. Interceptors: Bidirectional blocking gates (tool_request, output_ready, input_received)
 */

import type { InnerEvent, OuterCommand, CommandAck } from "./events";
import type { ToolDecision, OutputDecision, InputDecision } from "./decisions";
import type { ToolRequest, RawOutput, UserInput } from "./decisions";

// ─── Intercept Types ─────────────────────────────────────────────

export type InterceptType = "tool_request" | "output_ready" | "input_received";

export type InterceptRequest = {
	tool_request: ToolRequest;
	output_ready: RawOutput;
	input_received: UserInput;
};

export type InterceptResponse = {
	tool_request: ToolDecision;
	output_ready: OutputDecision;
	input_received: InputDecision;
};

// ─── Control Plane Interface ─────────────────────────────────────

export interface ControlPlane {
	// Event Bus (Inner -> Outer, non-blocking)
	emit(event: InnerEvent): void;
	subscribe(
		type: string | "*",
		handler: (event: InnerEvent) => void,
	): () => void;

	// Command Bus (Outer -> Inner, async with ack)
	sendCommand(command: OuterCommand): Promise<CommandAck>;
	onCommand(
		handler: (command: OuterCommand) => Promise<CommandAck>,
	): void;

	// Interceptors (blocking gates with timeout)
	intercept<T extends InterceptType>(
		type: T,
		request: InterceptRequest[T],
	): Promise<InterceptResponse[T]>;
	registerInterceptor<T extends InterceptType>(
		type: T,
		handler: (
			req: InterceptRequest[T],
		) => Promise<InterceptResponse[T]>,
	): void;

	// Lifecycle
	destroy(): void;
}
