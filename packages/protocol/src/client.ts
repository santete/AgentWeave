/**
 * AWOCPClient — WebSocket client for Dev Node → Gateway communication.
 * Supports auth handshake, request/response intercepts, fire-and-forget events,
 * ping/pong health checks, and reconnection with exponential backoff.
 */

import { randomUUID } from "node:crypto";
import WebSocket from "ws";
import { AGENTWEAVE_VERSION } from "@agentweave/types";
import type { ToolRequest, ToolDecision, RawOutput, OutputDecision, InnerEvent } from "@agentweave/types";
import type {
	AWOCPMessage,
	AuthRequestPayload,
	AuthResponsePayload,
} from "./types";

// ─── Config ─────────────────────────────────────────────────────

export interface AWOCPClientConfig {
	/** Gateway WebSocket URL (e.g. ws://localhost:9100/awocp/v1) */
	url: string;
	/** Bearer token for authentication */
	token: string;
	/** Session ID of the current agent session */
	sessionId: string;
	/** Agent ID */
	agentId: string;
	/** User ID */
	userId: string;
	/** Client version string */
	clientVersion?: string;
	/** LLM model in use */
	model?: string;
	/** Enable auto-reconnection (default true) */
	reconnect?: boolean;
	/** Ping interval in ms (default 30000) */
	pingIntervalMs?: number;
	/** Intercept request timeout in ms (default 5000) */
	interceptTimeoutMs?: number;
}

// ─── Pending Intercept Tracker ──────────────────────────────────

interface PendingIntercept<T> {
	resolve: (value: T) => void;
	reject: (err: Error) => void;
	timer: ReturnType<typeof setTimeout>;
}

// ─── Client ─────────────────────────────────────────────────────

export class AWOCPClient {
	private ws: WebSocket | null = null;
	private config: Required<
		Pick<AWOCPClientConfig, "url" | "token" | "sessionId" | "agentId" | "userId">
	> &
		AWOCPClientConfig;
	private pendingIntercepts = new Map<string, PendingIntercept<unknown>>();
	private pingTimer: ReturnType<typeof setInterval> | null = null;
	private reconnectAttempt = 0;
	private disconnectHandler: (() => void) | null = null;
	private _connected = false;
	private _authenticated = false;
	private _destroyed = false;

	constructor(config: AWOCPClientConfig) {
		this.config = {
			clientVersion: AGENTWEAVE_VERSION,
			model: "unknown",
			reconnect: true,
			pingIntervalMs: 30_000,
			interceptTimeoutMs: 5_000,
			...config,
		};
	}

	// ─── Connect + Auth ─────────────────────────────────────────

	/** Connect to Gateway and complete auth handshake. */
	async connect(): Promise<AuthResponsePayload> {
		if (this._destroyed) throw new Error("Client destroyed");

		return new Promise<AuthResponsePayload>((resolve, reject) => {
			const ws = new WebSocket(this.config.url);
			this.ws = ws;

			const authTimeout = setTimeout(() => {
				ws.close();
				reject(new Error("Auth handshake timeout"));
			}, 10_000);

			ws.on("open", () => {
				this._connected = true;
				this.reconnectAttempt = 0;

				// Send auth request
				const authMsg = this.makeMessage<AuthRequestPayload>("auth:request", {
					token: this.config.token,
					clientVersion: this.config.clientVersion!,
					sessionInfo: {
						sessionId: this.config.sessionId,
						userId: this.config.userId,
						model: this.config.model!,
					},
				});
				ws.send(JSON.stringify(authMsg));
			});

			ws.on("message", (data) => {
				const msg = this.parseMessage(data);
				if (!msg) return;

				// Auth response (first message)
				if (msg.type === "auth:response" && !this._authenticated) {
					clearTimeout(authTimeout);
					const payload = asAuthResponse(msg.payload);
					if (!payload) {
						ws.close();
						reject(new Error("Malformed auth response"));
						return;
					}
					if (payload.status === "ok") {
						this._authenticated = true;
						this.startPing();
						this.setupMessageHandler();
						resolve(payload);
					} else {
						ws.close();
						reject(new Error(payload.error ?? `Auth failed: ${payload.status}`));
					}
					return;
				}
			});

			ws.on("close", () => {
				clearTimeout(authTimeout);
				this.cleanup();
				if (!this._authenticated) {
					reject(new Error("Connection closed before auth"));
					return;
				}
				this.disconnectHandler?.();
				if (this.config.reconnect && !this._destroyed) {
					this.scheduleReconnect();
				}
			});

			ws.on("error", (err) => {
				clearTimeout(authTimeout);
				if (!this._authenticated) {
					reject(err);
				}
			});
		});
	}

	/** Disconnect and stop reconnection. */
	disconnect(): void {
		this._destroyed = true;
		this.cleanup();
		this.ws?.close();
		this.ws = null;
	}

	// ─── Intercepts ─────────────────────────────────────────────

	/** Send a tool_request intercept and wait for response. */
	async interceptTool(request: ToolRequest): Promise<ToolDecision> {
		return this.sendIntercept<ToolDecision>("intercept:tool_request", request);
	}

	/** Send an output_ready intercept and wait for response. */
	async interceptOutput(request: RawOutput): Promise<OutputDecision> {
		return this.sendIntercept<OutputDecision>("intercept:output_request", request);
	}

	// ─── Events ─────────────────────────────────────────────────

	/** Forward an inner event to Gateway (fire-and-forget). */
	sendEvent(event: InnerEvent): void {
		if (!this.canSend()) return;
		const msg = this.makeMessage("event:inner", event);
		this.ws!.send(JSON.stringify(msg));
	}

	// ─── State ──────────────────────────────────────────────────

	isConnected(): boolean {
		return this._connected && this._authenticated;
	}

	/** Check if socket is authenticated and ready to send. */
	private canSend(): boolean {
		return this._authenticated && !!this.ws && this.ws.readyState === WebSocket.OPEN;
	}

	onDisconnect(handler: () => void): void {
		this.disconnectHandler = handler;
	}

	// ─── Internal ───────────────────────────────────────────────

	private async sendIntercept<T>(
		requestType: AWOCPMessage["type"],
		payload: unknown,
	): Promise<T> {
		if (!this.canSend()) {
			throw new Error("Not connected to Gateway");
		}

		const correlationId = randomUUID();
		const msg = this.makeMessage(requestType, payload, correlationId);

		return new Promise<T>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pendingIntercepts.delete(correlationId);
				reject(new Error(`Intercept timeout: ${requestType} (${this.config.interceptTimeoutMs}ms)`));
			}, this.config.interceptTimeoutMs!);

			this.pendingIntercepts.set(correlationId, {
				resolve: resolve as (v: unknown) => void,
				reject,
				timer,
			});

			this.ws!.send(JSON.stringify(msg));
		});
	}

	private setupMessageHandler(): void {
		if (!this.ws) return;

		// Replace ALL auth-phase handlers with post-auth handlers
		this.ws.removeAllListeners("message");
		this.ws.removeAllListeners("close");
		this.ws.removeAllListeners("error");

		this.ws.on("close", () => {
			this.cleanup();
			this.disconnectHandler?.();
			if (this.config.reconnect && !this._destroyed) {
				this.scheduleReconnect();
			}
		});

		this.ws.on("error", () => {
			// Logged implicitly via close event — no action needed
		});

		this.ws.on("message", (data) => {
			const msg = this.parseMessage(data);
			if (!msg) return;

			// Health pong
			if (msg.type === "health:pong") return;

			// Intercept response — match by correlationId
			if (msg.correlationId) {
				const pending = this.pendingIntercepts.get(msg.correlationId);
				if (pending) {
					clearTimeout(pending.timer);
					this.pendingIntercepts.delete(msg.correlationId);
					pending.resolve(msg.payload);
				}
			}
		});
	}

	private makeMessage<T>(
		type: AWOCPMessage["type"],
		payload: T,
		correlationId?: string,
	): AWOCPMessage<T> {
		return {
			id: randomUUID(),
			ts: new Date().toISOString(),
			type,
			sessionId: this.config.sessionId,
			agentId: this.config.agentId,
			correlationId,
			payload,
		};
	}

	private parseMessage(data: WebSocket.RawData): AWOCPMessage | null {
		try {
			const parsed: unknown = JSON.parse(String(data));
			if (!isAWOCPMessage(parsed)) return null;
			return parsed;
		} catch {
			return null;
		}
	}

	private startPing(): void {
		this.stopPing();
		this.pingTimer = setInterval(() => {
			if (this.ws?.readyState === WebSocket.OPEN) {
				const msg = this.makeMessage("health:ping", {
					clientTime: new Date().toISOString(),
				});
				this.ws.send(JSON.stringify(msg));
			}
		}, this.config.pingIntervalMs!);
	}

	private stopPing(): void {
		if (this.pingTimer) {
			clearInterval(this.pingTimer);
			this.pingTimer = null;
		}
	}

	private cleanup(): void {
		this._connected = false;
		this._authenticated = false;
		this.stopPing();

		// Reject all pending intercepts
		for (const [id, pending] of this.pendingIntercepts) {
			clearTimeout(pending.timer);
			pending.reject(new Error("Connection lost"));
			this.pendingIntercepts.delete(id);
		}
	}

	private scheduleReconnect(): void {
		if (this._destroyed) return;

		const delays = [1000, 2000, 4000, 8000, 16000, 30000];
		const delay = delays[Math.min(this.reconnectAttempt, delays.length - 1)]!;
		this.reconnectAttempt++;

		setTimeout(() => {
			if (this._destroyed) return;
			this.connect().catch(() => {
				// Reconnect failed — will retry via close handler
			});
		}, delay);
	}
}

// ─── Runtime Type Guards ────────────────────────────────────────

function isRecord(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isAWOCPMessage(v: unknown): v is AWOCPMessage {
	if (!isRecord(v)) return false;
	return typeof v.type === "string" && typeof v.sessionId === "string" && "payload" in v;
}

function asAuthResponse(v: unknown): AuthResponsePayload | null {
	if (!isRecord(v)) return null;
	const status = v.status;
	if (status !== "ok" && status !== "denied" && status !== "version_mismatch") return null;
	return {
		status,
		serverId: typeof v.serverId === "string" ? v.serverId : undefined,
		serverVersion: typeof v.serverVersion === "string" ? v.serverVersion : undefined,
		error: typeof v.error === "string" ? v.error : undefined,
	};
}
