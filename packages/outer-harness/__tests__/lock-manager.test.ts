import { describe, it, expect, afterEach } from "vitest";
import { LockManager } from "../src/orchestration/lock-manager";

describe("LockManager", () => {
	let lm: LockManager;

	afterEach(() => {
		lm?.destroy();
	});

	// ─── Basic acquire/release ───────────────────────────────────

	it("should acquire an unlocked resource", async () => {
		lm = new LockManager();
		const acquired = await lm.acquire("file.ts", "agent-1");
		expect(acquired).toBe(true);
		expect(lm.isLocked("file.ts")).toBe(true);
		expect(lm.getHolder("file.ts")).toBe("agent-1");
	});

	it("should release a held lock", async () => {
		lm = new LockManager();
		await lm.acquire("file.ts", "agent-1");
		const released = lm.release("file.ts", "agent-1");
		expect(released).toBe(true);
		expect(lm.isLocked("file.ts")).toBe(false);
		expect(lm.getHolder("file.ts")).toBeUndefined();
	});

	it("should not release lock held by another agent", async () => {
		lm = new LockManager();
		await lm.acquire("file.ts", "agent-1");
		const released = lm.release("file.ts", "agent-2");
		expect(released).toBe(false);
		expect(lm.getHolder("file.ts")).toBe("agent-1");
	});

	it("should return false when releasing unlocked resource", () => {
		lm = new LockManager();
		expect(lm.release("nonexistent.ts", "agent-1")).toBe(false);
	});

	// ─── Reentrant ───────────────────────────────────────────────

	it("should allow reentrant acquire by same agent", async () => {
		lm = new LockManager();
		await lm.acquire("file.ts", "agent-1");
		const second = await lm.acquire("file.ts", "agent-1");
		expect(second).toBe(true);
		expect(lm.getHolder("file.ts")).toBe("agent-1");
	});

	// ─── Contention (FIFO queue) ─────────────────────────────────

	it("should queue and grant lock to next waiter on release", async () => {
		lm = new LockManager();
		await lm.acquire("file.ts", "agent-1");

		// Agent-2 waits
		const agent2Promise = lm.acquire("file.ts", "agent-2", 5000);

		// Release agent-1 → agent-2 should get the lock
		lm.release("file.ts", "agent-1");
		const acquired = await agent2Promise;

		expect(acquired).toBe(true);
		expect(lm.getHolder("file.ts")).toBe("agent-2");
	});

	it("should grant in FIFO order with multiple waiters", async () => {
		lm = new LockManager();
		await lm.acquire("file.ts", "agent-1");

		const order: string[] = [];
		const p2 = lm.acquire("file.ts", "agent-2", 5000).then((ok) => {
			if (ok) order.push("agent-2");
			return ok;
		});
		const p3 = lm.acquire("file.ts", "agent-3", 5000).then((ok) => {
			if (ok) order.push("agent-3");
			return ok;
		});

		// Release agent-1 → agent-2 gets it
		lm.release("file.ts", "agent-1");
		await p2;
		expect(lm.getHolder("file.ts")).toBe("agent-2");

		// Release agent-2 → agent-3 gets it
		lm.release("file.ts", "agent-2");
		await p3;
		expect(lm.getHolder("file.ts")).toBe("agent-3");
		expect(order).toEqual(["agent-2", "agent-3"]);
	});

	// ─── Timeout ─────────────────────────────────────────────────

	it("should timeout if lock is not released", async () => {
		lm = new LockManager();
		await lm.acquire("file.ts", "agent-1");

		const acquired = await lm.acquire("file.ts", "agent-2", 50);
		expect(acquired).toBe(false);
		// agent-1 still holds the lock
		expect(lm.getHolder("file.ts")).toBe("agent-1");
	});

	// ─── releaseAll ──────────────────────────────────────────────

	it("should release all locks held by an agent", async () => {
		lm = new LockManager();
		await lm.acquire("a.ts", "agent-1");
		await lm.acquire("b.ts", "agent-1");
		await lm.acquire("c.ts", "agent-2");

		lm.releaseAll("agent-1");

		expect(lm.isLocked("a.ts")).toBe(false);
		expect(lm.isLocked("b.ts")).toBe(false);
		expect(lm.isLocked("c.ts")).toBe(true); // agent-2 unaffected
	});

	it("should grant to waiters when releaseAll frees locks", async () => {
		lm = new LockManager();
		await lm.acquire("file.ts", "agent-1");

		const p2 = lm.acquire("file.ts", "agent-2", 5000);
		lm.releaseAll("agent-1");

		const acquired = await p2;
		expect(acquired).toBe(true);
		expect(lm.getHolder("file.ts")).toBe("agent-2");
	});

	// ─── destroy ─────────────────────────────────────────────────

	it("should reject all waiters on destroy", async () => {
		lm = new LockManager();
		await lm.acquire("file.ts", "agent-1");

		const p2 = lm.acquire("file.ts", "agent-2", 60_000);
		lm.destroy();

		const acquired = await p2;
		expect(acquired).toBe(false);
	});

	// ─── isLocked / getHolder edge cases ─────────────────────────

	it("should report unlocked for unknown resources", () => {
		lm = new LockManager();
		expect(lm.isLocked("unknown.ts")).toBe(false);
		expect(lm.getHolder("unknown.ts")).toBeUndefined();
	});
});
