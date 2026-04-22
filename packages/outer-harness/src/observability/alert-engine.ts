/**
 * AlertEngine — Rule-based alert system.
 * Checks MonitorSnapshot against configurable rules with cooldowns.
 */

import type {
	AlertRule,
	AlertEvent,
	AlertSeverity,
	MonitorSnapshot,
} from "@agentweave/types";
import type { AlertSink } from "./alert-sink";

export class AlertEngine {
	private rules: AlertRule[] = [];
	private lastFired = new Map<string, number>(); // ruleName -> timestamp
	private alerts: AlertEvent[] = [];
	private listeners: Array<(alert: AlertEvent) => void> = [];
	private sinks: AlertSink[] = [];

	addRule(rule: AlertRule): void {
		this.rules.push(rule);
	}

	removeRule(name: string): boolean {
		const idx = this.rules.findIndex((r) => r.name === name);
		if (idx === -1) return false;
		this.rules.splice(idx, 1);
		return true;
	}

	/** Check all rules against the current snapshot. Returns fired alerts. */
	check(snapshot: MonitorSnapshot): AlertEvent[] {
		const fired: AlertEvent[] = [];
		const now = Date.now();

		for (const rule of this.rules) {
			// Cooldown check
			const lastTime = this.lastFired.get(rule.name) ?? 0;
			if (now - lastTime < rule.cooldownMs) continue;

			// Evaluate rule
			let triggered: boolean;
			try {
				triggered = rule.check(snapshot);
			} catch {
				// Rule check threw — skip, don't crash
				continue;
			}

			if (triggered) {
				const alert: AlertEvent = {
					ruleId: rule.name,
					ruleName: rule.name,
					severity: rule.severity,
					message: rule.message ?? `Alert: ${rule.name}`,
					timestamp: now,
					sessionId: snapshot.sessionId,
					snapshot,
				};

				this.lastFired.set(rule.name, now);
				this.alerts.push(alert);
				fired.push(alert);

				// Notify listeners
				for (const listener of this.listeners) {
					try {
						listener(alert);
					} catch {
						// Listener error — don't crash engine
					}
				}

				// Fire-and-forget sink dispatch. `.catch()` guards against a sink
				// whose publish() rejects despite the MUST-NOT-throw contract,
				// so one bad sink never stalls the check() loop.
				for (const sink of this.sinks) {
					sink.publish(alert).catch(() => {
						// Sink violated its contract — swallow.
					});
				}
			}
		}

		return fired;
	}

	/** Register an AlertSink. Dispatched fire-and-forget on every fired alert. */
	addSink(sink: AlertSink): void {
		this.sinks.push(sink);
	}

	getSinks(): ReadonlyArray<AlertSink> {
		return this.sinks;
	}

	/** Close all sinks that implement close(). */
	async closeSinks(): Promise<void> {
		await Promise.all(
			this.sinks.map((s) =>
				s.close?.().catch(() => {
					/* swallow close errors */
				}),
			),
		);
	}

	/** Subscribe to alert events. */
	onAlert(listener: (alert: AlertEvent) => void): () => void {
		this.listeners.push(listener);
		return () => {
			const idx = this.listeners.indexOf(listener);
			if (idx !== -1) this.listeners.splice(idx, 1);
		};
	}

	getAlerts(): ReadonlyArray<AlertEvent> {
		return this.alerts;
	}

	getAlertsBySeverity(severity: AlertSeverity): AlertEvent[] {
		return this.alerts.filter((a) => a.severity === severity);
	}

	getRules(): ReadonlyArray<AlertRule> {
		return this.rules;
	}

	clearAlerts(): void {
		this.alerts = [];
	}

	resetCooldowns(): void {
		this.lastFired.clear();
	}
}

// ─── Built-in Alert Rules ────────────────────────────────────────

export function createDefaultAlertRules(options?: {
	budgetUsd?: number;
	warningThreshold?: number;
}): AlertRule[] {
	const budget = options?.budgetUsd ?? 10;
	const threshold = options?.warningThreshold ?? 0.8;

	return [
		{
			name: "budget_warning",
			severity: "warning",
			cooldownMs: 300_000, // 5 minutes
			message: `Session cost approaching budget limit ($${budget})`,
			check: (snap) =>
				snap.totalUsage.totalCost >= budget * threshold &&
				snap.totalUsage.totalCost < budget,
		},
		{
			name: "budget_exceeded",
			severity: "critical",
			cooldownMs: 0, // fire immediately, every time
			message: `Session budget exceeded ($${budget})`,
			check: (snap) => snap.totalUsage.totalCost >= budget,
		},
		{
			name: "high_error_rate",
			severity: "warning",
			cooldownMs: 60_000, // 1 minute
			message: "Tool error rate above 50%",
			check: (snap) => {
				let totalCalls = 0;
				let totalErrors = 0;
				for (const [, m] of snap.toolMetrics) {
					totalCalls += m.callCount;
					totalErrors += m.errorCount;
				}
				return totalCalls >= 5 && totalErrors / totalCalls > 0.5;
			},
		},
		{
			name: "long_session",
			severity: "info",
			cooldownMs: 600_000, // 10 minutes
			message: "Session running for over 10 minutes",
			check: (snap) => snap.sessionDurationMs > 600_000,
		},
	];
}
