/**
 * ConfigHierarchy — 7-level configuration merge system.
 *
 * Priority (low -> high):
 *   1. Defaults       Built-in framework defaults
 *   2. User config    ~/.agentweave/config.yaml
 *   3. Project config .agentweave/config.yaml
 *   4. Local config   .agentweave/config.local.yaml
 *   5. CLI flags      --model, --budget, etc.
 *   6. Env vars       AGENTWEAVE_MODEL, AGENTWEAVE_BUDGET
 *   7. Policy         Enterprise-managed (immutable)
 *
 * Higher priority overrides lower. Policy cannot be overridden.
 */

import type { HarnessConfig } from "@agentweave/types";

export interface ConfigSource {
	level: number;
	name: string;
	config: Partial<HarnessConfig>;
}

/** Sensible defaults — the base config when nothing else is specified. */
export function getDefaultConfig(): HarnessConfig {
	return {
		inner: {
			model: "claude-sonnet-4-6",
			maxTurns: 100,
			thinkingEnabled: true,
			tools: [],
		},
		permissions: {
			mode: "default",
			rules: [],
			failMode: "closed",
			timeoutMs: 5000,
			askTimeoutMs: 60000,
		},
		hooks: {},
		output: {
			pipeline: {
				validate: { enabled: false, rules: [] },
				filter: { enabled: true, filters: [] },
				transform: { enabled: false, transforms: [] },
				review: { enabled: false },
			},
			gateMode: "auto",
		},
		budget: {
			warningThreshold: 0.8,
		},
		monitoring: {
			enabled: true,
			traceEnabled: false,
		},
		session: {
			persistTranscript: true,
			transcriptDir: "~/.agentweave/sessions",
			autoSave: true,
		},
	};
}

export class ConfigHierarchy {
	private sources: ConfigSource[] = [];
	private effective: HarnessConfig | null = null;

	constructor() {
		// Start with defaults at level 1
		this.sources.push({
			level: 1,
			name: "defaults",
			config: getDefaultConfig(),
		});
	}

	/** Add a config source at the specified level. */
	addSource(level: number, name: string, config: Partial<HarnessConfig>): void {
		// Remove existing source at this level if any
		this.sources = this.sources.filter((s) => s.level !== level);
		this.sources.push({ level, name, config });
		this.sources.sort((a, b) => a.level - b.level);
		this.effective = null; // invalidate cache
	}

	/** Get the merged effective config. Higher levels override lower. */
	getEffectiveConfig(): HarnessConfig {
		if (this.effective) return this.effective;

		let result = getDefaultConfig();

		for (const source of this.sources) {
			result = mergeConfig(result, source.config);
		}

		this.effective = result;
		return result;
	}

	/** Get which sources are loaded. */
	getSources(): ReadonlyArray<ConfigSource> {
		return this.sources;
	}

	/** Check if policy level exists (level 7). */
	hasPolicy(): boolean {
		return this.sources.some((s) => s.level === 7);
	}

	/** Invalidate the cached effective config (e.g. after hot reload). */
	invalidate(): void {
		this.effective = null;
	}
}

// ─── Config Merge Logic ──────────────────────────────────────────

function mergeConfig(
	base: HarnessConfig,
	override: Partial<HarnessConfig>,
): HarnessConfig {
	const result = { ...base };

	// Inner
	if (override.inner) {
		result.inner = { ...result.inner, ...override.inner };
		if (override.inner.tools) {
			result.inner.tools = [...override.inner.tools];
		}
	}

	// Permissions — rules are merged (appended), not replaced
	if (override.permissions) {
		result.permissions = { ...result.permissions };
		if (override.permissions.mode !== undefined) result.permissions.mode = override.permissions.mode;
		if (override.permissions.failMode !== undefined) result.permissions.failMode = override.permissions.failMode;
		if (override.permissions.timeoutMs !== undefined) result.permissions.timeoutMs = override.permissions.timeoutMs;
		if (override.permissions.askTimeoutMs !== undefined) result.permissions.askTimeoutMs = override.permissions.askTimeoutMs;
		if (override.permissions.rules) {
			result.permissions.rules = [...result.permissions.rules, ...override.permissions.rules];
		}
	}

	// Hooks — merged by event name (appended)
	if (override.hooks) {
		result.hooks = { ...result.hooks };
		for (const [event, hooks] of Object.entries(override.hooks)) {
			const existing = result.hooks[event] ?? [];
			result.hooks[event] = [...existing, ...hooks];
		}
	}

	// Output
	if (override.output) {
		result.output = {
			...result.output,
			...override.output,
			pipeline: { ...result.output.pipeline },
		};
		if (override.output.pipeline) {
			const p = override.output.pipeline;
			if (p.validate) result.output.pipeline.validate = { ...result.output.pipeline.validate, ...p.validate };
			if (p.filter) {
				result.output.pipeline.filter = { ...result.output.pipeline.filter };
				if (p.filter.filters) {
					result.output.pipeline.filter.filters = [
						...result.output.pipeline.filter.filters,
						...p.filter.filters,
					];
				}
			}
			if (p.transform) result.output.pipeline.transform = { ...result.output.pipeline.transform, ...p.transform };
			if (p.review) result.output.pipeline.review = { ...result.output.pipeline.review, ...p.review };
		}
	}

	// Budget
	if (override.budget) {
		result.budget = { ...result.budget, ...override.budget };
	}

	// Monitoring
	if (override.monitoring) {
		result.monitoring = { ...result.monitoring, ...override.monitoring };
	}

	// Session
	if (override.session) {
		result.session = { ...result.session, ...override.session };
	}

	return result;
}
