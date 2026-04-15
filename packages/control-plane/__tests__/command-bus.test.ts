import { describe, it, expect, vi } from "vitest";
import { CommandBus } from "../src/command-bus";
import type { OuterCommand, CommandAck } from "@agentweave/types";

describe("CommandBus", () => {
	it("should return not-accepted when no handler registered", async () => {
		const bus = new CommandBus();
		const result = await bus.send({ type: "pause" });

		expect(result.accepted).toBe(false);
		expect(result.reason).toContain("No command handler");
	});

	it("should route command to handler and return ack", async () => {
		const bus = new CommandBus();
		bus.setHandler(async (cmd) => {
			return { accepted: true, reason: `Handled ${cmd.type}` };
		});

		const result = await bus.send({ type: "pause" });

		expect(result.accepted).toBe(true);
		expect(result.reason).toBe("Handled pause");
	});

	it("should handle different command types", async () => {
		const bus = new CommandBus();
		const received: OuterCommand[] = [];
		bus.setHandler(async (cmd) => {
			received.push(cmd);
			return { accepted: true };
		});

		await bus.send({ type: "pause" });
		await bus.send({ type: "resume" });
		await bus.send({ type: "abort", reason: "test" });
		await bus.send({ type: "set_model", model: "haiku" });

		expect(received).toHaveLength(4);
		expect(received.map((c) => c.type)).toEqual([
			"pause",
			"resume",
			"abort",
			"set_model",
		]);
	});

	it("should catch handler errors and return not-accepted", async () => {
		const bus = new CommandBus();
		bus.setHandler(async () => {
			throw new Error("handler crashed");
		});

		const result = await bus.send({ type: "pause" });

		expect(result.accepted).toBe(false);
		expect(result.reason).toBe("handler crashed");
	});

	it("should report hasHandler correctly", () => {
		const bus = new CommandBus();
		expect(bus.hasHandler()).toBe(false);

		bus.setHandler(async () => ({ accepted: true }));
		expect(bus.hasHandler()).toBe(true);

		bus.destroy();
		expect(bus.hasHandler()).toBe(false);
	});
});
