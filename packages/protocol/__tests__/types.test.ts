import { describe, it, expect } from "vitest";
import type { AWOCPMessage, AuthRequestPayload } from "../src/types";

describe("AWOCP Types", () => {
	it("should create a valid AWOCPMessage", () => {
		const msg: AWOCPMessage<AuthRequestPayload> = {
			id: "test-id",
			ts: new Date().toISOString(),
			type: "auth:request",
			sessionId: "ses_1",
			agentId: "agent_1",
			payload: {
				token: "my-token",
				clientVersion: "0.4.0",
				sessionInfo: {
					sessionId: "ses_1",
					userId: "user_1",
					model: "mock",
				},
			},
		};

		expect(msg.type).toBe("auth:request");
		expect(msg.payload.token).toBe("my-token");
		expect(msg.payload.sessionInfo.userId).toBe("user_1");
	});

	it("should support correlationId for request/response matching", () => {
		const msg: AWOCPMessage = {
			id: "msg-1",
			ts: new Date().toISOString(),
			type: "intercept:tool_request",
			sessionId: "ses_1",
			agentId: "agent_1",
			correlationId: "corr-123",
			payload: { toolName: "Bash", toolInput: {} },
		};

		expect(msg.correlationId).toBe("corr-123");
	});
});
