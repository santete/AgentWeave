# Quy ước Java / Spring Boot

> **Đây là bộ mặc định hợp lý theo chuẩn ngành, không phải khung rỗng.** Dùng được
> gần như ngay; rà lại và chỉnh cho khớp công ty trước khi bàn giao. Skill sai còn
> tệ hơn không có. Giữ tệp dưới 200 dòng — model 30B dễ bỏ qua phần giữa nếu dài.

## 1. Bố cục dự án

- Chia theo tính năng, mỗi tính năng đủ ba tầng: `controller` → `service` → `repository`.
- `controller` chỉ nhận/trả DTO. KHÔNG để entity JPA lọt ra khỏi tầng service.
- Logic nghiệp vụ ở `service`, không nhét vào controller hay repository.

## 2. Tiêm phụ thuộc

- Tiêm qua **constructor**, trường `final`. KHÔNG `@Autowired` trên trường.
  Constructor injection làm phụ thuộc rõ ràng và test được không cần Spring.
- Một constructor thì bỏ luôn `@Autowired` (Spring tự hiểu).

## 3. Đặt tên

- Lớp: `PascalCase`. Method, biến: `camelCase`. Hằng: `UPPER_SNAKE_CASE`.
- Interface KHÔNG tiền tố `I`; nếu có một cài đặt thì đặt tên `XxxImpl` hoặc theo vai trò.
- Gói theo tính năng (`order`, `payment`), không theo tầng (`controllers`, `services`).

## 4. Bắt buộc

- `@Transactional` đặt ở tầng **service**, trên method public. Đọc thuần: `readOnly = true`.
- Validate đầu vào bằng `@Valid` + annotation ràng buộc trên DTO, ngay ở controller.
- Log bằng SLF4J có tham số: `log.info("Đã tạo đơn {}", orderId)` — KHÔNG nối chuỗi.
- Mỗi service có test; test tầng web dùng `@WebMvcTest`, không nạp cả context nếu không cần.
- Trả mã HTTP đúng ngữ nghĩa (201 tạo mới, 404 không thấy), không phải 200 cho mọi thứ.

## 5. Cấm

- Field injection (`@Autowired` trên trường) — khó test, giấu phụ thuộc.
- `@Transactional` trên method private, controller, hoặc gọi nội bộ trong cùng lớp
  (proxy của Spring không chặn được → giao dịch không có hiệu lực, âm thầm).
- `catch (Exception e)` rồi nuốt. Bắt loại cụ thể hoặc để `@ControllerAdvice` xử lý.
- `System.out.println` / `printStackTrace()` — dùng logger.
- Trả `null` cho danh sách — trả `List.of()`. Với giá trị có thể vắng, dùng `Optional`.

## 6. Xử lý lỗi

- Một `@RestControllerAdvice` gom xử lý exception → body lỗi thống nhất.
- Ném exception của miền (`OrderNotFoundException`), không ném `RuntimeException` trần.
- Không dùng exception cho luồng bình thường.

## 7. Lệnh kiểm tra

```bash
./mvnw test        # hoặc ./gradlew test
./mvnw verify      # gồm cả kiểm tra tích hợp nếu có
# Nếu dự án dùng spotless/checkstyle:
./mvnw spotless:check
```

## Khi chỉnh sửa skill này

- Chỉ viết thứ **không suy ra được từ code**: quy ước ngầm, ràng buộc nghiệp vụ, lý do.
- Viết dạng **mệnh lệnh**, điều kiện đặt **trước** hành động.
