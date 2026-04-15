import { describe, it, expect } from "vitest";

describe("CLI bin", () => {
	it("should export as ESM module", async () => {
		// Smoke test: verify the module can be imported without errors
		// We don't run the full CLI here (it calls process.exit)
		// but we verify the run command module is importable
		const mod = await import("../src/commands/run.js");
		expect(mod.runCommand).toBeDefined();
		expect(typeof mod.runCommand).toBe("function");
	});
});
