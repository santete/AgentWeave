import { describe, it, expect } from "vitest";
import {
	createAiderAdapter,
	buildAiderAdapterConfig,
} from "../src/aider-adapter";
import { ProcessAdapter } from "../src/process-adapter";

// ─── Config shape ─────────────────────────────────────────────────

describe("buildAiderAdapterConfig", () => {
	it("should default to non-interactive, pipe-friendly flags", () => {
		const cfg = buildAiderAdapterConfig();

		expect(cfg.command).toBe("aider");
		expect(cfg.args).toContain("--no-pretty");
		expect(cfg.args).toContain("--yes-always");
		expect(cfg.args).toContain("--no-git");
		expect(cfg.promptMode).toBe("arg");
		expect(cfg.parseJson).toBe(false);
	});

	it("should place --message last so the prompt is appended as its value", () => {
		const cfg = buildAiderAdapterConfig();
		const args = cfg.args ?? [];

		expect(args[args.length - 1]).toBe("--message");
	});

	it("should inject --model when a model is supplied", () => {
		const cfg = buildAiderAdapterConfig({ model: "sonnet" });
		const args = cfg.args ?? [];

		const idx = args.indexOf("--model");
		expect(idx).toBeGreaterThanOrEqual(0);
		expect(args[idx + 1]).toBe("sonnet");
		// --message must still be last
		expect(args[args.length - 1]).toBe("--message");
	});

	it("should omit --model when no model is supplied", () => {
		const cfg = buildAiderAdapterConfig();
		expect(cfg.args ?? []).not.toContain("--model");
	});

	it("should append extraArgs before --message", () => {
		const cfg = buildAiderAdapterConfig({ extraArgs: ["--verbose", "--dark-mode"] });
		const args = cfg.args ?? [];

		const verboseIdx = args.indexOf("--verbose");
		const messageIdx = args.indexOf("--message");
		expect(verboseIdx).toBeGreaterThanOrEqual(0);
		expect(verboseIdx).toBeLessThan(messageIdx);
		expect(args.indexOf("--dark-mode")).toBeGreaterThanOrEqual(0);
	});

	it("should pass through cwd and env", () => {
		const cfg = buildAiderAdapterConfig({
			cwd: "/tmp/work",
			env: { ANTHROPIC_API_KEY: "sk-test" },
		});

		expect(cfg.cwd).toBe("/tmp/work");
		expect(cfg.env).toEqual({ ANTHROPIC_API_KEY: "sk-test" });
	});

	it("should enable stderr capture (for governance audit trail)", () => {
		const cfg = buildAiderAdapterConfig();
		expect(cfg.stderr?.capture).toBe(true);
		expect(cfg.stderr?.asEvents).toBe(false);
	});
});

// ─── Factory ──────────────────────────────────────────────────────

describe("createAiderAdapter", () => {
	it("should return a ProcessAdapter instance", () => {
		const adapter = createAiderAdapter();
		expect(adapter).toBeInstanceOf(ProcessAdapter);
	});

	it("should produce an InnerConfig with model=process:aider", () => {
		const adapter = createAiderAdapter();
		const cfg = adapter.getConfig();
		expect(cfg.model).toBe("process:aider");
		expect(cfg.tools).toEqual([]);
	});

	it("should expose no tools (Aider manages its own internally)", () => {
		const adapter = createAiderAdapter({ model: "sonnet" });
		expect(adapter.getTools()).toEqual([]);
	});

	it("should prevent double run (inherits ProcessAdapter contract)", async () => {
		const adapter = createAiderAdapter();

		// Start run but don't consume — just verify the state guard
		// triggers on a second invocation.
		const gen = adapter.run("test prompt");
		void gen; // one active run

		expect(() => adapter.run("second prompt")).toThrow("only be run once");

		adapter.abort("cleanup");
	});

	it("should transition to aborted state on abort()", () => {
		const adapter = createAiderAdapter();
		const gen = adapter.run("test");
		void gen;

		adapter.abort("test cleanup");
		expect(adapter.getState().status).toBe("aborted");
	});
});
