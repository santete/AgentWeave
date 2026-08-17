/**
 * 'pipeline config' — Quick toggle SDLC modules on/off.
 *
 * Usage:
 *   agentweave pipeline config                          Show current config
 *   agentweave pipeline config on qualityGate           Enable module
 *   agentweave pipeline config off retryEngine          Disable module
 *   agentweave pipeline config on qualityGate retryEngine   Enable multiple
 *   agentweave pipeline config off all                  Disable all
 *   agentweave pipeline config on all                   Enable all
 *   agentweave pipeline config set qualityGate.checks "pnpm test:unit,eslint src/"
 *   agentweave pipeline config set retryEngine.maxRetries 5
 *   agentweave pipeline config set execution.agent claude
 *   agentweave pipeline config init                     Create agentweave.yaml with defaults
 *   agentweave pipeline config reset                    Reset to defaults
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { getDefaultSDLCConfig } from "@agentweave/inner-harness";
import { loadConfig } from "../config-loader.js";

const CONFIG_PATH = "agentweave.yaml";

const C = {
	reset: "\x1b[0m",
	dim: "\x1b[2m",
	bold: "\x1b[1m",
	green: "\x1b[32m",
	red: "\x1b[31m",
	yellow: "\x1b[33m",
	cyan: "\x1b[36m",
	gray: "\x1b[90m",
	white: "\x1b[37m",
};

const MODULE_NAMES = [
	"taskNormalizer",
	"contextBuilder",
	"planGenerator",
	"executionBridge",
	"patchValidator",
	"qualityGate",
	"retryEngine",
	"outputStandardizer",
] as const;

const MODULE_LABELS: Record<string, string> = {
	taskNormalizer: "Task Normalize",
	contextBuilder: "Context Build",
	planGenerator: "Plan Generate",
	executionBridge: "Execute",
	patchValidator: "Patch Validate",
	qualityGate: "Quality Gate",
	retryEngine: "Retry Engine",
	outputStandardizer: "Output Standardize",
};

type ModuleName = typeof MODULE_NAMES[number];

export interface PipelineConfigArgs {
	action: "show" | "on" | "off" | "set" | "init" | "reset";
	targets?: string[];  // module names or "all"
	key?: string;        // for "set": "qualityGate.checks"
	value?: string;      // for "set": "pnpm test:unit,eslint src/"
}

export function pipelineConfigCommand(args: PipelineConfigArgs): void {
	switch (args.action) {
		case "show":
			showConfig();
			break;
		case "on":
			toggleModules(args.targets ?? [], true);
			break;
		case "off":
			toggleModules(args.targets ?? [], false);
			break;
		case "set":
			setConfigValue(args.key ?? "", args.value ?? "");
			break;
		case "init":
			initConfig();
			break;
		case "reset":
			resetConfig();
			break;
	}
}

// ─── Show ────────────────────────────────────────────────────────

function showConfig(): void {
	const { config, source } = loadConfig();
	const sourceLabel = source ? source : "defaults (no agentweave.yaml)";

	console.log(`\n  ${C.cyan}${C.bold}Pipeline Config${C.reset} ${C.dim}(${sourceLabel})${C.reset}\n`);

	for (const name of MODULE_NAMES) {
		const mod = config.modules[name];
		const enabled = mod?.enabled ?? false;
		const tag = enabled ? `${C.green}ON ${C.reset}` : `${C.red}OFF${C.reset}`;
		const label = MODULE_LABELS[name] ?? name;
		console.log(`  [${tag}]  ${label}${" ".repeat(Math.max(0, 22 - label.length))}${C.dim}${name}${C.reset}`);
	}

	// Execution
	const mode = config.execution.mode;
	const agent = mode === "process-adapter"
		? `${config.execution.processAdapter?.command ?? "?"} ${(config.execution.processAdapter?.args ?? []).join(" ")}`.trim()
		: mode === "agent-loop"
			? config.execution.agentLoop?.model ?? "?"
			: mode;
	console.log(`\n  ${C.white}Execution:${C.reset} ${mode} (${agent})`);
	console.log(`  ${C.white}Metrics:${C.reset}   ${config.metrics.enabled ? "ON" : "OFF"}${config.metrics.persistPath ? ` → ${config.metrics.persistPath}` : ""}`);

	console.log(`\n  ${C.dim}Toggle:  agentweave pipeline config on/off <module>${C.reset}`);
	console.log(`  ${C.dim}Set:     agentweave pipeline config set <key> <value>${C.reset}`);
	console.log(`  ${C.dim}Init:    agentweave pipeline config init${C.reset}\n`);
}

// ─── Toggle ──────────────────────────────────────────────────────

function toggleModules(targets: string[], enabled: boolean): void {
	const data = loadOrCreateConfigData();
	const modules = ensureModules(data);

	const resolvedTargets = resolveTargets(targets);
	if (resolvedTargets.length === 0) {
		console.log(`\n  ${C.yellow}No valid module names. Available:${C.reset}`);
		console.log(`  ${MODULE_NAMES.join(", ")}, all\n`);
		return;
	}

	for (const name of resolvedTargets) {
		if (!modules[name]) modules[name] = {};
		(modules[name] as Record<string, unknown>).enabled = enabled;
	}

	saveConfigData(data);

	const verb = enabled ? `${C.green}ON${C.reset}` : `${C.red}OFF${C.reset}`;
	const names = resolvedTargets.map((n) => MODULE_LABELS[n] ?? n);
	console.log(`\n  ${verb}  ${names.join(", ")}`);
	console.log(`  ${C.dim}Saved to ${CONFIG_PATH}${C.reset}\n`);
}

// ─── Set ─────────────────────────────────────────────────────────

function setConfigValue(key: string, value: string): void {
	if (!key) {
		console.log(`\n  ${C.yellow}Usage: agentweave pipeline config set <key> <value>${C.reset}`);
		console.log(`  ${C.dim}Examples:${C.reset}`);
		console.log(`    ${C.dim}set qualityGate.checks "pnpm test:unit,eslint src/"${C.reset}`);
		console.log(`    ${C.dim}set retryEngine.maxRetries 5${C.reset}`);
		console.log(`    ${C.dim}set execution.agent claude${C.reset}`);
		console.log(`    ${C.dim}set execution.model claude-sonnet-4-6${C.reset}`);
		console.log(`    ${C.dim}set metrics.persistPath .agentweave/metrics${C.reset}\n`);
		return;
	}

	const data = loadOrCreateConfigData();

	// Handle special keys
	if (key === "execution.agent") {
		ensureInner(data).execution = {
			mode: "process-adapter",
			processAdapter: { command: value },
		};
		saveConfigData(data);
		console.log(`\n  ${C.green}Set${C.reset} execution.agent = ${value}`);
		console.log(`  ${C.dim}Saved to ${CONFIG_PATH}${C.reset}\n`);
		return;
	}

	if (key === "execution.model") {
		ensureInner(data).execution = {
			mode: "agent-loop",
			agentLoop: { model: value },
		};
		saveConfigData(data);
		console.log(`\n  ${C.green}Set${C.reset} execution.model = ${value}`);
		console.log(`  ${C.dim}Saved to ${CONFIG_PATH}${C.reset}\n`);
		return;
	}

	if (key === "metrics.persistPath") {
		const inner = ensureInner(data);
		if (!inner.metrics) inner.metrics = {};
		(inner.metrics as Record<string, unknown>).persistPath = value;
		saveConfigData(data);
		console.log(`\n  ${C.green}Set${C.reset} metrics.persistPath = ${value}`);
		console.log(`  ${C.dim}Saved to ${CONFIG_PATH}${C.reset}\n`);
		return;
	}

	// Module-level set: "qualityGate.checks", "retryEngine.maxRetries"
	// Also supports aliases: "qa.checks", "retry.maxRetries"
	const parts = key.split(".");
	if (parts.length === 2) {
		const [rawModName, field] = parts as [string, string];
		const resolved = resolveTargets([rawModName]);
		if (resolved.length === 0) {
			console.log(`\n  ${C.red}Unknown module: ${rawModName}${C.reset}`);
			console.log(`  ${C.dim}Available: ${MODULE_NAMES.join(", ")}${C.reset}`);
			console.log(`  ${C.dim}Aliases: qa, retry, normalize, context, plan, exec, patch, output${C.reset}\n`);
			return;
		}
		const modName = resolved[0]!;

		const modules = ensureModules(data);
		if (!modules[modName]) modules[modName] = { enabled: true };
		const mod = modules[modName] as Record<string, unknown>;

		// Parse value
		if (field === "checks") {
			// "pnpm test:unit,eslint src/" → array of check objects
			mod.checks = value.split(",").map((cmd) => ({
				type: "custom",
				command: cmd.trim(),
				required: true,
			}));
		} else if (field === "maxRetries" || field === "maxSteps" || field === "maxFiles" || field === "maxFilesChanged" || field === "maxTokens") {
			mod[field] = parseInt(value, 10);
		} else if (field === "scopeStrict") {
			mod[field] = value === "true" || value === "yes";
		} else if (field === "strategies") {
			// "compile_error:fix_specific,test_failure:fix_specific"
			mod.strategies = value.split(",").map((s) => {
				const [errorType, action] = s.trim().split(":");
				return { errorType: errorType ?? "", action: action ?? "fix_specific" };
			});
		} else {
			mod[field] = value;
		}

		saveConfigData(data);
		console.log(`\n  ${C.green}Set${C.reset} ${key} = ${value}`);
		console.log(`  ${C.dim}Saved to ${CONFIG_PATH}${C.reset}\n`);
		return;
	}

	console.log(`\n  ${C.red}Invalid key format: ${key}${C.reset}`);
	console.log(`  ${C.dim}Use: <module>.<field> or execution.agent or metrics.persistPath${C.reset}\n`);
}

// ─── Init ────────────────────────────────────────────────────────

function initConfig(): void {
	if (existsSync(CONFIG_PATH)) {
		console.log(`\n  ${C.yellow}${CONFIG_PATH} already exists.${C.reset}`);
		console.log(`  ${C.dim}Use 'agentweave pipeline config reset' to overwrite with defaults.${C.reset}\n`);
		return;
	}

	const defaults = getDefaultSDLCConfig();
	const data = { inner: { modules: defaults.modules, execution: defaults.execution, metrics: defaults.metrics } };
	writeFileSync(CONFIG_PATH, JSON.stringify(data, null, 2), "utf-8");

	console.log(`\n  ${C.green}Created${C.reset} ${CONFIG_PATH}`);
	console.log(`  ${C.dim}Edit the file or use 'agentweave pipeline config set' to configure.${C.reset}`);
	console.log(`  ${C.dim}View with 'agentweave pipeline show'.${C.reset}\n`);
}

// ─── Reset ───────────────────────────────────────────────────────

function resetConfig(): void {
	const defaults = getDefaultSDLCConfig();
	const data = { inner: { modules: defaults.modules, execution: defaults.execution, metrics: defaults.metrics } };
	writeFileSync(CONFIG_PATH, JSON.stringify(data, null, 2), "utf-8");

	console.log(`\n  ${C.green}Reset${C.reset} ${CONFIG_PATH} to defaults.`);
	console.log(`  ${C.dim}View with 'agentweave pipeline show'.${C.reset}\n`);
}

// ─── Helpers ─────────────────────────────────────────────────────

function resolveTargets(targets: string[]): ModuleName[] {
	if (targets.includes("all")) return [...MODULE_NAMES];

	// Support short names: "qa" → "qualityGate", "retry" → "retryEngine"
	const ALIASES: Record<string, ModuleName> = {
		normalize: "taskNormalizer",
		normalizer: "taskNormalizer",
		task: "taskNormalizer",
		context: "contextBuilder",
		ctx: "contextBuilder",
		plan: "planGenerator",
		planner: "planGenerator",
		execute: "executionBridge",
		exec: "executionBridge",
		bridge: "executionBridge",
		patch: "patchValidator",
		validator: "patchValidator",
		qa: "qualityGate",
		quality: "qualityGate",
		gate: "qualityGate",
		test: "qualityGate",
		retry: "retryEngine",
		output: "outputStandardizer",
		standardize: "outputStandardizer",
		commit: "outputStandardizer",
	};

	return targets
		.map((t) => {
			const lower = t.toLowerCase();
			if (MODULE_NAMES.includes(lower as ModuleName)) return lower as ModuleName;
			return ALIASES[lower];
		})
		.filter((t): t is ModuleName => t !== undefined);
}

function loadOrCreateConfigData(): Record<string, unknown> {
	const path = join(process.cwd(), CONFIG_PATH);
	if (existsSync(path)) {
		try {
			return JSON.parse(readFileSync(path, "utf-8"));
		} catch {
			return { inner: {} };
		}
	}
	return { inner: {} };
}

function ensureInner(data: Record<string, unknown>): Record<string, unknown> {
	if (!data.inner || typeof data.inner !== "object") data.inner = {};
	return data.inner as Record<string, unknown>;
}

function ensureModules(data: Record<string, unknown>): Record<string, Record<string, unknown>> {
	const inner = ensureInner(data);
	if (!inner.modules || typeof inner.modules !== "object") inner.modules = {};
	return inner.modules as Record<string, Record<string, unknown>>;
}

function saveConfigData(data: Record<string, unknown>): void {
	writeFileSync(join(process.cwd(), CONFIG_PATH), JSON.stringify(data, null, 2), "utf-8");
}
