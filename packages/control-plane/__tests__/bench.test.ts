import { describe, it, expect } from "vitest";
import { EventBus } from "../src/event-bus";
import type { InnerEvent } from "@agentweave/types";

const mockEvent: InnerEvent = {
	id: "e1", timestamp: Date.now(), sessionId: "s1", agentId: "a1",
	type: "turn:start", turnIndex: 1,
};

describe("Performance: EventBus", () => {
	it("emit with 10 handlers should be < 0.5ms p99", () => {
		const bus = new EventBus();
		for (let i = 0; i < 10; i++) {
			bus.subscribe("turn:start", () => { /* noop handler */ });
		}

		const times: number[] = [];
		for (let i = 0; i < 1000; i++) {
			const start = performance.now();
			bus.emit(mockEvent);
			times.push(performance.now() - start);
		}

		times.sort((a, b) => a - b);
		const p99 = times[Math.floor(times.length * 0.99)]!;
		console.log(`  EventBus.emit (10 handlers) p99: ${p99.toFixed(3)}ms`);
		expect(p99).toBeLessThan(0.5);
	});
});
