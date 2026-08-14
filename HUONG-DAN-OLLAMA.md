# Hướng dẫn dùng OllamaAdapter

Adapter cho phép AgentWeave điều khiển model chạy cục bộ qua Ollama.

## 1. Chuẩn bị

```bash
cd /home/jwipc/Documents/Agent-Locally-Tu-Chu/AgentWeave-goc
export PATH="/home/jwipc/.local/share/pi-node/node-v22.23.2-linux-arm64/bin:$PATH"
pnpm build
```

Kiểm tra Ollama đang chạy:

```bash
systemctl is-active ollama && ollama list
```

## 2. Chạy thử ngay

```bash
node examples/ollama-demo.mjs "Viết hàm Python tính giai thừa. Chỉ code."
```

Đổi model hoặc endpoint bằng biến môi trường:

```bash
OLLAMA_MODEL=qwen3-coder:30b node examples/ollama-demo.mjs "Giải thích async/await trong 3 câu"
```

## 3. Dùng trong mã của bạn

```javascript
import { OllamaAdapter } from "@agentweave/adapters";

const adapter = new OllamaAdapter({
  model: "qwen2.5:7b",                    // bắt buộc
  endpoint: "http://127.0.0.1:11434",     // tuỳ chọn, đây là mặc định
  timeoutMs: 30000,                       // tuỳ chọn
  headers: {},                            // tuỳ chọn
});

const gen = adapter.run("câu hỏi của bạn");
for (;;) {
  const { value, done } = await gen.next();
  if (done) { console.log("xong:", value.reason); break; }
  if (value.type === "message:assistant") {
    process.stdout.write(value.content.map(c => c.text).join(""));
  }
}
```

### Các loại sự kiện

| `value.type` | Ý nghĩa |
|---|---|
| `turn:start` | Bắt đầu lượt |
| `message:assistant` | Một mẩu nội dung trả về (streaming) |

Giá trị trả về khi `done` là `TerminalResult`: `{ reason: "completed" \| ..., usage: {...} }`

### Các phương thức khác

```javascript
adapter.getState()      // { status, turnIndex, model, messageCount, ... }
adapter.getMessages()   // toàn bộ message đã nhận
adapter.getConfig()     // cấu hình hiện tại
adapter.setModel("qwen3-coder:30b")   // đổi model (trước khi run)
adapter.abort()         // dừng
```

## 4. ⚠️ Ba hạn chế cần biết

### 4.1 Một instance chỉ chạy được MỘT lần

```javascript
const a = new OllamaAdapter({ model: "qwen2.5:7b" });
await collect(a.run("câu 1"));
await collect(a.run("câu 2"));   // ❌ Error: can only be run once per instance
```

Muốn hỏi tiếp phải tạo instance mới:

```javascript
for (const q of ["câu 1", "câu 2"]) {
  const a = new OllamaAdapter({ model: "qwen2.5:7b" });
  await collect(a.run(q));
}
```

Đây **không phải lỗi** — nó khớp với vòng đời của `InnerHarnessProvider` trong AgentWeave (mỗi phiên một provider). Nhưng nếu dùng trực tiếp thì dễ vấp.

### 4.2 Không đếm token

`usage` luôn trả về toàn số 0:

```json
{"reason":"completed","usage":{"inputTokens":0,"outputTokens":0,...}}
```

Ollama **có** trả về `prompt_eval_count` và `eval_count` trong response, nhưng adapter chưa đọc. Nếu bạn cần theo dõi chi phí/định mức token thì phải bổ sung — đây là chỗ đáng làm tiếp đầu tiên.

### 4.3 Chưa hỗ trợ tool-calling

`registerTool()`, `unregisterTool()`, `injectMessage()`, `setSystemPromptSection()` đều là hàm rỗng, không làm gì. Adapter chỉ sinh văn bản, chưa gọi được công cụ.

Với agentic coding (agent tự đọc/ghi file) thì đây là hạn chế lớn — cần bổ sung trước khi dùng thật.

## 5. Chạy test

```bash
pnpm test --filter @agentweave/adapters
```

## 6. Nếu muốn hoàn tác

Ba file đã thay đổi:

```
M  packages/adapters/src/index.ts
+  packages/adapters/src/ollama-adapter.ts
+  packages/adapters/__tests__/ollama-adapter.test.ts
+  examples/ollama-demo.mjs
+  HUONG-DAN-OLLAMA.md
```

```bash
git checkout -- packages/adapters/src/index.ts
rm packages/adapters/src/ollama-adapter.ts packages/adapters/__tests__/ollama-adapter.test.ts
```
