import { describe, it, expect } from "vitest";
import {
	createCursorAdapter,
	buildCursorAdapterConfig,
} from "../src/cursor-adapter";
import { ProcessAdapter } from "../src/process-adapter";

// ─── Config shape ─────────────────────────────────────────────────

describe("buildCursorAdapterConfig", () => {
	it("should default to non-interactive, pipe-friendly flags", () => {
		const cfg = buildCursorAdapterConfig();

		expect(cfg.command).toBe("cursor-agent");
		expect(cfg.args).toContain("--force");
		expect(cfg.args).toContain("-p");
		expect(cfg.promptMode).toBe("arg");
		expect(cfg.parseJson).toBe(false);
	});

	it("should place -p last so the prompt is appended as its value", () => {
		const cfg = buildCursorAdapterConfig();
		const args = cfg.args ?? [];

		expect(args[args.length - 1]).toBe("-p");
	});

	it("should inject -m when a model is supplied", () => {
		const cfg = buildCursorAdapterConfig({ model: "sonnet-4" });
		const args = cfg.args ?? [];

		const idx = args.indexOf("-m");
		expect(idx).toBeGreaterThanOrEqual(0);
		expect(args[idx + 1]).toBe("sonnet-4");
		// -p must still be last
		expect(args[args.length - 1]).toBe("-p");
	});

	it("should omit -m when no model is supplied", () => {
		const cfg = buildCursorAdapterConfig();
		expect(cfg.args ?? []).not.toContain("-m");
	});

	it("should append extraArgs before -p", () => {
		const cfg = buildCursorAdapterConfig({ extraArgs: ["--verbose", "--debug"] });
		const args = cfg.args ?? [];

		const verboseIdx = args.indexOf("--verbose");
		const pIdx = args.indexOf("-p");
		expect(verboseIdx).toBeGreaterThanOrEqual(0);
		expect(verboseIdx).toBeLessThan(pIdx);
		expect(args.indexOf("--debug")).toBeGreaterThanOrEqual(0);
	});

	it("should allow opting out of --force when caller passes force=false", () => {
		const cfg = buildCursorAdapterConfig({ force: false });
		expect(cfg.args ?? []).not.toContain("--force");
	});

	it("should pass through cwd and env", () => {
		const cfg = buildCursorAdapterConfig({
			cwd: "/tmp/work",
			env: { CURSOR_API_KEY: "cur-test" },
		});

		expect(cfg.cwd).toBe("/tmp/work");
		expect(cfg.env).toEqual({ CURSOR_API_KEY: "cur-test" });
	});

	it("should enable stderr capture (for hang detection + audit trail)", () => {
		const cfg = buildCursorAdapterConfig();
		expect(cfg.stderr?.capture).toBe(true);
		expect(cfg.stderr?.asEvents).toBe(false);
	});
});

// ─── Factory ──────────────────────────────────────────────────────

describe("createCursorAdapter", () => {
	it("should return a ProcessAdapter instance", () => {
		const adapter = createCursorAdapter();
		expect(adapter).toBeInstanceOf(ProcessAdapter);
	});

	it("should produce an InnerConfig with model=process:cursor-agent", () => {
		const adapter = createCursorAdapter();
		const cfg = adapter.getConfig();
		expect(cfg.model).toBe("process:cursor-agent");
		expect(cfg.tools).toEqual([]);
	});

	it("should expose no tools (Cursor manages its own internally)", () => {
		const adapter = createCursorAdapter({ model: "sonnet-4" });
		expect(adapter.getTools()).toEqual([]);
	});

	it("should prevent double run (inherits ProcessAdapter contract)", () => {
		const adapter = createCursorAdapter();

		const gen = adapter.run("test prompt");
		void gen;

		expect(() => adapter.run("second prompt")).toThrow("only be run once");

		adapter.abort("cleanup");
	});

	it("should transition to aborted state on abort()", () => {
		const adapter = createCursorAdapter();
		const gen = adapter.run("test");
		void gen;

		adapter.abort("test cleanup");
		expect(adapter.getState().status).toBe("aborted");
	});
});
