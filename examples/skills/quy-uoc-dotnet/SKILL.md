# Quy ước .NET — KHUNG MẪU

> ⚠️ **Đây là khung mẫu, chưa phải quy ước thật.** Điền quy ước thật của công ty
> trước khi đóng gói bàn giao. Skill sai còn tệ hơn không có skill: model sẽ tuân
> theo mà không nghi ngờ, và trong khu bảo mật không ai tra cứu lại được.

Giữ tệp này dưới 200 dòng. Model 30B tuân thủ chỉ thị kém hơn model biên giới —
skill dài dễ bị bỏ qua từ giữa chừng.

## 1. Bố cục dự án

- (điền: đặt project ở đâu, chia layer thế nào)

## 2. Đặt tên

- (điền: quy ước namespace, tên interface, tên async method)

## 3. Bắt buộc

- (điền: những thứ review sẽ chặn nếu thiếu — vd: có test, có log, không dùng `async void`)

## 4. Cấm

- (điền: những thứ tuyệt đối không được dùng trong dự án này)

## 5. Lệnh hay dùng

```bash
dotnet build
dotnet test
```

## Cách viết một skill tốt

1. **Chỉ viết thứ không suy ra được từ code.** Quy ước ngầm, ràng buộc nghiệp vụ, lý do lịch sử.
2. **Viết dạng mệnh lệnh**, không kể chuyện: "Dùng X" thay vì "Chúng tôi thường dùng X".
3. **Một skill một việc.** Trùng lặp giữa các skill làm model nạp thừa.
4. **`whenToUse` dưới 100 byte.** Trường này nằm thường trực trong system prompt của mọi phiên.
