import { describe, it, expect } from "vitest";
import { z } from "zod";
import type { InnerEvent, ToolDefinition } from "@agentweave/types";
import { AgentLoop } from "../src/agent-loop";

it("cong kiem chung co no khong", async () => {
	const loop = new AgentLoop({
		model: "mock", maxTurns: 6,
		laLenhKiemTra: (c) => /--test|npm test/.test(c),
	});
	loop.registerTool({
		name: "FileWrite", description: "d",
		parameters: z.object({ path: z.string(), content: z.string() }),
		execute: async () => "Written 100 bytes",
		metadata: { isReadOnly:false, isDestructive:false, isConcurrencySafe:false, category:"file" },
	} as ToolDefinition);
	let n = 0;
	loop.setLLMCaller(async () => {
		n++;
		if (n === 1) return { stopReason:"tool_use", toolCalls:[{ toolUseId:"t1", toolName:"FileWrite", toolInput:{ path:"a.js", content:"x" } }] };
		return { text: "Da tao file a.js. Can tao them test.", stopReason:"end_turn" };
	});
	const ev: InnerEvent[] = [];
	for await (const e of loop.run("lam di")) ev.push(e);
	const cong = ev.filter(e => e.type === "recovery:retry" && /chua kiem chung/.test(String((e as {reason?:string}).reason)));
	console.log("So lan cong no:", cong.length);
	console.log("Ly do:", cong.map(c => (c as {reason?:string}).reason).join(" | "));
	console.log("So lan goi LLM:", n);
	expect(cong.length).toBeGreaterThan(0);
});
