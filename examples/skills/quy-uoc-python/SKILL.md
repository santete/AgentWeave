# Quy ước Python

> **Đây là bộ mặc định hợp lý theo chuẩn ngành, không phải khung rỗng.** Dùng được
> gần như ngay; rà lại và chỉnh cho khớp công ty trước khi bàn giao. Skill sai còn
> tệ hơn không có. Giữ tệp dưới 200 dòng — model 30B dễ bỏ qua phần giữa nếu dài.

## 1. Bố cục dự án

- Mã nguồn trong `src/<tên_gói>/`, test trong `tests/` song song.
- Một module một trách nhiệm. Không gom mọi thứ vào `utils.py` khổng lồ.
- Import tuyệt đối trong nội bộ gói (`from myapp.orders import ...`), không import tương đối sâu.

## 2. Đặt tên (PEP 8)

- Hàm, biến, module: `snake_case`. Lớp: `PascalCase`. Hằng: `UPPER_SNAKE_CASE`.
- Riêng tư trong module: một gạch dưới đầu (`_helper`). Không viết tắt khó hiểu.

## 3. Bắt buộc

- **Type hint** trên mọi hàm public (tham số + giá trị trả). Chạy `mypy` sạch.
- Docstring ngắn cho hàm/lớp public: nói *làm gì*, không lặp lại tên.
- Test bằng `pytest`. Sửa bug thì thêm test tái hiện trước khi sửa.
- Quản lý phụ thuộc và phiên bản ghim trong `pyproject.toml` (hoặc chuẩn của dự án).
- Đường dẫn dùng `pathlib.Path`, không nối chuỗi thủ công.

## 4. Cấm

- `except:` trần hoặc `except Exception:` rồi `pass`. Bắt loại cụ thể, xử lý hoặc ném lại.
- Tham số mặc định là đối tượng khả biến (`def f(x=[])`) — dùng `None` rồi khởi tạo trong thân.
- `print()` để ghi log — dùng module `logging`. `print` chỉ cho CLI xuất ra người dùng.
- `from module import *` — làm bẩn không gian tên, che tên bị ghi đè.
- So sánh với `None`/`True`/`False` bằng `==`; dùng `is`.

## 5. Xử lý lỗi

- Ném exception cụ thể của miền (`OrderNotFoundError`), không `Exception` trần.
- Không dùng exception cho luồng bình thường có thể kiểm bằng điều kiện.
- Dọn tài nguyên bằng `with` (context manager), không `try/finally` thủ công khi có thể.

## 6. Định dạng và lệnh kiểm tra

```bash
ruff check .        # lint
ruff format .       # định dạng (hoặc black nếu dự án dùng black)
mypy src            # kiểm kiểu tĩnh
pytest              # test
```

- Định dạng do công cụ lo, KHÔNG chỉnh tay khoảng trắng để "cho đẹp".

## Khi chỉnh sửa skill này

- Chỉ viết thứ **không suy ra được từ code**: quy ước ngầm, ràng buộc nghiệp vụ, lý do.
- Viết dạng **mệnh lệnh**, điều kiện đặt **trước** hành động.
