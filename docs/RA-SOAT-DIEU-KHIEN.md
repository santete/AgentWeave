# Rà soát hệ điều khiển model — vì sao "ghì" mà model không chuyển

> Đợt rà soát 5 mũi song song + kiểm chứng đối nghịch từng phát hiện (11 agent,
> mỗi finding có verdict XAC-NHAN / MOT-PHAN / BAC-BO). Hai phát hiện trung tâm
> được kiểm lại lần cuối bằng chạy thật trước khi viết tài liệu này.
>
> Đọc cùng `BAN-DO-KY-THUAT.md` — mọi vị trí ở đây trỏ theo § của bản đồ.
>
> **TRẠNG THÁI 2026-08-23: toàn bộ lộ trình P0→P2 đã thi hành.** Xem
> "Đã sửa gì" ở cuối tài liệu. Phần chẩn đoán bên dưới GIỮ NGUYÊN làm hồ sơ —
> nó ghi lý do của từng thay đổi, và mỗi lần ai đó định "đơn giản hoá" một cơ
> chế thì đây là chỗ tra xem cơ chế ấy sinh ra để chặn kiểu hỏng nào.

## Kết luận một đoạn

Hệ điều khiển không hiệu quả **không phải vì thiếu cơ chế** — có tới ~13 cơ chế
can thiệp — mà vì một chuỗi ba tầng lỗi: **(0)** model bị MÙ về hành động của
chính nó nên mọi lời răn đều vô nghĩa với nó; **(1)** các đòn bẩy cưỡng chế
thật (thu hẹp enum, done=false) chết ở đường chạy phổ biến, nên hệ chỉ còn
"khuyên bằng văn"; **(2)** phần văn đó lại mâu thuẫn nhau, nổ lặp không leo
thang, và chiếm chỗ trong cửa sổ 64K. Sửa tầng 0 trước — không sửa nó thì mọi
cải tiến tầng trên đều là nói chuyện với người điếc.

---

## TẦNG 0 — Model mù về hành động của chính nó (gốc rễ)

### KT-01: Đường structured (MẶC ĐỊNH) vứt sạch tool_use và tool_result

`chayCoRangBuoc` dựng messages gửi Ollama bằng `trichChu` (agent-loop.ts:1307),
mà `trichChu` chỉ giữ block `type:"text"` (:122). Kiểm bằng chạy thật — sau một
FileWrite thành công, model nhận được:

```
user:      "viet thue.js"
assistant: ""        ← lời gọi FileWrite của CHÍNH NÓ
user:      ""        ← "Written 205 bytes to thue.js"
```

Hệ quả dây chuyền:
- Model không biết nó đã ghi file → ghi lại, hoặc tự tin "đã xong" không bằng chứng.
- **Mọi cảnh báo guard tiêm qua `appendToolResult` (trinh sát, loop, gọi-liên-tiếp,
  từ chối quyền, loi-tep) là CHUỖI RỖNG đối với model** — guard nổ, nhưng chỉ
  người vận hành thấy; model không nghe được gì.
- Giao thức còn CẤM kể file không có xác nhận "Written ... bytes" phía trên —
  điều kiện không bao giờ thoả vì dòng đó không bao giờ hiện diện. Model bị đặt
  vào thế hoặc nói dối hoặc không báo cáo được.
- `tomTatHaCanh` (:1210) cùng lỗi.

### KT-04: Đường stream đưa lịch sử tool dưới dạng JSON escape sai role

`mapTinNhanChoSdk` (:173) `JSON.stringify` mọi content mảng không-ảnh: model
nhận `"[{\"type\":\"tool_use\",...}]"` như LỜI NGƯỜI DÙNG. qwen được huấn luyện
đọc lịch sử tool theo khuôn `assistant.tool_calls` + `role:"tool"` — khuôn đó
không bao giờ xuất hiện. `message-store.ts:49` có sẵn TODO thừa nhận đúng
khoảng cách này. Mỗi lượt còn phồng ~48% ký tự vì escape.

**Hai đường bù trừ nhau theo cách tệ nhất:** đường có đòn bẩy enum (structured)
thì mù thông tin; đường thấy thông tin (stream, dù méo) thì không có đòn bẩy
(xem F1). Không cấu hình nào cho cả hai.

→ Giải thích trọn ground truth: ghi `thue.js` y hệt 3 lần, ghi đè bản đúng bằng
bản sai, kết bằng câu tự tin, guard nổ 4-6-7-8-9 lần mà model trơ.

## TẦNG 1 — Đòn bẩy cưỡng chế chết hoặc thiếu

| ID | Phát hiện | Verdict |
|---|---|---|
| F1 | `epChiViet` được ĐẶT ở 5 chỗ nhưng chỉ được ĐỌC ở `chayCoRangBuoc:1287` — vô hiệu hoàn toàn ở stream; không reset theo lượt nên rò rỉ khi đổi đường | XAC-NHAN cao |
| F2 | `chuaXong` (done=false) chỉ sinh ở envelope → cơ chế #3 chết ngoài structured. Bảng §3 ghi 6 cơ chế, cấu hình stream chỉ còn 4 | XAC-NHAN trung |
| NS-4 | Ý "sửa xong phải kiểm chứng" phát biểu ở **6 chỗ / 3 tầng** nhưng không tồn tại đòn bẩy cơ học nào ép CHẠY — `epChiViet` chỉ biết ép VIẾT (lọc về FileWrite/FileEdit), không diễn đạt được "lượt sau chỉ được Bash" | XAC-NHAN cao |
| KT-03 | Tham chiếu ghì theo MODE hai tầng: văn nhắc theo nhịp **+ tầng quyền** (plan mode chỉ auto-allow đúng file kế hoạch — model phớt lời vẫn không làm sai được). AgentWeave chỉ có văn | XAC-NHAN cao |
| F5/KT-07 | Không truyền MỘT tham số sinh nào (temperature/top_p/repeat_penalty/seed) ở cả hai đường — sửa hành vi sampler bằng văn bản trong khi nút chỉnh sampler bỏ trống; không seed nên không tái lập được | XAC-NHAN trung |
| Critic | `num_ctx` không bao giờ được gửi cho Ollama — cửa sổ 65.536 chỉ là giả định phía client; server có thể đang chạy num_ctx nhỏ hơn và cắt cụt prompt im lặng | CHƯA KIỂM — bước kiểm ghi bên dưới |

## TẦNG 2 — Tiếng ồn, mâu thuẫn, vệ sinh bộ đếm

| ID | Phát hiện | Verdict |
|---|---|---|
| F3/F10-kc | `soToolLienTiep`: lời gọi BỊ CHẶN vẫn tăng đếm, ngưỡng phẳng ≥4, không leo thang → nổ lặp 4,6,7,8,9; lần 5 nhường chỗ cho demGoiTrung (kiểm ở :837 trước :881) | XAC-NHAN cao |
| F4/F5-cc, F02-04-kc | Thuốc mâu thuẫn: cảnh báo loop bảo "write the file" đúng lúc FileWrite là thứ đang lặp; `epChiViet` loại Bash khỏi enum đúng lúc mọi lời nhắc (và luật #1) đòi chạy Bash; từ chối quyền bảo "tell the user" rồi detector tuyên-bố quát "do NOT ask the user" | XAC-NHAN cao |
| F9 | `demGoiTrung` dương tính giả: chạy lại cùng lệnh kiểm tra hợp lệ 3 lần không xen ghi → bị chặn với thông điệp sai, lần 5 CẮT PHIÊN reason "loop" | XAC-NHAN trung |
| Critic | Bộ đếm loop đếm cả lời gọi bị NGƯỜI DÙNG từ chối quyền (đếm :827-836 chạy trước cửa quyền) — "user từ chối → model thử lại" tích luỹ tới cắt phiên, đổ lỗi cho model | hợp lý, cần test khoá |
| F05-kc/KT-05 | Nudge guard là user message TRẦN — cùng loại chữ điều khiển mang 3 khung khác nhau (user trần / system-reminder / tool_result). Tham chiếu: mọi nhắc đều system-reminder + isMeta, có nhịp full/sparse | XAC-NHAN trung |
| F06/F07-kc | Cảnh báo mượn tool_use_id của FileWrite nên bị NÉN như kết quả FileWrite (mức 2 cắt còn 80 ký tự — lời cấm cụt giữa chừng); nenManhTay bỏ hẳn nudge giữa hội thoại trong khi bộ đếm 1-2-4 lần/phiên tin là đã nhắc đủ | XAC-NHAN trung |
| F6/F7-cc | chat/serve dựng harness MỚI mỗi câu → mọi bộ đếm "phiên" thực chất per-câu: cổng kiểm chứng tái vũ trang mỗi câu (= "dính rule nhiều lần"), rule có điều kiện bị bơm LẠI vào lịch sử đã chứa nó | XAC-NHAN/MOT-PHAN |
| Critic | Nudge giả-role-user bị LƯU VĨNH VIỄN vào phiên và replay mọi câu sau — transcript model phân kỳ khỏi transcript người dùng thấy | hợp lý, cần kiểm |
| NS-1 | Hướng dẫn memory **2.845B ≈ 711 tok** thường trực MỌI lượt kể cả khi thư mục memory RỖNG — mục lớn thứ hai sau LOI, vi phạm chính nguyên tắc tiết lộ tiệm tiến của nó | XAC-NHAN cao |
| NS-2/NS-5 | Tổng chữ điều khiển thường trực ≈1.8k tok/lượt; trace hỏng: 754-905 tok chữ điều khiển so với ~675 tok chữ công việc | XAC-NHAN/MOT-PHAN |
| NS-3/NS-7 | "Không có mạng" nói 2-3 lần; luật #9 vs FORMATTING trùng ý | XAC-NHAN thấp |

## Trục mới critic chỉ ra — **đã xử cả ba, 2026-08-23**

1. **Trục "làm ĐÚNG hay SAI"** — sau FileWrite model chỉ nhận "Written N bytes",
   không cơ chế nào nhìn NỘI DUNG vừa ghi.
   → **Xử ở P1-5**: `kiem-cu-phap.ts` chạy sau MỌI lần ghi, kết quả gắn vào
   chính `tool_result`. Không kéo `sdlc/quality-gate` sang vì nó chạy cả bộ
   test — chờ tới đó thì đã muộn vài lượt, còn kiểm cú pháp mất vài chục ms.
2. **cuuToolCall nhận nhầm** — chạy TRƯỚC bộ bắt vẹt, không đối chiếu lời gọi
   đã thực thi, nên văn xuôi nhại JSON lịch sử bị "cứu" thành lệnh THẬT và chạy
   lại. Ứng viên trực tiếp cho "lần 3 GHI ĐÈ bản sai".
   → **Đã xử**: lời gọi được CỨU mà trùng khít một chữ ký trong `demGoiTrung`
   thì bỏ, coi là model KỂ LẠI chứ không phải GỌI. Dùng chung bộ đếm nên thừa
   hưởng luôn ngữ nghĩa "kể từ lần ghi gần nhất" — vòng đọc-sửa-chạy hợp lệ
   không bị chặn oan. Cứu được toàn thứ nhại lại → coi như không có tool call,
   rơi xuống nhánh dưới, và ở đó bộ bắt vẹt mới là thứ nên xử. Chỉ áp cho
   đường CỨU: tool call thật thì model chủ ý gọi.
   **Lỗ này RỘNG RA sau P0** — model nay đọc được lịch sử tool của chính nó nên
   nhại khuôn `[GOI TOOL …]` thường xuyên hơn hẳn.
3. **Bản đồ phanh có lỗ** — budget USD luôn = 0 với Ollama (MIEN_PHI) nên không
   bao giờ kích; không trần thời gian; "loop biến thể" né được cả `demGoiTrung`
   lẫn `soToolLienTiep` và nghiền đủ 50 lượt.
   → **Đã xử cả ba vế**:
   - *loop biến thể* — trần cứng 8 ở `soToolLienTiep` (P2-6).
   - *trần thời gian* — `RunOptions.timeoutMs` và `TerminalReason: "timeout"`
     nằm trong kiểu từ lâu mà **không ai nối**; nay nối vào đầu mỗi lượt, kèm
     `maxDurationMs` trong `agent.json`. Kiểm ở ĐẦU LƯỢT chứ không giữa lượt:
     cắt ngang một lệnh Bash đang chạy sẽ để lại tiến trình mồ côi và file ghi
     dở — ca lệnh đơn lẻ chạy quá lâu đã có `bashTimeoutMs`.
   - *budget chết* — không sửa được (giá model cục bộ đúng là 0), nên `chat`
     **cảnh báo thẳng** khi `budget` được đặt cho model cục bộ và chỉ sang
     `maxDurationMs`. Một phanh đọc thì có mà đạp thì không, im lặng về nó là
     tệ hơn không có.

## Lộ trình sửa (thứ tự bắt buộc)

**P0 — trả lại mắt cho model** (mọi thứ khác vô nghĩa khi chưa xong):
1. `chayCoRangBuoc` + `tomTatHaCanh`: render tool_use/tool_result thành text có
   nhãn (`[GOI TOOL FileWrite] {...}` / `[KET QUA t1] Written 205 bytes`) thay
   vì `trichChu`. Test khoá: chuỗi gửi Ollama PHẢI chứa "Written" và lời cảnh báo guard.
2. `mapTinNhanChoSdk`: map sang CoreMessage chuẩn (assistant tool-call parts,
   `role:"tool"` cho kết quả) — đúng TODO có sẵn ở message-store.ts:49. Kiểm lại
   `chuanHoaCapTool` sau khi đổi hình dạng.

**P1 — trả lại răng cho hệ ghì:**
3. `epChiViet` → mặt nạ trạng thái dùng được ở CẢ HAI đường và diễn đạt được
   `{Bash}`: cổng kiểm chứng lần 1 thu về {FileWrite,FileEdit,Bash}, lần 2 về
   {Bash} (hoặc host TỰ chạy lệnh kiểm rồi tiêm output thật). Reset cờ mỗi lượt.
4. `num_ctx` + tham số sinh (`temperature`, `repeat_penalty`, `seed`) vào
   agent.json, truyền xuống cả hai đường; nối leo thang: lặp lần 3 → tăng
   repeat_penalty một nấc thay vì chỉ tiêm thêm chữ.
5. Syntax-check rẻ sau ghi (node --check/tsc --noEmit theo đuôi) làm tool_result
   thật — trả trục "làm sai yêu cầu".

**P2 — vệ sinh:**
6. Bộ đếm: không đếm lời gọi bị chặn/bị từ chối quyền; leo thang soToolLienTiep;
   miễn trừ lệnh-kiểm-tra cho demGoiTrung; đếm xuyên câu hoặc ghi rõ per-câu.
7. Thống nhất khung: mọi nudge qua kênh attachment (system-reminder + nhịp +
   không lưu vào phiên); lọc nudge hết hạn khỏi lichSu khi luuPhien.
8. Memory prompt lười (rỗng → 2 câu, ~40 tok); gộp phát biểu trùng.

## Đã sửa gì — 2026-08-23

Thứ tự thi hành đúng như lộ trình. Mỗi dòng ghi *đòn bẩy cơ học* đã thêm, không
phải câu chữ đã thêm — chữ thì bản cũ đã thừa.

### P0 — trả lại mắt cho model

| # | Việc | Ở đâu | Test khoá |
|---|---|---|---|
| 1 | `chayCoRangBuoc` + `tomTatHaCanh` render `tool_use`/`tool_result` thành chữ CÓ NHÃN (`[GOI TOOL FileWrite t1]` / `[KET QUA t1] Written 205 bytes`) thay `trichChu`. Tham số dài rút gọn theo TỪNG giá trị nên đường dẫn còn nguyên mà nội dung file không bị nhồi lại mỗi lượt | `render-lich-su.ts` | `render-lich-su.test.ts` — chuỗi gửi Ollama phải chứa "Written" **và** lời cảnh báo guard |
| 2 | `mapTinNhanChoSdk` sang CoreMessage chuẩn: `tool-call` part cho assistant, tin nhắn `role:"tool"` cho kết quả, `isError` giữ nguyên | `render-lich-su.ts` | cùng tệp — không tin nhắn nào còn mang JSON escape của content block |

Hai test cũ khoá đúng hành vi HỎNG (`mảng KHÔNG có ảnh vẫn JSON.stringify`) đã
được viết lại theo hợp đồng mới.

### P1 — trả lại răng cho hệ ghì

| # | Việc | Ở đâu | Test khoá |
|---|---|---|---|
| 3 | `epChiViet` (boolean) → `matNaTool` (tập tên tool). Tiêu thụ ở `goiLLM()` nên cả stream lẫn structured đều nhận và đều reset. Diễn đạt được `{Bash}`: cổng kiểm chứng nhịp 1 → `{Write,Edit,Bash}`, nhịp 2 → `{Bash}`. Mặt nạ rỗng thì KHÔNG thu hẹp | `agent-loop.ts` | `mat-na-tool.test.ts` |
| 4 | `num_ctx` gửi mọi lượt trên đường có ràng buộc; `temperature`/`topP`/`repeatPenalty`/`seed` vào `agent.json` → SDK → cả hai đường. Leo thang: mỗi lần nổ loop cộng một nấc `repeat_penalty` (nền 1,1 · bước 0,1 · trần 1,5), hạ về nền khi ghi file thành công | `agent-loop.ts`, `agent-config.ts`, `chat.ts`, `serve.ts` | typecheck + kiểm khoảng giá trị trong `agent-config` |
| 5 | Kiểm CÚ PHÁP sau mỗi lần ghi, gắn vào chính `tool_result`. `.js` → `node --check`, `.json` → `JSON.parse`, `.ts` → `parseDiagnostics`. Đuôi lạ → im lặng | `kiem-cu-phap.ts` | `kiem-cu-phap.test.ts` — 12 test, gồm hai test chống BÁO ĐỘNG GIẢ (sai kiểu và import không phân giải được vẫn phải ĐẠT) |

`typescript` được đánh dấu **external** khi build: để mặc định tsup gói cả trình
biên dịch 9,48 MB vào bundle.

### P2 — vệ sinh

| # | Việc | Ở đâu | Test khoá |
|---|---|---|---|
| 6 | Không tính lời gọi bị NGƯỜI DÙNG từ chối quyền (hoàn lại cả hai bộ đếm); miễn trừ lệnh kiểm chứng khỏi `demGoiTrung`; `soToolLienTiep` leo thang 4 → 6 (cảnh cuối) → **8 (cắt phiên)** thay vì nổ phẳng mãi | `agent-loop.ts` | `ve-sinh-bo-dem.test.ts` |
| 7 | Mọi câu răn qua `nhacGuard()` — một `<system-reminder>` cho cả lượt, xả SAU dãy `tool_result` nên không tách cặp tool. `tool_result` của lời gọi bị chặn chỉ còn một câu nêu sự kiện (< 120 ký tự) nên nén mức 2 không cắt cụt lời cấm. `locNhacGuard()` lọc nhắc khỏi `lichSu` ở ranh giới giữa hai câu | `attachments/thu-thap.ts`, `chat.ts`, `serve.ts` | `ve-sinh-bo-dem.test.ts` |
| 8 | Thư mục bộ nhớ rỗng → bản LƯỜI (< 600 byte, vẫn đủ khuôn để ghi mẩu đầu tiên) thay cho 2.845 byte thường trực. Câu "không có mạng" gộp từ 3 chỗ còn 1 — và `LOI` thôi khẳng định điều nó không biết khi `offline: false` | `memory/prompt.ts`, `system-prompt.ts` | `memory.test.ts`, `nap-tri-thuc.test.ts`, `co-lap.test.ts` |

### Còn nợ — có chủ đích

- **Bộ đếm vẫn per-CÂU, không per-phiên.** `chat`/`serve` dựng harness mới mỗi
  câu, đó là thiết kế có chủ đích cho REPL (đổi model/quyền giữa chừng phải ăn
  ngay). Rà soát cho hai lựa chọn — đếm xuyên câu HOẶC ghi rõ per-câu — và đây
  chọn vế thứ hai: đã ghi ở `agent-loop.ts` (khối `demGoiTrung`) và §3 bản đồ.
- **`num_ctx` không có đường đi ở đường stream.** Endpoint tương thích OpenAI
  của Ollama không nhận tham số này. Đã ghi ở §9 bản đồ.
- **`maxDurationMs` mặc định TẮT.** Giữ trung lập như `bashTimeoutMs`: bật một
  trần thời gian sau lưng người vận hành thì một bản build dài hợp lệ sẽ bị cắt
  mà không ai hiểu vì sao. Đã ghi ở §9 bản đồ để nó là lựa chọn tường minh chứ
  không phải thứ bị quên.

---

## Sổ tay verdicts

MOT-PHAN đáng lưu ý: F6-cc (harness-mỗi-câu là thiết kế có chủ đích cho REPL,
hệ quả phụ mới là lỗi); NS-5 (số token đúng, quy kết "gấp 43 lần" chỉ đúng cho
trace cực đoan); F11-kc, NS-7, KT-08 hạ mức. Không finding CAO nào bị BAC-BO.
