/**
 * PolicyLoader — resolves, parses, validates, and merges 3 YAML policy files
 * (org / team / user) per P3.1 design §1-2.
 *
 * Discovery order per level: CLI flag > env var > OS-standard path.
 * Malformed file = fail-closed at boot (throw). Missing file = silent skip.
 */

import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import yaml from "js-yaml";
import { z } from "zod";
import type { PermissionRule } from "@agentweave/types";
import { InvalidImmutableLevel, PolicyLoadError } from "./policy-errors";

// ─── Public types ────────────────────────────────────────────────

export interface PolicyPaths {
	org?: string;
	team?: string;
	user?: string;
}

export interface LoadedPolicy {
	rules: PermissionRule[];
	sources: {
		orgPath?: string;
		teamPath?: string;
		userPath?: string;
	};
	hashes: {
		org?: string;
		team?: string;
		user?: string;
	};
}

export interface LoadOptions {
	/** Highest-rank overrides (CLI flags). Skips env + OS lookup for level. */
	overrides?: PolicyPaths;
	/** Env vars, defaults to `process.env`. Injected for testability. */
	env?: NodeJS.ProcessEnv;
	/** Override process.platform, for cross-platform tests. */
	platform?: NodeJS.Platform;
	/** Override homedir(), for tests. */
	home?: string;
	/** Override process.cwd(), for tests. */
	cwd?: string;
}

// ─── Constants ───────────────────────────────────────────────────

const MAX_FILE_BYTES = 1_000_000;
const MAX_RULES_PER_FILE = 10_000;

export type PolicyLevel = "org" | "team" | "user";
type Level = PolicyLevel;
type Source = "policy" | "project" | "user";

const LEVEL_TO_SOURCE: Record<Level, Source> = {
	org: "policy",
	team: "project",
	user: "user",
};

const ENV_VAR: Record<Level, string> = {
	org: "AGENTWEAVE_POLICY_ORG",
	team: "AGENTWEAVE_POLICY_TEAM",
	user: "AGENTWEAVE_POLICY_USER",
};

// ─── Zod schema ──────────────────────────────────────────────────

const RateLimitSchema = z.object({
	maxCalls: z.number().int().positive(),
	windowMs: z.number().int().positive(),
});

// Per §1.4: rule schema is PermissionRule minus `source` (loader assigns).
const PermissionRuleYamlSchema = z.object({
	pattern: z.string().min(1),
	behavior: z.enum(["allow", "deny", "ask"]),
	priority: z.number().int(),
	condition: z.string().optional(),
	message: z.string().optional(),
	group: z.string().optional(),
	rateLimit: RateLimitSchema.optional(),
	immutable: z.boolean().optional(),
});

const PolicyFileSchema = z.object({
	version: z.literal(1),
	metadata: z
		.object({
			name: z.string().optional(),
			owner: z.string().optional(),
			updatedAt: z.string().optional(),
		})
		.optional(),
	rules: z.array(PermissionRuleYamlSchema),
});

// ─── OS path resolution ──────────────────────────────────────────

function osPaths(
	level: Level,
	platform: NodeJS.Platform,
	env: NodeJS.ProcessEnv,
	home: string,
	cwd: string,
): string[] {
	const isWin = platform === "win32";
	const programData = env.PROGRAMDATA ?? "C:\\ProgramData";
	const userProfile = env.USERPROFILE ?? home;

	if (level === "org" || level === "team") {
		const file = level === "org" ? "policy.org.yaml" : "policy.team.yaml";
		return isWin
			? [join(programData, "agentweave", file)]
			: [join("/etc/agentweave", file)];
	}

	// user level: project cwd wins over home
	const file = "policy.user.yaml";
	return isWin
		? [join(cwd, file), join(userProfile, ".agentweave", file)]
		: [join(cwd, file), join(home, ".agentweave", file)];
}

function resolvePath(level: Level, opts: Required<LoadOptions>): string | undefined {
	// Rank 1: explicit override
	const override = opts.overrides[level];
	if (override !== undefined) {
		return existsFile(override) ? resolve(override) : undefined;
	}
	// Rank 2: env var
	const envPath = opts.env[ENV_VAR[level]];
	if (envPath) {
		return existsFile(envPath) ? resolve(envPath) : undefined;
	}
	// Rank 3: OS paths (first existing wins)
	for (const p of osPaths(level, opts.platform, opts.env, opts.home, opts.cwd)) {
		if (existsFile(p)) return p;
	}
	return undefined;
}

function existsFile(p: string): boolean {
	try {
		return statSync(p).isFile();
	} catch {
		return false;
	}
}

// ─── Parse + validate one file ───────────────────────────────────

function parseFile(path: string, level: Level): { rules: PermissionRule[]; hash: string } {
	let raw: Buffer;
	try {
		raw = readFileSync(path);
	} catch (e) {
		throw new PolicyLoadError(path, "io", (e as Error).message);
	}

	if (raw.byteLength > MAX_FILE_BYTES) {
		throw new PolicyLoadError(
			path,
			"size-cap",
			`File exceeds ${MAX_FILE_BYTES} bytes (got ${raw.byteLength})`,
		);
	}

	const hash = createHash("sha256").update(raw).digest("hex");

	let doc: unknown;
	try {
		doc = yaml.load(raw.toString("utf-8"), { schema: yaml.JSON_SCHEMA });
	} catch (e) {
		throw new PolicyLoadError(path, "parse", (e as Error).message);
	}

	const parsed = PolicyFileSchema.safeParse(doc);
	if (!parsed.success) {
		throw new PolicyLoadError(path, "schema", parsed.error.message);
	}

	if (parsed.data.rules.length > MAX_RULES_PER_FILE) {
		throw new PolicyLoadError(
			path,
			"count-cap",
			`Rule count ${parsed.data.rules.length} exceeds cap ${MAX_RULES_PER_FILE}`,
		);
	}

	const source = LEVEL_TO_SOURCE[level];
	const rules: PermissionRule[] = [];
	for (const r of parsed.data.rules) {
		if (r.immutable === true && level !== "org") {
			throw new InvalidImmutableLevel(path, r.pattern, level);
		}
		rules.push({ ...r, source });
	}
	return { rules, hash };
}

// ─── Public API ──────────────────────────────────────────────────

export class PolicyLoader {
	/**
	 * Parse + validate a single file as if it lived at `level`. Used by
	 * `agentweave policy lint` so operators can dry-run a draft file before
	 * dropping it into the org/team/user slot.
	 */
	static lint(
		filePath: string,
		level: Level,
	): { rules: PermissionRule[]; hash: string } {
		return parseFile(resolve(filePath), level);
	}

	/**
	 * Resolve paths → parse → validate → merge. Throws PolicyLoadError or
	 * InvalidImmutableLevel on any malformed file. Missing files are skipped.
	 */
	static load(options: LoadOptions = {}): LoadedPolicy {
		const opts: Required<LoadOptions> = {
			overrides: options.overrides ?? {},
			env: options.env ?? process.env,
			platform: options.platform ?? process.platform,
			home: options.home ?? homedir(),
			cwd: options.cwd ?? process.cwd(),
		};

		const orgPath = resolvePath("org", opts);
		const teamPath = resolvePath("team", opts);
		const userPath = resolvePath("user", opts);

		const org = orgPath ? parseFile(orgPath, "org") : undefined;
		const team = teamPath ? parseFile(teamPath, "team") : undefined;
		const user = userPath ? parseFile(userPath, "user") : undefined;

		return {
			rules: [
				...(org?.rules ?? []),
				...(team?.rules ?? []),
				...(user?.rules ?? []),
			],
			sources: {
				orgPath,
				teamPath,
				userPath,
			},
			hashes: {
				org: org?.hash,
				team: team?.hash,
				user: user?.hash,
			},
		};
	}
}
