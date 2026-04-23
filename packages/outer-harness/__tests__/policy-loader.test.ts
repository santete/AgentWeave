import { beforeEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PolicyLoader } from "../src/governance/policy-loader";
import {
	InvalidImmutableLevel,
	PolicyLoadError,
} from "../src/governance/policy-errors";

// ─── Fixtures ────────────────────────────────────────────────────

function writeYaml(path: string, rules: unknown[]): void {
	const doc = {
		version: 1,
		metadata: { name: "test-fixture" },
		rules,
	};
	// Use JSON — valid YAML subset — so we don't depend on a yaml stringifier.
	writeFileSync(path, JSON.stringify(doc, null, 2));
}

function writeRaw(path: string, contents: string): void {
	writeFileSync(path, contents);
}

let tmp: string;
let orgPath: string;
let teamPath: string;
let userPath: string;

beforeEach(() => {
	tmp = mkdtempSync(join(tmpdir(), "p31-policy-"));
	orgPath = join(tmp, "policy.org.yaml");
	teamPath = join(tmp, "policy.team.yaml");
	userPath = join(tmp, "policy.user.yaml");
	return () => rmSync(tmp, { recursive: true, force: true });
});

// ─── §10.1 Test matrix ───────────────────────────────────────────

describe("PolicyLoader.load — §10.1 test matrix", () => {
	// #1
	it("loads all 3 files, tags each rule with correct source", () => {
		writeYaml(orgPath, [
			{ pattern: "Bash(rm -rf *)", behavior: "deny", priority: 100, immutable: true },
		]);
		writeYaml(teamPath, [
			{ pattern: "Bash(git push *)", behavior: "ask", priority: 50 },
		]);
		writeYaml(userPath, [
			{ pattern: "Grep(*)", behavior: "allow", priority: 10 },
		]);

		const loaded = PolicyLoader.load({
			overrides: { org: orgPath, team: teamPath, user: userPath },
		});

		expect(loaded.rules).toHaveLength(3);
		expect(loaded.rules[0]).toMatchObject({ source: "policy", immutable: true });
		expect(loaded.rules[1]).toMatchObject({ source: "project" });
		expect(loaded.rules[2]).toMatchObject({ source: "user" });
		expect(loaded.sources).toEqual({ orgPath, teamPath, userPath });
	});

	// #2
	it("loads only user file when org/team absent", () => {
		writeYaml(userPath, [
			{ pattern: "FileRead(*)", behavior: "allow", priority: 1 },
		]);

		const loaded = PolicyLoader.load({
			overrides: { user: userPath },
			env: {}, // force no env var resolution
			home: tmp, // no ~/.agentweave/policy.org.yaml
			cwd: tmp,
			platform: "linux",
		});

		expect(loaded.rules).toHaveLength(1);
		expect(loaded.rules[0]!.source).toBe("user");
		expect(loaded.sources.orgPath).toBeUndefined();
		expect(loaded.sources.teamPath).toBeUndefined();
	});

	// #3
	it("returns empty array when no files present", () => {
		const loaded = PolicyLoader.load({
			env: {},
			home: tmp,
			cwd: tmp,
			platform: "linux",
		});

		expect(loaded.rules).toEqual([]);
		expect(loaded.hashes).toEqual({});
	});

	// #4
	it("rejects immutable:true in team file", () => {
		writeYaml(teamPath, [
			{ pattern: "Bash(*)", behavior: "deny", priority: 1, immutable: true },
		]);

		expect(() =>
			PolicyLoader.load({ overrides: { team: teamPath }, env: {}, platform: "linux", home: tmp, cwd: tmp }),
		).toThrow(InvalidImmutableLevel);
	});

	// #5
	it("rejects immutable:true in user file", () => {
		writeYaml(userPath, [
			{ pattern: "FileWrite(*)", behavior: "deny", priority: 1, immutable: true },
		]);

		expect(() =>
			PolicyLoader.load({ overrides: { user: userPath }, env: {}, platform: "linux", home: tmp, cwd: tmp }),
		).toThrow(InvalidImmutableLevel);
	});

	// #6
	it("fails with reason:parse on malformed YAML in org", () => {
		writeRaw(orgPath, "version: 1\nrules: [ { pattern: 'x', behavior: deny, priority: 1 }, }\n");

		try {
			PolicyLoader.load({ overrides: { org: orgPath }, env: {}, platform: "linux", home: tmp, cwd: tmp });
			throw new Error("expected throw");
		} catch (e) {
			expect(e).toBeInstanceOf(PolicyLoadError);
			expect((e as PolicyLoadError).reason).toBe("parse");
			expect((e as PolicyLoadError).path).toBe(orgPath);
		}
	});

	// #7
	it("fails with reason:schema on invalid behavior enum", () => {
		writeYaml(orgPath, [
			{ pattern: "Bash(*)", behavior: "maybe", priority: 1 }, // bad enum
		]);

		try {
			PolicyLoader.load({ overrides: { org: orgPath }, env: {}, platform: "linux", home: tmp, cwd: tmp });
			throw new Error("expected throw");
		} catch (e) {
			expect(e).toBeInstanceOf(PolicyLoadError);
			expect((e as PolicyLoadError).reason).toBe("schema");
		}
	});

	// #8
	it("respects CLI flag > env var > OS path per level", () => {
		// Prepare 3 candidate files for the same level with different contents.
		const flagPath = join(tmp, "flag.yaml");
		const envFile = join(tmp, "env.yaml");
		const osFile = join(tmp, "policy.org.yaml"); // matches OS name
		writeYaml(flagPath, [{ pattern: "FLAG", behavior: "allow", priority: 1 }]);
		writeYaml(envFile, [{ pattern: "ENV", behavior: "allow", priority: 1 }]);
		writeYaml(osFile, [{ pattern: "OS", behavior: "allow", priority: 1 }]);

		// Rank 1: CLI flag wins when all 3 present.
		const cliWins = PolicyLoader.load({
			overrides: { org: flagPath },
			env: { AGENTWEAVE_POLICY_ORG: envFile, PROGRAMDATA: tmp },
			platform: "win32",
			home: tmp,
			cwd: tmp,
		});
		expect(cliWins.rules[0]!.pattern).toBe("FLAG");

		// Rank 2: env var wins when no CLI flag. Point ProgramData to a dir WITH an OS-named file so we can verify env beats it.
		const osDir = join(tmp, "programdata");
		mkdirSync(join(osDir, "agentweave"), { recursive: true });
		writeYaml(join(osDir, "agentweave", "policy.org.yaml"), [
			{ pattern: "OS-FALLBACK", behavior: "allow", priority: 1 },
		]);
		const envWins = PolicyLoader.load({
			env: { AGENTWEAVE_POLICY_ORG: envFile, PROGRAMDATA: osDir },
			platform: "win32",
			home: tmp,
			cwd: tmp,
		});
		expect(envWins.rules[0]!.pattern).toBe("ENV");

		// Rank 3: OS path when neither CLI nor env set.
		const osWins = PolicyLoader.load({
			env: { PROGRAMDATA: osDir },
			platform: "win32",
			home: tmp,
			cwd: tmp,
		});
		expect(osWins.rules[0]!.pattern).toBe("OS-FALLBACK");
	});

	// #9
	it("rejects files larger than 1 MB with reason:size-cap", () => {
		// Build a 1.1 MB file by adding a long metadata string.
		const bigPadding = "x".repeat(1_100_000);
		writeRaw(
			orgPath,
			JSON.stringify({ version: 1, metadata: { name: bigPadding }, rules: [] }),
		);

		try {
			PolicyLoader.load({ overrides: { org: orgPath }, env: {}, platform: "linux", home: tmp, cwd: tmp });
			throw new Error("expected throw");
		} catch (e) {
			expect(e).toBeInstanceOf(PolicyLoadError);
			expect((e as PolicyLoadError).reason).toBe("size-cap");
		}
	});

	// #10
	it("rejects files with more than 10 000 rules with reason:count-cap", () => {
		const rules = Array.from({ length: 10_001 }, (_, i) => ({
			pattern: `Tool${i}`,
			behavior: "allow" as const,
			priority: 1,
		}));
		writeYaml(orgPath, rules);

		try {
			PolicyLoader.load({ overrides: { org: orgPath }, env: {}, platform: "linux", home: tmp, cwd: tmp });
			throw new Error("expected throw");
		} catch (e) {
			expect(e).toBeInstanceOf(PolicyLoadError);
			expect((e as PolicyLoadError).reason).toBe("count-cap");
		}
	});

	// #11
	it("computes stable sha256 hash per loaded file", () => {
		const body = JSON.stringify({
			version: 1,
			metadata: { name: "hash-test" },
			rules: [{ pattern: "Bash(*)", behavior: "allow", priority: 1 }],
		});
		writeRaw(orgPath, body);
		const expected = createHash("sha256").update(body).digest("hex");

		const loaded = PolicyLoader.load({
			overrides: { org: orgPath },
			env: {},
			platform: "linux",
			home: tmp,
			cwd: tmp,
		});

		expect(loaded.hashes.org).toBe(expected);
	});

	// #12
	it("resolves Windows-style OS paths when platform=win32", () => {
		const programData = join(tmp, "progdata");
		mkdirSync(join(programData, "agentweave"), { recursive: true });
		writeYaml(join(programData, "agentweave", "policy.org.yaml"), [
			{ pattern: "WIN-OS", behavior: "allow", priority: 1 },
		]);

		const loaded = PolicyLoader.load({
			env: { PROGRAMDATA: programData },
			platform: "win32",
			home: tmp,
			cwd: tmp,
		});

		expect(loaded.rules[0]!.pattern).toBe("WIN-OS");
		expect(loaded.sources.orgPath).toContain("progdata");
	});
});
