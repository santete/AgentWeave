// Version — single source of truth for all packages
export const AGENTWEAVE_VERSION = "0.5.1";

// Messages & Content
export type {
	ContentBlock,
	MessageRole,
	Message,
	InjectableMessage,
	Attachment,
} from "./messages";

// Metrics
export type {
	TokenUsage,
	ContextUsage,
	SessionMetrics,
	ToolMetrics,
	TurnMetrics,
	MonitorSnapshot,
	AlertSeverity,
	AlertRule,
	AlertEvent,
} from "./metrics";
export { createEmptyTokenUsage, createEmptyContextUsage } from "./metrics";

// Events & Commands
export type {
	InnerEventPayload,
	InnerEvent,
	OuterCommand,
	CommandAck,
	TerminalReason,
	TerminalResult,
} from "./events";

// Decisions & Gates
export type {
	PermissionDecision,
	PermissionUpdate,
	ToolDecision,
	ToolRequest,
	OutputDecision,
	OutputStageResult,
	RawOutput,
	InputDecision,
	UserInput,
} from "./decisions";

// Tools
export type { ToolDefinition, ToolContext, ToolResult, SandboxConfig } from "./tools";

// Hooks
export type {
	HookEventType,
	HookType,
	HookDefinition,
	CommandHook,
	PromptHook,
	AgentHook,
	HttpHook,
	FunctionHook,
	HookEvent,
	HookResult,
} from "./hooks";

// Permissions
export type {
	PermissionMode,
	PermissionRule,
	PermissionConfig,
} from "./permissions";

// Sessions
export type { SessionInfo, SessionState, SessionEndInfo } from "./sessions";

// Config
export type {
	HarnessConfig,
	OutputValidationRule,
	OutputFilter,
	OutputTransform,
} from "./config";

// Inner Harness
export type {
	InnerHarnessProvider,
	RunOptions,
	InnerState,
	InnerConfig,
} from "./inner";

// Outer Harness
export type { OuterHarnessConsumer } from "./outer";

// Control Plane
export type {
	InterceptType,
	InterceptRequest,
	InterceptResponse,
	ControlPlane,
} from "./control-plane";

// Multi-Agent
export type {
	AgentState,
	AgentSpawnConfig,
	AgentInfo,
	AgentMessageType,
	AgentMessage,
	MultiAgentConfig,
	AgentLifecycleEvent,
} from "./multi-agent";

// Plugins
export type {
	PluginManifest,
	PluginPermissions,
	PluginContext,
	PluginRegistration,
	PluginConfig,
} from "./plugin";
