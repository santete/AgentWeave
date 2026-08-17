# Chọn model cho từng loại việc

Số liệu đo trên Jetson AGX Thor · 128 GB unified · băng thông ~273 GB/s ·
Ollama ctx 65536 · KV cache f16 · xung CPU đã khoá.

| Model | Kiến trúc | Đĩa | RAM | tok/s (ctx nhỏ) | tok/s (ctx 16k) |
|---|---|---|---|---|---|
| `qwen3-coder:30b` | MoE | 18 GB | 25 GB | 63,8 | 41,8 |
| `qwen3.6:35b` | MoE | 23 GB | 24 GB | 56,8 | 50,5 |
| `qwen2.5:7b` | dense | 4,7 GB | ~6 GB | — | — |
| `qwen2.5-coder:32b` | dense | 19 GB | 28 GB | 9,0 | 7,6 |

## Chọn thế nào

- **Mặc định, viết code:** `qwen3-coder:30b` — nhanh nhất ở context ngắn.
- **Việc cần cẩn thận, context dài:** `qwen3.6:35b` — giảm tốc ít nhất khi context đầy (50,5 tok/s ở 16k).
- **Việc cơ học** (đổi tên, sinh boilerplate): `qwen2.5:7b`.
- **Đừng dùng model dense cỡ lớn.** `qwen2.5-coder:32b` chậm hơn `qwen3-coder:30b` khoảng 7 lần dù dung lượng file gần bằng nhau.

## Ba điều dễ hiểu sai

1. **Dung lượng file không dự đoán được tốc độ.** Tốc độ do số tham số *active* quyết định, không phải tổng tham số.
2. **Đổi model không miễn phí.** `OLLAMA_MAX_LOADED_MODELS=1`, nên nạp model mới sẽ đẩy model cũ ra khỏi RAM.
3. **Nhồi thêm vào context luôn có giá.** Context đầy làm tốc độ giảm 34%. Nạp skill khi cần, đừng nạp sẵn.
