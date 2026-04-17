import { describe, it, expect, afterEach } from "vitest";
import { PluginLoader } from "../src/orchestration/plugin-loader";
import type { PluginManifest, PluginContext, ToolDefinition } from "@agentweave/types";

const TEST_CONTEXT: PluginContext = {
	version: "0.5.0",
	projectRoot: "/tmp/test-project",
	dataDir: "/tmp/test-plugins/test-plugin",
};

function makeToolPlugin(name = "test-plugin"): PluginManifest {
	const tool: ToolDefinition = {
		name: "PluginTool",
		description: "A test tool from plugin",
		parameters: { parse: (v: unknown) => v } as never,
		execute: async ({ input }) => `echo: ${input}`,
		metadata: {
			isReadOnly: true,
			isDestructive: false,
			isConcurrencySafe: true,
			category: "custom",
		},
	};

	return {
		name,
		version: "1.0.0",
		description: "Test plugin",
		permissions: {
			tools: { register: ["PluginTool"] },
		},
		activate: async () => ({
			tools: [tool],
		}),
	};
}

function makeHookPlugin(): PluginManifest {
	return {
		name: "hook-plugin",
		version: "1.0.0",
		description: "Plugin with hooks",
		permissions: {
			hooks: { events: ["PostToolUse"] },
		},
		activate: async () => ({
			hooks: [
				{
					event: "PostToolUse",
					matcher: "FileWrite",
					definition: {
						type: "command" as const,
						event: "PostToolUse" as const,
						command: "echo lint",
					},
				},
			],
		}),
	};
}

describe("PluginLoader", () => {
	let loader: PluginLoader;

	afterEach(async () => {
		await loader?.deactivateAll();
	});

	// ─── loadFromManifest ────────────────────────────────────────

	it("should load and activate a plugin with tools", async () => {
		loader = new PluginLoader();
		const loaded = await loader.loadFromManifest(makeToolPlugin(), TEST_CONTEXT);

		expect(loaded.manifest.name).toBe("test-plugin");
		expect(loaded.registration.tools).toHaveLength(1);
		expect(loaded.registration.tools![0]!.name).toBe("PluginTool");
	});

	it("should load a plugin with hooks", async () => {
		loader = new PluginLoader();
		const loaded = await loader.loadFromManifest(makeHookPlugin(), TEST_CONTEXT);

		expect(loaded.registration.hooks).toHaveLength(1);
		expect(loaded.registration.hooks![0]!.event).toBe("PostToolUse");
	});

	it("should pass pluginConfig to activate context", async () => {
		loader = new PluginLoader();
		let receivedConfig: Record<string, unknown> | undefined;

		const manifest: PluginManifest = {
			name: "config-plugin",
			version: "1.0.0",
			description: "reads config",
			activate: async (ctx) => {
				receivedConfig = ctx.pluginConfig;
				return {};
			},
		};

		await loader.loadFromManifest(manifest, {
			...TEST_CONTEXT,
			pluginConfig: { foo: "bar" },
		});

		expect(receivedConfig).toEqual({ foo: "bar" });
	});

	// ─── Validation ─────────────────────────────────────────────

	it("should reject manifest without name", async () => {
		loader = new PluginLoader();
		const bad = { version: "1.0.0", activate: async () => ({}) } as unknown as PluginManifest;

		await expect(loader.loadFromManifest(bad, TEST_CONTEXT)).rejects.toThrow(
			"must have a name",
		);
	});

	it("should reject manifest without version", async () => {
		loader = new PluginLoader();
		const bad = { name: "x", activate: async () => ({}) } as unknown as PluginManifest;

		await expect(loader.loadFromManifest(bad, TEST_CONTEXT)).rejects.toThrow(
			"must have a version",
		);
	});

	it("should reject manifest without activate function", async () => {
		loader = new PluginLoader();
		const bad = { name: "x", version: "1.0.0" } as unknown as PluginManifest;

		await expect(loader.loadFromManifest(bad, TEST_CONTEXT)).rejects.toThrow(
			"must have an activate function",
		);
	});

	// ─── Permission Validation ──────────────────────────────────

	it("should reject tool not declared in permissions", async () => {
		loader = new PluginLoader();
		const manifest: PluginManifest = {
			name: "sneaky",
			version: "1.0.0",
			description: "tries to sneak undeclared tool",
			permissions: { tools: { register: ["AllowedTool"] } },
			activate: async () => ({
				tools: [
					{
						name: "SneakyTool",
						description: "not declared",
						parameters: { parse: (v: unknown) => v } as never,
						execute: async () => "nope",
						metadata: { isReadOnly: true, isDestructive: false, isConcurrencySafe: true, category: "custom" as const },
					},
				],
			}),
		};

		await expect(loader.loadFromManifest(manifest, TEST_CONTEXT)).rejects.toThrow(
			'tool "SneakyTool" not declared',
		);
	});

	it("should reject hook event not declared in permissions", async () => {
		loader = new PluginLoader();
		const manifest: PluginManifest = {
			name: "sneaky-hooks",
			version: "1.0.0",
			description: "undeclared hook",
			permissions: { hooks: { events: ["SessionEnd"] } },
			activate: async () => ({
				hooks: [{ event: "PreToolUse", definition: { type: "command" as const, event: "PreToolUse" as const, command: "echo" } }],
			}),
		};

		await expect(loader.loadFromManifest(manifest, TEST_CONTEXT)).rejects.toThrow(
			'hook for event "PreToolUse" not declared',
		);
	});

	it("should allow tools/hooks when no permissions declared (no restrictions)", async () => {
		loader = new PluginLoader();
		const manifest: PluginManifest = {
			name: "no-perms",
			version: "1.0.0",
			description: "no permissions field",
			activate: async () => ({
				tools: [
					{
						name: "AnyTool",
						description: "ok",
						parameters: { parse: (v: unknown) => v } as never,
						execute: async () => "ok",
						metadata: { isReadOnly: true, isDestructive: false, isConcurrencySafe: true, category: "custom" as const },
					},
				],
			}),
		};

		// No permissions = no restriction (trusted plugin)
		const loaded = await loader.loadFromManifest(manifest, TEST_CONTEXT);
		expect(loaded.registration.tools).toHaveLength(1);
	});

	// ─── Deactivate ─────────────────────────────────────────────

	it("should call deactivate on all loaded plugins", async () => {
		loader = new PluginLoader();
		let deactivated = 0;

		const manifest: PluginManifest = {
			...makeToolPlugin("deactivate-test"),
			deactivate: async () => { deactivated++; },
		};

		await loader.loadFromManifest(manifest, TEST_CONTEXT);
		await loader.loadFromManifest(
			{ ...makeHookPlugin(), deactivate: async () => { deactivated++; } },
			TEST_CONTEXT,
		);

		expect(loader.getLoaded()).toHaveLength(2);
		await loader.deactivateAll();
		expect(deactivated).toBe(2);
		expect(loader.getLoaded()).toHaveLength(0);
	});

	it("should not throw if deactivate fails", async () => {
		loader = new PluginLoader();
		const manifest: PluginManifest = {
			...makeToolPlugin("fail-deactivate"),
			deactivate: async () => { throw new Error("boom"); },
		};

		await loader.loadFromManifest(manifest, TEST_CONTEXT);
		await expect(loader.deactivateAll()).resolves.not.toThrow();
	});

	it("should reject loading same plugin name twice", async () => {
		loader = new PluginLoader();
		await loader.loadFromManifest(makeToolPlugin("dup-plugin"), TEST_CONTEXT);

		await expect(
			loader.loadFromManifest(makeToolPlugin("dup-plugin"), TEST_CONTEXT),
		).rejects.toThrow('Plugin "dup-plugin" is already loaded');
	});

	// ─── Multiple plugins ───────────────────────────────────────

	it("should load multiple plugins", async () => {
		loader = new PluginLoader();
		await loader.loadFromManifest(makeToolPlugin("p1"), TEST_CONTEXT);
		await loader.loadFromManifest(makeHookPlugin(), TEST_CONTEXT);

		expect(loader.getLoaded()).toHaveLength(2);
		expect(loader.getLoaded()[0]!.manifest.name).toBe("p1");
		expect(loader.getLoaded()[1]!.manifest.name).toBe("hook-plugin");
	});
});
