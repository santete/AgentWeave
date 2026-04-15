import { describe, it, expect, vi } from "vitest";
import { EventBus } from "../src/event-bus";
import type { InnerEvent } from "@agentweave/types";

function makeEvent(
	type: string,
	extra: Record<string, unknown> = {},
): InnerEvent {
	return {
		id: "evt_1",
		timestamp: Date.now(),
		sessionId: "ses_1",
		agentId: "agent_1",
		type,
		...extra,
	} as InnerEvent;
}

describe("EventBus", () => {
	it("should emit to typed handler", () => {
		const bus = new EventBus();
		const handler = vi.fn();
		bus.subscribe("turn:start", handler);

		const event = makeEvent("turn:start", { turnIndex: 1 });
		bus.emit(event);

		expect(handler).toHaveBeenCalledOnce();
		expect(handler).toHaveBeenCalledWith(event);
	});

	it("should emit to wildcard handler", () => {
		const bus = new EventBus();
		const handler = vi.fn();
		bus.subscribe("*", handler);

		bus.emit(makeEvent("turn:start", { turnIndex: 1 }));
		bus.emit(makeEvent("tool:requested", { toolName: "Bash", toolInput: {}, toolUseId: "tu_1" }));

		expect(handler).toHaveBeenCalledTimes(2);
	});

	it("should not call handler for non-matching type", () => {
		const bus = new EventBus();
		const handler = vi.fn();
		bus.subscribe("turn:start", handler);

		bus.emit(makeEvent("turn:end", { turnIndex: 1, stopReason: "completed" }));

		expect(handler).not.toHaveBeenCalled();
	});

	it("should unsubscribe correctly", () => {
		const bus = new EventBus();
		const handler = vi.fn();
		const unsub = bus.subscribe("turn:start", handler);

		bus.emit(makeEvent("turn:start", { turnIndex: 1 }));
		expect(handler).toHaveBeenCalledOnce();

		unsub();
		bus.emit(makeEvent("turn:start", { turnIndex: 2 }));
		expect(handler).toHaveBeenCalledOnce(); // still 1
	});

	it("should not throw when handler throws", () => {
		const bus = new EventBus();
		bus.subscribe("turn:start", () => {
			throw new Error("handler error");
		});

		expect(() => {
			bus.emit(makeEvent("turn:start", { turnIndex: 1 }));
		}).not.toThrow();
	});

	it("should call multiple handlers for same type", () => {
		const bus = new EventBus();
		const h1 = vi.fn();
		const h2 = vi.fn();
		bus.subscribe("turn:start", h1);
		bus.subscribe("turn:start", h2);

		bus.emit(makeEvent("turn:start", { turnIndex: 1 }));

		expect(h1).toHaveBeenCalledOnce();
		expect(h2).toHaveBeenCalledOnce();
	});

	it("should report handler count", () => {
		const bus = new EventBus();
		expect(bus.handlerCount("turn:start")).toBe(0);
		expect(bus.handlerCount("*")).toBe(0);

		bus.subscribe("turn:start", vi.fn());
		bus.subscribe("*", vi.fn());

		expect(bus.handlerCount("turn:start")).toBe(1);
		expect(bus.handlerCount("*")).toBe(1);
	});

	it("should clear all handlers on destroy", () => {
		const bus = new EventBus();
		const handler = vi.fn();
		bus.subscribe("turn:start", handler);
		bus.subscribe("*", handler);

		bus.destroy();

		bus.emit(makeEvent("turn:start", { turnIndex: 1 }));
		expect(handler).not.toHaveBeenCalled();
	});
});
