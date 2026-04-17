import { describe, it, expect } from "vitest";
import { PermissionEngine } from "../src/governance/permission-engine";
import { OutputPipeline } from "../src/governance/output-pipeline";

describe("Performance: PermissionEngine", () => {
	it("evaluate with 10 rules should be < 3ms p99", async () => {
		const engine = new PermissionEngine({
			mode: "default",
			rules: Array.from({ length: 10 }, (_, i) => ({
				pattern: `Tool${i}(*)`,
				behavior: i % 2 === 0 ? "allow" as const : "deny" as const,
				source: "project" as const,
				priority: i * 10,
			})),
			failMode: "closed",
			timeoutMs: 5000,
			askTimeoutMs: 60000,
		});

		const request = {
			toolName: "Tool5",
			toolInput: { arg: "value" },
			toolUseId: "tu_bench",
			turnIndex: 1,
			isReadOnly: false,
			isDestructive: false,
		};

		const times: number[] = [];
		for (let i = 0; i < 1000; i++) {
			const start = performance.now();
			await engine.evaluate(request);
			times.push(performance.now() - start);
		}

		times.sort((a, b) => a - b);
		const p99 = times[Math.floor(times.length * 0.99)]!;
		console.log(`  PermissionEngine.evaluate (10 rules) p99: ${p99.toFixed(3)}ms`);
		expect(p99).toBeLessThan(3);
	});
});

describe("Performance: OutputPipeline", () => {
	it("applyFilters on 1KB text should be < 3ms p99", () => {
		const pipeline = new OutputPipeline({
			gateMode: "auto",
			filters: [
				{ type: "secret", name: "secrets", patterns: ["sk-[a-zA-Z0-9]{20,}"], replacement: "[SECRET]" },
				{ type: "pii", name: "pii", entities: ["email", "phone"], replacement: "[PII]" },
			],
		});

		const text = "Here is the key sk-abcdefghijklmnopqrstuvwxyz1234 and email test@example.com. ".repeat(10);

		const times: number[] = [];
		for (let i = 0; i < 1000; i++) {
			const start = performance.now();
			pipeline.applyFilters(text);
			times.push(performance.now() - start);
		}

		times.sort((a, b) => a - b);
		const p99 = times[Math.floor(times.length * 0.99)]!;
		console.log(`  OutputPipeline.applyFilters (1KB) p99: ${p99.toFixed(3)}ms`);
		expect(p99).toBeLessThan(3);
	});
});
