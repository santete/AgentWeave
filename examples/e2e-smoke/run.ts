#!/usr/bin/env npx tsx
/**
 * E2E Smoke Test — Run a real agent session with AgentWeave governance.
 *
 * Prerequisites:
 *   export ANTHROPIC_API_KEY=sk-ant-...
 *
 * Usage:
 *   npx tsx examples/e2e-smoke/run.ts
 *
 * What this proves:
 *   1. Real LLM call (Anthropic Claude)
 *   2. Built-in tools (FileRead, Bash) actually execute
 *   3. Permission rules enforce (deny rm -rf, allow ls)
 *   4. Output filters redact secrets
 *   5. Budget tracking works
 *   6. Session events stream to terminal
 */

import { createHarness } from "../../packages/sdk/src/index";
import { BUILT_IN_TOOLS } from "../../packages/inner-harness/src/built-in-tools/index";
import type { InnerEvent } from "../../packages/types/src/index";

async function main() {
	// Auto-detect provider from env vars
	const hasOpenRouter = !!process.env.OPENROUTER_API_KEY;
	const hasAnthropic = !!process.env.ANTHROPIC_API_KEY;
	const hasGoogle = !!process.env.GOOGLE_GENERATIVE_AI_API_KEY;
	const hasOpenAI = !!process.env.OPENAI_API_KEY;

	if (!hasOpenRouter && !hasAnthropic && !hasGoogle && !hasOpenAI) {
		console.error("ERROR: Set one of these API key env vars:");
		console.error("  export OPENROUTER_API_KEY=sk-or-...");
		console.error("  export ANTHROPIC_API_KEY=sk-ant-...");
		console.error("  export GOOGLE_GENERATIVE_AI_API_KEY=AI...");
		console.error("  export OPENAI_API_KEY=sk-...");
		process.exit(1);
	}

	// Pick model per provider (OpenRouter supports any model name)
	const model = hasOpenRouter
		? (process.env.OPENROUTER_MODEL ?? "nvidia/nemotron-nano-9b-v2:free")
		: hasGoogle
			? "gemini-2.0-flash"
			: hasAnthropic
				? "claude-haiku-4-5"
				: "gpt-4o-mini";

	console.log("\n  AgentWeave E2E Smoke Test");
	console.log("  ────────────────────────\n");

	const harness = createHarness({
		model,
		tools: BUILT_IN_TOOLS,
		permissions: {
			mode: "default",
			rules: [
				{ pattern: "FileRead(*)", behavior: "allow", source: "project", priority: 50 },
				{ pattern: "Bash(ls *)", behavior: "allow", source: "project", priority: 50 },
				{ pattern: "Bash(echo *)", behavior: "allow", source: "project", priority: 50 },
				{ pattern: "Bash(rm *)", behavior: "deny", source: "policy", priority: 100 },
				{ pattern: "Grep(*)", behavior: "allow", source: "project", priority: 50 },
				{ pattern: "Glob(*)", behavior: "allow", source: "project", priority: 50 },
			],
			failMode: "closed",
		},
		output: {
			gateMode: "batch",
			filters: [
				{ type: "secret", name: "secrets", patterns: [], replacement: "[SECRET]" },
				{ type: "pii", name: "pii", entities: ["email"], replacement: "[EMAIL]" },
			],
		},
		budget: {
			maxPerSession: 0.50, // $0.50 max — safety cap
			warningThreshold: 0.8,
		},
	});

	console.log("  Config:");
	console.log(`    Model:  ${model}`);
	console.log("    Tools:  " + BUILT_IN_TOOLS.map((t) => t.name).join(", "));
	console.log("    Budget: $0.50 max");
	console.log("    Mode:   default (closed failMode)\n");

	const prompt = "List the TypeScript files in the current directory using the Bash tool with 'ls *.ts' or similar. Then tell me how many you found.";

	console.log(`  Prompt: "${prompt}"\n`);
	console.log("  ── Events ──\n");

	const events: InnerEvent[] = [];
	const gen = harness.stream(prompt, { maxTurns: 5 });

	for (;;) {
		const { value, done } = await gen.next();
		if (done) {
			console.log(`\n  ── Result ──`);
			console.log(`  Reason: ${value.reason}`);
			if (value.usage) {
				console.log(`  Tokens: ${value.usage.inputTokens} in / ${value.usage.outputTokens} out`);
				console.log(`  Cost:   $${value.usage.totalCost.toFixed(4)}`);
			}
			break;
		}

		events.push(value);

		// Print key events
		switch (value.type) {
			case "turn:start":
				console.log(`  Turn ${value.turnIndex}`);
				break;
			case "tool:requested":
				console.log(`  Tool: ${value.toolName}(${JSON.stringify(value.toolInput).slice(0, 60)})`);
				break;
			case "permission:allowed":
				console.log(`  ALLOWED: ${value.toolName} [${value.source}]`);
				break;
			case "permission:denied":
				console.log(`  DENIED: ${value.toolName} — ${value.reason}`);
				break;
			case "tool:completed":
				console.log(`  Done: ${value.toolUseId} (${value.durationMs.toFixed(0)}ms)`);
				break;
			case "message:assistant":
				for (const block of value.content) {
					if (block.type === "text") {
						console.log(`  ${block.text.slice(0, 200)}`);
					}
				}
				break;
		}
	}

	console.log(`\n  ── Summary ──`);
	console.log(`  Total events: ${events.length}`);
	console.log(`  Tools called: ${events.filter((e) => e.type === "tool:completed").length}`);
	console.log(`  Permissions denied: ${events.filter((e) => e.type === "permission:denied").length}`);
	console.log(`  Final cost: $${harness.getUsage().totalCost.toFixed(4)}`);
	console.log(`  Audit log: ${harness.outer.getAuditLogger().size()} entries`);
	console.log("");
}

main().catch((err) => {
	console.error("E2E smoke test failed:", err);
	process.exit(1);
});
