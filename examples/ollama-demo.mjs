/**
 * Demo dùng OllamaAdapter của AgentWeave với model chạy cục bộ.
 *
 * Chạy:  node examples/ollama-demo.mjs "câu hỏi của bạn"
 * Yêu cầu: đã chạy `pnpm build` trước đó.
 */
import { OllamaAdapter } from "../packages/adapters/dist/index.js";

const prompt = process.argv[2] || "Viết hàm JavaScript đảo ngược chuỗi. Chỉ code.";
const MODEL = process.env.OLLAMA_MODEL || "qwen2.5:7b";
const ENDPOINT = process.env.OLLAMA_ENDPOINT || "http://127.0.0.1:11434";

console.log(`model:    ${MODEL}`);
console.log(`endpoint: ${ENDPOINT}`);
console.log(`prompt:   ${prompt}\n${"─".repeat(60)}`);

// LƯU Ý: mỗi instance chỉ chạy được MỘT lần. Muốn hỏi tiếp phải tạo instance mới.
const adapter = new OllamaAdapter({ model: MODEL, endpoint: ENDPOINT });

const t0 = Date.now();
let text = "";
let events = 0;

const gen = adapter.run(prompt);
for (;;) {
  const { value, done } = await gen.next();
  if (done) {
    console.log(`\n${"─".repeat(60)}`);
    console.log(`kết thúc: ${JSON.stringify(value)}`);
    break;
  }
  events++;
  if (value.type === "message:assistant") {
    const chunk = value.content?.map((c) => c.text).join("") ?? "";
    text += chunk;
    process.stdout.write(chunk);
  }
}

const secs = (Date.now() - t0) / 1000;
console.log(`\nsố event: ${events} | ${secs.toFixed(1)}s | ${text.length} ký tự`);
console.log(`trạng thái cuối: ${adapter.getState().status}`);
console.log(`số message: ${adapter.getMessages().length}`);
