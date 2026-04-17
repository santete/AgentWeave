/**
 * OuterHarness — Main governance class implementing OuterHarnessConsumer.
 * Wires PermissionEngine + OutputPipeline + BudgetManager + AuditLogger.
 * Connects to Control Plane as interceptor for tool_request, output_ready, input_received.
 */

import type {
	OuterHarnessConsumer,
	ControlPlane,
	InnerEvent,
	TerminalResult,
	ToolRequest,
	ToolDecision,
	RawOutput,
	OutputDecision,
	UserInput,
	InputDecision,
	HookEvent,
	HookResult,
	SessionInfo,
	PermissionConfig,
	AlertRule,
	HookDefinition,
	MultiAgentConfig,
} from "@agentweave/types";
import { PermissionEngine } from "./governance/permission-engine";
import { OutputPipeline } from "./governance/output-pipeline";
import type { OutputPipelineConfig } from "./governance/output-pipeline";
import { BudgetManager } from "./governance/budget-manager";
import type { BudgetConfig } from "./governance/budget-manager";
import { InputGate } from "./governance/input-gate";
import type { InputGateConfig } from "./governance/input-gate";
import { AuditLogger } from "./observability/audit-logger";
import { MonitorCollector } from "./observability/monitor-collector";
import { AlertEngine } from "./observability/alert-engine";
import { SessionManager } from "./observability/session-manager";
import type { SessionManagerConfig } from "./observability/session-manager";
import { HookEngine } from "./governance/hook-engine";
import { MultiAgentOrchestrator } from "./orchestration/multi-agent-orchestrator";

/** Events that can change alert-relevant state — skip noisy stream deltas */
const ALERT_CHECK_EVENTS = new Set([
	"turn:end",
	"tool:failed",
	"error",
	"llm:stream_end",
	"permission:denied",
]);

export interface OuterHarnessConfig {
	permissions: PermissionConfig;
	output: OutputPipelineConfig;
	budget: BudgetConfig;
	hooks?: Record<string, HookDefinition[]>;
	session?: SessionManagerConfig;
	alertRules?: AlertRule[];
	multiAgent?: MultiAgentConfig;
	inputGate?: InputGateConfig;
}

export class OuterHarness implements OuterHarnessConsumer {
	private permissions: PermissionEngine;
	private outputPipeline: OutputPipeline;
	private budget: BudgetManager;
	private hookEngine: HookEngine;
	private inputGate: InputGate;
	private audit: AuditLogger;
	private monitor: MonitorCollector;
	private alerts: AlertEngine;
	private sessions: SessionManager;
	private orchestrator: MultiAgentOrchestrator | null;
	private lastKnownCost = 0;

	constructor(config: OuterHarnessConfig) {
		this.permissions = new PermissionEngine(config.permissions);
		this.outputPipeline = new OutputPipeline(config.output);
		this.budget = new BudgetManager(config.budget);
		this.hookEngine = new HookEngine({ hooks: config.hooks ?? {} });
		this.inputGate = new InputGate(config.inputGate);
		this.audit = new AuditLogger();
		this.monitor = new MonitorCollector();
		this.alerts = new AlertEngine();
		this.sessions = new SessionManager(config.session);
		this.orchestrator = config.multiAgent
			? new MultiAgentOrchestrator(config.multiAgent)
			: null;

		if (config.alertRules) {
			for (const rule of config.alertRules) {
				this.alerts.addRule(rule);
			}
		}
	}

	/** Connect to a ControlPlane — register interceptors. */
	connectToControlPlane(cp: ControlPlane): void {
		cp.registerInterceptor("tool_request", (req) => this.onToolRequested(req));
		cp.registerInterceptor("output_ready", (req) => this.onOutputReady(req));
		cp.registerInterceptor("input_received", (req) =>
			this.onInputReceived(req),
		);
		cp.subscribe("*", (event) => this.onEvent(event));
	}

	// ─── Gates ───────────────────────────────────────────────────

	async onToolRequested(request: ToolRequest): Promise<ToolDecision> {
		// 1. Permission engine -> PermissionDecision (allow/deny/ask)
		const permDecision = await this.permissions.evaluate(request);

		this.audit.log("permission_decision", {
			tool: request.toolName,
			behavior: permDecision.behavior,
			source: permDecision.source,
		});

		// 2. Resolve ask -> for MVP, use failMode (no user interaction gate yet)
		let toolDecision: ToolDecision;
		if (permDecision.behavior === "ask") {
			const fallback =
				this.permissions.config.failMode === "open" ? "allow" : "deny";
			toolDecision = {
				behavior: fallback,
				reason: `Ask resolved to ${fallback} (no interaction gate in MVP)`,
				source: "default",
				resolvedFromAsk: true,
			};
		} else {
			toolDecision = {
				behavior: permDecision.behavior,
				modifiedInput: permDecision.modifiedInput,
				reason: permDecision.reason,
				source: permDecision.source,
			};
		}

		// 3. Budget check (only if allowing)
		if (toolDecision.behavior === "allow" && !this.budget.canProceed()) {
			this.audit.log("budget_exceeded", {
				tool: request.toolName,
				status: this.budget.getStatus(),
			});
			return {
				behavior: "deny",
				reason: "Budget exceeded",
				source: "budget",
			};
		}

		return toolDecision;
	}

	async onOutputReady(output: RawOutput): Promise<OutputDecision> {
		const decision = await this.outputPipeline.process(output);

		this.audit.log("output_processed", {
			action: decision.action,
			stages: decision.stages,
			redacted: decision.modifiedContent !== undefined,
		});

		return decision;
	}

	async onInputReceived(input: UserInput): Promise<InputDecision> {
		const result = this.inputGate.process(input.text);

		if (result.action === "reject") {
			this.audit.log("input_rejected", { reason: result.reason });
			return { action: "reject", reason: result.reason };
		}

		if (result.action === "transform") {
			return {
				action: "transform",
				transformedInput: result.transformedInput,
				injectedContext: result.injectedContext,
			};
		}

		return { action: "pass" };
	}

	// ─── Observers ───────────────────────────────────────────────

	onEvent(event: InnerEvent): void {
		this.audit.logEvent(event);
		this.monitor.collect(event);

		// Track cost DELTA from LLM usage events (not cumulative total)
		if (event.type === "llm:stream_end") {
			const currentTotal = event.usage.totalCost;
			const delta = currentTotal - this.lastKnownCost;
			if (delta > 0) {
				this.budget.addCost(delta);
				this.lastKnownCost = currentTotal;
			}
		}

		// Persist event to session transcript
		this.sessions.onEvent(event).catch(() => {
			// Non-blocking — don't crash on I/O error
		});

		// Check alerts only on state-changing events (skip noisy stream deltas)
		if (ALERT_CHECK_EVENTS.has(event.type)) {
			this.alerts.check(this.monitor.getSnapshot());
		}
	}

	async executeHooks(event: HookEvent): Promise<HookResult> {
		return this.hookEngine.execute(event);
	}

	async onSessionStart(session: SessionInfo): Promise<void> {
		this.audit.setSessionId(session.sessionId);
		this.audit.log("session_start", { session }, "lifecycle");
		this.budget.resetSession();
		this.lastKnownCost = 0;
		this.monitor.setSessionId(session.sessionId);
		this.monitor.reset();
		await this.sessions.onSessionStart(session);
	}

	async onSessionEnd(
		session: SessionInfo,
		result: TerminalResult,
	): Promise<void> {
		this.audit.log(
			"session_end",
			{ session, result, budgetStatus: this.budget.getStatus() },
			"lifecycle",
		);
		await this.sessions.onSessionEnd(session, result);
	}

	// ─── Accessors ───────────────────────────────────────────────

	getPermissionEngine(): PermissionEngine {
		return this.permissions;
	}

	getOutputPipeline(): OutputPipeline {
		return this.outputPipeline;
	}

	getBudgetManager(): BudgetManager {
		return this.budget;
	}

	getAuditLogger(): AuditLogger {
		return this.audit;
	}

	getHookEngine(): HookEngine {
		return this.hookEngine;
	}

	getMonitorCollector(): MonitorCollector {
		return this.monitor;
	}

	getAlertEngine(): AlertEngine {
		return this.alerts;
	}

	getSessionManager(): SessionManager {
		return this.sessions;
	}

	getOrchestrator(): MultiAgentOrchestrator | null {
		return this.orchestrator;
	}
}
