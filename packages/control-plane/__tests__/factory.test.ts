import { describe, it, expect, vi } from "vitest";
import { createControlPlane } from "../src/factory";
import type { InnerEvent } from "@agentweave/types";

function makeEvent(type: string, extra: Record<string, unknown> = {}): InnerEvent {
	return {
		id: "evt_1",
		timestamp: Date.now(),
		sessionId: "ses_1",
		agentId: "agent_1",
		type,
		...extra,
	} as InnerEvent;
}

describe("createControlPlane", () => {
	it("should create a working control plane", () => {
		const cp = createControlPlane();

		expect(cp.emit).toBeDefined();
		expect(cp.subscribe).toBeDefined();
		expect(cp.sendCommand).toBeDefined();
		expect(cp.onCommand).toBeDefined();
		expect(cp.intercept).toBeDefined();
		expect(cp.registerInterceptor).toBeDefined();
		expect(cp.destroy).toBeDefined();
	});

	it("should wire event bus correctly", () => {
		const cp = createControlPlane();
		const handler = vi.fn();
		cp.subscribe("turn:start", handler);

		cp.emit(makeEvent("turn:start", { turnIndex: 1 }));

		expect(handler).toHaveBeenCalledOnce();
	});

	it("should wire command bus correctly", async () => {
		const cp = createControlPlane();
		cp.onCommand(async (cmd) => ({
			accepted: true,
			reason: `ok: ${cmd.type}`,
		}));

		const ack = await cp.sendCommand({ type: "pause" });

		expect(ack.accepted).toBe(true);
		expect(ack.reason).toBe("ok: pause");
	});

	it("should wire interceptors correctly", async () => {
		const cp = createControlPlane();
		cp.registerInterceptor("tool_request", async (req) => ({
			behavior: "allow" as const,
			reason: `Allowed ${req.toolName}`,
			source: "test",
		}));

		const decision = await cp.intercept("tool_request", {
			toolName: "Bash",
			toolInput: { command: "ls" },
			toolUseId: "tu_1",
			turnIndex: 1,
			isReadOnly: true,
			isDestructive: false,
		});

		expect(decision.behavior).toBe("allow");
	});

	it("should respect failMode option", async () => {
		const cp = createControlPlane({ failMode: "open" });

		const decision = await cp.intercept("tool_request", {
			toolName: "Bash",
			toolInput: { command: "ls" },
			toolUseId: "tu_1",
			turnIndex: 1,
			isReadOnly: true,
			isDestructive: false,
		});

		// No interceptor registered, fail-open -> allow
		expect(decision.behavior).toBe("allow");
	});

	it("should clean up on destroy", () => {
		const cp = createControlPlane();
		const handler = vi.fn();
		cp.subscribe("turn:start", handler);

		cp.destroy();

		cp.emit(makeEvent("turn:start", { turnIndex: 1 }));
		expect(handler).not.toHaveBeenCalled();
	});
});
