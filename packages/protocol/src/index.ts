// AWOCP Message Types
export type {
	AWOCPMessageType,
	AWOCPMessage,
	AuthRequestPayload,
	AuthResponsePayload,
	InterceptToolRequestPayload,
	InterceptToolResponsePayload,
	InterceptOutputRequestPayload,
	InterceptOutputResponsePayload,
	EventInnerPayload,
	HealthPingPayload,
	HealthPongPayload,
} from "./types";

// Client
export { AWOCPClient } from "./client";
export type { AWOCPClientConfig } from "./client";
