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


describe("createControlPlane — chuyển tiếp options cho intercept (hồi quy)", () => {
	// Bug đã xảy ra: lớp bọc factory bỏ tham số `options`, nên `timeoutMs: 0`
	// (chờ vô hạn cho quyết định của con người) bị nuốt, mọi lời gọi rơi về mặc
	// định 30s rồi tự TỪ CHỐI. Test này khoá lại: options phải tới nơi.
	it("timeoutMs: 0 khiến intercept CHỜ, không tự hết giờ 30s", async () => {
		vi.useFakeTimers();
		const cp = createControlPlane();
		let daGiaiQuyet = false;
		// handler treo lâu hơn 30s mặc định
		cp.registerInterceptor("tool_request", async () => {
			await new Promise((r) => setTimeout(r, 60_000));
			daGiaiQuyet = true;
			return { behavior: "allow", source: "test", priority: 1 } as never;
		});
		const p = cp.intercept(
			"tool_request",
			{
				toolName: "FileWrite",
				toolInput: {},
				toolUseId: "1",
				turnIndex: 0,
				isReadOnly: false,
				isDestructive: false,
			},
			{ timeoutMs: 0 },
		);
		// Vượt mốc 30s: nếu options bị nuốt thì ở đây đã reject bằng timeout.
		await vi.advanceTimersByTimeAsync(35_000);
		expect(daGiaiQuyet).toBe(false); // vẫn đang chờ, chưa xong, chưa bị từ chối
		// Cho handler chạy nốt.
		await vi.advanceTimersByTimeAsync(30_000);
		const kq = await p;
		expect(kq.behavior).toBe("allow");
		vi.useRealTimers();
	});

	it("KHÔNG truyền options thì dùng mặc định 30s (không phải chờ mãi)", async () => {
		vi.useFakeTimers();
		const cp = createControlPlane();
		cp.registerInterceptor("tool_request", async () => {
			await new Promise((r) => setTimeout(r, 60_000));
			return { behavior: "allow", source: "test", priority: 1 } as never;
		});
		const p = cp.intercept("tool_request", {
			toolName: "FileWrite",
			toolInput: {},
			toolUseId: "1",
			turnIndex: 0,
			isReadOnly: false,
			isDestructive: false,
		});
		await vi.advanceTimersByTimeAsync(31_000);
		const kq = await p; // hết 30s → quyết định mặc định kèm lý do timeout
		expect(String((kq as { reason?: string }).reason ?? "")).toMatch(/timeout/i);
		vi.useRealTimers();
	});
});
