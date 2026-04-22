import { describe, expect, it } from "vitest";
import { PermissionEngine } from "../src/governance/permission-engine";
import { buildPermissionContext } from "../src/governance/permission-context";
import type {
	PermissionConfig,
	PermissionRule,
	ToolRequest,
} from "@agentweave/types";

function req(
	toolName: string,
	toolInput: Record<string, unknown> = {},
	opts: Partial<Pick<ToolRequest, "isReadOnly" | "isDestructive" | "turnIndex">> = {},
): ToolRequest {
	return {
		toolName,
		toolInput,
		toolUseId: "tu_1",
		turnIndex: opts.turnIndex ?? 1,
		isReadOnly: opts.isReadOnly ?? false,
		isDestructive: opts.isDestructive ?? false,
	};
}

function makeEngine(rules: PermissionRule[], envAllowlist?: readonly string[]): PermissionEngine {
	const cfg: PermissionConfig = {
		mode: "permissive", // no-match = allow, so the only deny we see comes from a rule
		rules,
		failMode: "closed",
		timeoutMs: 5000,
		askTimeoutMs: 60000,
		envAllowlist,
	};
	return new PermissionEngine(cfg);
}

function ruleWith(pattern: string, condition: string, behavior: "allow" | "deny" = "deny"): PermissionRule {
	return { pattern, behavior, source: "policy", priority: 100, condition };
}

// ─── 7.2 Operators ──────────────────────────────────────────────

describe("contextual conditions — time", () => {
	it("fires when condition against time.hour is true", async () => {
		const engine = makeEngine([ruleWith("Bash(*)", "time.hour >= 18")]);
		const ctx = buildPermissionContext(req("Bash", { command: "ls" }), {
			now: () => new Date(2026, 3, 22, 19, 0, 0),
		});
		const d = await engine.evaluate(req("Bash", { command: "ls" }), ctx);
		expect(d.behavior).toBe("deny");
	});

	it("supports OR for after-hours (|| lowest precedence)", async () => {
		const engine = makeEngine([
			ruleWith("Bash(*)", "time.hour >= 18 || time.hour < 9"),
		]);
		const ctxMorning = buildPermissionContext(req("Bash"), {
			now: () => new Date(2026, 3, 22, 7, 30, 0),
		});
		const ctxAfternoon = buildPermissionContext(req("Bash"), {
			now: () => new Date(2026, 3, 22, 14, 0, 0),
		});
		expect((await engine.evaluate(req("Bash"), ctxMorning)).behavior).toBe("deny");
		expect((await engine.evaluate(req("Bash"), ctxAfternoon)).behavior).toBe("allow");
	});

	it("weekday == 0 matches Sunday", async () => {
		const engine = makeEngine([ruleWith("Bash(*)", "time.weekday == 0")]);
		const sunday = buildPermissionContext(req("Bash"), {
			now: () => new Date(2026, 3, 19, 12, 0, 0), // Sunday
		});
		expect((await engine.evaluate(req("Bash"), sunday)).behavior).toBe("deny");
	});
});

describe("contextual conditions — matches()", () => {
	it("detects sudo via word-boundary regex", async () => {
		const engine = makeEngine([
			ruleWith("Bash(*)", "matches(request.toolInput.command, /\\bsudo\\b/)"),
		]);
		expect(
			(await engine.evaluate(req("Bash", { command: "sudo rm -rf /" }))).behavior,
		).toBe("deny");
	});

	it("does NOT fire for substring-only match", async () => {
		const engine = makeEngine([
			ruleWith("Bash(*)", "matches(request.toolInput.command, /\\bsudo\\b/)"),
		]);
		expect(
			(await engine.evaluate(req("Bash", { command: "pseudonym tool" }))).behavior,
		).toBe("allow");
	});

	it("drops a rule whose regex pattern exceeds MAX_REGEX_LEN (fail-safe)", async () => {
		const huge = "a".repeat(300);
		const engine = makeEngine([
			ruleWith("Bash(*)", `matches(request.toolInput.command, /${huge}/)`),
		]);
		// Rule dropped → no match → permissive default = allow.
		expect((await engine.evaluate(req("Bash", { command: "x" }))).behavior).toBe("allow");
	});

	it("flags=i makes the regex case-insensitive", async () => {
		const engine = makeEngine([
			ruleWith("Bash(*)", "matches(request.toolInput.command, /DROP TABLE/i)"),
		]);
		expect(
			(await engine.evaluate(req("Bash", { command: "drop table users" }))).behavior,
		).toBe("deny");
	});
});

describe("contextual conditions — pathMatches()", () => {
	it("matches nested glob `src/**/*.ts`", async () => {
		const engine = makeEngine([
			ruleWith(
				"FileWrite(*)",
				'pathMatches(request.toolInput.file_path, "src/**/*.ts")',
			),
		]);
		expect(
			(await engine.evaluate(req("FileWrite", { file_path: "src/a/b.ts" })))
				.behavior,
		).toBe("deny");
		expect(
			(await engine.evaluate(req("FileWrite", { file_path: "src/a/b.md" })))
				.behavior,
		).toBe("allow");
	});

	it("negation `!.env*` is true iff path does NOT match .env*", async () => {
		const engine = makeEngine([
			ruleWith(
				"FileWrite(*)",
				'pathMatches(request.toolInput.file_path, "!.env*")',
			),
		]);
		expect(
			(await engine.evaluate(req("FileWrite", { file_path: ".env.local" })))
				.behavior,
		).toBe("allow");
		expect(
			(await engine.evaluate(req("FileWrite", { file_path: "src/app.ts" })))
				.behavior,
		).toBe("deny");
	});

	it("path-traversal `../../etc/passwd` does NOT match `src/**`", async () => {
		const engine = makeEngine([
			ruleWith(
				"FileWrite(*)",
				'pathMatches(request.toolInput.file_path, "src/**")',
			),
		]);
		expect(
			(await engine.evaluate(req("FileWrite", { file_path: "../../etc/passwd" })))
				.behavior,
		).toBe("allow");
	});

	it("`src/**` also matches bare `src`", async () => {
		const engine = makeEngine([
			ruleWith("FileWrite(*)", 'pathMatches(request.toolInput.file_path, "src/**")'),
		]);
		expect(
			(await engine.evaluate(req("FileWrite", { file_path: "src" }))).behavior,
		).toBe("deny");
	});
});

describe("contextual conditions — session.*", () => {
	it("matches session.projectId equality", async () => {
		const engine = makeEngine([ruleWith("*", 'session.projectId == "prod"')]);
		const ctx = buildPermissionContext(req("Bash"), {
			session: { projectId: "prod" },
		});
		expect((await engine.evaluate(req("Bash"), ctx)).behavior).toBe("deny");
	});

	it("undefined session field never compares equal", async () => {
		const engine = makeEngine([ruleWith("*", 'session.projectId == "prod"')]);
		const ctx = buildPermissionContext(req("Bash"), { session: {} });
		expect((await engine.evaluate(req("Bash"), ctx)).behavior).toBe("allow");
	});
});

describe("contextual conditions — env.*", () => {
	it("allowlisted env var is readable", async () => {
		process.env.P22_ENGINE_CI = "true";
		try {
			const engine = makeEngine(
				[ruleWith("HttpFetch(*)", 'env.P22_ENGINE_CI == "true"')],
				["P22_ENGINE_CI"],
			);
			const ctx = buildPermissionContext(req("HttpFetch"), {
				envAllowlist: ["P22_ENGINE_CI"],
			});
			expect((await engine.evaluate(req("HttpFetch"), ctx)).behavior).toBe("deny");
		} finally {
			delete process.env.P22_ENGINE_CI;
		}
	});

	it("non-allowlisted env var resolves undefined → rule skipped", async () => {
		process.env.P22_ENGINE_SECRET = "sekret";
		try {
			const engine = makeEngine(
				[ruleWith("HttpFetch(*)", 'env.P22_ENGINE_SECRET == "sekret"')],
				[], // explicit empty allowlist
			);
			expect((await engine.evaluate(req("HttpFetch"))).behavior).toBe("allow");
		} finally {
			delete process.env.P22_ENGINE_SECRET;
		}
	});
});

// ─── 7.3 Logical combination ────────────────────────────────────

describe("logical operators", () => {
	it("A && B — both must hold", async () => {
		const engine = makeEngine([
			ruleWith("*", "request.isDestructive == true && request.isReadOnly == false"),
		]);
		expect(
			(await engine.evaluate(req("Bash", {}, { isDestructive: true, isReadOnly: false })))
				.behavior,
		).toBe("deny");
		expect(
			(await engine.evaluate(req("Bash", {}, { isDestructive: true, isReadOnly: true })))
				.behavior,
		).toBe("allow");
	});

	it("A || B — either holds", async () => {
		const engine = makeEngine([
			ruleWith("*", 'request.toolName == "X" || request.toolName == "Y"'),
		]);
		expect((await engine.evaluate(req("X"))).behavior).toBe("deny");
		expect((await engine.evaluate(req("Y"))).behavior).toBe("deny");
		expect((await engine.evaluate(req("Z"))).behavior).toBe("allow");
	});

	it("|| has lowest precedence: `A && B || C` = `(A && B) || C`", async () => {
		const engine = makeEngine([
			ruleWith("*", 'request.isReadOnly == false && request.isDestructive == true || request.toolName == "Explicit"'),
		]);
		// C branch: toolName == Explicit → fires regardless of A/B
		expect((await engine.evaluate(req("Explicit"))).behavior).toBe("deny");
		// (A && B) branch: destructive + writable
		expect(
			(await engine.evaluate(req("X", {}, { isDestructive: true, isReadOnly: false })))
				.behavior,
		).toBe("deny");
		// Neither
		expect(
			(await engine.evaluate(req("X", {}, { isDestructive: false, isReadOnly: true })))
				.behavior,
		).toBe("allow");
	});
});

// ─── 7.3b Parser robustness — literal-safe split ───────────────

describe("parser robustness — logical split ignores literals", () => {
	it("|| inside a regex literal is not a top-level OR", async () => {
		// Regex `/a||b/` = empty alternations around b; valid JS regex.
		// If the splitter were naive, this would split into two broken parts
		// and the rule would be dropped (→ allow in permissive mode).
		const engine = makeEngine([
			ruleWith("Bash(*)", "matches(request.toolInput.command, /a||b/)"),
		]);
		// 'xbx' matches the `b` alternative → rule fires.
		expect(
			(await engine.evaluate(req("Bash", { command: "xbx" }))).behavior,
		).toBe("deny");
	});

	it("&& inside a string literal is not a top-level AND", async () => {
		const engine = makeEngine([
			ruleWith("Bash(*)", 'contains(request.toolInput.command, "x && y")'),
		]);
		expect(
			(await engine.evaluate(req("Bash", { command: "echo x && y" })))
				.behavior,
		).toBe("deny");
	});
});

// ─── 7.3c ReDoS safety — field-value length cap ─────────────────

describe("field-value length cap — matches/pathMatches/contains", () => {
	it("drops the match silently when the subject exceeds MAX_FIELD_VALUE_LEN", async () => {
		// Pattern that *would* catastrophically backtrack on a long subject.
		// Cap makes it a no-match instead of a CPU burn.
		const engine = makeEngine([
			ruleWith("Bash(*)", "matches(request.toolInput.command, /(a+)+b/)"),
		]);
		const huge = "a".repeat(10_000);
		const start = Date.now();
		const d = await engine.evaluate(req("Bash", { command: huge }));
		const elapsed = Date.now() - start;
		expect(d.behavior).toBe("allow"); // no-match → permissive default
		expect(elapsed).toBeLessThan(100); // should not backtrack
	});

	it("contains/pathMatches also respect the length cap", async () => {
		const engine = makeEngine([
			ruleWith("Bash(*)", 'contains(request.toolInput.command, "needle")'),
		]);
		const huge = "x".repeat(10_000) + "needle";
		expect(
			(await engine.evaluate(req("Bash", { command: huge }))).behavior,
		).toBe("allow"); // cap makes it a non-match even though `needle` is present
	});
});

// ─── 7.4 Fail-safe ──────────────────────────────────────────────

describe("fail-safe — invalid conditions never crash", () => {
	it("condition > 512 chars → rule dropped", async () => {
		const cond = 'request.toolName == "' + "x".repeat(600) + '"';
		const engine = makeEngine([ruleWith("*", cond)]);
		// Even if the request somehow matched, rule is dropped at compile.
		expect((await engine.evaluate(req("Bash"))).behavior).toBe("allow");
	});

	it("nonsense expression skips the rule but still evaluates others", async () => {
		const engine = makeEngine([
			ruleWith("Bash(*)", "this is not a valid expression"), // skipped
			ruleWith("Bash(*)", "request.toolName == \"Bash\""),   // fires
		]);
		expect((await engine.evaluate(req("Bash"))).behavior).toBe("deny");
	});

	it("dot-path deeper than MAX_FIELD_DEPTH returns undefined", async () => {
		const engine = makeEngine([ruleWith("*", "a.b.c.d.e == 1")]);
		expect((await engine.evaluate(req("Bash"))).behavior).toBe("allow");
	});
});

// ─── 7.5 Regression — baseline backward compat ──────────────────

describe("backward-compat: single-arg evaluate() still works", () => {
	it("resolves request.isReadOnly without a ctx argument", async () => {
		const engine = makeEngine([
			ruleWith("*", "request.isReadOnly == true", "allow"),
		]);
		const d = await engine.evaluate(req("Bash", {}, { isReadOnly: true }));
		expect(d.behavior).toBe("allow");
	});
});

// ─── 7.6 End-to-end via OuterHarness ────────────────────────────

// (kept in a separate file — ./outer-harness.test.ts — to not duplicate harness wiring here)
