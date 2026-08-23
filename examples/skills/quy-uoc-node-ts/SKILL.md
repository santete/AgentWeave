# Quy ước Node.js / TypeScript

> **Đây là bộ mặc định hợp lý theo chuẩn ngành, không phải khung rỗng.** Dùng được
> gần như ngay; rà lại và chỉnh cho khớp công ty trước khi bàn giao. Skill sai còn
> tệ hơn không có. Giữ tệp dưới 200 dòng — model 30B dễ bỏ qua phần giữa nếu dài.

## 1. Bố cục dự án

- Mã nguồn trong `src/`, biên dịch ra `dist/` (không sửa tay `dist/`).
- Một module một trách nhiệm. Xuất qua `index.ts` của thư mục, không import xuyên sâu.
- Cùng một hệ module trong toàn dự án (ESM hoặc CJS) — không trộn.

## 2. Đặt tên

- Biến, hàm: `camelCase`. Kiểu, interface, class, enum: `PascalCase`. Hằng cấp module: `UPPER_SNAKE_CASE`.
- Tên file `kebab-case.ts`. Không tiền tố `I` cho interface.

## 3. Bắt buộc

- `tsconfig` bật `strict: true`. Sửa lỗi kiểu, KHÔNG dập bằng `any` hay `as`.
- Kiểu chưa biết dùng `unknown` rồi thu hẹp, không dùng `any`.
- `await` mọi Promise, hoặc xử lý tường minh — không để promise trôi nổi.
- Log bằng logger của dự án (pino/winston…) có cấu trúc, không nội suy chuỗi tùy tiện.
- Mỗi hành vi public có test (vitest/jest). Sửa bug thì thêm test tái hiện trước.
- Dùng `const` mặc định; `let` chỉ khi thật sự gán lại. Không `var`.

## 4. Cấm

- `any` và `@ts-ignore` không kèm lý do. Nếu buộc phải bỏ qua, dùng `@ts-expect-error` + chú thích.
- Promise trôi nổi (gọi hàm async mà không `await`/`.catch`) — nuốt lỗi âm thầm.
- `require()` trong file ESM; `import` động chỉ khi cần tách bó.
- `console.log` trong mã chạy thật — dùng logger. `console` chỉ cho script/CLI.
- `==` / `!=` — luôn dùng `===` / `!==`.
- Ép non-null bằng `!` để cho qua trình biên dịch — kiểm tra thật hoặc thu hẹp kiểu.

## 5. Xử lý lỗi

- Ném `Error` (hoặc lớp con của nó), KHÔNG ném chuỗi hay object trần.
- `catch (e)` thì `e` là `unknown` — thu hẹp trước khi đọc `.message`.
- Không dùng exception cho luồng bình thường kiểm được bằng điều kiện.

## 6. Lệnh kiểm tra

```bash
npm run build        # hoặc: tsc --noEmit để chỉ kiểm kiểu
npm test
npm run lint         # eslint hoặc biome, tùy dự án
```

- Định dạng do công cụ lo (prettier/biome), KHÔNG chỉnh tay.

## Khi chỉnh sửa skill này

- Chỉ viết thứ **không suy ra được từ code**: quy ước ngầm, ràng buộc nghiệp vụ, lý do.
- Viết dạng **mệnh lệnh**, điều kiện đặt **trước** hành động.
