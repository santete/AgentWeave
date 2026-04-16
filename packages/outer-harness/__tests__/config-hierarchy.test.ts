import { describe, it, expect } from "vitest";
import { ConfigHierarchy, getDefaultConfig } from "../src/orchestration/config-hierarchy";

describe("getDefaultConfig", () => {
	it("should return sensible defaults", () => {
		const config = getDefaultConfig();
		expect(config.inner.model).toBe("claude-sonnet-4-6");
		expect(config.inner.maxTurns).toBe(100);
		expect(config.permissions.mode).toBe("default");
		expect(config.permissions.failMode).toBe("closed");
		expect(config.budget.warningThreshold).toBe(0.8);
		expect(config.output.gateMode).toBe("auto");
		expect(config.session.persistTranscript).toBe(true);
	});
});

describe("ConfigHierarchy", () => {
	it("should return defaults when no sources added", () => {
		const hierarchy = new ConfigHierarchy();
		const config = hierarchy.getEffectiveConfig();

		expect(config.inner.model).toBe("claude-sonnet-4-6");
		expect(config.permissions.rules).toEqual([]);
	});

	it("should override defaults with user config (level 2)", () => {
		const hierarchy = new ConfigHierarchy();
		hierarchy.addSource(2, "user", {
			inner: { model: "claude-opus-4-6", maxTurns: 50, thinkingEnabled: true, tools: [] },
		});

		const config = hierarchy.getEffectiveConfig();
		expect(config.inner.model).toBe("claude-opus-4-6");
		expect(config.inner.maxTurns).toBe(50);
	});

	it("should override user with project config (level 3)", () => {
		const hierarchy = new ConfigHierarchy();
		hierarchy.addSource(2, "user", {
			inner: { model: "claude-opus-4-6", maxTurns: 50, thinkingEnabled: true, tools: [] },
		});
		hierarchy.addSource(3, "project", {
			inner: { model: "claude-sonnet-4-6", maxTurns: 100, thinkingEnabled: true, tools: [] },
		});

		const config = hierarchy.getEffectiveConfig();
		expect(config.inner.model).toBe("claude-sonnet-4-6"); // project wins
	});

	it("should merge permission rules (append, not replace)", () => {
		const hierarchy = new ConfigHierarchy();
		hierarchy.addSource(2, "user", {
			permissions: {
				mode: "default",
				rules: [{ pattern: "Bash(git *)", behavior: "allow", source: "user", priority: 10 }],
				failMode: "closed",
				timeoutMs: 5000,
				askTimeoutMs: 60000,
			},
		});
		hierarchy.addSource(3, "project", {
			permissions: {
				mode: "default",
				rules: [{ pattern: "Bash(npm *)", behavior: "allow", source: "project", priority: 50 }],
				failMode: "closed",
				timeoutMs: 5000,
				askTimeoutMs: 60000,
			},
		});

		const config = hierarchy.getEffectiveConfig();
		expect(config.permissions.rules).toHaveLength(2);
		expect(config.permissions.rules.map((r) => r.pattern)).toContain("Bash(git *)");
		expect(config.permissions.rules.map((r) => r.pattern)).toContain("Bash(npm *)");
	});

	it("should merge hooks by event (append)", () => {
		const hierarchy = new ConfigHierarchy();
		hierarchy.addSource(2, "user", {
			hooks: {
				PostToolUse: [
					{ type: "function", event: "PostToolUse", inline: "return { outcome: 'pass' }" } as import("@agentweave/types").HookDefinition,
				],
			},
		});
		hierarchy.addSource(3, "project", {
			hooks: {
				PostToolUse: [
					{ type: "command", event: "PostToolUse", command: "npm test" } as import("@agentweave/types").HookDefinition,
				],
			},
		});

		const config = hierarchy.getEffectiveConfig();
		expect(config.hooks.PostToolUse).toHaveLength(2);
	});

	it("should respect CLI flags (level 5) over project (level 3)", () => {
		const hierarchy = new ConfigHierarchy();
		hierarchy.addSource(3, "project", {
			inner: { model: "claude-sonnet-4-6", maxTurns: 100, thinkingEnabled: true, tools: [] },
			budget: { maxPerSession: 10, warningThreshold: 0.8 },
		});
		hierarchy.addSource(5, "cli", {
			inner: { model: "claude-haiku-4-5", maxTurns: 20, thinkingEnabled: false, tools: [] },
			budget: { maxPerSession: 2, warningThreshold: 0.8 },
		});

		const config = hierarchy.getEffectiveConfig();
		expect(config.inner.model).toBe("claude-haiku-4-5");
		expect(config.budget.maxPerSession).toBe(2);
	});

	it("should report sources", () => {
		const hierarchy = new ConfigHierarchy();
		hierarchy.addSource(2, "user", { inner: { model: "x", maxTurns: 1, thinkingEnabled: true, tools: [] } });
		hierarchy.addSource(3, "project", { inner: { model: "y", maxTurns: 1, thinkingEnabled: true, tools: [] } });

		const sources = hierarchy.getSources();
		expect(sources).toHaveLength(3); // defaults + user + project
		expect(sources.map((s) => s.name)).toContain("defaults");
		expect(sources.map((s) => s.name)).toContain("user");
		expect(sources.map((s) => s.name)).toContain("project");
	});

	it("should detect policy level", () => {
		const hierarchy = new ConfigHierarchy();
		expect(hierarchy.hasPolicy()).toBe(false);

		hierarchy.addSource(7, "policy", {
			permissions: {
				mode: "strict",
				rules: [{ pattern: "Bash(rm -rf *)", behavior: "deny", source: "policy", priority: 1000 }],
				failMode: "closed",
				timeoutMs: 5000,
				askTimeoutMs: 60000,
			},
		});

		expect(hierarchy.hasPolicy()).toBe(true);
		const config = hierarchy.getEffectiveConfig();
		expect(config.permissions.mode).toBe("strict");
	});

	it("should cache effective config and invalidate on change", () => {
		const hierarchy = new ConfigHierarchy();
		const config1 = hierarchy.getEffectiveConfig();
		const config2 = hierarchy.getEffectiveConfig();
		expect(config1).toBe(config2); // same reference = cached

		hierarchy.addSource(2, "user", { inner: { model: "opus", maxTurns: 1, thinkingEnabled: true, tools: [] } });
		const config3 = hierarchy.getEffectiveConfig();
		expect(config3).not.toBe(config1); // new reference = recalculated
		expect(config3.inner.model).toBe("opus");
	});

	it("should replace source at same level", () => {
		const hierarchy = new ConfigHierarchy();
		hierarchy.addSource(2, "user-v1", { inner: { model: "opus", maxTurns: 1, thinkingEnabled: true, tools: [] } });
		hierarchy.addSource(2, "user-v2", { inner: { model: "haiku", maxTurns: 1, thinkingEnabled: true, tools: [] } });

		const config = hierarchy.getEffectiveConfig();
		expect(config.inner.model).toBe("haiku");
		expect(hierarchy.getSources().filter((s) => s.level === 2)).toHaveLength(1);
	});
});
