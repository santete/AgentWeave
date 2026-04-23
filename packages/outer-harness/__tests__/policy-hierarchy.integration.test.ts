/**
 * P3.1 §10.2 — end-to-end cascade through OuterHarness.
 * Rows 13–22 of the design test matrix (#21 is CLI-level, deferred to step 8).
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
	OuterHarnessConfig,
	PermissionRule,
	ToolRequest,
} from "@agentweave/types";
import { OuterHarness } from "../src/outer-harness";
import { PermissionRuleConflictError } from "../src/governance/policy-errors";

// ─── Fixtures ────────────────────────────────────────────────────

let tmp: string;
let orgPath: string;
let teamPath: string;
let userPath: string;

beforeEach(() => {
	tmp = mkdtempSync(join(tmpdir(), "p31-integ-"));
	orgPath = join(tmp, "policy.org.yaml");
	teamPath = join(tmp, "policy.team.yaml");
	userPath = join(tmp, "policy.user.yaml");
});

afterEach(() => {
	rmSync(tmp, { recursive: true, force: true });
});

function writeYaml(path: string, rules: unknown[]): void {
	// JSON is a valid YAML subset — avoids bringing in a yaml stringifier.
	writeFileSync(path, JSON.stringify({ version: 1, rules }, null, 2));
}

function baseConfig(overrides: Partial<OuterHarnessConfig> = {}): OuterHarnessConfig {
	return {
		permissions: {
			mode: "default",
			rules: [],
			failMode: "closed",
			timeoutMs: 5000,
			askTimeoutMs: 60000,
		},
		output: {
			gateMode: "batch",
			filters: [],
		},
		budget: {
			maxPerSession: 100,
			warningThreshold: 0.8,
		},
		...overrides,
	};
}

function makeRequest(toolName: string, input: Record<string, unknown>): ToolRequest {
	return {
		toolName,
		toolInput: input,
		toolUseId: "tu_test",
		turnIndex: 1,
		isReadOnly: false,
		isDestructive: false,
	};
}

// ─── Tests ───────────────────────────────────────────────────────

describe("Policy hierarchy integration — §10.2 matrix", () => {
	// #13
	it("immutable org deny + user allow same pattern → deny + immutable_override_blocked audit", async () => {
		writeYaml(orgPath, [
			{ pattern: "Bash(*)", behavior: "deny", priority: 100, immutable: true },
		]);
		writeYaml(userPath, [
			{ pattern: "Bash(*)", behavior: "allow", priority: 50 },
		]);

		const outer = new OuterHarness(
			baseConfig({ policy: { paths: { org: orgPath, user: userPath } } }),
		);
		const decision = await outer.onToolRequested(
			makeRequest("Bash", { command: "ls" }),
		);

		expect(decision.behavior).toBe("deny");
		const overrideEvents = outer
			.getAuditLogger()
			.getEntriesByAction("immutable_override_blocked");
		expect(overrideEvents).toHaveLength(1);
		const details = overrideEvents[0]!.details as {
			tool: string;
			overridden: Array<{ pattern: string; behavior: string }>;
		};
		expect(details.tool).toBe("Bash");
		expect(details.overridden).toHaveLength(1);
		expect(details.overridden[0]!.pattern).toBe("Bash(*)");
		expect(details.overridden[0]!.behavior).toBe("allow");
	});

	// #14
	it("immutable deny prio=1 beats user allow prio=999 (bucket order, not priority)", async () => {
		writeYaml(orgPath, [
			{ pattern: "Bash(*)", behavior: "deny", priority: 1, immutable: true },
		]);
		writeYaml(userPath, [
			{ pattern: "Bash(*)", behavior: "allow", priority: 999 },
		]);

		const outer = new OuterHarness(
			baseConfig({ policy: { paths: { org: orgPath, user: userPath } } }),
		);
		const decision = await outer.onToolRequested(
			makeRequest("Bash", { command: "echo hi" }),
		);
		expect(decision.behavior).toBe("deny");
		expect(decision.source).toBe("rule:policy");
	});

	// #15
	it("non-immutable org deny is NOT privileged — user allow with higher priority wins", async () => {
		writeYaml(orgPath, [
			{ pattern: "Bash(*)", behavior: "deny", priority: 100 },
		]);
		writeYaml(userPath, [
			{ pattern: "Bash(*)", behavior: "allow", priority: 200 },
		]);

		const outer = new OuterHarness(
			baseConfig({ policy: { paths: { org: orgPath, user: userPath } } }),
		);
		const decision = await outer.onToolRequested(
			makeRequest("Bash", { command: "ls" }),
		);
		expect(decision.behavior).toBe("allow");
		// Pure-allow means no override event (we only scan mutable when immutable DENIES).
		expect(
			outer.getAuditLogger().getEntriesByAction("immutable_override_blocked"),
		).toHaveLength(0);
	});

	// #16
	it("no policy files configured → engine evaluates with default behavior only (regression gate)", async () => {
		const outer = new OuterHarness(baseConfig());
		const decision = await outer.onToolRequested(
			makeRequest("Bash", { command: "ls" }),
		);
		// mode: "default" → ask → failMode: "closed" → deny
		expect(decision.behavior).toBe("deny");
		expect(decision.source).toBe("default");
		// No policy_loaded emitted because policy wasn't configured.
		expect(
			outer.getAuditLogger().getEntriesByAction("policy_loaded"),
		).toHaveLength(0);
	});

	// #17
	it("persisted alwaysAllow conflicts with new immutable deny → orphaned + ask_approval_orphaned", async () => {
		// Pre-seed AskStore with an approval from a prior session.
		const askStorePath = join(tmp, "ask.json");
		const persistedRule: PermissionRule = {
			pattern: "Bash(npm run *)",
			behavior: "allow",
			source: "runtime",
			priority: 75,
		};
		writeFileSync(
			askStorePath,
			JSON.stringify([{ rule: persistedRule, savedAt: new Date().toISOString() }], null, 2),
		);

		// Now an org admin drops in an immutable deny that would cover it.
		writeYaml(orgPath, [
			{ pattern: "Bash(*)", behavior: "deny", priority: 100, immutable: true },
		]);

		const outer = new OuterHarness(
			baseConfig({
				policy: { paths: { org: orgPath } },
				askPersistence: { enabled: true, path: askStorePath },
			}),
		);

		const orphanEvents = outer
			.getAuditLogger()
			.getEntriesByAction("ask_approval_orphaned");
		expect(orphanEvents).toHaveLength(1);
		const details = orphanEvents[0]!.details as {
			persisted: PermissionRule;
			conflictingImmutable: PermissionRule;
		};
		expect(details.persisted.pattern).toBe("Bash(npm run *)");
		expect(details.conflictingImmutable.pattern).toBe("Bash(*)");
		// Engine must NOT have absorbed the persisted allow — deny still wins.
		const decision = await outer.onToolRequested(
			makeRequest("Bash", { command: "npm run build" }),
		);
		expect(decision.behavior).toBe("deny");
	});

	// #18
	it("addRule called with immutable:true at runtime → throws", () => {
		const outer = new OuterHarness(baseConfig());
		expect(() =>
			outer.getPermissionEngine().addRule({
				pattern: "Bash(*)",
				behavior: "allow",
				source: "runtime",
				priority: 10,
				immutable: true,
			} as PermissionRule),
		).toThrow(/cannot be immutable/i);
	});

	// #19
	it("addRule conflicting with immutable rule → throws PermissionRuleConflictError", () => {
		writeYaml(orgPath, [
			{ pattern: "Bash(*)", behavior: "deny", priority: 100, immutable: true },
		]);
		const outer = new OuterHarness(
			baseConfig({ policy: { paths: { org: orgPath } } }),
		);
		expect(() =>
			outer.getPermissionEngine().addRule({
				pattern: "Bash(ls)",
				behavior: "allow",
				source: "runtime",
				priority: 50,
			}),
		).toThrow(PermissionRuleConflictError);
	});

	// #20
	it("malformed org file at boot → new OuterHarness() throws", () => {
		writeFileSync(orgPath, ":\n  bad: [yaml: : syntax");
		expect(
			() =>
				new OuterHarness(
					baseConfig({ policy: { paths: { org: orgPath } } }),
				),
		).toThrow();
	});

	// #22
	it("p99 evaluate with 10 mixed immutable/mutable rules is < 3 ms", async () => {
		const rules: unknown[] = [];
		for (let i = 0; i < 5; i++) {
			rules.push({
				pattern: `Tool${i}(*)`,
				behavior: "deny",
				priority: 100,
				immutable: true,
			});
		}
		writeYaml(orgPath, rules);
		const userRules: unknown[] = [];
		for (let i = 5; i < 10; i++) {
			userRules.push({
				pattern: `Tool${i}(*)`,
				behavior: "allow",
				priority: 50,
			});
		}
		writeYaml(userPath, userRules);

		const outer = new OuterHarness(
			baseConfig({ policy: { paths: { org: orgPath, user: userPath } } }),
		);
		const request = makeRequest("Tool7", { arg: "v" });

		const samples: number[] = [];
		for (let i = 0; i < 500; i++) {
			const start = performance.now();
			await outer.getPermissionEngine().evaluate(request);
			samples.push(performance.now() - start);
		}
		samples.sort((a, b) => a - b);
		const p99 = samples[Math.floor(samples.length * 0.99)]!;
		// Log so regressions surface in CI output.
		console.log(`  PolicyHierarchy.evaluate (10 mixed rules) p99: ${p99.toFixed(3)}ms`);
		expect(p99).toBeLessThan(3);
	});
});
