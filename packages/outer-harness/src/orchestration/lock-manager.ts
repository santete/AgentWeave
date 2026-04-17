/**
 * LockManager — Sequential file locking for multi-agent conflict resolution.
 * Supports async acquire with timeout, FIFO wait queue, and reentrant locks.
 */

interface LockEntry {
	agentId: string;
	acquiredAt: number;
}

interface Waiter {
	agentId: string;
	resolve: (acquired: boolean) => void;
	timer: ReturnType<typeof setTimeout>;
}

const DEFAULT_WAIT_TIMEOUT_MS = 30_000;

export class LockManager {
	private locks = new Map<string, LockEntry>();
	private waitQueues = new Map<string, Waiter[]>();

	/**
	 * Acquire a lock on a resource. Waits up to waitTimeoutMs if held by another agent.
	 * Returns true if acquired, false on timeout.
	 *
	 * Reentrant: same agent acquiring same lock succeeds immediately.
	 * Note: reentrant acquires are NOT depth-tracked — a single release()
	 * fully releases the lock regardless of how many times it was acquired.
	 */
	async acquire(
		resource: string,
		agentId: string,
		waitTimeoutMs = DEFAULT_WAIT_TIMEOUT_MS,
	): Promise<boolean> {
		const holder = this.locks.get(resource);

		// Not locked — acquire immediately
		if (!holder) {
			this.locks.set(resource, { agentId, acquiredAt: Date.now() });
			return true;
		}

		// Reentrant: same agent already holds it
		if (holder.agentId === agentId) {
			return true;
		}

		// Wait in queue with timeout
		return new Promise<boolean>((resolve) => {
			const waiter: Waiter = {
				agentId,
				resolve: () => {}, // replaced below
				timer: setTimeout(() => {
					// Timeout — remove from queue, resolve false
					const queue = this.waitQueues.get(resource);
					if (queue) {
						const idx = queue.indexOf(waiter);
						if (idx >= 0) queue.splice(idx, 1);
						if (queue.length === 0) this.waitQueues.delete(resource);
					}
					resolve(false);
				}, waitTimeoutMs),
			};

			// Wire resolve to clear its own timer (dangling timer pattern fix)
			waiter.resolve = (acquired: boolean) => {
				clearTimeout(waiter.timer);
				resolve(acquired);
			};

			if (!this.waitQueues.has(resource)) {
				this.waitQueues.set(resource, []);
			}
			this.waitQueues.get(resource)!.push(waiter);
		});
	}

	/**
	 * Release a lock. Grants to next waiter in FIFO order.
	 * Returns true if the lock was held by the given agent and released.
	 */
	release(resource: string, agentId: string): boolean {
		const holder = this.locks.get(resource);
		if (!holder || holder.agentId !== agentId) return false;

		this.locks.delete(resource);
		this.grantNextWaiter(resource);
		return true;
	}

	/** Release all locks held by an agent (cleanup on agent exit). */
	releaseAll(agentId: string): void {
		const resources = [...this.locks.entries()]
			.filter(([, entry]) => entry.agentId === agentId)
			.map(([resource]) => resource);

		for (const resource of resources) {
			this.release(resource, agentId);
		}
	}

	isLocked(resource: string): boolean {
		return this.locks.has(resource);
	}

	getHolder(resource: string): string | undefined {
		return this.locks.get(resource)?.agentId;
	}

	/** Clean up all locks and reject all waiters. */
	destroy(): void {
		for (const [, queue] of this.waitQueues) {
			for (const waiter of queue) {
				waiter.resolve(false);
			}
		}
		this.waitQueues.clear();
		this.locks.clear();
	}

	private grantNextWaiter(resource: string): void {
		const queue = this.waitQueues.get(resource);
		if (!queue || queue.length === 0) return;

		const next = queue.shift()!;
		if (queue.length === 0) this.waitQueues.delete(resource);

		this.locks.set(resource, {
			agentId: next.agentId,
			acquiredAt: Date.now(),
		});
		next.resolve(true);
	}
}
