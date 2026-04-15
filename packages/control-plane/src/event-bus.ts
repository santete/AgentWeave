/**
 * EventBus — Non-blocking pub/sub for Inner -> Outer event flow.
 * Handlers never throw; errors are silently caught to protect the bus.
 */

import type { InnerEvent } from "@agentweave/types";

type Handler = (event: InnerEvent) => void;

export class EventBus {
	private handlers = new Map<string, Set<Handler>>();
	private wildcardHandlers = new Set<Handler>();

	emit(event: InnerEvent): void {
		const typeHandlers = this.handlers.get(event.type);
		if (typeHandlers) {
			for (const h of typeHandlers) {
				try {
					h(event);
				} catch {
					// Never throw from emit — protect the bus
				}
			}
		}
		for (const h of this.wildcardHandlers) {
			try {
				h(event);
			} catch {
				// Never throw from emit
			}
		}
	}

	subscribe(type: string | "*", handler: Handler): () => void {
		if (type === "*") {
			this.wildcardHandlers.add(handler);
			return () => {
				this.wildcardHandlers.delete(handler);
			};
		}
		let set = this.handlers.get(type);
		if (!set) {
			set = new Set();
			this.handlers.set(type, set);
		}
		set.add(handler);
		return () => {
			set.delete(handler);
		};
	}

	/** Number of handlers for a specific event type (or '*' for wildcard). */
	handlerCount(type: string | "*"): number {
		if (type === "*") return this.wildcardHandlers.size;
		return this.handlers.get(type)?.size ?? 0;
	}

	destroy(): void {
		this.handlers.clear();
		this.wildcardHandlers.clear();
	}
}
