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
} from "@agentweave/types";
import { PermissionEngine } from "./governance/permission-engine";
import { OutputPipeline } from "./governance/output-pipeline";
import type { OutputPipelineConfig } from "./governance/output-pipeline";
import { BudgetManager } from "./governance/budget-manager";
import type { BudgetConfig } from "./governance/budget-manager";
import { AuditLogger } from "./observability/audit-logger";

export interface OuterHarnessConfig {
	permissions: PermissionConfig;
	output: OutputPipelineConfig;
	budget: BudgetConfig;
}

export class OuterHarness implements OuterHarnessConsumer {
	private permissions: PermissionEngine;
	private outputPipeline: OutputPipeline;
	private budget: BudgetManager;
	private audit: AuditLogger;
	private lastKnownCost = 0;

	constructor(config: OuterHarnessConfig) {
		this.permissions = new PermissionEngine(config.permissions);
		this.outputPipeline = new OutputPipeline(config.output);
		this.budget = new BudgetManager(config.budget);
		this.audit = new AuditLogger();
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

	async onInputReceived(_input: UserInput): Promise<InputDecision> {
		// MVP: passthrough — no input gate logic yet
		return { action: "pass" };
	}

	// ─── Observers ───────────────────────────────────────────────

	onEvent(event: InnerEvent): void {
		this.audit.logEvent(event);

		// Track cost DELTA from LLM usage events (not cumulative total)
		if (event.type === "llm:stream_end") {
			const currentTotal = event.usage.totalCost;
			const delta = currentTotal - this.lastKnownCost;
			if (delta > 0) {
				this.budget.addCost(delta);
				this.lastKnownCost = currentTotal;
			}
		}
	}

	async executeHooks(_event: HookEvent): Promise<HookResult> {
		// MVP: no hook engine yet — passthrough
		return { outcome: "pass" };
	}

	async onSessionStart(session: SessionInfo): Promise<void> {
		this.audit.setSessionId(session.sessionId);
		this.audit.log("session_start", { session }, "lifecycle");
		this.budget.resetSession();
		this.lastKnownCost = 0;
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
}
