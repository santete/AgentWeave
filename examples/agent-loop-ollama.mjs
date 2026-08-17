/**
 * Demo: chạy AgentLoop THẬT của AgentWeave với model cục bộ qua Ollama.
 *
 * Khác với examples/ollama-demo.mjs (chỉ dùng OllamaAdapter đứng riêng),
 * demo này chạy toàn bộ vòng lặp agent: gọi LLM → tool call → thực thi → lặp.
 *
 * Chạy:
 *   AGENTWEAVE_DEFAULT_PROVIDER=ollama node examples/agent-loop-ollama.mjs
 */
import { AgentLoop, createDefaultRegistry } from "../packages/inner-harness/dist/index.js";
import { FileReadTool, GlobTool, GrepTool } from "../packages/inner-harness/dist/index.js";

const MODEL = process.env.OLLAMA_MODEL || "qwen3-coder:30b";
process.env.AGENTWEAVE_DEFAULT_PROVIDER ??= "ollama";

// Chẩn đoán: provider nào sẽ xử lý model này?
const reg = createDefaultRegistry();
console.log(`model:    ${MODEL}`);
console.log(`provider: ${reg.whichProvider(MODEL)}`);
console.log(`endpoint: ${process.env.OLLAMA_HOST ?? "http://127.0.0.1:11434"}`);
console.log("─".repeat(64));

const loop = new AgentLoop({
	model: MODEL,
	maxTurns: 5,
	systemPrompt: "Bạn là trợ lý lập trình. Trả lời ngắn gọn bằng tiếng Việt.",
	tools: [FileReadTool, GlobTool, GrepTool],
});

const prompt = process.argv[2] || "Nói ngắn gọn: 2+2 bằng mấy?";
const t0 = Date.now();
let turns = 0;

const gen = loop.run(prompt, { maxTurns: 5 });
for (;;) {
	const { value, done } = await gen.next();
	if (done) {
		console.log("─".repeat(64));
		console.log(`kết thúc: ${value.reason}`);
		console.log(`token:    in=${value.usage?.inputTokens ?? 0} out=${value.usage?.outputTokens ?? 0}`);
		break;
	}
	if (value.type === "turn:start") turns++;
	if (value.type === "message:assistant") {
		const t = value.content?.map((c) => c.text).join("") ?? "";
		if (t.trim()) console.log(`[trả lời] ${t.trim().slice(0, 300)}`);
	}
	if (value.type === "tool:start") console.log(`[tool] gọi ${value.toolName}`);
	if (value.type === "error") console.log(`[lỗi] ${JSON.stringify(value).slice(0, 200)}`);
}

console.log(`số lượt:  ${turns} | ${((Date.now() - t0) / 1000).toFixed(1)}s`);
