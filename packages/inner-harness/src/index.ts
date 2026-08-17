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

// Skill — tri thức quy trình nạp theo nhu cầu
export {
	SkillRegistry,
	UnknownSkillError,
	installSkills,
	summarizeSkillReport,
	renderSkillIndex,
	projectSkillsDir,
	createLoadSkillTool,
	SkillManifestSchema,
	LOAD_SKILL_TOOL_NAME,
	SKILL_INDEX_SECTION,
	SKILL_NAME_PATTERN,
	SKILL_MANIFEST_FILE,
	SKILL_CONTENT_FILE,
	DEFAULT_MAX_SKILLS_PER_SCOPE,
	DEFAULT_MAX_CONTENT_BYTES,
	WHEN_TO_USE_SOFT_LIMIT,
} from "./skills/index";
export type {
	Skill,
	SkillManifest,
	SkillScope,
	SkillProblem,
	SkillProblemKind,
	SkillDiscoveryReport,
	SkillRegistryOptions,
	SkillHost,
	InstallSkillsOptions,
	InstallSkillsResult,
	ShadowedSkill,
	ScopeScan,
} from "./skills/index";

// Quản lý ngữ cảnh — đo độ đầy và nén khi gần tràn
export {
	suyRaCuaSo,
	capNhatDoDay,
	canNen,
	nenTinNhan,
	nenManhTay,
	CUA_SO_CUC_BO,
	CUA_SO_DAM_MAY,
	NGUONG_NEN,
} from "./context-manager";
export type { KetQuaNen } from "./context-manager";

// Cứu tool-call model nhả ra dạng chữ
export { cuuToolCall } from "./tool-call-recovery";
export type { KetQuaCuu } from "./tool-call-recovery";

// Theo dõi đọc/ghi file — chặn ghi đè mù
export {
	ghiNhanDaDoc,
	ghiNhanDaGhi,
	kiemTraTruocKhiGhi,
	xoaDauVetPhien,
	GhiDeMuError,
} from "./file-access-tracker";

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

// Sandbox — cô lập tool có tác dụng phụ, đa nền tảng
export {
	detectSandbox,
	registerSandbox,
	BubblewrapSandbox,
	SeatbeltSandbox,
	NoopSandbox,
	SandboxUnavailableError,
} from "./sandbox";
export type { Sandbox, SandboxCapabilities, SandboxPolicy } from "./sandbox";
export { taoRangBuocSandbox } from "./sandbox/binding";
export type { TuyChonCoLap } from "./sandbox/binding";
