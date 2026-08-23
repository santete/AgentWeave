# Sổ tay vết tích — mổ xẻ một phiên agent hỏng

> Dùng khi agent cho ra kết quả vô lý và ta cần biết **vì sao**, chứ không phải
> đoán. Chi tiết cơ chế nằm ở §14 `BAN-DO-KY-THUAT.md`; đây là quy trình dùng.

## 0. Bật — không cần làm gì

**Vết tích BẬT MẶC ĐỊNH** cho mọi dự án, ở cả ba đường vào (`chat`, `serve`,
`run`). Đây là lựa chọn có chủ đích cho giai đoạn sản phẩm còn chạy chưa ổn
định.

Tắt khi cần: `"vetTich": false` trong `.agentweave/agent.json`, hoặc
`AGENTWEAVE_TRACE=0`.

Ghi vào `.agentweave/vet-tich/<phien>/` (đã nằm trong `.gitignore`), giữ **20
phiên gần nhất** rồi tự dọn.

## 1. Vì sao cần nó

Ba tầng log cũ đều **không** giữ nội dung thật gửi cho model. Nghĩa là mọi câu
hỏi dạng "sao nó không nghe lời?" trước nay chỉ trả lời được bằng suy đoán.
Đợt rà soát hệ điều khiển phải chặn ở tầng mạng mới thấy được rằng model đang
nhận **chuỗi rỗng** thay cho lời gọi tool của chính nó.

Vết tích biến câu hỏi đó thành một lệnh đọc tệp.

## 2. Quy trình bốn bước

### Bước 1 — nhìn tổng thể

```bash
agentweave vet-tich
```

Đọc cột tầng: `user` → `host` → `agent` → `llm` → `tool`. Dòng thời gian cho
thấy ngay nhịp nào bất thường (một lượt 40 giây, hay guard nổ ba lần liên tiếp).

### Bước 2 — soi ranh giới model

```bash
agentweave vet-tich --tang llm
```

Đây là bước quan trọng nhất. Ba con số cần soi ở mỗi lượt:

| Dấu hiệu | Nghĩa là |
|---|---|
| `soTinNhan` tụt đột ngột | vừa có một lần nén — đối chiếu `agent:nen` cùng lượt |
| `tongKyTu` gần trần cửa sổ | sắp tràn; model có thể đang bị Ollama cắt cụt âm thầm |
| `tool: ...` thiếu tool đáng lẽ phải có | mặt nạ đang thu hẹp — đối chiếu `agent:guard` |
| `(CÓ MẶT NẠ)` | lượt này model **không được phép** gọi tool ngoài danh sách |
| `token vào` chênh nhiều so với `tongKyTu / 4` | `num_ctx` phía server nhỏ hơn ta tưởng |

### Bước 3 — đổ trọn chuỗi của lượt đáng ngờ

```bash
agentweave vet-tich --xem <stt>
```

Đây là thứ không tầng nào khác có: **đúng từng byte** đã gửi. Đọc theo thứ tự:

1. Tin nhắn `system` — câu dẫn có đúng như ta nghĩ không, dài bao nhiêu.
2. Lịch sử — lời gọi tool của model có hiện diện dưới dạng `[GOI TOOL ...]`
   không, kết quả có `[KET QUA ...]` không. **Nếu chúng rỗng thì model đang mù
   về hành động của chính nó** và mọi lời răn phía trên là vô nghĩa.
3. Cảnh báo guard — tìm chuỗi `<system-reminder source="agentweave:nhac-guard">`.
   Không thấy nghĩa là guard nổ nhưng model không nhận được gì.
4. `options` — `num_ctx`, `temperature`, `repeat_penalty` có đúng cấu hình không.

So hai lượt liên tiếp bằng `diff` là cách nhanh nhất tìm chỗ ngữ cảnh trôi:

```bash
cd .agentweave/vet-tich/<phien>/noi-dung
diff <(python3 -m json.tool 00012-gui.json) <(python3 -m json.tool 00031-gui.json) | head -60
```

### Bước 4 — đối chiếu guard với thực tế

```bash
agentweave vet-tich --luot <N>
```

Một lượt hiện đủ cả năm tầng. Ba câu hỏi:

- Guard có nổ không, và nó đặt mặt nạ gì?
- Mặt nạ đó có xuất hiện trong `llm:gui` của lượt **kế tiếp** không? Nếu không,
  đòn bẩy đã chết ở đâu đó giữa đường.
- Model có làm đúng thứ mặt nạ ép không? Nếu nó vẫn làm khác trong khi enum đã
  thu hẹp thì vấn đề nằm ở giao thức, không nằm ở câu chữ.

## 3. Bảng chẩn đoán nhanh

| Triệu chứng | Nhìn vào | Kết luận nếu khớp |
|---|---|---|
| Ghi cùng một file nhiều lần | `--xem` lượt gửi, tìm `[KET QUA` | không thấy → model không biết nó đã ghi |
| Tự tin báo xong mà chưa chạy gì | `agent:guard` coCHE `cong-kiem-chung` | không nổ → `laLenhKiemTra` chưa được truyền |
| Guard nổ mà model trơ | tìm `system-reminder` trong `gui.json` | không thấy → răn không tới nơi |
| Chạy chậm bất thường | `llm:nhan` cột `ms` | tăng dần theo lượt → ngữ cảnh phình |
| Bị cắt phiên vì loop | `agent:guard` coCHE `lap-y-het` / `goi-lien-tiep` | xem `toolBiChan` và `nacRepeatPenalty` |
| Lệnh bị chặn mà không rõ vì sao | `agent:quyen` | `nguon` cho biết luật nào quyết |
| File sai cú pháp vẫn báo xong | `tool:xong` cột `kiemCuPhap` | `SYNTAX ERROR` mà model vẫn kết thúc |

## 4. Giới hạn cần biết

- **Đường stream ghi ĐẦU VÀO của AI SDK**, không phải JSON cuối trên dây — SDK
  tự dựng phần đó. Đủ để đối chiếu, nhưng không phải bytes tuyệt đối. Đường có
  ràng buộc (mặc định của `chat`/`serve`) thì ghi đúng thân request.
- **`tongKyTu` ở đường stream ĐẾM THIẾU.** Nó chỉ tính system prompt cộng lịch
  sử; schema của các tool do AI SDK ghép thêm thì không. Đo thật: 1.206 ký tự
  ghi nhận nhưng Ollama báo 1.759 token vào — phần chênh gần như toàn là schema
  của 7 tool. Muốn con số đúng thì so `tokenVao` ở `llm:nhan`, đó là số Ollama
  tự đếm. Đường có ràng buộc không có vấn đề này vì tool nằm ngay trong thân
  request đã ghi.
  **`agentweave run` chạy đường stream** (không đặt `structuredProtocol`), còn
  `chat`/`serve` mặc định đi đường có ràng buộc.
- **Không ghi nội dung file mà tool đọc được** ngoài phần đã nằm trong kết quả
  tool. Muốn xem model đọc thấy gì thì xem `tool:xong` → `ket-qua.txt`.
- **Tốn đĩa.** Một phiên dài vài chục MB, phần lớn là bản sao chuỗi prompt qua
  từng lượt. Giữ 20 phiên gần nhất rồi tự dọn; xoá tay cả thư mục cũng an toàn,
  không gì phụ thuộc vào nó.
- **Pipeline SDLC đã nối** (§13 bản đồ): `pipeline run` và lệnh pipeline gọi
  từ VS Code đều sinh vết tích. Nhưng nhịp của nó là 8 BƯỚC, còn vết tích ghi
  theo LƯỢT của `AgentLoop` bên trong — muốn thấy ranh giới bước thì đọc
  `pipeline_stage` ở editor hoặc dòng `[SDLC]` trên terminal.
- **Bộ đếm và vết tích đều theo MỘT CÂU** người dùng, không phải cả buổi —
  `chat`/`serve` dựng harness mới mỗi câu (§3 bản đồ). Bộ ghi thì giữ nguyên
  một thư mục cho cả buổi, nên chỗ nối giữa các câu vẫn đọc liền mạch được.
