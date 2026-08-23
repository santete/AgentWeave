# Quy ước .NET / C#

> **Đây là bộ mặc định hợp lý theo chuẩn ngành, không phải khung rỗng.** Dùng được
> gần như ngay; rà lại và chỉnh cho khớp công ty trước khi bàn giao. Skill sai còn
> tệ hơn không có: model tuân theo mà không nghi ngờ, và trong khu cô lập không ai
> tra cứu lại được. Giữ tệp dưới 200 dòng — model 30B dễ bỏ qua phần giữa nếu dài.

## 1. Bố cục dự án

- Chia bốn tầng, phụ thuộc chỉ đi vào trong: `Api` → `Application` → `Domain` ← `Infrastructure`.
- `Domain` KHÔNG tham chiếu tầng nào khác: không EF, không HTTP, không framework.
- Một dự án test cho mỗi dự án mã: `Xxx` ↔ `Xxx.Tests`.

## 2. Đặt tên

- Kiểu, method, property, hằng: `PascalCase`. Biến cục bộ, tham số: `camelCase`.
- Interface có tiền tố `I` (`IOrderRepository`). Method bất đồng bộ có hậu tố `Async`.
- Trường private: `_camelCase`. Không viết tắt trừ khi đã phổ biến (`id`, `db`).

## 3. Bắt buộc

- Bật `<Nullable>enable</Nullable>`. Không tắt cảnh báo nullable bằng `!` để cho qua.
- Truyền `CancellationToken` xuyên suốt mọi method async I/O, và tôn trọng nó.
- Log bằng `ILogger` có cấu trúc: `logger.LogInformation("Đã tạo đơn {OrderId}", id)` —
  KHÔNG nội suy chuỗi vào thông điệp log.
- `DateTimeOffset.UtcNow` cho thời điểm; nếu cần test thì tiêm `TimeProvider`/clock.
- Mỗi hành vi public phải có test. Sửa bug thì thêm test tái hiện bug trước.
- Thư viện (không phải app): `.ConfigureAwait(false)` trên await.

## 4. Cấm

- `async void` — trừ event handler. Nuốt exception và không await được.
- `.Result`, `.Wait()`, `.GetAwaiter().GetResult()` trên code async → nguy cơ deadlock.
- `catch (Exception)` rồi bỏ trống hoặc chỉ log. Bắt loại cụ thể, hoặc để nó nổi lên.
- `DateTime.Now` (phụ thuộc múi giờ máy). Dùng `DateTimeOffset.UtcNow`.
- Trả `null` cho tập hợp — trả rỗng. Public API nhận vào thì kiểm null tường minh.

## 5. Xử lý lỗi

- Ném exception cụ thể (`ArgumentException`, `InvalidOperationException`, hoặc loại
  của miền). KHÔNG ném `Exception` trần.
- Không dùng exception cho luồng điều khiển thông thường — dùng kiểu trả về.
- Validate đầu vào ở biên (controller/handler), không để lỗi lan vào Domain.

## 6. Lệnh kiểm tra

```bash
dotnet build -warnaserror   # cảnh báo = lỗi, để không tích nợ âm thầm
dotnet test
dotnet format --verify-no-changes   # định dạng thống nhất
```

## Khi chỉnh sửa skill này

- Chỉ viết thứ **không suy ra được từ code**: quy ước ngầm, ràng buộc nghiệp vụ, lý do.
- Viết dạng **mệnh lệnh** ("Dùng X"), không kể chuyện ("Chúng tôi hay dùng X").
- Điều kiện đặt **trước** hành động: "Với thư viện, thêm ConfigureAwait" — model 30B
  bám vế đầu câu, vế nhượng bộ đứng sau dễ bị bỏ.
