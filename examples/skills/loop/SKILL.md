# Lặp một việc theo chu kỳ

Kỹ năng này **không có mã**. Toàn bộ luật phân tích nằm ở đây dưới dạng chữ, để
bạn đọc và làm theo. Đó là chủ ý: một bộ phân tích viết bằng mã sẽ vỡ ở mọi cách
diễn đạt nó chưa lường trước, còn bạn thì đọc được cả những cách chưa từng gặp.

## 1. Tách khoảng thời gian ra khỏi yêu cầu

Xét theo đúng thứ tự sau, dừng ở luật đầu tiên khớp:

1. **Token đầu tiên khớp `^\d+[smhd]$`** → đó là khoảng.
   `5m chạy test` → khoảng `5m`, việc `chạy test`.
2. **Đuôi câu có `mỗi <số><đơn vị>` / `every <N><unit>`** → tách ra.
   Chỉ khớp khi ngay sau "mỗi"/"every" là một **biểu thức thời gian**.
   `kiểm tra build mỗi 10 phút` → khoảng `10m`, việc `kiểm tra build`.
   `xem lại mọi PR` → **không có khoảng** ("mọi PR" không phải thời gian).
3. **Không thấy gì** → mặc định `10m`.

Đơn vị: `s` giây · `m` phút · `h` giờ · `d` ngày. Tiếng Việt: giây/phút/tiếng/giờ/ngày.

## 2. Quy ra giây, và làm tròn CÓ NÓI RA

`ScheduleTask` nhận `everySeconds`. Khoảng nhỏ nhất là **60 giây**.

| Người dùng nói | everySeconds | Ghi chú |
|---|---|---|
| `30s` | 60 | làm tròn lên — **phải nói** |
| `5m` | 300 | |
| `90m` | 5400 | |
| `2h` | 7200 | |
| `1d` | 86400 | |

Luật bất di bất dịch: **làm tròn thì nói ra đã tròn thành bao nhiêu.** Người dùng
xin 30 giây, hệ thống lặng lẽ cho 1 phút, rồi họ ngồi đếm và tưởng máy hỏng —
một câu "đã đặt 60 giây vì đó là mức tối thiểu" tốn một dòng và tránh hẳn chuyện đó.

Khoảng quá dài cũng vậy: trần là 86.400 giây (1 ngày). Xin hơn thì đặt về 1 ngày
và nói rõ.

## 3. Đặt hẹn

```
ScheduleTask(action="add", id="<tên-ngắn-kebab>", task="<việc, viết đầy đủ>",
             everySeconds=<số>, repeat=true)
```

`task` phải **đứng độc lập**: mỗi lần đến hạn bạn chỉ nhận lại đúng chuỗi đó, không
có phần hội thoại quanh nó. `"chạy lại"` là vô dụng; `"chạy npm test trong
packages/cli và báo cáo test nào đỏ"` mới dùng được.

`repeat=false` cho việc một lần ("nhắc tôi sau 20 phút").

## 4. Rồi LÀM NGAY LẦN ĐẦU

Đây là bước quan trọng nhất và cũng là bước hay bị bỏ nhất.

Đặt hẹn xong, **làm việc đó ngay bây giờ**, đừng đợi lần bắn đầu tiên. Không có
bước này thì `mỗi 1 tiếng kiểm tra deploy` sẽ im lặng suốt một tiếng, và người dùng
kết luận là hỏng — họ không có cách nào phân biệt "đang chờ" với "chết".

## 5. Dừng lại

- `ScheduleTask(action="list")` — xem đang hẹn những gì, còn bao lâu tới hạn.
- `ScheduleTask(action="cancel", id="...")` — bỏ một hẹn.

Người dùng nói "thôi", "dừng", "đủ rồi" → huỷ hẹn và **xác nhận đã huỷ cái nào**.

## 6. Giới hạn phải nói trước

Hẹn chỉ sống trong **phiên hiện tại** và không ghi xuống đĩa. Đóng phiên là mất.
Nếu người dùng có vẻ đang trông đợi thứ chạy qua đêm, nói thẳng điều này trước khi
đặt, đừng để họ phát hiện sau.
