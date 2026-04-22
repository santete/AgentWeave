// Main
export { OuterHarness } from "./outer-harness";
export type {
	OuterHarnessConfig,
	MonitoringConfig,
	AlertSinkConfig,
} from "./outer-harness";

// Governance
export { PermissionEngine, matchPattern } from "./governance/permission-engine";
export { OutputPipeline } from "./governance/output-pipeline";
export type { OutputPipelineConfig } from "./governance/output-pipeline";
export { BudgetManager } from "./governance/budget-manager";
export type { BudgetConfig, BudgetStatus } from "./governance/budget-manager";
export { HookEngine } from "./governance/hook-engine";
export type { HookEngineConfig } from "./governance/hook-engine";
export { InputGate } from "./governance/input-gate";
export type { InputGateConfig, InputGateResult } from "./governance/input-gate";

// Orchestration
export { ConfigHierarchy, getDefaultConfig } from "./orchestration/config-hierarchy";
export type { ConfigSource } from "./orchestration/config-hierarchy";
export { LockManager } from "./orchestration/lock-manager";
export { MultiAgentOrchestrator } from "./orchestration/multi-agent-orchestrator";
export { PluginLoader } from "./orchestration/plugin-loader";
export type { LoadedPlugin } from "./orchestration/plugin-loader";

// Observability
export { AuditLogger } from "./observability/audit-logger";
export type { AuditEntry } from "./observability/audit-logger";
export { MonitorCollector } from "./observability/monitor-collector";
export { AlertEngine, createDefaultAlertRules } from "./observability/alert-engine";
export { SessionManager } from "./observability/session-manager";
export type { SessionManagerConfig, SessionRecord } from "./observability/session-manager";
export {
	StdoutSink,
	FileSink,
	WebhookSink,
} from "./observability/alert-sink";
export type {
	AlertSink,
	StdoutSinkOptions,
	FileSinkOptions,
	WebhookSinkOptions,
} from "./observability/alert-sink";
export { PrometheusExporter } from "./observability/prometheus-exporter";
export type { PrometheusExporterOptions } from "./observability/prometheus-exporter";
export { PrometheusServer } from "./observability/prometheus-server";
export type { PrometheusServerOptions } from "./observability/prometheus-server";
export { fetchWithRetry } from "./shared/http-retry";
export type { HttpRetryOptions, HttpRetryResult } from "./shared/http-retry";
