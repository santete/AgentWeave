import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { runModule, ModuleError } from "../../src/sdlc/module-runner";
import type { SDLCModule, SDLCModuleContext, SDLCConfig } from "@agentweave/types";
import { MetricsCollector } from "../../src/sdlc/metrics-collector";
import { getDefaultSDLCConfig } from "../../src/sdlc/sdlc-config";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";

function makeContext(): SDLCModuleContext {
	const mc = new MetricsCollector("task_test");
	return {
		sessionId: "ses_test",
		cwd: process.cwd(),
		signal: new AbortController().signal,
		config: getDefaultSDLCConfig(),
		metrics: mc.createHandle(),
	};
}

const echoModule: SDLCModule<string, string> = {
	name: "Echo",
	async execute(input: string) {
		return `echo:${input}`;
	},
};

const failModule: SDLCModule<string, string> = {
	name: "FailModule",
	async execute() {
		throw new Error("module crashed");
	},
};

describe("runModule", () => {
	it("should run enabled module and return output", async () => {
		const result = await runModule({
			builtIn: echoModule,
			config: { enabled: true },
			input: "hello",
			context: makeContext(),
			defaultOutput: "default",
		});

		expect(result.output).toBe("echo:hello");
		expect(result.skipped).toBe(false);
		expect(result.durationMs).toBeGreaterThanOrEqual(0);
	});

	it("should return default when module is disabled", async () => {
		const result = await runModule({
			builtIn: echoModule,
			config: { enabled: false },
			input: "hello",
			context: makeContext(),
			defaultOutput: "default",
		});

		expect(result.output).toBe("default");
		expect(result.skipped).toBe(true);
		expect(result.durationMs).toBe(0);
	});

	it("should wrap module errors in ModuleError", async () => {
		await expect(
			runModule({
				builtIn: failModule,
				config: { enabled: true },
				input: "hello",
				context: makeContext(),
				defaultOutput: "default",
			}),
		).rejects.toThrow(ModuleError);

		try {
			await runModule({
				builtIn: failModule,
				config: { enabled: true },
				input: "hello",
				context: makeContext(),
				defaultOutput: "default",
			});
		} catch (err) {
			expect(err).toBeInstanceOf(ModuleError);
			expect((err as ModuleError).moduleName).toBe("FailModule");
			expect((err as ModuleError).message).toContain("module crashed");
		}
	});

	it("should record timing in metrics", async () => {
		const mc = new MetricsCollector("task_test");
		const ctx = {
			...makeContext(),
			metrics: mc.createHandle(),
		};

		await runModule({
			builtIn: echoModule,
			config: { enabled: true },
			input: "hello",
			context: ctx,
			defaultOutput: "default",
		});

		expect(mc.get("module:Echo:durationMs")).toBeGreaterThanOrEqual(0);
	});
});

describe("runModule — custom module loading", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = join(tmpdir(), `agentweave-module-${randomUUID().slice(0, 8)}`);
		mkdirSync(tmpDir, { recursive: true });
	});

	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true });
	});

	it("should load custom module from path", async () => {
		const handlerPath = join(tmpDir, "custom-echo.mjs");
		writeFileSync(handlerPath, `
			export default {
				name: "CustomEcho",
				async execute(input) { return "custom:" + input; }
			};
		`);

		const result = await runModule({
			builtIn: echoModule,
			config: { enabled: true, custom: handlerPath },
			input: "world",
			context: makeContext(),
			defaultOutput: "default",
		});

		expect(result.output).toBe("custom:world");
	});

	it("should throw clear error for invalid custom module", async () => {
		const handlerPath = join(tmpDir, "bad-module.mjs");
		writeFileSync(handlerPath, `export default "not a module";`);

		await expect(
			runModule({
				builtIn: echoModule,
				config: { enabled: true, custom: handlerPath },
				input: "hello",
				context: makeContext(),
				defaultOutput: "default",
			}),
		).rejects.toThrow("does not export a valid SDLCModule");
	});

	it("should throw clear error for missing custom module", async () => {
		await expect(
			runModule({
				builtIn: echoModule,
				config: { enabled: true, custom: join(tmpDir, "nonexistent.mjs") },
				input: "hello",
				context: makeContext(),
				defaultOutput: "default",
			}),
		).rejects.toThrow("Failed to load custom module");
	});

	it("should reject path traversal in custom module path", async () => {
		await expect(
			runModule({
				builtIn: echoModule,
				config: { enabled: true, custom: "../../etc/evil.js" },
				input: "hello",
				context: makeContext(),
				defaultOutput: "default",
			}),
		).rejects.toThrow("path traversal");
	});

	it("should reject custom module without .js/.ts/.mjs extension", async () => {
		await expect(
			runModule({
				builtIn: echoModule,
				config: { enabled: true, custom: "/some/module.py" },
				input: "hello",
				context: makeContext(),
				defaultOutput: "default",
			}),
		).rejects.toThrow("must end in");
	});
});
