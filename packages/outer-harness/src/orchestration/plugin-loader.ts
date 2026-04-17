/**
 * PluginLoader — Discovers, validates, activates, and deactivates plugins.
 * Returns PluginRegistrations that the SDK wires into inner (tools) and outer (hooks).
 */

import { resolve, normalize } from "node:path";
import type {
	PluginManifest,
	PluginContext,
	PluginRegistration,
	PluginConfig,
} from "@agentweave/types";

// ─── Loaded Plugin ──────────────────────────────────────────────

export interface LoadedPlugin {
	manifest: PluginManifest;
	registration: PluginRegistration;
	config: PluginConfig;
}

// ─── Loader ─────────────────────────────────────────────────────

export class PluginLoader {
	private loaded: LoadedPlugin[] = [];

	/**
	 * Load and activate a plugin from a PluginManifest object.
	 * Used for testing and inline plugins.
	 */
	async loadFromManifest(
		manifest: PluginManifest,
		context: PluginContext,
		pluginConfig?: PluginConfig,
	): Promise<LoadedPlugin> {
		this.validateManifest(manifest);

		// Reject duplicate plugin names
		if (this.loaded.some((p) => p.manifest.name === manifest.name)) {
			throw new Error(`Plugin "${manifest.name}" is already loaded`);
		}

		const registration = await manifest.activate(context);
		this.validateRegistration(manifest, registration);

		const loaded: LoadedPlugin = {
			manifest,
			registration,
			config: pluginConfig ?? { name: manifest.name, enabled: true },
		};
		this.loaded.push(loaded);
		return loaded;
	}

	/**
	 * Load and activate a plugin from a file path (dynamic import).
	 * The file must default-export a PluginManifest.
	 */
	async loadFromPath(
		pluginPath: string,
		context: PluginContext,
		pluginConfig?: PluginConfig,
	): Promise<LoadedPlugin> {
		// SECURITY: validate path — reject traversal, resolve to absolute
		const safePath = this.validatePluginPath(pluginPath, context.projectRoot);
		const mod = await import(safePath);
		const manifest: PluginManifest = mod.default ?? mod;

		if (!manifest || typeof manifest.activate !== "function") {
			throw new Error(
				`Plugin at ${safePath} does not export a valid PluginManifest (missing activate function)`,
			);
		}

		return this.loadFromManifest(manifest, context, pluginConfig);
	}

	/**
	 * Load and activate all plugins from config array.
	 * Skips disabled plugins. Uses source path if provided, otherwise imports by name.
	 */
	async activateAll(
		configs: PluginConfig[],
		context: PluginContext,
	): Promise<LoadedPlugin[]> {
		const results: LoadedPlugin[] = [];

		for (const cfg of configs) {
			if (cfg.enabled === false) continue;

			const ctx: PluginContext = { ...context, pluginConfig: cfg.config };
			const source = cfg.source ?? cfg.name;

			try {
				const loaded = await this.loadFromPath(source, ctx, cfg);
				results.push(loaded);
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				throw new Error(`Failed to load plugin "${cfg.name}": ${msg}`);
			}
		}

		return results;
	}

	/** Deactivate all loaded plugins (reverse order). */
	async deactivateAll(): Promise<void> {
		for (const plugin of [...this.loaded].reverse()) {
			try {
				await plugin.manifest.deactivate?.();
			} catch {
				// Non-blocking — best effort cleanup
			}
		}
		this.loaded = [];
	}

	/** Get all currently loaded plugins. */
	getLoaded(): ReadonlyArray<LoadedPlugin> {
		return this.loaded;
	}

	// ─── Path Security ──────────────────────────────────────────

	private validatePluginPath(pluginPath: string, projectRoot: string): string {
		// Scoped npm packages (e.g. "@org/plugin-name") — allow as-is
		if (pluginPath.startsWith("@") || !pluginPath.includes("/") && !pluginPath.includes("\\")) {
			return pluginPath; // npm package name — resolved by Node module system
		}

		// File path — normalize and check for traversal
		const normalized = normalize(pluginPath);
		if (normalized.includes("..")) {
			throw new Error(
				`Plugin path "${pluginPath}" contains path traversal ("..") — rejected`,
			);
		}

		// Resolve to absolute and verify it's under project root
		const absolute = resolve(projectRoot, normalized);
		const resolvedRoot = resolve(projectRoot);
		if (!absolute.startsWith(resolvedRoot)) {
			throw new Error(
				`Plugin path "${pluginPath}" resolves outside project root — rejected`,
			);
		}

		return absolute;
	}

	// ─── Validation ─────────────────────────────────────────────

	private validateManifest(manifest: PluginManifest): void {
		if (!manifest.name || typeof manifest.name !== "string") {
			throw new Error("Plugin manifest must have a name");
		}
		if (!manifest.version || typeof manifest.version !== "string") {
			throw new Error(`Plugin "${manifest.name}" must have a version`);
		}
		if (typeof manifest.activate !== "function") {
			throw new Error(`Plugin "${manifest.name}" must have an activate function`);
		}
	}

	private validateRegistration(
		manifest: PluginManifest,
		registration: PluginRegistration,
	): void {
		const perms = manifest.permissions;

		// Validate registered tools match declared permissions
		if (registration.tools && perms?.tools) {
			for (const tool of registration.tools) {
				if (!perms.tools.register.includes(tool.name)) {
					throw new Error(
						`Plugin "${manifest.name}" registered tool "${tool.name}" not declared in permissions.tools.register`,
					);
				}
			}
		}

		// Validate registered hooks match declared permissions
		if (registration.hooks && perms?.hooks) {
			for (const hook of registration.hooks) {
				if (!perms.hooks.events.includes(hook.event)) {
					throw new Error(
						`Plugin "${manifest.name}" registered hook for event "${hook.event}" not declared in permissions.hooks.events`,
					);
				}
			}
		}
	}
}
