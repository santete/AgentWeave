// Process Adapter (generic CLI wrapper)
export { ProcessAdapter } from "./process-adapter";
export type { ProcessAdapterConfig } from "./process-adapter";

// Claude Code Adapter (preset)
export { createClaudeCodeAdapter } from "./claude-code-adapter";
export type { ClaudeCodeAdapterConfig } from "./claude-code-adapter";

// Aider Adapter (preset)
export { createAiderAdapter, buildAiderAdapterConfig } from "./aider-adapter";
export type { AiderAdapterConfig } from "./aider-adapter";
