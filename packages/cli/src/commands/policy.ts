/**
 * `agentweave policy` — inspect and validate the 3-file YAML policy cascade.
 *
 *   agentweave policy show [--policy-org X] [--policy-team Y] [--policy-user Z]
 *   agentweave policy lint <file> [--as org|team|user]
 *
 * `show` resolves the effective cascade (overrides + env + OS paths) and prints
 * which file was picked for each level, its rule count, and sha256 of bytes.
 * `lint` parses a single file in isolation (no env/OS lookup) so operators can
 * dry-run a draft before dropping it into the org/team/user slot.
 */

import { basename } from "node:path";
import { PolicyLoader } from "@agentweave/outer-harness";
import type { PolicyLevel, PolicyPaths } from "@agentweave/outer-harness";
import type { PermissionRule } from "@agentweave/types";

export interface PolicyShowArgs {
	paths?: PolicyPaths;
	format?: "table" | "json";
}

export interface PolicyLintArgs {
	file: string;
	as?: PolicyLevel;
}

// ─── show ────────────────────────────────────────────────────────

export function policyShowCommand(args: PolicyShowArgs): number {
	let loaded;
	try {
		loaded = PolicyLoader.load({ overrides: args.paths });
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		console.error(`Error: ${msg}`);
		return 1;
	}

	if (args.format === "json") {
		console.log(
			JSON.stringify(
				{
					sources: loaded.sources,
					hashes: loaded.hashes,
					ruleCounts: countBySource(loaded.rules),
					totalRules: loaded.rules.length,
				},
				null,
				2,
			),
		);
		return 0;
	}

	const rows: Array<{
		level: PolicyLevel;
		path?: string;
		rules: number;
		hash?: string;
	}> = [
		{
			level: "org",
			path: loaded.sources.orgPath,
			rules: loaded.rules.filter((r) => r.source === "policy").length,
			hash: loaded.hashes.org,
		},
		{
			level: "team",
			path: loaded.sources.teamPath,
			rules: loaded.rules.filter((r) => r.source === "project").length,
			hash: loaded.hashes.team,
		},
		{
			level: "user",
			path: loaded.sources.userPath,
			rules: loaded.rules.filter((r) => r.source === "user").length,
			hash: loaded.hashes.user,
		},
	];

	const resolvedCount = rows.filter((r) => r.path).length;
	console.log(`\n  AgentWeave policy cascade — ${resolvedCount}/3 levels resolved`);
	console.log(`  ${"─".repeat(78)}`);
	console.log(`  ${pad("LEVEL", 6)}${pad("RULES", 7)}${pad("HASH (sha256)", 18)}PATH`);
	console.log(`  ${"─".repeat(78)}`);
	for (const r of rows) {
		const hashShort = r.hash ? r.hash.slice(0, 12) + "…" : "—";
		const path = r.path ?? "(not resolved)";
		console.log(`  ${pad(r.level, 6)}${pad(String(r.rules), 7)}${pad(hashShort, 18)}${path}`);
	}
	console.log(`  ${"─".repeat(78)}`);
	console.log(`  Total rules merged: ${loaded.rules.length}`);
	const immutable = loaded.rules.filter((r) => r.immutable).length;
	if (immutable > 0) {
		console.log(`  Immutable rules:    ${immutable} (org-level only)`);
	}
	console.log();
	return 0;
}

// ─── lint ────────────────────────────────────────────────────────

export function policyLintCommand(args: PolicyLintArgs): number {
	const level = args.as ?? inferLevel(args.file);
	try {
		const result = PolicyLoader.lint(args.file, level);
		const immutable = result.rules.filter((r) => r.immutable).length;
		console.log(`  ✓ ${args.file}`);
		console.log(`    level:     ${level}${args.as ? "" : " (inferred from filename)"}`);
		console.log(`    rules:     ${result.rules.length}`);
		if (immutable > 0) {
			console.log(`    immutable: ${immutable}`);
		}
		console.log(`    sha256:    ${result.hash}`);
		return 0;
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		console.error(`  ✗ ${args.file}`);
		console.error(`    ${msg}`);
		return 1;
	}
}

/** `policy.org.yaml` → org, `policy.team.yaml` → team, anything else → user. */
function inferLevel(path: string): PolicyLevel {
	const name = basename(path).toLowerCase();
	if (name.includes(".org.")) return "org";
	if (name.includes(".team.")) return "team";
	return "user";
}

function countBySource(rules: PermissionRule[]): Record<string, number> {
	const counts: Record<string, number> = { policy: 0, project: 0, user: 0 };
	for (const r of rules) {
		counts[r.source] = (counts[r.source] ?? 0) + 1;
	}
	return counts;
}

function pad(s: string, width: number): string {
	return (s + " ".repeat(width)).slice(0, width);
}
