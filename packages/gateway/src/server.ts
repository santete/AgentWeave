/**
 * AWOCPServer — WebSocket server handling AWOCP protocol.
 * Manages client connections, auth, message routing, and health checks.
 */

import { randomUUID } from "node:crypto";
import { WebSocketServer, WebSocket } from "ws";
import type {
	AWOCPMessage,
	AuthRequestPayload,
	AuthResponsePayload,
} from "@agentweave/protocol";
import type { ToolRequest, ToolDecision, RawOutput, OutputDecision, InnerEvent } from "@agentweave/types";
import { verifyAuth } from "./auth";
import type { AuthConfig } from "./auth";

// ─── Types ──────────────────────────────────────────────────────

export interface AWOCPServerConfig {
	port: number;
	auth: AuthConfig;
	serverId?: string;
	serverVersion?: string;
	/** Auth handshake timeout in ms (default 10000) */
	authTimeoutMs?: number;
}

export interface ClientConnection {
	id: string;
	ws: WebSocket;
	userId: string;
	sessionId: string;
	agentId: string;
	authenticatedAt: number;
}

export type InterceptHandler = (
	type: "tool_request" | "output_request",
	payload: ToolRequest | RawOutput,
	client: ClientConnection,
) => Promise<ToolDecision | OutputDecision>;

export type EventHandler = (event: InnerEvent, client: ClientConnection) => void;

// ─── Server ─────────────────────────────────────────────────────

export class AWOCPServer {
	private wss: WebSocketServer | null = null;
	private clients = new Map<string, ClientConnection>();
	private interceptHandler: InterceptHandler | null = null;
	private eventHandler: EventHandler | null = null;
	private config: AWOCPServerConfig;

	constructor(config: AWOCPServerConfig) {
		this.config = config;
	}

	/** Start the WebSocket server. */
	async start(): Promise<void> {
		return new Promise<void>((resolve) => {
			this.wss = new WebSocketServer({ port: this.config.port }, () => {
				resolve();
			});

			this.wss.on("connection", (ws) => {
				this.handleNewConnection(ws);
			});
		});
	}

	/** Stop the server and close all connections. */
	async stop(): Promise<void> {
		// Close all client connections
		for (const client of this.clients.values()) {
			client.ws.close();
		}
		this.clients.clear();

		return new Promise<void>((resolve) => {
			if (this.wss) {
				this.wss.close(() => {
					this.wss = null;
					resolve();
				});
			} else {
				resolve();
			}
		});
	}

	/** Register handler for intercept requests (tool/output). */
	onIntercept(handler: InterceptHandler): void {
		this.interceptHandler = handler;
	}

	/** Register handler for forwarded inner events. */
	onEvent(handler: EventHandler): void {
		this.eventHandler = handler;
	}

	getClients(): ClientConnection[] {
		return [...this.clients.values()];
	}

	getClientCount(): number {
		return this.clients.size;
	}

	// ─── Connection Handling ────────────────────────────────────

	private handleNewConnection(ws: WebSocket): void {
		const connectionId = randomUUID().slice(0, 8);
		let authenticated = false;

		const authTimeout = setTimeout(() => {
			if (!authenticated) {
				ws.close(4001, "Auth timeout");
			}
		}, this.config.authTimeoutMs ?? 10_000);

		ws.on("message", (data) => {
			const msg = this.parseMessage(data);
			if (!msg) return;

			// ── Auth phase ──
			if (!authenticated && msg.type === "auth:request") {
				clearTimeout(authTimeout);
				const authPayload = msg.payload as AuthRequestPayload;
				const authResult = verifyAuth(authPayload, this.config.auth);

				// Send auth response
				const response: AWOCPMessage<AuthResponsePayload> = {
					id: randomUUID(),
					ts: new Date().toISOString(),
					type: "auth:response",
					sessionId: msg.sessionId,
					agentId: msg.agentId,
					payload: {
						...authResult,
						serverId: this.config.serverId ?? "gateway-1",
						serverVersion: this.config.serverVersion ?? "0.5.0",
					},
				};
				ws.send(JSON.stringify(response));

				if (authResult.status === "ok") {
					authenticated = true;
					const client: ClientConnection = {
						id: connectionId,
						ws,
						userId: authPayload.sessionInfo.userId,
						sessionId: authPayload.sessionInfo.sessionId,
						agentId: msg.agentId,
						authenticatedAt: Date.now(),
					};
					this.clients.set(connectionId, client);
				} else {
					ws.close(4003, authResult.error ?? "Auth failed");
				}
				return;
			}

			if (!authenticated) {
				ws.close(4001, "Not authenticated");
				return;
			}

			const client = this.clients.get(connectionId);
			if (!client) return;

			// ── Intercept requests ──
			if (msg.type === "intercept:tool_request" || msg.type === "intercept:output_request") {
				this.handleIntercept(msg, client);
				return;
			}

			// ── Events ──
			if (msg.type === "event:inner") {
				try {
					this.eventHandler?.(msg.payload as InnerEvent, client);
				} catch {
					// Non-blocking
				}
				return;
			}

			// ── Health ping ──
			if (msg.type === "health:ping") {
				const pong: AWOCPMessage = {
					id: randomUUID(),
					ts: new Date().toISOString(),
					type: "health:pong",
					sessionId: msg.sessionId,
					agentId: msg.agentId,
					payload: { serverTime: new Date().toISOString() },
				};
				ws.send(JSON.stringify(pong));
			}
		});

		ws.on("close", () => {
			clearTimeout(authTimeout);
			this.clients.delete(connectionId);
		});

		ws.on("error", () => {
			clearTimeout(authTimeout);
			this.clients.delete(connectionId);
		});
	}

	private async handleIntercept(
		msg: AWOCPMessage,
		client: ClientConnection,
	): Promise<void> {
		const responseType = msg.type === "intercept:tool_request"
			? "intercept:tool_response"
			: "intercept:output_response";

		// Reject requests without correlationId — client can't match response
		if (!msg.correlationId) {
			const errorPayload = msg.type === "intercept:tool_request"
				? { behavior: "deny" as const, reason: "Missing correlationId", source: "gateway" }
				: { action: "approve" as const, stages: [], reason: "Missing correlationId" };
			client.ws.send(JSON.stringify({
				id: randomUUID(), ts: new Date().toISOString(),
				type: responseType, sessionId: msg.sessionId, agentId: msg.agentId,
				payload: errorPayload,
			}));
			return;
		}

		if (!this.interceptHandler) return;

		const interceptType = msg.type === "intercept:tool_request"
			? "tool_request" as const
			: "output_request" as const;

		try {
			const result = await this.interceptHandler(
				interceptType,
				msg.payload as ToolRequest | RawOutput,
				client,
			);

			const response: AWOCPMessage = {
				id: randomUUID(),
				ts: new Date().toISOString(),
				type: responseType,
				sessionId: msg.sessionId,
				agentId: msg.agentId,
				correlationId: msg.correlationId,
				payload: result,
			};
			client.ws.send(JSON.stringify(response));
		} catch (err) {
			// Send error response so client doesn't timeout
			const response: AWOCPMessage = {
				id: randomUUID(),
				ts: new Date().toISOString(),
				type: responseType,
				sessionId: msg.sessionId,
				agentId: msg.agentId,
				correlationId: msg.correlationId,
				payload: interceptType === "tool_request"
					? { behavior: "deny", reason: "Gateway error", source: "gateway" }
					: { action: "approve", stages: [], reason: "Gateway error" },
			};
			client.ws.send(JSON.stringify(response));
		}
	}

	private parseMessage(data: unknown): AWOCPMessage | null {
		try {
			return JSON.parse(String(data)) as AWOCPMessage;
		} catch {
			return null;
		}
	}
}
