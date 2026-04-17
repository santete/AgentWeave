/**
 * Plugin system types: manifest, context, registration, permissions.
 * Plugins extend AgentWeave with custom tools, hooks, and config presets.
 */

import type { ToolDefinition } from "./tools";
import type { HookDefinition } from "./hooks";

// ─── Plugin Manifest (what a plugin exports) ────────────────────

export interface PluginManifest {
	/** Unique name (scoped: @org/plugin-name or plain name). */
	name: string;
	/** Semver version. */
	version: string;
	/** Short description. */
	description: string;
	/** Author. */
	author?: string;
	/** AgentWeave version range this plugin supports. */
	agentweaveVersion?: string;
	/** Permissions the plugin requests. */
	permissions?: PluginPermissions;
	/** Called when plugin is loaded. Returns tools/hooks to register. */
	activate(context: PluginContext): Promise<PluginRegistration>;
	/** Called when plugin is unloaded. */
	deactivate?(): Promise<void>;
}

// ─── Plugin Permissions ─────────────────────────────────────────

export interface PluginPermissions {
	/** Tools this plugin registers. */
	tools?: { register: string[] };
	/** Hook events this plugin listens to. */
	hooks?: { events: string[] };
}

// ─── Plugin Context (passed to activate) ────────────────────────

export interface PluginContext {
	/** AgentWeave version. */
	version: string;
	/** Project root directory. */
	projectRoot: string;
	/** Plugin-specific data directory for persistence. */
	dataDir: string;
	/** Plugin-specific config from user's config file. */
	pluginConfig?: Record<string, unknown>;
}

// ─── Plugin Registration (returned by activate) ─────────────────

export interface PluginRegistration {
	/** Tools to register with the inner harness ToolRegistry. */
	tools?: ToolDefinition[];
	/** Hooks to register with the outer harness HookEngine. */
	hooks?: Array<{
		event: string;
		matcher?: string;
		definition: HookDefinition;
	}>;
}

// ─── Plugin Config (from user's config file) ────────────────────

export interface PluginConfig {
	/** Plugin name or scoped package name. */
	name: string;
	/** Enable/disable (default true). */
	enabled?: boolean;
	/** Local path override (for development). */
	source?: string;
	/** Plugin-specific configuration. */
	config?: Record<string, unknown>;
}
