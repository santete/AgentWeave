/**
 * QualityGate — Run test, lint, compile, typecheck commands.
 * Each check: run shell command, parse exit code, collect results.
 *
 * SECURITY: Commands are validated against a safe binary allowlist before execution.
 * Only known package manager / toolchain commands are allowed.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type {
	SDLCModule,
	SDLCModuleContext,
	SDLCExecutionResult,
	SDLCValidationResult,
	SDLCCheck,
	QualityGateCheck,
} from "@agentweave/types";

const execFileAsync = promisify(execFile);

// ─── Command Security ────────────────────────────────────────────

/**
 * Allowlist of safe binaries for quality gate commands.
 * Only the first token (binary name) is checked.
 * Arguments are passed through — the binary is trusted to handle them safely.
 */
const SAFE_BINARIES = new Set([
	// Package managers
	"npm", "npx", "pnpm", "yarn", "bun", "bunx", "deno",
	// Build tools
	"tsc", "tsup", "esbuild", "vite", "turbo", "nx",
	// Test runners
	"vitest", "jest", "mocha", "ava", "tap",
	// Linters
	"eslint", "biome", "prettier", "oxlint",
	// Language tools
	"node", "python", "go", "cargo", "dotnet", "javac", "gcc",
	// Common CI tools
	"make", "cmake",
]);

/**
 * Validate and parse a command string. Returns the binary and args.
 * Rejects commands with shell metacharacters or unknown binaries.
 */
function validateCommand(command: string): { binary: string; args: string[] } {
	const trimmed = command.trim();
	if (!trimmed) {
		throw new CommandValidationError("Empty command");
	}

	// Reject shell metacharacters that indicate chaining/injection
	if (/[;|&`$(){}]/.test(trimmed)) {
		throw new CommandValidationError(
			`Command contains shell metacharacters: "${trimmed.slice(0, 50)}". ` +
			"Use simple 'binary arg1 arg2' format. Shell operators are not allowed.",
		);
	}

	// Split into binary + args (simple space split, respects quoted strings)
	const parts = parseCommandParts(trimmed);
	const binary = parts[0]!;
	const args = parts.slice(1);

	// Check binary against allowlist
	const baseName = binary.split("/").pop()!.split("\\").pop()!;
	if (!SAFE_BINARIES.has(baseName)) {
		throw new CommandValidationError(
			`Binary "${baseName}" is not in the safe allowlist. ` +
			`Allowed: ${[...SAFE_BINARIES].slice(0, 10).join(", ")}...`,
		);
	}

	return { binary, args };
}

/** Simple command parser — split on spaces, respect double-quoted strings. */
function parseCommandParts(cmd: string): string[] {
	const parts: string[] = [];
	let current = "";
	let inQuote = false;

	for (const char of cmd) {
		if (char === '"') {
			inQuote = !inQuote;
		} else if (char === " " && !inQuote) {
			if (current) { parts.push(current); current = ""; }
		} else {
			current += char;
		}
	}
	if (current) parts.push(current);
	return parts;
}

class CommandValidationError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "CommandValidationError";
	}
}

// ─── QualityGate Module ──────────────────────────────────────────

export class QualityGateModule implements SDLCModule<SDLCExecutionResult, SDLCValidationResult> {
	readonly name = "QualityGate";

	async execute(_input: SDLCExecutionResult, context: SDLCModuleContext): Promise<SDLCValidationResult> {
		const checks = context.config.modules.qualityGate.checks ?? [];
		if (checks.length === 0) {
			return { passed: true, checks: [] };
		}

		const results: SDLCCheck[] = [];
		let allRequiredPassed = true;

		for (const check of checks) {
			const result = await this.runCheck(check, context);
			results.push(result);

			if (!result.passed && check.required) {
				allRequiredPassed = false;
			}
		}

		// Record lint warning count for M10
		const lintCheck = results.find((r) => r.name === "lint");
		if (lintCheck?.message) {
			const warningCount = countWarnings(lintCheck.message);
			context.metrics.record("lintWarnings", warningCount);
		}

		return {
			passed: allRequiredPassed,
			checks: results,
			score: results.length > 0
				? results.filter((r) => r.passed).length / results.length
				: 1,
		};
	}

	private async runCheck(check: QualityGateCheck, context: SDLCModuleContext): Promise<SDLCCheck> {
		// SECURITY: Validate command before execution
		let binary: string;
		let args: string[];
		try {
			const parsed = validateCommand(check.command);
			binary = parsed.binary;
			args = parsed.args;
		} catch (err) {
			return {
				name: check.type,
				passed: false,
				message: err instanceof Error ? err.message : "Command validation failed",
				severity: "error",
			};
		}

		try {
			const { stdout, stderr } = await execFileAsync(binary, args, {
				cwd: context.cwd,
				timeout: 120_000,
				signal: context.signal,
			});

			return {
				name: check.type,
				passed: true,
				message: (stdout + stderr).trim().slice(0, 2000) || undefined,
				severity: "info",
			};
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			return {
				name: check.type,
				passed: false,
				message: message.slice(0, 2000),
				severity: check.required ? "error" : "warning",
			};
		}
	}
}

function countWarnings(output: string): number {
	const matches = output.match(/\d+ warnings?/gi);
	if (!matches) return 0;
	let total = 0;
	for (const m of matches) {
		const num = parseInt(m, 10);
		if (!isNaN(num)) total += num;
	}
	return total;
}
