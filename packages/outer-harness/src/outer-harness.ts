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
	AlertSeverity,
	HookDefinition,
	MultiAgentConfig,
} from "@agentweave/types";
import { PermissionEngine } from "./governance/permission-engine";
import { AskStore } from "./governance/ask-store";
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
import { PrometheusExporter } from "./observability/prometheus-exporter";
import { StdoutSink, FileSink, WebhookSink } from "./observability/alert-sink";

/** Events that can change alert-relevant state — skip noisy stream deltas */
const ALERT_CHECK_EVENTS = new Set([
	"turn:end",
	"tool:failed",
	"error",
	"llm:stream_end",
	"permission:denied",
]);

export type AlertSinkConfig =
	| { type: "stdout"; severityFilter?: AlertSeverity[] }
	| { type: "file"; path: string; severityFilter?: AlertSeverity[] }
	| {
			type: "webhook";
			url: string;
			method?: "POST" | "PUT";
			headers?: Record<string, string>;
			maxRetries?: number;
			timeoutMs?: number;
			severityFilter?: AlertSeverity[];
	  };

export interface MonitoringConfig {
	prometheus?: {
		enabled: boolean;
		instance?: string;
		includeSessionLabel?: boolean;
	};
	alertSinks?: AlertSinkConfig[];
}

export interface AskPersistenceConfig {
	enabled: boolean;
	/** Absolute or cwd-relative path. Default: `.agentweave/ask-approvals.json`. */
	path?: string;
	/** Override base directory for relative paths; defaults to `process.cwd()`. */
	cwd?: string;
}

export interface OuterHarnessConfig {
	permissions: PermissionConfig;
	output: OutputPipelineConfig;
	budget: BudgetConfig;
	hooks?: Record<string, HookDefinition[]>;
	session?: SessionManagerConfig;
	alertRules?: AlertRule[];
	multiAgent?: MultiAgentConfig;
	inputGate?: InputGateConfig;
	/** Opt-in observability — omit to keep current zero-behavior-change default. */
	monitoring?: MonitoringConfig;
	/** Handler for permission "ask" flow. If not set, falls back to failMode. */
	onAsk?: (toolName: string, toolInput: Record<string, unknown>, message: string) => Promise<{ allow: boolean; alwaysAllow?: boolean }>;
	/** Opt-in persistence of "always allow" decisions across process restarts. */
	askPersistence?: AskPersistenceConfig;
}

export class OuterHarness implements OuterHarnessConsumer {
	private permissions: PermissionEngine;
	private outputPipeline: OutputPipeline;
	private budget: BudgetManager;
	private hookEngine: HookEngine;
	private inputGate: InputGate;
	private askHandler: OuterHarnessConfig["onAsk"];
	private askStore: AskStore | null = null;
	private audit: AuditLogger;
	private monitor: MonitorCollector;
	private alerts: AlertEngine;
	private sessions: SessionManager;
	private orchestrator: MultiAgentOrchestrator | null;
	private prometheusExporter: PrometheusExporter | null = null;
	private lastKnownCost = 0;
	private currentModel = "";
	private currentToolName = "";

	constructor(config: OuterHarnessConfig) {
		this.permissions = new PermissionEngine(config.permissions);
		this.outputPipeline = new OutputPipeline(config.output);
		this.budget = new BudgetManager(config.budget);
		this.hookEngine = new HookEngine({ hooks: config.hooks ?? {} });
		this.inputGate = new InputGate(config.inputGate);
		this.askHandler = config.onAsk;
		if (config.askPersistence?.enabled) {
			this.askStore = new AskStore({
				path: config.askPersistence.path,
				cwd: config.askPersistence.cwd,
			});
			for (const rule of this.askStore.load()) {
				this.permissions.addRule(rule);
			}
		}
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

		// Opt-in monitoring wiring. `monitoring` absent → zero behavior change.
		if (config.monitoring) {
			for (const sinkCfg of config.monitoring.alertSinks ?? []) {
				this.alerts.addSink(buildSink(sinkCfg));
			}
			if (config.monitoring.prometheus?.enabled) {
				const { instance, includeSessionLabel } = config.monitoring.prometheus;
				this.prometheusExporter = new PrometheusExporter(this.monitor, this.alerts, {
					instance,
					includeSessionLabel,
				});
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

		// 2. Resolve ask via handler or failMode fallback
		let toolDecision: ToolDecision;
		if (permDecision.behavior === "ask") {
			if (this.askHandler) {
				const askMsg = permDecision.askMessage ?? `Allow ${request.toolName}?`;
				const response = await this.askHandler(request.toolName, request.toolInput, askMsg);
				toolDecision = {
					behavior: response.allow ? "allow" : "deny",
					reason: response.allow ? "User approved" : "User denied",
					source: "user",
					resolvedFromAsk: true,
				};
				// Persist "always allow" as runtime rule (and to disk if configured)
				if (response.allow && response.alwaysAllow) {
					const runtimeRule = {
						pattern: `${request.toolName}(*)`,
						behavior: "allow" as const,
						source: "runtime" as const,
						priority: 75,
					};
					this.permissions.addRule(runtimeRule);
					this.askStore?.persist(runtimeRule);
				}
			} else {
				const fallback =
					this.permissions.config.failMode === "open" ? "allow" : "deny";
				toolDecision = {
					behavior: fallback,
					reason: `Ask resolved to ${fallback} (no ask handler configured)`,
					source: "default",
					resolvedFromAsk: true,
				};
			}
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

		// Track current model and tool for cost metadata
		if (event.type === "llm:request_start") {
			this.currentModel = (event as unknown as Record<string, unknown>).model as string ?? "";
		}
		if (event.type === "tool:requested") {
			this.currentToolName = (event as unknown as Record<string, unknown>).toolName as string ?? "";
		}

		// Track cost DELTA from LLM usage events (not cumulative total)
		if (event.type === "llm:stream_end") {
			const currentTotal = event.usage.totalCost;
			const delta = currentTotal - this.lastKnownCost;
			if (delta > 0) {
				this.budget.addCost(delta, {
					model: this.currentModel || undefined,
					toolName: this.currentToolName || undefined,
				});
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

	/** Returns a PrometheusExporter if `config.monitoring.prometheus.enabled`, else null. */
	getPrometheusExporter(): PrometheusExporter | null {
		return this.prometheusExporter;
	}
}

function buildSink(cfg: AlertSinkConfig) {
	switch (cfg.type) {
		case "stdout":
			return new StdoutSink({ severityFilter: cfg.severityFilter });
		case "file":
			return new FileSink({ path: cfg.path, severityFilter: cfg.severityFilter });
		case "webhook":
			return new WebhookSink({
				url: cfg.url,
				method: cfg.method,
				headers: cfg.headers,
				maxRetries: cfg.maxRetries,
				timeoutMs: cfg.timeoutMs,
				severityFilter: cfg.severityFilter,
			});
	}
}
