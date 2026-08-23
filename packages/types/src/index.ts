// Version — single source of truth for all packages
export const AGENTWEAVE_VERSION = "1.1.0";

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
	StageTiming,
	PipelineMetrics,
	HookMetrics,
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
	SDLCStageName,
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
export type {
	ToolDefinition,
	ToolContext,
	ToolResult,
	SandboxConfig,
	ProcessSandboxBinding,
} from "./tools";

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
	RateLimit,
	PermissionRule,
	PermissionAuditRecord,
	RuleConflict,
	RuleAnalysis,
	PermissionConfig,
} from "./permissions";

// Budget
export type {
	BudgetConfig,
	CostBreakdown,
	BudgetStatus,
	CostEstimate,
	CostMetadata,
	BudgetEventType,
	BudgetEvent,
} from "./budget";

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

// Governance (Inner ↔ Outer DI seam for SDLC pipeline)
export type { GovernanceHandle } from "./governance";

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

// SDLC Engine
export type {
	SDLCTask,
	SDLCPlan,
	SDLCPlanStep,
	SDLCExecutionResult,
	SDLCValidationResult,
	SDLCCheck,
	SDLCRetryDecision,
	SDLCOutput,
	SDLCModule,
	LLMCallerFn,
	SDLCModuleContext,
	MetricsHandle,
	SDLCMetricsSnapshot,
	SDLCBaselineComparison,
	SDLCModuleConfig,
	QualityGateCheck,
	RetryStrategy,
	SDLCConfig,
} from "./sdlc";

// Plugins
export type {
	PluginManifest,
	PluginPermissions,
	PluginContext,
	PluginRegistration,
	PluginConfig,
} from "./plugin";

// Guard (hook governance)
export type {
	HookInput,
	GuardDecision,
	GuardConfig,
	GuardPermissionRule,
	GuardBudgetConfig,
	GuardAuditConfig,
} from "./guard";
export {
	HookInputSchema,
	GuardDecisionSchema,
	GuardConfigSchema,
} from "./guard";

// Vết tích — ghi nhận mọi điểm chạm dữ liệu (xem vet-tich.ts)
export type { TangVetTich, DiemCham, BoGhiVetTich } from "./vet-tich";
export { LOAI_DIEM_CHAM } from "./vet-tich";
