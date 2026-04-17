export { createHarness } from "./agentweave";
export type {
	CreateHarnessOptions,
	HarnessInstance,
	AgentHandle,
	RunInstanceOptions,
	RunResult,
} from "./agentweave";

// Re-export key types for convenience
export type {
	InnerEvent,
	TerminalResult,
	ToolDefinition,
	ToolDecision,
	PermissionRule,
	OutputFilter,
	TokenUsage,
	InnerState,
	HookDefinition,
	ContentBlock,
	Message,
	AgentSpawnConfig,
	AgentInfo,
	AgentMessage,
	PluginManifest,
	PluginRegistration,
} from "@agentweave/types";

// Re-export testing utilities
export {
	createMockLLMCaller,
	MockScenarios,
} from "@agentweave/inner-harness";
export type { MockResponse, LLMCallResult } from "@agentweave/inner-harness";
