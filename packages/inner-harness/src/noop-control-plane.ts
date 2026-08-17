/**
 * NoopControlPlane — Minimal passthrough ControlPlane for standalone usage.
 *
 * All interceptors return permissive defaults:
 * - tool_request → allow
 * - output_ready → approve
 * - input_received → pass
 *
 * Events are silently dropped. Commands are acked with success.
 * Use this when inner-harness runs WITHOUT outer-harness or a real control-plane.
 */

import type {
	ControlPlane,
	InterceptType,
	InterceptRequest,
	InterceptResponse,
	InnerEvent,
	OuterCommand,
	CommandAck,
} from "@agentweave/types";

const PASSTHROUGH_RESPONSES: {
	tool_request: InterceptResponse["tool_request"];
	output_ready: InterceptResponse["output_ready"];
	input_received: InterceptResponse["input_received"];
} = {
	tool_request: { behavior: "allow", reason: "standalone mode", source: "noop" },
	output_ready: { action: "approve", stages: [] },
	input_received: { action: "pass" },
};

export function createNoopControlPlane(): ControlPlane {
	let commandHandler: ((cmd: OuterCommand) => Promise<CommandAck>) | null = null;

	return {
		emit(_event: InnerEvent): void {
			// Silent drop — no observers in standalone mode
		},

		subscribe(_type: string | "*", _handler: (event: InnerEvent) => void): () => void {
			return () => {}; // no-op unsubscribe
		},

		async sendCommand(command: OuterCommand): Promise<CommandAck> {
			if (commandHandler) return commandHandler(command);
			return { accepted: true };
		},

		onCommand(handler: (command: OuterCommand) => Promise<CommandAck>): void {
			commandHandler = handler;
		},

		async intercept<T extends InterceptType>(
			type: T,
			_request: InterceptRequest[T],
			_options?: { timeoutMs?: number },
		): Promise<InterceptResponse[T]> {
			return PASSTHROUGH_RESPONSES[type] as InterceptResponse[T];
		},

		registerInterceptor<T extends InterceptType>(
			_type: T,
			_handler: (req: InterceptRequest[T]) => Promise<InterceptResponse[T]>,
		): void {
			// No-op — standalone mode has no interceptors
		},

		destroy(): void {
			commandHandler = null;
		},
	};
}
