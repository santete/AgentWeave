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
	private static readonly MAX_ENTRIES = 10_000;
	private entries: AuditEntry[] = [];
	private sessionId = "";

	setSessionId(sessionId: string): void {
		this.sessionId = sessionId;
	}

	log(action: string, details: Record<string, unknown>, category = "governance"): void {
		this.appendEntry({
			timestamp: Date.now(),
			sessionId: this.sessionId,
			category,
			action,
			details,
		});
	}

	logEvent(event: InnerEvent): void {
		this.appendEntry({
			timestamp: event.timestamp,
			sessionId: event.sessionId,
			category: "event",
			action: event.type,
			details: { ...event },
		});
	}

	private appendEntry(entry: AuditEntry): void {
		this.entries.push(entry);
		if (this.entries.length > AuditLogger.MAX_ENTRIES) {
			this.entries.splice(0, this.entries.length - AuditLogger.MAX_ENTRIES);
		}
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
