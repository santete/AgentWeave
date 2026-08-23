// Core
export { AgentLoop } from "./agent-loop";
export type { AgentLoopConfig, LLMCallResult, ThamSoSinh } from "./agent-loop";

// Tool System
export { ToolRegistry } from "./tool-registry";
export { ToolExecutor, partitionToolCalls } from "./tool-executor";
export type { ToolCall, ToolCallResult } from "./tool-executor";

// Supporting
export { MessageStore } from "./message-store";
export { TokenCounter, laModelCucBo } from "./token-counter";

// Built-in Tools
export {
	BUILT_IN_TOOLS,
	boToolMacDinh,
	type TuyChonBoTool,
	getBuiltInTool,
	BashTool,
	taoBashTool,
	TIMEOUT_MAC_DINH_MS,
	DAU_MA_THOAT,
	DAU_BI_GIET,
	FileReadTool,
	FileWriteTool,
	FileEditTool,
	GrepTool,
	GlobTool,
} from "./built-in-tools/index";

// Kết quả tool quá lớn — ghi ra đĩa, không cắt
export {
	ghiKetQuaRaDia,
	apTranTongLuot,
	thongBaoDaGhi,
	dungXemTruoc,
	thuMucKetQua,
	TRAN_MOI_TOOL,
	TRAN_TONG_MOI_LUOT,
	CO_XEM_TRUOC,
} from "./tool-result-store";
export type { KetQuaDaGhi } from "./tool-result-store";

// Hợp đồng giao tiếp model ↔ tool — lỗi nói được, tên gõ sai gợi ý được
export {
	chuanHoaThamSo,
	dienGiaiLoiZod,
	duongDanLoi,
	goiYTenGan,
	loiToolKhongCo,
	catKetQua,
	TRAN_KET_QUA_MAC_DINH,
} from "./tool-contract";
export type { KetQuaChuanHoa } from "./tool-contract";

// Bộ nhớ liên phiên — recall tất định, không gọi model
export {
	installMemory,
	nguonBoNhoLienQuan,
	summarizeMemoryReport,
	quetBoNho,
	docNoiDung,
	memoryDir,
	chonLienQuan,
	chuoiTuoi,
	tachTu,
	cauDanBoNho,
	cauDanBoNhoRong,
	khoiChiMuc,
	MEMORY_SECTION,
	MEMORY_DIR_SEGMENTS,
	TEP_CHI_MUC,
	NHAN_KHOI_BO_NHO,
	MAX_BYTE_MOI_TEP,
	MAX_TEP_MOI_LUOT,
	MAX_BYTE_CA_PHIEN,
} from "./memory/index";
export type {
	LoaiBoNho,
	TepBoNho,
	MemoryProblem,
	MemoryScanReport,
	MemoryHost,
	InstallMemoryOptions,
	InstallMemoryResult,
} from "./memory/index";

// Cặp tool_use/tool_result — tầng phòng thủ trước mỗi lượt gọi
export { chuanHoaCapTool, KET_QUA_GIAN_DOAN } from "./cap-tool";
export type { KetQuaChuanHoaCap } from "./cap-tool";

// Danh sách việc — ép model lập kế hoạch và bám tiến độ
export {
	SoTayViec,
	createTodoTool,
	nguonNhacTodo,
	veDanhSach,
	kiemDanhSach,
	CAU_DAN_TODO,
	TODO_TOOL_NAME,
	MAX_VIEC,
	LUOT_COI_LA_TROI,
} from "./todo";
export type { Viec, TrangThaiViec, KetQuaTodo } from "./todo";

// Attachment — chữ bơm vào GIỮA hội thoại, có nhịp và có hàng rào lỗi
export {
	thuNhac,
	bocNhacHeThong,
	nhacGuard,
	locNhacGuard,
	NHAN_NHAC_GUARD,
	NhipNhac,
	TIMEOUT_THU_NHAC,
} from "./attachments/index";
export type {
	Nhac,
	NguonNhac,
	BoiCanhLuot,
	KetQuaThuNhac,
} from "./attachments/index";

// Rule — chỉ dẫn phân tầng, có loại chỉ nạp khi chạm đúng đường dẫn
export {
	RuleRegistry,
	installRules,
	nguonRuleTheoDuongDan,
	summarizeRuleReport,
	renderRules,
	renderRuleTheoDuongDan,
	tachFrontmatter,
	taoBoKhop,
	laVoDieuKien,
	moRongInclude,
	boChuThichHtml,
	RULE_SECTION,
	CAU_DAN_RULE,
	MAX_INCLUDE_DEPTH,
	MAX_KY_TU_MOT_RULE,
	NHAN_NGUON,
	RULES_DIR_SEGMENTS,
	TEP_RULE_DU_AN,
	TEP_RULE_LOCAL,
} from "./rules/index";
export type {
	Rule,
	RuleScope,
	RuleProblem,
	RuleProblemKind,
	RuleDiscoveryReport,
	RuleRegistryOptions,
	RuleHost,
	InstallRulesOptions,
	InstallRulesResult,
} from "./rules/index";

// Hẹn giờ trong phiên — bắn vào ống dẫn attachment, không cần luồng nền
export {
	LichHen,
	nguonHenGio,
	createScheduleTool,
	phanJitter,
	doTre,
	SCHEDULE_TOOL_NAME,
	KHOANG_TOI_THIEU_MS,
	TU_HET_HAN_MAC_DINH_MS,
	JITTER,
} from "./cron/index";
export type { CongViecHen, YeuCauHen, KetQuaThem } from "./cron/index";

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
	SKILL_BUDGET_CONTEXT_PERCENT,
	MAX_LISTING_DESC_CHARS,
	MIN_DESC_LENGTH,
	nganSachChiMuc,
	nguonSkillTheoDuongDan,
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
	nenTheoThoiGian,
	banDoTenTool,
	daBoDoLau,
	TOOL_NEN_DUOC,
	MAX_NEN_THAT_BAI_LIEN_TIEP,
	NGUONG_BO_DO_MS,
	NOI_DUNG_DA_XOA,
	mucNen,
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
