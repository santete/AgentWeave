# Nhật ký thay đổi kỹ thuật

> Mỗi mục nói: **sửa gì · vì sao · đụng § nào của `BAN-DO-KY-THUAT.md` · sau này
> muốn đổi thì phải kiểm lại cái gì**.
>
> Cột cuối mới là lý do tài liệu này tồn tại. `git log` đã kể được ba cột đầu;
> thứ nó không kể được là **hàng rào nào đang giữ một sửa đổi khỏi bị phá lại**.
> Trước khi chỉnh bất cứ dòng nào ở đây, đọc cột đó trước.
>
> Quy ước: một mục = một commit. Số § trỏ tới `BAN-DO-KY-THUAT.md`.
>
> **Hash điền ở commit SAU, không điền trước.** Một commit không thể chứa hash
> của chính nó, và `--amend` thì đổi hash thêm lần nữa. Đã mắc lỗi này ba lần
> trong một buổi: để trống rồi bổ sung, đừng điền một chuỗi trông giống hash.

---

## Đợt 2026-08-23 — nhánh `feat/product-grade`

Mười hai commit, chia làm ba nhóm: đại tu hệ điều khiển theo
`RA-SOAT-DIEU-KHIEN.md`, dựng tầng vết tích, rồi sửa những lỗi mà chính vết
tích phơi ra khi chạy thật trên một solution .NET.

### Bảng tra nhanh

| Commit | Sửa gì | § bản đồ |
|---|---|---|
| `82e0e1d` | Đại tu hệ điều khiển model (P0→P2 của rà soát) | §1 §2 §3 §6 §9 §11 §12 |
| `575a753` | Tầng vết tích — ghi mọi điểm chạm dữ liệu | **§14** (mới) · §0 §10 §11 §12 |
| `c6ac8f9` | Vết tích BẬT MẶC ĐỊNH + tự dọn + nối cho `run` | §9 §14 |
| `7ac7e53` | Pipeline theo model local + nối vào VS Code | §12 §13 |
| `c9c720a` | `FileEdit` chuẩn hoá BOM/CRLF, lỗi biết chẩn đoán | §3 §6 |
| `56b7d62` | Bộ vẽ markdown đánh số danh sách sai | §12 |
| `73034c5` | `respond` luôn ở trong enum → mặt nạ bất lực | §3 |
| `a372524` | Pipeline treo giao diện + mọi bước báo xanh | §12 §13 |
| `887b19b` | Cổng chất lượng "đạt" mà không kiểm gì | §13 |
| `6133bec` | `.sln` phải CÓ project mới tính là phép kiểm | §13 |
| `6e4b4e9` | Agent trong pipeline chạy với system prompt RỖNG | §13 |
| `5aa1bd4` | Cổng kiểm chứng ②: kiểm HỎNG thì không cho dừng | §3 |

---

## 1 · `82e0e1d` — đại tu hệ điều khiển model

Thi hành trọn `docs/RA-SOAT-DIEU-KHIEN.md`, cộng ba trục "chưa soi" của critic.

| Thay đổi | § | Phải kiểm lại nếu đụng |
|---|---|---|
| `render-lich-su.ts` (mới): render `tool_use`/`tool_result` có nhãn cho đường có ràng buộc, CoreMessage chuẩn cho đường stream | §11 §12 | **GỐC RỄ tầng 0.** Mọi cơ chế §3 giả định model ĐỌC ĐƯỢC lịch sử tool. Test `render-lich-su`; sau khi đổi hình dạng phải chạy `chuanHoaCapTool` |
| `epChiViet` (boolean) → `matNaTool` (tập tên tool), tiêu thụ ở `goiLLM()` | §3 | Mặt nạ phải khớp câu nhắc đi kèm; không bao giờ để tập rỗng; test `mat-na-tool` |
| `num_ctx` + `temperature`/`topP`/`repeatPenalty`/`seed` | §9 | `num_ctx` KHÔNG đi được đường stream — xem bảng phanh §9 |
| `kiem-cu-phap.ts` (mới): kiểm cú pháp sau mỗi lần ghi | §1 ⑨ §6 | Luật "không biết thì im"; thêm đuôi thì thêm test chống báo động giả |
| Vệ sinh bộ đếm: bỏ đếm lời gọi bị từ chối quyền, miễn trừ lệnh kiểm, leo thang 4→6→cắt 8 | §3 | Quan hệ #6↔#7; ngưỡng phải LEO THANG không nổ phẳng |
| Nhắc guard qua `<system-reminder>`, `tool_result` giữ ngắn | §2 | Đổi `NHAN_NHAC_GUARD` thì `chat`/`serve` lọc hụt, nhắc bị lưu vĩnh viễn vào phiên |
| Trần thời gian `maxDurationMs`; `budget` USD chết với model cục bộ | §9 | Bảng phanh §9 — kiểm ở ĐẦU LƯỢT, đổi ra giữa lượt là để lại tiến trình mồ côi |
| Câu dẫn bộ nhớ lười khi thư mục rỗng | §5 §9 | Test `memory` + `nap-tri-thuc` khoá độ dài < 600 byte |

---

## 2 · `575a753` — tầng vết tích

Thêm hẳn **§14** vào bản đồ. Ba tầng log cũ đều không giữ nội dung thật gửi
cho model, nên mọi chẩn đoán trước nay là suy đoán.

| Thay đổi | § | Phải kiểm lại nếu đụng |
|---|---|---|
| `types/vet-tich.ts`: `DiemCham` + `BoGhiVetTich` | §0 §14 | **Tầng trong KHÔNG chạm đĩa** — inner-harness phát, host ghi |
| Điểm chạm trong `AgentLoop`, đặc biệt `llm:gui` / `llm:nhan` | §14 | **Chỉ QUAN SÁT** — bật vết tích không được đổi một quyết định nào. Test `vet-tich` khoá điều này |
| `cli/lib/vet-tich-tep.ts`: JSONL + payload tách tệp | §10 §14 | Payload phải NGUYÊN VẸN; cắt là hỏng mục đích |
| Lệnh `agentweave vet-tich` | §14 | `LOAI_DIEM_CHAM` — thêm nhãn thì an toàn, ĐỔI tên thì bộ đọc mất dấu |

---

## 3 · `c6ac8f9` — vết tích bật mặc định

| Thay đổi | § | Phải kiểm lại nếu đụng |
|---|---|---|
| `batVetTich`: `=== true` → `!== false` | §9 §14 | Khi sản phẩm ổn định thì đảo lại; chỗ sửa ghi trong chú thích hàm |
| Tự dọn, giữ 20 phiên | §10 §14 | Sắp theo mtime **hoà thì theo tên** — nhiều phiên cùng mili-giây thì so mtime cho thứ tự tuỳ ý và xoá nhầm phiên MỚI |
| Nối cho `run` + ghi vết lỗi phân giải provider | §14 | `resolveModel()` ném TRƯỚC mọi điểm chạm khác |

---

## 4 · `7ac7e53` — pipeline theo model local, nối vào editor

| Thay đổi | § | Phải kiểm lại nếu đụng |
|---|---|---|
| Mặc định `qwen3-coder:30b`; chuỗi ưu tiên `--model` > `agentweave.yaml` > `agent.json` > mặc định | §13 | Dùng `\|\|` chứ KHÔNG `??`: `parseArgs` trả `model = ""`, chuỗi rỗng lọt qua `??` và Ollama trả 400 |
| `execution-bridge` truyền `structuredProtocol`/`contextWindow`/tham số sinh/vết tích | §13 | Thiếu chúng thì cùng model chạy trong pipeline tệ hơn trong chat mà không có gì báo |
| Giao thức `pipeline` ↔ `pipeline_start`/`_stage`/`_end` | §12 §13 | `sdlc:stage_*` KHÔNG đi qua luồng generator — phải BỌC `GovernanceHandle` |
| Lệnh VS Code `agentweave.pipeline` | §13 | Ba bước đầu BẬT khi gọi từ editor, khác mặc định dòng lệnh |

---

## 5 · `c9c720a` — `FileEdit` và định dạng vô hình

Rút từ vết tích thật: 9 câu hỏi, sửa nổi đúng MỘT file, biến số duy nhất là
dòng kết thúc.

| Thay đổi | § | Phải kiểm lại nếu đụng |
|---|---|---|
| Khớp bỏ qua BOM và CRLF/LF, ghi lại đúng định dạng gốc | §6 | File **TRỘN** dòng kết thúc thì giữ LF — quy cả file về CRLF sẽ đụng dòng không liên quan |
| Lỗi biết chẩn đoán, luôn kết bằng *"NOT a permissions problem — file was NOT changed"* | §6 | Bản cũ chỉ có `String not found`, model bịa ra "không có quyền" trong khi 0 lần từ chối |
| Từ chối `old_string === new_string` | §6 | Nếu khớp thì tool báo "Edited… replaced 205 chars" — thành công GIẢ |
| `FileRead` có mặt trong MỌI mặt nạ | §3 | Cấm đọc thì không ép model làm việc, mà ép nó ĐOÁN |

Test hồi quy `file-edit-crlf` dùng chuỗi **chép nguyên từ vết tích**.

---

## 6 · `56b7d62` — bộ vẽ markdown

| Thay đổi | § | Phải kiểm lại nếu đụng |
|---|---|---|
| Dòng trống giữa hai mục không đóng danh sách; giữ `ol.start` | §12 | Vết tích chứng minh model nhả ra đúng `1. 2. 3. 4.` ở cả 8 câu trả lời — **lỗi tầng hiển thị, không phải lỗi model** |

Bài học ghi thẳng vào §12: kiểm tầng hiển thị trước khi đổ cho model.

---

## 7 · `73034c5` — `respond` không phải bất khả xâm phạm

| Thay đổi | § | Phải kiểm lại nếu đụng |
|---|---|---|
| Bỏ `respond` khỏi enum từ nhịp 2 của `done=false` | §3 | Không bao giờ bỏ khi enum sẽ rỗng — model kẹt cứng |
| Thu hẹp ngay nhịp 1 | §3 | Nhịp 1 nhắc suông là một lượt sinh vứt đi |
| Hết nhịp mà vẫn `done=false` → cắt `reason: "loop"` | §3 §12 | **Không được ghi `completed` khi model nói chưa xong** — nói dối trong chính số liệu của mình |

---

## 8 · `a372524` — giao diện pipeline

| Thay đổi | § | Phải kiểm lại nếu đụng |
|---|---|---|
| `pipeline_end` gọi `ngungChay()` + `datBan(false)` | §12 | Đường chat được `turn_end` lo; đường pipeline KHÔNG đi qua đó. Thiếu là treo giao diện |
| Đọc `status` thật thay vì `e.ok` (không tồn tại) | §12 §13 | Đọc nhầm tên trường → mọi bước xanh bất kể kết cục |
| `pipeline_end` mang kết cục thật từ số đo | §13 | `status` chỉ nói "module chạy xong", KHÔNG nói "cổng đạt"; `reason` là `completed` kể cả khi build đỏ |
| Lệnh kiểm đoán theo dự án | §13 | — |
| Hiện số lần chạy lại của mỗi bước | §12 | Cập nhật tại chỗ mà không hiện số lần thì ba vòng trông y hệt một vòng |

---

## 9 · `887b19b` — cổng chất lượng rỗng

| Thay đổi | § | Phải kiểm lại nếu đụng |
|---|---|---|
| Lệnh đoán TRỎ ĐÚNG vào file dự án | §13 | `dotnet build` trần chạy ở gốc workspace in "0 Error(s)" và trả **exit 0** trong 0,15s — cổng xanh trong khi build thật hỏng |
| `coCongKiem`: không nói "ĐẠT" khi không có phép kiểm nào | §13 | Một phép kiểm không kiểm gì mà vẫn xanh biến cả cơ chế cổng chất lượng thành trang trí |
| **`.sln` phải CÓ `Project(` bên trong** (vá bổ sung `6133bec`) | §13 | Trỏ vào đúng loại file vẫn CHƯA ĐỦ. Đo thật: dự án có hai `.sln` — một cái ở gốc **rỗng** (0 project, 441 byte) build xanh 0,15s, một cái thật 3 project build hỏng `MSB4006`. Bản vá "trỏ vào .sln" vẫn chọn nhầm cái rỗng |

**Kiểm hai chiều trên dự án .NET thật** (bản sao, vì dự án gốc không phải git repo):

| Lệnh kiểm | Kết quả |
|---|---|
| `dotnet build "HelpdeskSolution.sln"` (sln rỗng) | `dat=True` — vẫn nói dối |
| `dotnet build "HelpdeskSolution/HelpdeskSolution.sln.sln"` (3 project) | **`dat=False` · thửLại=1** |

---

## 11 · `6e4b4e9` — agent trong pipeline chạy với system prompt RỖNG

Đây là lý do agent "không chịu sửa file", và nó không liên quan gì tới model.

| Thay đổi | § | Phải kiểm lại nếu đụng |
|---|---|---|
| `execution.agentLoop.systemPrompt` = câu dẫn chat/serve + cây thư mục, ở CẢ `serve.chayPipeline` lẫn `pipeline run` | §13 | `createAgentLoop` lấy `config.systemPrompt`; không ai đặt thì `getSystemPrompt()` trả RỖNG và agent chỉ còn khối giao thức |
| `empty_patch`: `severity` warning → **error** | §13 | `allRequiredPassed` chỉ lọc `severity === "error"` — để "warning" tức là cho qua. "Chạy xong mà không đổi gì" chính là kiểu hỏng cả bộ cổng sinh ra để bắt |

**Đo trước/sau, cùng việc cùng model, trên bản sao dự án .NET thật:**

| | Trước | Sau |
|---|---|---|
| System prompt | 1.405 ký tự (chỉ giao thức) | **10.000** — có 9 luật + cây thư mục |
| Agent đi tìm | `package.json`, `**/*.ts` | `HelpdeskSolution/**`, `.csproj`, `.cs` |
| Số tool chạy | 3 | **15** |
| File sửa được | **0** | **1** |

Cổng vẫn báo `dat=False` — build còn hỏng thật. Đó là báo cáo trung thực, không
phải thất bại của bản vá.

---

## 12 · `5aa1bd4` — cổng kiểm chứng ② — *nó có ĐẠT không?*

| Thay đổi | § | Phải kiểm lại nếu đụng |
|---|---|---|
| Cổng mới: lệnh kiểm đã chạy và HỎNG → chặn kết thúc, ép sửa tiếp, trần 4 nhịp | §3 | Cổng ① chỉ là boolean "đã chạy chưa" — model chạy một lần dù hỏng là thoả mãn vĩnh viễn |
| Tín hiệu đạt/hỏng lấy từ tiền tố `[mã thoát N]` của `bash.ts` | §3 §6 | Đổi định dạng output của Bash thì cổng ② mù. `DAU_MA_THOAT`/`DAU_BI_GIET` là hợp đồng giữa hai module |
| Ghi file thành công → xoá kết cục kiểm cũ | §3 | Sửa xong rồi thì kết quả kiểm trước không còn nói gì về mã hiện tại |

**Số liệu thúc đẩy thay đổi:** 4 phiên, 28 lượt kết thúc — **25 lượt không sửa
file nào**, và **cả 28 đều ghi `completed`**.

**Giới hạn, nói thẳng:** trần 4 nhịp là lời thú nhận. Không có phương án nào
cho "chạy tới khi hoàn thiện" theo nghĩa tuyệt đối — mọi vòng lặp đều phải có
trần. Thay đổi thật nằm ở chỗ trần dựa trên cái gì: "model tự nhận xong" (cũ)
hay "lệnh kiểm xanh, hoặc 4 lần thử" (nay).

---

## Còn nợ — chưa sửa, có chủ đích

| Việc | § | Vì sao chưa làm |
|---|---|---|
| Pipeline KHÔNG có rule/skill/memory (`napTriThuc` không được gọi) | §13 | Đổi hành vi cả hai đường vào |
| Cây thư mục ~5.100 ký tự nằm trong system prompt, sinh lại mỗi lượt → đập prefix cache | §2 §9 | Đo được 3 bản system prompt khác nhau trong một phiên; chưa sửa |
| `maxDurationMs` mặc định TẮT | §9 | Bật sau lưng người vận hành thì build dài hợp lệ bị cắt không rõ lý do |
| Danh sách con thụt lề chưa lồng vào `<li>` cha | §12 | Số hiệu đã đúng nhờ `ol.start`; thụt lề là việc khác |

---

## Cách dùng tài liệu này

1. **Trước khi sửa** một vùng: tra § trong `BAN-DO-KY-THUAT.md` → §11 "Bản đồ
   ảnh hưởng" → rồi tra ngược ở đây xem vùng đó đã từng sửa vì lý do gì.
2. **Cột "phải kiểm lại"** là hàng rào. Phần lớn nội dung cột đó đến từ một lần
   hỏng thật đã đo được, không phải từ suy đoán — phá nó là mời lại đúng lỗi cũ.
3. **Thêm mục mới** thì giữ đúng bốn cột, và nói *vì sao* chứ không chỉ *cái gì*.
   Sáu tháng nữa "cái gì" đọc từ diff được, "vì sao" thì không.
