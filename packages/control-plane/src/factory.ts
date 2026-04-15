/**
 * Factory function to create a fully wired ControlPlane instance.
 */

import type { ControlPlane } from "@agentweave/types";
import { EventBus } from "./event-bus";
import { CommandBus } from "./command-bus";
import { InterceptorRegistry } from "./interceptors";

export interface CreateControlPlaneOptions {
	failMode?: "open" | "closed";
}

export function createControlPlane(
	options?: CreateControlPlaneOptions,
): ControlPlane {
	const eventBus = new EventBus();
	const commandBus = new CommandBus();
	const interceptors = new InterceptorRegistry();

	if (options?.failMode) {
		interceptors.setFailMode(options.failMode);
	}

	return {
		// Event Bus
		emit: (event) => eventBus.emit(event),
		subscribe: (type, handler) => eventBus.subscribe(type, handler),

		// Command Bus
		sendCommand: (cmd) => commandBus.send(cmd),
		onCommand: (handler) => commandBus.setHandler(handler),

		// Interceptors
		intercept: (type, req) => interceptors.intercept(type, req),
		registerInterceptor: (type, handler) =>
			interceptors.registerInterceptor(type, handler),

		// Lifecycle
		destroy: () => {
			eventBus.destroy();
			commandBus.destroy();
			interceptors.destroy();
		},
	};
}
