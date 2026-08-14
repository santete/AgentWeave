# Model Providers

AgentWeave phân giải model qua `ProviderRegistry` — thay được, mở rộng được, không cần sửa mã lõi.

## Provider dựng sẵn

| Provider | Nhận model nào | Cần gì |
|---|---|---|
| `anthropic` | `claude-*` | `ANTHROPIC_API_KEY` |
| `openai` | `gpt-*`, `o1*`, `o3*`, `o4*` | `OPENAI_API_KEY` |
| `google` | `gemini*` | `GOOGLE_GENERATIVE_AI_API_KEY` |
| `ollama` | khi khai báo rõ | Ollama đang chạy cục bộ |
| `openrouter` | khi khai báo rõ | `OPENROUTER_API_KEY` |

## Quy tắc phân giải

Thứ tự ưu tiên:

1. **Tiền tố tường minh** `provider/model` — luôn thắng
   ```
   ollama/qwen3-coder:30b    → provider ollama, model "qwen3-coder:30b"
   openrouter/meta-llama/llama-3-70b → provider openrouter
   ```
2. **`matches()`** theo `priority` giảm dần — cho tên model quen thuộc (`gpt-4o`, `claude-opus-4`)
3. **Không khớp gì → ném `UnknownProviderError`** kèm danh sách provider đã đăng ký

> ⚠️ Bước 3 là cố ý. Phiên bản trước âm thầm gửi model lạ tới Anthropic — model cục bộ bị đẩy ra internet mà người dùng không biết.

## Dùng model cục bộ (Ollama)

Hai cách:

```bash
# Cách 1: tiền tố tường minh — rõ ràng nhất
AGENT_MODEL="ollama/qwen3-coder:30b"

# Cách 2: đặt provider mặc định, rồi dùng tên model trần
export AGENTWEAVE_DEFAULT_PROVIDER=ollama
AGENT_MODEL="qwen3-coder:30b"
```

Biến môi trường:

| Biến | Mặc định | Ý nghĩa |
|---|---|---|
| `OLLAMA_HOST` | `http://127.0.0.1:11434` | Địa chỉ Ollama |
| `OLLAMA_API_KEY` | `ollama` | Ollama bỏ qua, để cho SDK hài lòng |
| `AGENTWEAVE_DEFAULT_PROVIDER` | *(trống)* | Provider nhận model không tiền tố |

Chạy thử:

```bash
pnpm build
AGENTWEAVE_DEFAULT_PROVIDER=ollama OLLAMA_MODEL=qwen3-coder:30b \
  node examples/agent-loop-ollama.mjs "Đọc package.json và cho biết trường name"
```

## Thêm provider riêng

Không cần sửa mã lõi:

```typescript
import { AgentLoop } from "@agentweave/inner-harness";

const loop = new AgentLoop({ model: "cty/model-noi-bo-v2" });

loop.registerProvider({
  id: "cty",
  description: "Endpoint LLM nội bộ",
  matches: (m) => m.startsWith("cty-"),      // dùng khi không có tiền tố
  async resolve(model) {
    const { createOpenAI } = await import("@ai-sdk/openai");
    const client = createOpenAI({
      baseURL: "https://llm.cty-noi-bo.vn/v1",
      apiKey: process.env.CTY_LLM_KEY,
    });
    return client(model);
  },
});
```

### Ví dụ: Azure OpenAI

```typescript
loop.registerProvider({
  id: "azure",
  matches: () => false,                       // chỉ dùng qua tiền tố "azure/..."
  async resolve(deployment) {
    const { createAzure } = await import("@ai-sdk/azure");
    return createAzure({
      resourceName: process.env.AZURE_RESOURCE_NAME,
      apiKey: process.env.AZURE_API_KEY,
    })(deployment);
  },
});
// dùng: model = "azure/gpt-4o-deployment"
```

Cần cài thêm `@ai-sdk/azure`. Tương tự cho `@ai-sdk/amazon-bedrock`, `@ai-sdk/google-vertex`.

## Chẩn đoán

```typescript
loop.whichProvider();                 // provider nào sẽ xử lý model hiện tại
createDefaultRegistry().whichProvider("gpt-4o");   // → "openai"
```

Hàm này **không gọi mạng** — chỉ cho biết định tuyến, dùng để kiểm tra cấu hình trước khi chạy thật.

## Ghi chú về OpenRouter

Trước đây, chỉ cần đặt `OPENROUTER_API_KEY` là **mọi** model đều bị đẩy qua OpenRouter — kể cả model cục bộ. Hành vi này đã bị loại bỏ.

Giờ OpenRouter chỉ được dùng khi khai báo rõ: tiền tố `openrouter/...` hoặc `AGENTWEAVE_DEFAULT_PROVIDER=openrouter`.
