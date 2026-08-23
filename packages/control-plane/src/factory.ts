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

		// Interceptors.
		//
		// PHẢI chuyển tiếp `options` (chứa timeoutMs). Bỏ nó đi thì mọi lời gọi
		// rơi về hạn giờ mặc định 30 giây — kể cả `timeoutMs: 0` mà agent-loop
		// truyền cho quyết định của con người. Hậu quả đã đo: xin quyền ghi file,
		// người dùng rời màn hình 30 giây, agent tự TỪ CHỐI với "Interceptor
		// timeout (30000ms)". Đúng thứ nguyên tắc "không bấm giờ người dùng" cấm,
		// nhưng bị chính lớp bọc này âm thầm vô hiệu.
		intercept: (type, req, options) => interceptors.intercept(type, req, options),
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
