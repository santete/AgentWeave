// Core
export { AgentLoop } from "./agent-loop";
export type { AgentLoopConfig, LLMCallResult } from "./agent-loop";

// Tool System
export { ToolRegistry } from "./tool-registry";
export { ToolExecutor, partitionToolCalls } from "./tool-executor";
export type { ToolCall, ToolCallResult } from "./tool-executor";

// Supporting
export { MessageStore } from "./message-store";
export { TokenCounter } from "./token-counter";

// Built-in Tools
export {
	BUILT_IN_TOOLS,
	getBuiltInTool,
	BashTool,
	FileReadTool,
	FileWriteTool,
	FileEditTool,
	GrepTool,
	GlobTool,
} from "./built-in-tools/index";

// Standalone (no control-plane needed)
export { createNoopControlPlane } from "./noop-control-plane";

// Testing
export { createMockLLMCaller, MockScenarios } from "./mock-llm";
export type { MockResponse } from "./mock-llm";

// SDLC Engine
export {
	SDLCOrchestrator,
	createSDLCPipeline,
	MetricsCollector,
	runModule,
	ModuleError,
	getDefaultSDLCConfig,
	validateSDLCConfig,
	SDLCConfigSchema,
	TaskNormalizerModule,
	ContextBuilderModule,
	PlanGeneratorModule,
	ExecutionBridgeModule,
	PatchValidatorModule,
	QualityGateModule,
	RetryEngineModule,
	OutputStandardizerModule,
} from "./sdlc/index";
export type { SDLCOrchestratorConfig, CreateSDLCPipelineOptions } from "./sdlc/index";

// Provider Registry — điểm mở rộng nhà cung cấp model
export {
	ProviderRegistry,
	UnknownProviderError,
	createDefaultRegistry,
	ollamaProvider,
	openrouterProvider,
	googleProvider,
	openaiProvider,
	anthropicProvider,
} from "./provider-registry";
export type { ModelProvider, ResolvedModel } from "./provider-registry";
