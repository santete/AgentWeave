import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	buildPermissionContext,
	sessionContextFromInfo,
} from "../src/governance/permission-context";
import type { SessionInfo, ToolRequest } from "@agentweave/types";

function makeRequest(
	overrides: Partial<ToolRequest> = {},
): ToolRequest {
	return {
		toolName: "Bash",
		toolInput: { command: "ls" },
		toolUseId: "tu_1",
		turnIndex: 3,
		isReadOnly: true,
		isDestructive: false,
		...overrides,
	};
}

describe("buildPermissionContext — request", () => {
	it("mirrors ToolRequest fields exactly", () => {
		const ctx = buildPermissionContext(
			makeRequest({ toolName: "FileWrite", turnIndex: 7, isDestructive: true }),
		);
		expect(ctx.request.toolName).toBe("FileWrite");
		expect(ctx.request.turnIndex).toBe(7);
		expect(ctx.request.isDestructive).toBe(true);
		expect(ctx.request.isReadOnly).toBe(true);
		expect(ctx.request.toolUseId).toBe("tu_1");
	});

	it("exposes toolInput as the raw Record", () => {
		const ctx = buildPermissionContext(
			makeRequest({ toolInput: { command: "git status", flag: 1 } }),
		);
		expect(ctx.request.toolInput).toEqual({ command: "git status", flag: 1 });
	});
});

describe("buildPermissionContext — time", () => {
	it("derives hour/minute/weekday from injected clock", () => {
		// Sunday 2026-04-19 at 03:05 UTC — use a fixed Date.
		const fixed = new Date(2026, 3, 19, 3, 5, 0); // month is 0-indexed (April = 3)
		const ctx = buildPermissionContext(makeRequest(), { now: () => fixed });
		expect(ctx.time.hour).toBe(3);
		expect(ctx.time.minute).toBe(5);
		expect(ctx.time.weekday).toBe(0); // Sunday
		expect(ctx.time.epochMs).toBe(fixed.getTime());
		expect(ctx.time.iso).toBe(fixed.toISOString());
	});

	it("falls back to wall clock when no `now` provided", () => {
		const ctx = buildPermissionContext(makeRequest());
		expect(ctx.time.hour).toBeGreaterThanOrEqual(0);
		expect(ctx.time.hour).toBeLessThanOrEqual(23);
		expect(ctx.time.weekday).toBeGreaterThanOrEqual(0);
		expect(ctx.time.weekday).toBeLessThanOrEqual(6);
	});
});

describe("buildPermissionContext — session", () => {
	it("copies only known session keys from the partial", () => {
		const ctx = buildPermissionContext(makeRequest(), {
			session: { sessionId: "s1", projectId: "prod", model: "claude" },
		});
		expect(ctx.session.sessionId).toBe("s1");
		expect(ctx.session.projectId).toBe("prod");
		expect(ctx.session.model).toBe("claude");
		expect(ctx.session.agentId).toBeUndefined();
		expect(ctx.session.cwd).toBeUndefined();
	});

	it("returns an empty session namespace when no session is set", () => {
		const ctx = buildPermissionContext(makeRequest());
		expect(ctx.session).toEqual({
			sessionId: undefined,
			agentId: undefined,
			userId: undefined,
			projectId: undefined,
			model: undefined,
			cwd: undefined,
		});
	});
});

describe("buildPermissionContext — env allowlist", () => {
	const ORIG: NodeJS.ProcessEnv = { ...process.env };
	beforeEach(() => {
		process.env.P22_TEST_VISIBLE = "yes";
		process.env.P22_TEST_HIDDEN = "secret";
	});
	afterEach(() => {
		for (const k of Object.keys(process.env)) {
			if (k.startsWith("P22_TEST_")) delete process.env[k];
		}
		Object.assign(process.env, ORIG);
	});

	it("exposes only allowlisted env vars", () => {
		const ctx = buildPermissionContext(makeRequest(), {
			envAllowlist: ["P22_TEST_VISIBLE"],
		});
		expect(ctx.env.P22_TEST_VISIBLE).toBe("yes");
		expect(ctx.env.P22_TEST_HIDDEN).toBeUndefined();
	});

	it("defaults to no env access when allowlist is empty", () => {
		const ctx = buildPermissionContext(makeRequest());
		expect(ctx.env).toEqual({});
	});

	it("returns undefined for allowlisted vars that are not set", () => {
		const ctx = buildPermissionContext(makeRequest(), {
			envAllowlist: ["P22_TEST_NEVERSET"],
		});
		expect("P22_TEST_NEVERSET" in ctx.env).toBe(true);
		expect(ctx.env.P22_TEST_NEVERSET).toBeUndefined();
	});
});

describe("sessionContextFromInfo", () => {
	it("maps SessionInfo → session-namespace subset", () => {
		const info: SessionInfo = {
			sessionId: "s",
			agentId: "a",
			userId: "u",
			projectId: "p",
			model: "m",
			startTime: 123,
			cwd: "/tmp",
		};
		expect(sessionContextFromInfo(info)).toEqual({
			sessionId: "s",
			agentId: "a",
			userId: "u",
			projectId: "p",
			model: "m",
			cwd: "/tmp",
		});
	});
});
