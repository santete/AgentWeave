/**
 * GatewayServer — Main entry point for the AgentWeave Gateway.
 * Wires AWOCPServer with a shared OuterHarness for centralized governance.
 */

import type { PermissionConfig, InnerEvent, ToolRequest, RawOutput } from "@agentweave/types";
import { OuterHarness } from "@agentweave/outer-harness";
import type { OuterHarnessConfig } from "@agentweave/outer-harness";
import type { BudgetConfig } from "@agentweave/outer-harness";
import type { OutputPipelineConfig } from "@agentweave/outer-harness";
import { AWOCPServer } from "./server";
import type { AuthConfig } from "./auth";

// ─── Config ─────────────────────────────────────────────────────

export interface GatewayConfig {
	/** WebSocket port (default 9100) */
	port: number;
	/** Auth configuration */
	auth: AuthConfig;
	/** Shared permission rules (applied to all connected agents) */
	permissions: PermissionConfig;
	/** Shared output pipeline config */
	output?: OutputPipelineConfig;
	/** Shared budget config */
	budget?: BudgetConfig;
	/** Server identification */
	serverId?: string;
}

// ─── Gateway ────────────────────────────────────────────────────

export class GatewayServer {
	private static readonly MAX_EVENT_LOG = 10_000;
	private server: AWOCPServer;
	private outer: OuterHarness;
	private eventLog: InnerEvent[] = [];

	constructor(config: GatewayConfig) {
		// Build shared OuterHarness
		const outerConfig: OuterHarnessConfig = {
			permissions: config.permissions,
			output: config.output ?? { gateMode: "auto", filters: [] },
			budget: config.budget ?? { warningThreshold: 0.8 },
		};
		this.outer = new OuterHarness(outerConfig);

		// Build AWOCP server
		this.server = new AWOCPServer({
			port: config.port,
			auth: config.auth,
			serverId: config.serverId,
		});

		// Wire intercepts → OuterHarness governance
		// Narrowing: server.ts validates payload shape before calling handler
		this.server.onIntercept(async (type, payload) => {
			if (type === "tool_request") {
				return this.outer.onToolRequested(payload as ToolRequest);
			}
			return this.outer.onOutputReady(payload as RawOutput);
		});

		// Wire events → collect for observability (capped ring buffer)
		this.server.onEvent((event) => {
			this.outer.onEvent(event);
			this.eventLog.push(event);
			if (this.eventLog.length > GatewayServer.MAX_EVENT_LOG) {
				this.eventLog.splice(0, this.eventLog.length - GatewayServer.MAX_EVENT_LOG);
			}
		});
	}

	async start(): Promise<void> {
		await this.server.start();
	}

	async stop(): Promise<void> {
		await this.server.stop();
	}

	/** Access the shared OuterHarness (for inspection/testing). */
	getOuterHarness(): OuterHarness {
		return this.outer;
	}

	/** Access the underlying AWOCP server. */
	getServer(): AWOCPServer {
		return this.server;
	}

	/** Get all forwarded events (for observability). */
	getEventLog(): ReadonlyArray<InnerEvent> {
		return this.eventLog;
	}

	/** Number of connected clients. */
	getClientCount(): number {
		return this.server.getClientCount();
	}
}
