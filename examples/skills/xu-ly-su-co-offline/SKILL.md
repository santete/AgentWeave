# Xử lý sự cố agent cục bộ (không có mạng)

Nguyên tắc: **bẫy nguy hiểm nhất là bẫy báo xanh trong khi thực tế sai.** Kiểm tra
theo thứ tự dưới đây, đừng đoán.

## 1. Trả lời sai nhưng không báo lỗi

| Triệu chứng | Nguyên nhân thường gặp | Kiểm tra |
|---|---|---|
| Model bịa tên file, hàm không tồn tại | Repo chưa commit → repo-map rỗng | `git ls-files \| wc -l` phải > 0 |
| Agent "quên" file vừa đọc | Nhiều model cùng nằm RAM → context bị cắt âm thầm | `curl -s localhost:11434/api/ps` xem `context_length` |
| Skill không được áp dụng | Chỉ mục không vào system prompt | Xác nhận prompt có mục `[skills]` |

## 2. Báo lỗi rõ ràng

| Lỗi | Nguyên nhân | Xử lý |
|---|---|---|
| `ECONNREFUSED :8080` | Cấu hình cũ trỏ llama.cpp đã tắt | Đổi sang `:11434` |
| `HTTP 400: does not support thinking` | Model không hỗ trợ thinking | Đặt `reasoning_effort: none` |
| `bwrap: Can't find source path /lib64` | Hướng dẫn viết cho x86, máy này là aarch64 | Dùng `--ro-bind-try` |
| `bwrap: Can't chdir` | `--tmpfs /tmp` gắn SAU `--bind workspace` | tmpfs phải đứng TRƯỚC bind |

## 3. Chậm bất thường

Kiểm tra theo thứ tự tác động giảm dần:

1. **KV cache** — `OLLAMA_KV_CACHE_TYPE` phải là `f16`. Đặt `q8_0` mất tới 45% tốc độ ở context dài.
2. **Xung CPU** — `jetson-clocks.service` mất tác dụng sau reboot nếu chưa enable. Ảnh hưởng ~9%.
3. **Kiến trúc model** — model dense chậm hơn MoE khoảng 7 lần ở cùng cỡ tham số. Xem skill `chon-model`.
4. **Độ dài context** — context 16K làm tốc độ sinh giảm 34%. Đây là vật lý, không sửa được bằng cấu hình.

## 4. Điều KHÔNG nên làm

- Đừng dùng `ss -tnp` để kết luận có rò rỉ mạng: nó liệt kê socket cũ, không phải kết nối sống. Phải thăm dò chủ động.
- Đừng parse bảng `ollama ps` bằng cột: số hex trong model ID dễ bị lấy nhầm. Dùng `/api/ps`.
- Đừng viết `A && ok || no` trong bash kiểm tra: khi `ok` trả mã khác 0 thì in cả hai dòng mâu thuẫn.
