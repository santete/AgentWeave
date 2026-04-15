import { describe, it, expect } from "vitest";
import { AuditLogger } from "../src/observability/audit-logger";
import type { InnerEvent } from "@agentweave/types";

describe("AuditLogger", () => {
	it("should start empty", () => {
		const logger = new AuditLogger();
		expect(logger.size()).toBe(0);
		expect(logger.getEntries()).toEqual([]);
	});

	it("should log entries with timestamp and sessionId", () => {
		const logger = new AuditLogger();
		logger.setSessionId("ses_123");
		logger.log("tool_allowed", { tool: "Bash" });

		const entries = logger.getEntries();
		expect(entries).toHaveLength(1);
		expect(entries[0]!.sessionId).toBe("ses_123");
		expect(entries[0]!.action).toBe("tool_allowed");
		expect(entries[0]!.category).toBe("governance");
		expect(entries[0]!.details.tool).toBe("Bash");
		expect(entries[0]!.timestamp).toBeGreaterThan(0);
	});

	it("should log with custom category", () => {
		const logger = new AuditLogger();
		logger.log("session_start", { model: "sonnet" }, "lifecycle");

		expect(logger.getEntries()[0]!.category).toBe("lifecycle");
	});

	it("should log inner events", () => {
		const logger = new AuditLogger();
		const event: InnerEvent = {
			id: "evt_1",
			timestamp: Date.now(),
			sessionId: "ses_1",
			agentId: "agent_1",
			type: "tool:completed",
			toolUseId: "tu_1",
			result: "ok",
			durationMs: 42,
		};

		logger.logEvent(event);

		const entries = logger.getEntries();
		expect(entries).toHaveLength(1);
		expect(entries[0]!.category).toBe("event");
		expect(entries[0]!.action).toBe("tool:completed");
		expect(entries[0]!.sessionId).toBe("ses_1");
	});

	it("should filter by category", () => {
		const logger = new AuditLogger();
		logger.log("a", {}, "governance");
		logger.log("b", {}, "lifecycle");
		logger.log("c", {}, "governance");

		const governance = logger.getEntriesByCategory("governance");
		expect(governance).toHaveLength(2);
		expect(governance.map((e) => e.action)).toEqual(["a", "c"]);
	});

	it("should filter by action", () => {
		const logger = new AuditLogger();
		logger.log("permission_decision", { tool: "Bash" });
		logger.log("budget_check", { cost: 1.5 });
		logger.log("permission_decision", { tool: "FileRead" });

		const perms = logger.getEntriesByAction("permission_decision");
		expect(perms).toHaveLength(2);
	});

	it("should be append-only (entries are readonly)", () => {
		const logger = new AuditLogger();
		logger.log("test", { x: 1 });

		const entries = logger.getEntries();
		expect(entries).toHaveLength(1);
		// ReadonlyArray — can't mutate
	});

	it("should track size correctly", () => {
		const logger = new AuditLogger();
		expect(logger.size()).toBe(0);

		logger.log("a", {});
		logger.log("b", {});
		logger.log("c", {});

		expect(logger.size()).toBe(3);
	});
});
