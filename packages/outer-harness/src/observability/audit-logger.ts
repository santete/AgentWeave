/**
 * AuditLogger — Immutable, append-only audit log.
 * Records all permission decisions, tool executions, and lifecycle events.
 */

import type { InnerEvent } from "@agentweave/types";

export interface AuditEntry {
	timestamp: number;
	sessionId: string;
	category: string;
	action: string;
	details: Record<string, unknown>;
}

export class AuditLogger {
	private entries: AuditEntry[] = [];
	private sessionId = "";

	setSessionId(sessionId: string): void {
		this.sessionId = sessionId;
	}

	log(action: string, details: Record<string, unknown>, category = "governance"): void {
		this.entries.push({
			timestamp: Date.now(),
			sessionId: this.sessionId,
			category,
			action,
			details,
		});
	}

	logEvent(event: InnerEvent): void {
		this.entries.push({
			timestamp: event.timestamp,
			sessionId: event.sessionId,
			category: "event",
			action: event.type,
			details: { ...event },
		});
	}

	getEntries(): ReadonlyArray<AuditEntry> {
		return this.entries;
	}

	getEntriesByCategory(category: string): AuditEntry[] {
		return this.entries.filter((e) => e.category === category);
	}

	getEntriesByAction(action: string): AuditEntry[] {
		return this.entries.filter((e) => e.action === action);
	}

	size(): number {
		return this.entries.length;
	}
}
