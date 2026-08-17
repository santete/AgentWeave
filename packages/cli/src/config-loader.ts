/**
 * Config loader — reads agentweave.yaml from cwd and merges with defaults.
 */

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { getDefaultSDLCConfig } from "@agentweave/inner-harness";
import type { SDLCConfig } from "@agentweave/types";

const CONFIG_FILES = [
	"agentweave.yaml",
	"agentweave.yml",
	".agentweave/config.yaml",
	".agentweave/config.yml",
];

export interface LoadedConfig {
	config: SDLCConfig;
	source: string | null; // file path or null (defaults)
}

/**
 * Load SDLC config from agentweave.yaml in cwd.
 * Falls back to defaults if no config file found.
 */
export function loadConfig(cwd?: string): LoadedConfig {
	const dir = cwd ?? process.cwd();
	const defaults = getDefaultSDLCConfig();

	for (const file of CONFIG_FILES) {
		const path = join(dir, file);
		if (existsSync(path)) {
			try {
				const raw = readFileSync(path, "utf-8");
				const parsed = parseYamlSimple(raw);
				const inner = (parsed.inner ?? parsed) as Record<string, unknown>;
				const merged = mergeConfig(defaults, inner);
				return { config: merged, source: path };
			} catch {
				// Corrupted config — use defaults
			}
		}
	}

	return { config: defaults, source: null };
}

/**
 * Minimal YAML parser for agentweave.yaml.
 * Handles simple key: value, nested objects, arrays.
 * For production, swap with a proper YAML parser.
 */
function parseYamlSimple(yaml: string): Record<string, unknown> {
	// Simple approach: try JSON first (YAML is a superset of JSON)
	try {
		return JSON.parse(yaml);
	} catch {
		// Fall back to basic YAML parsing
	}

	const result: Record<string, unknown> = {};
	const lines = yaml.split("\n");

	for (const line of lines) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith("#")) continue;

		const match = trimmed.match(/^(\w+):\s*(.+)$/);
		if (match) {
			const key = match[1]!;
			let value: unknown = match[2]!.trim();
			if (value === "true") value = true;
			else if (value === "false") value = false;
			else if (!isNaN(Number(value))) value = Number(value);
			result[key] = value;
		}
	}

	return result;
}

function mergeConfig(defaults: SDLCConfig, overrides: Record<string, unknown>): SDLCConfig {
	const modules = { ...defaults.modules };

	if (typeof overrides.modules === "object" && overrides.modules !== null) {
		const mods = overrides.modules as Record<string, Record<string, unknown>>;
		for (const [key, val] of Object.entries(mods)) {
			if (key in modules && typeof val === "object" && val !== null) {
				(modules as Record<string, unknown>)[key] = {
					...(modules as unknown as Record<string, Record<string, unknown>>)[key],
					...val,
				};
			}
		}
	}

	const execution = typeof overrides.execution === "object" && overrides.execution !== null
		? { ...defaults.execution, ...(overrides.execution as Record<string, unknown>) }
		: defaults.execution;

	const metrics = typeof overrides.metrics === "object" && overrides.metrics !== null
		? { ...defaults.metrics, ...(overrides.metrics as Record<string, unknown>) }
		: defaults.metrics;

	return { modules, execution, metrics } as SDLCConfig;
}
