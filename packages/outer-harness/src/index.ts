// Main
export { OuterHarness } from "./outer-harness";
export type { OuterHarnessConfig } from "./outer-harness";

// Governance
export { PermissionEngine, matchPattern } from "./governance/permission-engine";
export { OutputPipeline } from "./governance/output-pipeline";
export type { OutputPipelineConfig } from "./governance/output-pipeline";
export { BudgetManager } from "./governance/budget-manager";
export type { BudgetConfig, BudgetStatus } from "./governance/budget-manager";

// Observability
export { AuditLogger } from "./observability/audit-logger";
export type { AuditEntry } from "./observability/audit-logger";
export { MonitorCollector } from "./observability/monitor-collector";
export { AlertEngine, createDefaultAlertRules } from "./observability/alert-engine";
export { SessionManager } from "./observability/session-manager";
export type { SessionManagerConfig, SessionRecord } from "./observability/session-manager";
