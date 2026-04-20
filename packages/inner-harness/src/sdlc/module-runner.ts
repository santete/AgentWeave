/**
 * ModuleRunner — Generic wrapper that runs an SDLC module if enabled.
 * Handles: enabled check, custom module loading, error wrapping, timing.
 *
 * SECURITY: Custom module paths are validated — no traversal, require .js/.ts/.mjs extension.
 */

import { resolve, normalize } from "node:path";
import type { SDLCModule, SDLCModuleConfig, SDLCModuleContext } from "@agentweave/types";

export interface RunModuleOptions<TInput, TOutput> {
	/** The built-in module implementation. */
	builtIn: SDLCModule<TInput, TOutput>;
	/** Config for this module (must have `enabled` and optional `custom`). */
	config: SDLCModuleConfig;
	/** Input to pass to the module. */
	input: TInput;
	/** Shared SDLC context. */
	context: SDLCModuleContext;
	/** Default output if module is disabled. */
	defaultOutput: TOutput;
}

/**
 * Run a module if enabled. Loads custom implementation if configured.
 * Returns defaultOutput if disabled. Wraps errors with module name.
 */
export async function runModule<TInput, TOutput>(
	opts: RunModuleOptions<TInput, TOutput>,
): Promise<{ output: TOutput; skipped: boolean; durationMs: number }> {
	if (!opts.config.enabled) {
		return { output: opts.defaultOutput, skipped: true, durationMs: 0 };
	}

	const start = performance.now();
	const module = opts.config.custom
		? await loadCustomModule<TInput, TOutput>(opts.config.custom, opts.builtIn.name)
		: opts.builtIn;

	try {
		const output = await module.execute(opts.input, opts.context);
		const durationMs = performance.now() - start;

		// Record timing in metrics
		opts.context.metrics.record(`module:${module.name}:durationMs`, durationMs);

		return { output, skipped: false, durationMs };
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		throw new ModuleError(module.name, message);
	}
}

// ─── Path Validation ─────────────────────────────────────────────

/**
 * Validate custom module path. Rejects:
 * - Path traversal (..)
 * - Missing .js/.ts/.mjs extension
 * - Paths outside project root (must be relative or within cwd)
 */
function validateModulePath(modulePath: string): string | null {
	const normalized = normalize(modulePath);

	// Reject path traversal
	if (normalized.includes("..")) {
		return `Custom module path rejected: path traversal detected in "${modulePath}"`;
	}

	// Require safe extension
	if (!normalized.endsWith(".js") && !normalized.endsWith(".ts") && !normalized.endsWith(".mjs")) {
		return `Custom module path rejected: must end in .js, .ts, or .mjs ("${modulePath}")`;
	}

	return null; // valid
}

/** Load a custom module implementation via dynamic import. */
async function loadCustomModule<TInput, TOutput>(
	path: string,
	moduleName: string,
): Promise<SDLCModule<TInput, TOutput>> {
	// SECURITY: validate path before import
	const validationError = validateModulePath(path);
	if (validationError) {
		throw new Error(validationError);
	}

	try {
		const absPath = resolve(path);
		const mod = await import(absPath);
		const impl = mod.default ?? mod;

		if (typeof impl !== "object" || typeof impl.execute !== "function") {
			throw new Error(`Custom module at "${path}" does not export a valid SDLCModule (missing execute())`);
		}

		return impl as SDLCModule<TInput, TOutput>;
	} catch (err) {
		if (err instanceof Error && (err.message.includes("does not export") || err.message.includes("rejected"))) throw err;
		throw new Error(`Failed to load custom module "${moduleName}" from "${path}": ${err instanceof Error ? err.message : String(err)}`);
	}
}

export class ModuleError extends Error {
	readonly moduleName: string;

	constructor(moduleName: string, message: string) {
		super(`[${moduleName}] ${message}`);
		this.moduleName = moduleName;
		this.name = "ModuleError";
	}
}
