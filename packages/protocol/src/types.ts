/**
 * AWOCP — AgentWeave Outer Control Protocol.
 * Message types for WebSocket communication between Dev Node and Gateway.
 */

import type { ToolRequest, ToolDecision, RawOutput, OutputDecision, InnerEvent } from "@agentweave/types";

// ─── Message Types ──────────────────────────────────────────────

export type AWOCPMessageType =
	// Handshake
	| "auth:request"
	| "auth:response"
	// Intercept (request/response)
	| "intercept:tool_request"
	| "intercept:tool_response"
	| "intercept:output_request"
	| "intercept:output_response"
	// Events (fire-and-forget)
	| "event:inner"
	// Health
	| "health:ping"
	| "health:pong";

// ─── Envelope ───────────────────────────────────────────────────

export interface AWOCPMessage<T = unknown> {
	id: string;
	ts: string;
	type: AWOCPMessageType;
	sessionId: string;
	agentId: string;
	correlationId?: string;
	payload: T;
}

// ─── Auth Payloads ──────────────────────────────────────────────

export interface AuthRequestPayload {
	token: string;
	clientVersion: string;
	sessionInfo: {
		sessionId: string;
		userId: string;
		model: string;
	};
}

export interface AuthResponsePayload {
	status: "ok" | "denied" | "version_mismatch";
	serverId?: string;
	serverVersion?: string;
	error?: string;
}

// ─── Intercept Payloads (reuse types from @agentweave/types) ────

export type InterceptToolRequestPayload = ToolRequest;
export type InterceptToolResponsePayload = ToolDecision;
export type InterceptOutputRequestPayload = RawOutput;
export type InterceptOutputResponsePayload = OutputDecision;

// ─── Event Payload ──────────────────────────────────────────────

export type EventInnerPayload = InnerEvent;

// ─── Health ─────────────────────────────────────────────────────

export interface HealthPingPayload {
	clientTime: string;
}

export interface HealthPongPayload {
	serverTime: string;
}
