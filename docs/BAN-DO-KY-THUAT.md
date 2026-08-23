# Bản đồ kỹ thuật AgentWeave

> Đọc cái này TRƯỚC khi sửa bất cứ thứ gì. Mỗi mục nói: cơ chế nằm ở đâu, nó
> quyết định cái gì, và sửa nó thì đụng tới ai.
>
> Lập từ mã nguồn thật, không viết từ trí nhớ. Con số nào ghi ở đây đều trích
> từ hằng số trong code — sửa code thì sửa luôn bảng tương ứng.

---

## 0. Ba tầng, và ranh giới giữa chúng

```
┌─ TẦNG HOST (packages/cli) ─────────────────────────────────────┐
│  chat · serve · run          ← nơi người dùng chạm vào          │
│  Sở hữu: đồng hồ hẹn giờ, phiên, cấu hình, cô lập, ô nhập      │
│  Sống suốt phiên, KỂ CẢ lúc agent rảnh                          │
└───────────────┬────────────────────────────────────────────────┘
                │ createHarness()
┌───────────────▼─ TẦNG QUẢN TRỊ (outer-harness + control-plane) ┐
│  Quyền · Ngân sách · Lọc đầu ra · Kiểm toán · Hook              │
│  Chặn ở giữa: mọi tool call đi qua đây trước khi chạy           │
└───────────────┬────────────────────────────────────────────────┘
                │ intercept("tool_request")
┌───────────────▼─ TẦNG THỰC THI (inner-harness) ────────────────┐
│  AgentLoop · ToolExecutor · Ngữ cảnh · Tri thức · Ghì model     │
│  Chỉ sống trong MỘT lượt run()                                  │
└────────────────────────────────────────────────────────────────┘
```

**Ranh giới quan trọng nhất:** thứ gì cần sống lâu hơn một lượt agent thì phải
đặt ở tầng HOST. Đồng hồ hẹn giờ từng nằm ở inner-harness và đứng im, vì
inner-harness chỉ tồn tại khi có lượt chạy.

| Gói | Dòng | Trách nhiệm |
|---|---:|---|
| `inner-harness` | 12.479 | vòng lặp agent, tool, ngữ cảnh, rule/skill/memory |
| `cli` | 9.327 | lệnh người dùng, phiên, đồng hồ, cấu hình |
| `outer-harness` | 5.335 | quyền, ngân sách, lọc, kiểm toán |
| `types` | 1.914 | hợp đồng dùng chung — đổi ở đây là đụng tất cả |
| `adapters` | 1.055 | nối tới Claude Code / agent ngoài |
| `gateway` `sdk` `protocol` `mcp-server` `control-plane` | 2.685 | vận chuyển và lắp ráp |

---

## 1. Vòng đời MỘT lượt agent

Thứ tự này nằm trong `agent-loop.ts:343` và **thứ tự là quan trọng**.

```
⓪ Trần thời gian          hết `timeoutMs` → chốt hạ cánh, dừng reason "timeout"
① Dọn theo thời gian      nếu nghỉ > 30 phút → xoá nội dung tool result cũ
② Nén ngữ cảnh            nếu đầy ≥ 80% → thang 3 mức → ngắt mạch sau 3 lần vô ích
③ Thu nhắc                chạy mọi nguồn song song, timeout cứng 1s, nuốt lỗi
④ Chuẩn hoá cặp tool      khử tool_use mồ côi trước khi gửi
⑤ GỌI LLM                 stream chữ ra ngoài ngay
⑥ Cứu tool-call dạng chữ  4 khuôn, chỉ khi không có tool call hợp lệ
                          → BỎ lời gọi trùng khít lệnh đã chạy (model KỂ LẠI)
⑦ Nếu KHÔNG có tool call  → ba bộ bắt bệnh (§3) → hoặc kết thúc
⑧ Với TỪNG tool call      → ngân sách trinh sát → phát hiện lặp → quyền → chạy
⑨ Sau lệnh GHI            kiểm cú pháp theo đuôi file, gắn vào chính tool_result
⑩ Xả nhắc guard           gom cả lượt thành MỘT <system-reminder>
⑪ Kiểm ngân sách tiền
```

Sửa ở bước nào thì phải hỏi: **bước sau nó có dựa vào kết quả bước này không?**
Ví dụ ③ phải sau ② (nén xong mới còn chỗ), ④ phải sau ③ (nhắc là tin nhắn mới).

---

## 2. Bốn kênh bơm chữ vào model

Mỗi kênh có vòng đời khác nhau. Nhầm kênh là nguyên nhân của phần lớn lỗi context.

| Kênh | Nội dung | Sống bao lâu | Đặt ở đâu |
|---|---|---|---|
| **1. Câu dẫn lõi** | 9 luật + FORMATTING | cả phiên, mọi lượt | `cli/lib/system-prompt.ts:LOI` |
| **2. Mục prompt động** | `rules` · `skills` · `memory` | cả phiên, đặt lúc nạp | `setSystemPromptSection()` |
| **3. Attachment** | nhắc giữa hội thoại **+ mọi câu răn của guard** | một lượt, rồi trôi theo nén | `attachments/` |
| **4. Kết quả tool** | đầu ra lệnh | tới khi bị nén | `ToolExecutor` |

**Luật chọn kênh:** thứ đúng với MỌI lượt → kênh 1. Thứ đúng với dự án này →
kênh 2. Thứ chỉ đúng lúc này → kênh 3. Nhồi nhầm vào kênh 1 thì trả giá bằng
tốc độ sinh suốt cả phiên.

**Câu răn của guard đi kênh 3, không đi kênh 4.** Trước 2026-08-23 cùng một
loại chữ điều khiển mang ba khung khác nhau (user trần / `<system-reminder>` /
`tool_result`) — model học được rằng khung nào cũng có thể là chữ điều khiển,
nên không khung nào còn trọng lượng. Nay mọi câu răn qua `nhacGuard()`:

- gắn nhãn `NHAN_NHAC_GUARD`, nên `locNhacGuard()` bỏ được nó trước khi ghi
  phiên — nhắc là chữ của MỘT lượt, không phải nội dung hội thoại;
- `tool_result` của lời gọi bị chặn chỉ còn **một câu nêu sự kiện**. Nó mượn id
  của một tool nằm trong `TOOL_NEN_DUOC` nên nén mức 2 cắt còn 80 ký tự — bài
  răn dài để ở đó sẽ đứt giữa câu, còn một câu ngắn thì cắt cũng không mất gì.

### Câu dẫn hệ thống lắp theo thứ tự (`system-prompt.ts:110`)

```
LOI (9 luật + FORMATTING)          luôn có
 └─ KHONG_MANG                     trừ khi offline: false
 └─ CAU_DAN_TODO                   chỉ khi danhSachViec: true
 └─ coLapTienTrinh(...)            chỉ khi sandbox: true
 └─ "The project's check command"  nếu đoán được từ package.json
 └─ Project-specific instructions  nếu agent.json có systemPrompt
[rules]   ← setSystemPromptSection
[skills]  ← setSystemPromptSection
[memory]  ← setSystemPromptSection
```

---

## 3. Hệ thống ghì model — bảng tra cứu

Đây là phần dễ sửa sai nhất, vì các cơ chế **cùng tác động lên một biến**:
`matNaTool` — tập tên tool được phép ở lượt gọi kế tiếp.

> **Đã sửa 2026-08-23** theo `docs/RA-SOAT-DIEU-KHIEN.md`. Ba thay đổi nền,
> đọc trước khi động vào bảng:
>
> 1. **Model đã NHÌN THẤY hành động của chính nó.** Cả hai đường gọi từng làm
>    mất sạch `tool_use`/`tool_result` (đường structured qua `trichChu`, đường
>    stream qua `JSON.stringify` sai role). Nay dùng `render-lich-su.ts`. Mọi
>    cơ chế dưới đây giả định điều đó — nó là điều kiện để chúng có nghĩa.
> 2. **`epChiViet` (boolean) → `matNaTool` (tập tên tool).** Tiêu thụ ở
>    `goiLLM()` nên CẢ HAI đường đều nhận và đều reset. Diễn đạt được `{Bash}`,
>    thứ mà cờ cũ không làm nổi.
> 3. **Bộ đếm có phạm vi MỘT CÂU**, không phải cả phiên: `chat`/`serve` dựng
>    harness mới cho mỗi câu. Chỗ nào ghi "phiên" ở dưới đều đọc là "câu này".

| # | Cơ chế | Kích hoạt khi | Ngưỡng | Mặt nạ đặt cho lượt sau | Dòng |
|---|---|---|---|---|---|
| 1 | Bắt "tuyên bố rồi dừng" | không tool call + khớp mẫu hứa hẹn + chưa có tiến triển gần đây | 4 lần | `{Write,Edit,Bash,Read}` | 768 |
| 2 | Bắt "trả lời vẹt" | lặp nguyên văn câu trả lời cũ | 1 lần | — | 724 |
| 3 | Model tự khai chưa xong | `done=false` trong envelope (chỉ có ở structured) | 3 lần, hết nhịp → **cắt, reason `loop`** | nhịp 1 `{Write,Edit,Bash,Read}`, từ nhịp 2 thêm **BỎ `respond` khỏi enum** | 739 |
| 4 | **Cổng kiểm chứng** | đã sửa file mà chưa chạy lệnh kiểm nào | 2 nhịp | nhịp 1 `{Write,Edit,Bash,Read}` → nhịp 2 **`{Bash,Read}`** | 797 |
| 5 | Ngân sách trinh sát | 6 lệnh đọc liên tiếp không ghi gì | tái kích mỗi 6 | `{Write,Edit,Read}` | 888 |
| 6 | Lặp Y HỆT (tool+tham số) | cùng tool, cùng tham số — **trừ lệnh kiểm chứng** | nhắc lần 3, **cắt phiên** lần 5 | `{Write,Edit,Bash,Read}` | 943 |
| 7 | Gọi LIÊN TIẾP cùng tool | cùng tên tool, tham số đổi vặt | nhắc 4 → cảnh cuối 6 → **cắt 8** | ghi→`{Bash,Read}`, đọc→`{Write,Edit,Bash,Read}` | 987 |
| 8 | **Kiểm cú pháp sau ghi** | FileWrite/FileEdit xong, đuôi có bộ kiểm | mỗi lần ghi | — (gắn vào `tool_result`) | 1151 |

**Quan hệ #6 và #7:** #6 chạy trước và có đường cắt hẳn phiên ở lần 5. Đảo thứ
tự thì #6 không bao giờ leo tới ngưỡng đó — đã vấp đúng lỗi này.

**Ba luật khi chỉnh bảng này:**

- **Mặt nạ phải khớp câu nhắc.** Kiểu hỏng đã đo: cảnh báo bảo "run the check
  command with Bash" trong khi enum vừa loại Bash — model không còn nước đi
  hợp lệ nào. `thuHepTool()` trả về mô tả tập đã áp và nó được gắn vào
  `recovery:retry`, nên nhìn nhật ký là đối chiếu được.
- **Mặt nạ không bao giờ rỗng.** `thuHepTool()` lọc theo registry trước; giao
  rỗng thì KHÔNG thu hẹp. Thà mất đòn bẩy còn hơn nhốt model.
- **`FileRead` có mặt trong MỌI mặt nạ.** Đọc không bao giờ là hành động giả.
  Đo thật: mặt nạ loại FileRead ra, model bị ép ghi nhưng không còn cách lấy
  đúng nội dung file, nên nó dựng `old_string` từ trí nhớ và sửa trượt — rồi
  đổ cho thiếu quyền. Cấm đọc thì ta không ép model làm việc, ta ép nó ĐOÁN.
  Thứ cần chặn là trinh sát LAN MAN (Grep/Glob quét mò), không phải việc đọc
  đúng một file model sắp sửa.
- **`respond` KHÔNG phải bất khả xâm phạm.** Nó nằm trong enum ở mọi lượt, nên
  với một model chỉ muốn nói thì mặt nạ tool hoàn toàn bất lực — thu hẹp còn
  `{Write,Edit,Bash,Read}` mà nó vẫn nộp thêm một bài văn. Đo thật
  (`vet-tich/20260823-180443`): tự khai `done=false` ba lần rồi vẫn kết thúc
  với 0 file được sửa, harness ghi `reason: completed`. Khi model TỰ KHAI chưa
  xong thì bỏ hẳn `respond` — không phải ép nó làm điều nó không muốn, mà là
  thi hành đúng lời khai của nó. Không bao giờ bỏ khi enum sẽ rỗng.
- **Không được ghi `completed` khi model nói chưa xong.** Đó là nói dối trong
  chính số liệu của mình: người dùng đọc `turn_end` thấy xanh rồi tin là xong.
  Hết nhịp mà vẫn `done=false` → cắt với `reason: "loop"` kèm lỗi nói rõ.
- **Ngưỡng phải LEO THANG, không nổ phẳng.** #7 từng lặp lại y nguyên bài răn
  ở lần 4, 6, 7, 8, 9 rồi hết lượt: model phớt ở lần 4 thì lần 7 cũng thế, mà
  mỗi lần lặp là một khối chữ nữa chiếm chỗ trong cửa sổ.

**Đặt lại bộ đếm:** ghi file thành công xoá bộ đếm của lệnh ĐỌC (giữ đếm của
lệnh ghi), đặt lại ngân sách trinh sát, và **hạ `repeat_penalty` về nền**. Lời
gọi bị NGƯỜI DÙNG từ chối quyền được **hoàn lại** bộ đếm — nếu không, chuỗi
"từ chối → model thử cách khác" tích luỹ thẳng tới ngưỡng cắt phiên và đổ lỗi
cho model về một quyết định của con người.

**Leo thang ở tầng sinh:** #6 và #7 mỗi lần nổ đều cộng một nấc
`repeat_penalty` (nền 1,1 · bước 0,1 · trần 1,5). Cái lặp sinh ra từ sampler,
nên vặn ở sampler; tiêm thêm chữ là chữa triệu chứng ở sai tầng.

---

## 4. Quản lý ngữ cảnh

```
Cửa sổ thật ← agent.json:contextWindow → OLLAMA_CONTEXT_LENGTH → 65.536
                                              │
                   đầy ≥ 80%  ────────────────┤
                                              ▼
      ┌── Thang nén, leo mỗi lượt còn chật ──────────┐
      │ mức 0: giữ 6 lượt cuối, cắt tool result 400  │
      │ mức 1: giữ 4 lượt cuối, cắt 200              │
      │ mức 2: giữ 2 lượt cuối, cắt 80               │
      └──────────────────────────────────────────────┘
                                              │
              vượt mức 2 mà VẪN đầy, 3 lượt liên tiếp
                                              ▼
                              NGẮT MẠCH → dừng, báo lỗi rõ
```

**Hai luật bất biến khi sửa nén:**
- Chỉ nén tool result của tool **lấy lại được** (`TOOL_NEN_DUOC`: FileRead,
  FileWrite, FileEdit, Bash, Grep, Glob). `LoadSkill` nén đi là mất hẳn.
- Ranh giới cắt phải lùi qua trọn cụm `tool_result`, không được tách cặp.

---

## 5. Ba hệ tri thức — cùng một hình dạng

Cả ba đều **tiết lộ tiệm tiến**: một dòng chỉ mục luôn có mặt, nội dung nạp khi cần.

| | Rule | Skill | Memory |
|---|---|---|---|
| Nơi để | `.agentweave/rules/`, `AGENTS.md` | `.agentweave/skills/` | `.agentweave/memory/` |
| Tầng | org→user→project→local | project→user→org | (một tầng) |
| Trong prompt | rule vô điều kiện, **nguyên văn** | chỉ mục 1 dòng/skill | `MEMORY.md` |
| Nạp khi | chạm file khớp `paths:` | model gọi `LoadSkill` | câu hỏi khớp từ khoá |
| Ngân sách | cảnh báo ở 40.000 ký tự | 1% × cửa sổ × 4 = **2.621** | ≤3 tệp/lượt, ≤20KB/phiên |
| Chọn bằng | glob kiểu gitignore | glob + dò stack lúc khởi động | chấm điểm từ khoá + độ mới |

**Không dùng model để chọn** ở bất kỳ chỗ nào — air-gap có một model trên
Jetson, gọi phụ là trả tiền hai lần.

---

## 6. Tool

| Tool | Nhóm | Ghi chú |
|---|---|---|
| `FileRead` `FileWrite` `FileEdit` | tệp | có chống ghi đè mù (mtime + size + cờ đọc thiếu) |
| `Grep` `Glob` | tìm | |
| `Bash` | chạy | hạn giờ `bashTimeoutMs`, bọc sandbox nếu bật, **giết cả NHÓM tiến trình** |
| `LoadSkill` | tri thức | đăng ký khi có skill |
| `ScheduleTask` | hẹn giờ | chỉ khi host truyền `LichHen` |
| `TodoWrite` | kế hoạch | **mặc định TẮT**, bật bằng `danhSachViec: true` |

**Bash và khoá tệp** — `Bash` chạy lệnh trong một **nhóm tiến trình riêng**
(`detached: true`), hết hạn giờ thì `kill(-pid)` để tín hiệu tới cả cháu. Tuỳ
chọn `timeout` sẵn có của Node chỉ giết con TRỰC TIẾP: với `cd x && dotnet build`
thì `sh` là con còn `dotnet` là cháu — giết `sh` xong `dotnet` vẫn sống và tiếp
tục giữ khoá `bin/obj`. Lượt sau `FileEdit` lên đúng tệp đó nhận *"being used by
another process"* — **do chính agent để lại ở lượt trước**, không phải người
dùng mở IDE. Đã tái hiện và có test hồi quy (đo bằng PID chứ không bằng
`pgrep -f` — khớp chuỗi thì lệnh đo tự khớp chính nó).

**`FileEdit` và định dạng vô hình** — so khớp BỎ QUA khác biệt BOM và CRLF/LF,
rồi ghi lại đúng định dạng gốc (file TRỘN dòng kết thúc thì giữ LF, không quy
cả file).

Vì sao bắt buộc: `\r` và BOM **vô hình** với model — không LLM nào tái tạo
được thứ nó không nhìn thấy. Đo thật trên một solution .NET
(`vet-tich/20260823-171947`): cả buổi 9 câu hỏi chỉ sửa nổi ĐÚNG MỘT file, và
biến số duy nhất phân biệt là dòng kết thúc — file LF sửa được, hai file CRLF
thì `String not found` mọi lần.

Hai luật đi kèm, cả hai đều rút từ chính phiên đó:

- **Thông báo lỗi phải CHẨN ĐOÁN.** Nói khác ở đâu (khoảng trắng? dòng nào sai?
  lắp khối sai?), và LUÔN kết bằng *"This is NOT a permissions problem — the
  file was NOT changed"*. Bản cũ chỉ có `String not found in <path>`; model
  không hiểu vì sao trượt nên **bịa** ra "tôi không có quyền truy cập đầy đủ",
  trong khi vết tích ghi 16 quyết định quyền và KHÔNG một lần từ chối. Người
  dùng đọc câu đó rồi cấp thêm quyền — vô ích.
- **Sửa RỖNG bị từ chối.** `old_string === new_string` là thao tác không đổi gì
  nhưng vẫn báo "Edited … replaced 205 chars" — một thành công GIẢ đánh lừa cả
  bộ đếm tiến triển lẫn người dùng.

**Lỗi hệ thống tệp** (`built-in-tools/loi-tep.ts`): `FileEdit`/`FileWrite` bọc
mọi thao tác đĩa, dịch mã lỗi OS sang câu nêu **hành động đúng** — bị khoá
(tạm thời, dừng tiến trình đang giữ rồi thử lại MỘT lần) khác hẳn hết quyền
(không tự khắc phục được) và hết đĩa (thử lại vô ích). Nhánh nào cũng kết bằng
*"file was NOT changed — do not report this edit as done"*.

**Kiểm cú pháp sau khi ghi** (`kiem-cu-phap.ts`): mỗi lần `FileWrite`/`FileEdit`
thành công, harness chạy một phép kiểm CÚ PHÁP theo đuôi tệp rồi gắn kết quả
vào chính `tool_result` đó — `[SYNTAX OK]` hoặc `[SYNTAX ERROR] … do not report
this task as done`.

| Đuôi | Cách kiểm | Ghi chú |
|---|---|---|
| `.js` `.mjs` `.cjs` | `node --check` | Node 22 tự nhận diện cú pháp module, `import` không báo giả |
| `.json` | `JSON.parse` trong tiến trình | không đẻ tiến trình con |
| `.ts` `.tsx` `.mts` `.cts` | `ts.createSourceFile` → `parseDiagnostics` | `typescript` là **external**; không cài thì bỏ qua |
| còn lại | — | trả `dat: null`, **im lặng** |

Ba luật khi mở rộng bảng này:
- **Chỉ cú pháp.** Kiểm kiểu một tệp lẻ ngoài ngữ cảnh dự án nôn ra hàng loạt
  lỗi "không tìm thấy module" — báo động giả đẩy model đi sửa thứ không hỏng.
- **Không biết thì im.** Đuôi lạ, tiến trình hết giờ, không có `node` → `null`,
  nơi gọi không nói gì.
- **Nói cả khi ĐẠT.** Một câu xác nhận rẻ cũng là bằng chứng model được phép
  trích dẫn; thiếu bằng chứng chính là lý do nó phải chọn giữa nói dối và
  không báo cáo được gì.

**Hợp đồng chung mọi tool** (`tool-contract.ts` + `tool-executor.ts`):
tham số lệch kiểu được sửa hộ và **báo lại** → kiểm tra schema → lỗi dịch sang
chữ model đọc được → tên tool sai thì gợi ý tên gần nhất → kết quả > 16.000 ký
tự thì **ghi ra đĩa** kèm bản xem trước, tổng cả lượt > 64.000 cũng vậy.

---

## 7. Quyền — bốn tầng ưu tiên

```
100  LUAT_NGUY_HIEM        18 luật: rm -rf, sudo, ghi .env, git reset --hard…
 50  cho phép dựng sẵn      FileRead, Grep, Glob, LoadSkill, ScheduleTask,
                            TodoWrite, Bash(ls|cat|git status|git diff)
 45  "Luôn cho phép"        người dùng bấm trong editor → Tool(*)
 40  luật của agent.json    rules[] trong cấu hình dự án
  —  còn lại               → hỏi người dùng (chat/serve) · chặn (guard)
```

Ưu tiên 45 thấp hơn 100 nên **"Luôn cho phép Bash" vẫn không mở được `rm -rf`**.
Nhưng nó mở mọi thứ khác — đó là lý do sandbox tồn tại (§8).

---

## 8. Cô lập — hai tầng khác hẳn nhau

| | Tầng chính sách | Tầng nhân |
|---|---|---|
| Cách làm | so khớp chuỗi trong tham số | bọc argv bằng bubblewrap/seatbelt |
| Bắt được | lệnh viết đúng khuôn đã liệt kê | mọi thứ, kể cả không lường trước |
| Bỏ lọt | `r=rm; $r -rf` — đo thật | — |
| Bật bằng | luôn bật | `sandbox: true`, **mặc định tắt** |

---

## 9. Cấu hình `.agentweave/agent.json`

| Trường | Mặc định | Đụng tới |
|---|---|---|
| `model` `maxTurns` `budget` | qwen3-coder:30b · 50 · — | vòng lặp |
| `contextWindow` | suy từ env → 65.536 | **ngưỡng nén** — sai là tràn âm thầm |
| `permissionMode` `rules` | default · [] | tầng quyền |
| `systemPrompt` | — | kênh 1 |
| `offline` | **true** | câu KHÔNG-MẠNG |
| `sandbox` `sandboxReadOnly` | **false** · [] | cô lập tầng nhân |
| `danhSachViec` | **false** | tool TodoWrite + câu dẫn |
| `structuredProtocol` | true | ép envelope JSON |
| `bashTimeoutMs` | 600.000 | tool Bash |
| `temperature` `topP` `repeatPenalty` `seed` | **không gửi** | bộ sinh — xem dưới |
| `maxDurationMs` | **không có trần** | phanh thời gian — xem dưới |
| `vetTich` | **true** | ghi vết tích §14 — bật mặc định giai đoạn này |
| `orgSkillsDir` `orgRulesDir` | env · null | tri thức tầng tổ chức |
| `visionModel` | tự dò | lượt có ảnh |

**Tham số sinh — bỏ trống nghĩa là KHÔNG GỬI**, để mặc định của Modelfile
thắng. Đặt một con số "trông có vẻ đúng" là âm thầm ghi đè cấu hình mà người
vận hành đã cân. Hai điểm phải biết:

- `num_ctx` **luôn** được gửi (bằng `contextWindow`) trên đường có ràng buộc.
  Trước 2026-08-23 nó không bao giờ được gửi: cửa sổ 65.536 chỉ là giả định
  phía client, server có thể đang chạy nhỏ hơn và cắt cụt prompt trong im lặng
  — agent quên đề bài mà mọi số đo vẫn xanh.
- Đường **stream** đi qua endpoint tương thích OpenAI nên **không có** `num_ctx`,
  và `repeatPenalty` được quy sang `frequencyPenalty = repeatPenalty - 1`. Hai
  thang đo không tương đương chính xác. Đây là một lý do nữa để đường có ràng
  buộc là mặc định.

### Bản đồ phanh — cái nào thật sự đạp được

| Phanh | Với model đám mây | Với model cục bộ |
|---|---|---|
| `budget` (USD) | có tác dụng | **CHẾT** — giá luôn 0, ngưỡng không bao giờ chạm. `chat` cảnh báo khi ông đặt nó |
| `maxTurns` | có | có, nhưng đếm LƯỢT chứ không đếm giờ — 50 lượt của model 30B trên Jetson có thể là 40 phút |
| `maxDurationMs` | có | **phanh duy nhất theo thời gian**; mặc định tắt |
| `bashTimeoutMs` | có | chỉ chặn MỘT lệnh, không chặn phần tích luỹ |
| trần lặp (§3 #6, #7) | có | có — cắt ở 5 và 8 |

`maxDurationMs` kiểm ở **đầu mỗi lượt**, không kiểm giữa lượt: cắt ngang một
lệnh Bash đang chạy sẽ để lại tiến trình mồ côi và file ghi dở.

---

## 10. Trạng thái trên đĩa

```
.agentweave/                      (đã trong .gitignore)
├─ agent.json                     cấu hình dự án
├─ rules/*.md                     rule dự án
├─ skills/<tên>/{skill.json,SKILL.md}
├─ memory/{MEMORY.md,<slug>.md}
├─ sessions/<id>.json             hội thoại đã lưu
│  └─ <id>/tool-results/*.txt     kết quả tool quá lớn
├─ vet-tich/<phien>/               VẾT TÍCH — xem §14
│  ├─ vet-tich.jsonl              một dòng một điểm chạm
│  └─ noi-dung/<stt>-<ten>        payload lớn, NGUYÊN VẸN
├─ audit.log · metrics/ · credentials
AGENTS.md · AGENTS.local.md       rule ở gốc dự án
```

---

## 11. Bản đồ ảnh hưởng — **tra trước khi sửa**

| Sửa chỗ này | Thì phải kiểm lại |
|---|---|
| `system-prompt.ts` | tốc độ sinh (prompt dài = chậm cả phiên) · test `co-lap` |
| ngưỡng ghì model (§3) | test `mat-na-tool` + `ve-sinh-bo-dem` · quan hệ #6↔#7 · **mặt nạ phải khớp câu nhắc** |
| `context-manager.ts` | cặp tool_use/tool_result · whitelist nén · ngắt mạch |
| ngân sách skill/memory | tổng cả ba + câu dẫn phải vừa cửa sổ THẬT |
| thêm tool | luật quyền (nếu không sẽ bị hỏi mỗi lần) · `TOOL_NEN_DUOC` · hiển thị ở webview |
| `packages/types` | **mọi gói** — build lại tất cả theo thứ tự phụ thuộc |
| giao thức serve↔editor | §12 — webview bỏ qua tin lạ, thêm thì an toàn, ĐỔI tên thì vỡ |
| `sdlc/` | §13 — đường chạy riêng, KHÔNG có rule/skill/memory trừ khi nối tay |
| `do-hieu-nang.ts` | §12 — chat VÀ serve dùng chung; sửa một chỗ, hai lệnh cùng đổi |
| `loi-tep.ts` | §6 — FileEdit và FileWrite cùng dùng |
| `bash.ts` (cách chạy) | §6 — phải giữ nhóm tiến trình, bỏ đi thì khoá tệp quay lại |
| `render-lich-su.ts` | GỐC RỄ tầng 0 — mọi cơ chế §3 giả định model ĐỌC ĐƯỢC lịch sử tool. Test `render-lich-su` · kiểm lại `chuanHoaCapTool` |
| `kiem-cu-phap.ts` | §6 — chạy sau MỌI lần ghi; thêm đuôi thì thêm test khoá luật "không biết thì im" |
| `nhacGuard`/`locNhacGuard` | §2 — đổi nhãn thì `chat`/`serve` lọc hụt và nhắc bị lưu vĩnh viễn vào phiên |
| tham số sinh (§9) | truyền ở CẢ HAI đường; `num_ctx` chỉ có ở đường có ràng buộc |
| `tool-call-recovery.ts` | §1 ⑥ — lời gọi CỨU được phải qua cổng đối chiếu `demGoiTrung`, nếu không văn xuôi nhại lại lịch sử sẽ chạy thành lệnh thật |
| trần thời gian / `timeoutMs` | §9 bảng phanh — đổi chỗ kiểm ra giữa lượt là để lại tiến trình mồ côi |
| điểm chạm vết tích (`this.vet(...)`) | §14 — **chỉ quan sát**, thêm chỗ gọi không được đổi một quyết định nào. Test `vet-tich` khoá điều này |
| `LOAI_DIEM_CHAM` | §14 — bộ đọc khớp đúng chuỗi nhãn. Thêm nhãn thì an toàn, ĐỔI tên thì bộ đọc mất dấu |
| bất cứ gì ở inner-harness | `npm run build` inner → sdk → cli, nếu không CLI vẫn chạy bản cũ |

**Thứ tự build bắt buộc:** `types → control-plane → inner-harness → sdk → cli`.
Bỏ qua một mắt xích thì `dist/bin.js` vẫn là bản cũ và mọi phép thử đều sai.

---

## 12. Luồng sự kiện: agent → người dùng

Ba chặng, **ba từ vựng khác nhau**. Đây là chỗ dễ lạc nhất khi gỡ rối, vì cùng
một việc mang ba cái tên.

```
AgentLoop              serve.ts              webview (chat.js)
──────────             ────────              ─────────────────
InnerEvent      ──►    thông điệp     ──►    khối giao diện
(31 loại)              giao thức             (24 nhánh)
                       (18 loại)
```

### Bảng đổi tên — tra khi một sự kiện "biến mất"

| InnerEvent | → serve phát | → webview vẽ |
|---|---|---|
| `llm:stream_delta` | `delta` | chữ chảy vào khối đang chạy |
| `llm:text_corrected` | `text_corrected` | thay khối bằng bản đã làm sạch |
| `tool:requested` | `tool` | dòng `⚡ TênTool` (**ẩn nếu là TodoWrite**) |
| `tool:completed` | `tool_result` | dấu ✓ + bản xem trước |
| `tool:failed` | `tool_result` (ok:false) | dấu ✗ |
| `permission:denied` | `denied` | khối từ chối |
| `context:usage` | `context` | thanh % ngữ cảnh |
| `context:compacted` | `compacted` | dòng "đã nén" |
| `context:reminder` | `notice` | dòng `ⓘ đã bơm …` — **kể cả câu răn của guard** (`loai: ["guard"]`) |
| `recovery:retry` | `recovered` | dòng `↻ lý do` |
| `error` | `error` | khối lỗi + gợi ý sửa |
| — (host tự phát) | `notice` `turn_start` `model_switched` `attached` `undone` … | |
| — (host chốt cuối lượt) | **`turn_end`** | dãy ô số đo + cảnh báo kiểm tra |
| `sdlc:stage_start/end` ¹ | `pipeline_stage` | dòng `⏳/✓/✗ <bước>` trong khối pipeline |
| — (host phát) | `pipeline_start` `pipeline_end` | mở/đóng khối 8 bước |

¹ **Không đi qua luồng generator.** `module-runner` bắn thẳng vào
`governance.onEvent`, nên `serve` phải BỌC `GovernanceHandle` để thấy chúng —
nối theo `value.type` trong vòng lặp sự kiện thì không nhận được gì. Đã vấp
đúng lỗi này: pipeline chạy xong mà editor chỉ thấy start rồi end.

### `turn_end` — thông điệp giàu nhất, và nó KHÔNG đến từ InnerEvent

Host tự dựng lúc `gen.next()` trả `done`, mang theo: `usage` · `context` ·
`edited` (file đã sửa) · `ranCheck` · `checkOutcome` · và **kết quả bộ đo**.

```
cli/lib/do-hieu-nang.ts  ← MỘT bộ đo duy nhất, dùng chung cho chat và serve
   moLoiGoi()   ← llm:request_start
   moDelta()    ← llm:stream_delta   (token chữ đầu → TTFT)
   dongLoiGoi() ← llm:stream_end     (chốt khoảng sinh của lượt gọi)
   themTool()   ← tool:requested
   chot()       → { totalMs, ttftMs, genMs, tokPerSec, toolCalls }
```

Đặt ở **tầng host** chứ không ở inner-harness là bắt buộc: nó phải trừ thời
gian người dùng ngồi nghĩ và thời gian chờ duyệt quyền (`dongHoChoNguoi`) —
hai thứ chỉ host mới biết.

**Ba luật khi sửa bộ đo:**
- `tokPerSec = null` nghĩa là **không đo được**, nơi gọi phải ẩn ô đó. In `0.0`
  là bịa một phép đo — người dùng đọc thành "máy chậm tới mức không sinh nổi chữ".
- Mẫu số là tổng khoảng SINH của từng lượt gọi LLM, không phải cả lượt agent.
  Tính cả thời gian chạy tool vào mẫu số thì tok/s thấp hẳn so với thực.
- Bất biến `chờ + sinh ≤ tổng` phải luôn đúng; có test khoá điều này.

**Sự kiện KHÔNG được chuyển tiếp** (chỉ dùng nội bộ hoặc cho `run`/kiểm toán):
`turn:start` `turn:end` `llm:request_start` `llm:stream_end` `tool:started`
`message:assistant` `message:tool_result` `permission:allowed` `permission:asking`
`recovery:fallback` `terminal` `agent:*` (riêng `sdlc:stage_*` NAY có chuyển
tiếp — xem bảng trên).

**Vết tích KHÔNG đi qua đường này.** `InnerEvent` là kênh cho NGƯỜI DÙNG xem
lúc chạy, nên nó cố tình gọn. Vết tích (§14) là kênh cho người MỔ XẺ về sau,
nên nó giữ nguyên payload. Hai mục đích khác nhau, đừng gộp: nhồi trọn chuỗi
prompt vào `InnerEvent` thì webview phải tải vài trăm KB mỗi lượt.

### Bộ vẽ markdown của webview — hai bẫy đã vấp

`veDoanChu` trong `media/chat.js` tự dựng markdown theo DÒNG. Hai luật rút từ
lỗi thật ("model toàn đánh số 1, không có số 2"):

- **Dòng trống giữa hai mục KHÔNG được đóng danh sách.** Model viết danh sách
  "thoáng" — mỗi mục cách nhau một dòng trống, rất hay gặp khi mục có dẫn đề
  in đậm. Bản trước đóng danh sách ở bất kỳ dòng nào không phải mục, nên mỗi
  mục thành một `<ol>` riêng chứa đúng một `<li>`, và `<ol>` nào cũng bắt đầu
  từ 1. Phải nhìn TỚI dòng không trống kế tiếp mới quyết định đóng hay không.
- **Giữ số bắt đầu thật** (`ol.start`). Danh sách bị ngắt giữa chừng (vd mục
  có danh sách con thụt lề) thì phần sau vẫn phải nối đúng số, không được để
  trình duyệt đánh lại từ 1 — đánh lại là bịa ra một thứ tự khác với thứ tự
  model nói, và người đọc sẽ trích dẫn nhầm mục.

Vết tích chứng minh model KHÔNG sai: `llm:nhan` cho thấy nó nhả ra đúng
`1. 2. 3. 4.` ở cả 8 câu trả lời của phiên bị than phiền. Đây là bài học về
việc đổ lỗi cho model trước khi kiểm tầng hiển thị.

Muốn thêm thứ hiện lên editor thì **chọn một trong hai**:
- Việc hiếm, chỉ cần một dòng chữ → dùng lại `notice`, **không phải đổi giao thức**
- Việc cần giao diện riêng → thêm loại mới; webview không có nhánh `default`
  nên bản cũ **bỏ qua im lặng**, thêm thì an toàn, ĐỔI tên thì vỡ

### Chiều ngược: editor → serve

`prompt` · `permission` · `abort` · `reset` · `resume` · `undo` · `set_model` ·
`list_models` · `list_sessions` · **`pipeline`**

Gõ sai tên ở chiều này thì serve trả `{"type":"error","message":"khong hieu type=…"}`
— đã vấp khi em thử gửi `hoi` (tên nội bộ của webview) thay vì `prompt`.

---

## 13. Pipeline SDLC — trụ cột thứ hai

Đây là **đường chạy khác hẳn** `AgentLoop`. Không dùng chung vòng lặp, không
dùng chung cơ chế ghì model. Nó bọc một agent (nội bộ hoặc Claude Code qua
adapter) trong một quy trình có cổng chất lượng.

```
                    ┌──────────────┐
   yêu cầu thô ───► │taskNormalizer│  chuẩn hoá thành SDLCTask
                    └──────┬───────┘
                    ┌──────▼───────┐
                    │contextBuilder│  nhét file liên quan vào ngữ cảnh
                    └──────┬───────┘
                    ┌──────▼───────┐
                    │planGenerator │  sinh kế hoạch từng bước
                    └──────┬───────┘
                    ┌──────▼───────┐
                    │ qualityGate  │  ① chạy TRƯỚC — chụp mốc "trước khi sửa"
                    └──────┬───────┘
        ┌──────────────────▼───────────────────┐
        │  ┌──────────────┐                    │
        │  │executionBridge│ giao cho agent    │
        │  └──────┬───────┘                    │
        │  ┌──────▼───────┐                    │
        │  │patchValidator │ thay đổi có đúng  │   VÒNG LẶP
        │  └──────┬───────┘ phạm vi không      │   THỬ LẠI
        │  ┌──────▼───────┐                    │
        │  │ qualityGate  │ ② test/lint/build  │
        │  └──────┬───────┘                    │
        │      đạt ├─── không ──┐              │
        │         │      ┌──────▼──────┐       │
        │         │      │ retryEngine │ phân  │
        │         │      └──────┬──────┘ loại  │
        │         │   shouldRetry│ lỗi         │
        │         │      ┌───────┴────┐        │
        │         │     có│          không     │
        │         │       └──► quay lại ───────┘  break
        └─────────┼──────────────────────────────┘
           ┌──────▼───────────┐
           │outputStandardizer│  commit message · tiêu đề PR
           └──────────────────┘
```

**Thứ tự thật** (trích từ `stage:` trong `sdlc-orchestrator.ts`):
`taskNormalizer → contextBuilder → planGenerator → qualityGate → executionBridge
→ patchValidator → qualityGate → retryEngine → executionBridge → qualityGate
→ outputStandardizer`

`qualityGate` chạy **ba lần** là có chủ đích: lần đầu lấy mốc (để biết test nào
vốn đã đỏ trước khi agent đụng vào), lần hai chấm kết quả, lần ba chấm sau khi
thử lại. Không có mốc đầu thì mọi test đỏ sẵn đều bị quy cho agent.

| Module | Trách nhiệm |
|---|---|
| `task-normalizer` | yêu cầu thô → `SDLCTask` có cấu trúc |
| `context-builder` | chọn file liên quan nhét vào ngữ cảnh |
| `plan-generator` | sinh kế hoạch từng bước |
| `execution-bridge` | giao việc cho `AgentLoop` / `ProcessAdapter` / adapter khác |
| `patch-validator` | thay đổi có nằm trong phạm vi cho phép không |
| `quality-gate` | chạy test · lint · compile · typecheck |
| `output-standardizer` | commit message, tiêu đề và mô tả PR |
| `retry-engine` | phân loại lỗi, quyết định có thử lại không |

**Quan hệ với phần còn lại của bản đồ:** SDLC gọi `AgentLoop` qua
`execution-bridge`, nên **mọi cơ chế ở §3 và §4 vẫn có hiệu lực bên trong**.
Nhưng nó **không** dùng `napTriThuc`, nên rule/skill/memory/hẹn giờ **không tự
có** trong pipeline — muốn có thì phải nối riêng. Vết tích (§14) thì ĐÃ nối.

### Model và cách chạy — theo ĐÚNG chuỗi ưu tiên của chat/serve

```
--model  >  agentweave.yaml execution.agentLoop.model  >  .agentweave/agent.json model  >  qwen3-coder:30b
```

Dùng `||` chứ không `??`: `parseArgs` trả `model = ""` khi không có cờ (cố ý,
để `agent.json` còn cửa thắng). Chuỗi rỗng lọt qua `??` và đi thẳng tới Ollama,
nhận về **400** mà thông báo không nói gì về model — đã đo đúng ca đó.

`execution-bridge` truyền xuống `AgentLoop` đủ bộ như chat/serve:
`structuredProtocol` (mặc định BẬT), `contextWindow`, tham số sinh, và vết
tích. Thiếu chúng thì cùng một model chạy trong pipeline lại tệ hơn chạy trong
chat mà không có gì báo: rơi về đường stream (mất đòn bẩy enum), cửa sổ ngữ
cảnh là số đoán, `num_ctx` không tới Ollama.

**Cạm bẫy:** không có `agentweave.yaml` và KHÔNG truyền `--agent` thì
`pipeline run` **tự dò CLI agent đã cài** (claude, cursor, aider) và chuyển
sang `process-adapter` — không dùng model cục bộ. Muốn chắc chắn chạy
`agent-loop` thì khai `execution.mode` trong `agentweave.yaml`.

### Gọi từ VS Code

Lệnh **"AgentWeave: Chạy pipeline SDLC"** hỏi hai thứ (việc cần làm, lệnh
kiểm) rồi gửi `{"type":"pipeline",...}` cho `serve`. Quyền dùng CHUNG cơ chế
với chat (`permission_request` + hàng chờ), nên người dùng thấy đúng hộp thoại
quen thuộc.

Khi gọi từ editor, ba bước đầu (`taskNormalizer`, `contextBuilder`,
`planGenerator`) **được BẬT** — khác mặc định dòng lệnh, vì ở đây không có
agent CLI nào lo hộ.

Lệnh liên quan: `agentweave pipeline setup|run|status|config` · `agentweave metrics`.

---

## 14. Vết tích — soi mọi điểm chạm dữ liệu

Trả lời một câu hỏi mà ba tầng log cũ đều không trả lời được: **model thật sự
ĐỌC được gì?**

Trước đợt này, thứ gần nhất với một bản ghi là ba mảnh rời và không mảnh nào
đủ:

| Có sẵn | Vì sao không dùng được |
|---|---|
| `AuditLogger` (outer-harness) | chỉ nằm trong RAM, trần 10.000 mục, **không bao giờ ghi đĩa** |
| `.agentweave/audit.log` | chỉ lệnh `guard` ghi vào; đường chat/serve không đụng tới |
| `InnerEvent` (31 loại) | `llm:request_start` chỉ mang `{model, estimatedInputTokens}` — **nội dung gửi model không tồn tại ở đâu cả** |

Chính vì thiếu mảnh thứ ba mà `RA-SOAT-DIEU-KHIEN.md` phải chặn ở tầng mạng
mới phát hiện được lỗi tầng 0 (model mù về hành động của chính nó). Việc đó
đáng lẽ phải đọc được từ một tệp.

### Bật — MẶC ĐỊNH BẬT

```
(không cần khai gì)                             bật sẵn cho MỌI dự án
.agentweave/agent.json → "vetTich": false       tắt theo dự án
AGENTWEAVE_TRACE=0                              tắt, ép, tiện cho script bọc
```

Bật mặc định là lựa chọn **có chủ đích cho giai đoạn sản phẩm còn chạy chưa ổn
định**: một lần agent hỏng mà không tái hiện được là một buổi phải chạy lại,
đắt hơn nhiều so với chỗ đĩa. Khi sản phẩm ổn định thì đảo lại trong
`cli/src/lib/vet-tich-tep.ts` → `batVetTich` (`cauHinh !== false` → `=== true`).

Áp cho cả ba đường vào: `chat`, `serve`, `run`. Pipeline SDLC (§13) **chưa**
nối — nó là đường chạy riêng.

Mỗi phiên sinh `.agentweave/vet-tich/<phien>/`; **giữ 20 phiên gần nhất** rồi
tự dọn, cùng con số với `sessions/`. Không dọn thì đĩa Jetson đầy dần trong im
lặng — kiểu hỏng tệ nhất vì nó không báo gì cho tới lúc mọi thứ cùng hỏng.

### Ba luật bất biến

- **Chỉ QUAN SÁT.** Bật vết tích không được đổi một quyết định nào của agent —
  ghi nhận mà làm đổi hành vi thì cái ghi được là hành vi khác. Có test khoá.
- **Không bao giờ ném, không bao giờ chặn.** Ghi hỏng thì mất vết tích, không
  được mất lượt trả lời. Hỏng một lần là ngưng hẳn, khỏi bơm nghìn dòng lỗi.
- **Tầng trong KHÔNG chạm đĩa.** `inner-harness` phát `DiemCham`, host quyết
  định ghi đi đâu — cùng ranh giới với đồng hồ hẹn giờ và bộ đo hiệu năng (§0).

### Bảng điểm chạm

| Tầng | Nhãn | Bắt được gì |
|---|---|---|
| user | `user:cau-hoi` | câu người dùng GÕ, nguyên văn |
| user | `user:duyet-quyen` | bấm cho phép hay từ chối, tool nào, có "luôn cho phép" không |
| user | `user:lenh` | abort/reset/undo/set_model |
| host | `host:cau-day-du` | câu sau khi host chèn nội dung file — **phần agent nhận thêm mà người dùng không thấy** |
| host | `host:chot-luot` | reason, token, file đã sửa, đã kiểm chứng chưa, số đo |
| agent | `agent:nen` | mức nén, bỏ bao nhiêu, độ đầy trước đó |
| agent | `agent:nhac` | nhắc bơm vào, nguyên văn |
| agent | `agent:chuan-hoa-cap` | cặp tool nào bị lệch và sửa ra sao |
| agent | `agent:guard` | **cơ chế nào nổ, nhịp mấy trên mấy, mặt nạ đặt cho lượt sau** |
| agent | `agent:cuu-tool-call` | cứu mấy lời gọi, bỏ mấy vì nhại lại lịch sử |
| agent | `agent:quyen` | quyết định quyền, nguồn, thời gian chờ người |
| **llm** | **`llm:gui`** | **TRỌN chuỗi gửi model**: system prompt, mọi tin nhắn, tool sau mặt nạ, `options` |
| **llm** | **`llm:nhan`** | **raw trả về**, chưa qua một bước diễn giải nào |
| llm | `llm:hong` | mã lỗi, thông báo, thời lượng |
| tool | `tool:xong` / `tool:hong` | tham số VÀO và kết quả RA, thời lượng |
| tool | `tool:kiem-cu-phap` | đạt/không đạt sau khi ghi file |

Hai nhãn `llm:*` là lý do cả mục này tồn tại. Chúng ghi **nguyên vẹn**, không
cắt: một chuỗi bị cắt thì không đối chiếu được với thứ model trả lời, mà đối
chiếu đúng chỗ đó mới là cách tìm ra ngữ cảnh trôi.

**Hai đường ghi không tương đương.** Đường có ràng buộc ghi đúng thân request
gửi Ollama. Đường stream chỉ ghi được ĐẦU VÀO của AI SDK — schema tool do SDK
ghép thêm nằm ngoài, nên `tongKyTu` đếm thiếu (đo thật: 1.206 ký tự ghi nhận
so với 1.759 token Ollama báo). Khi cần con số đúng thì lấy `tokenVao` ở
`llm:nhan`. `chat`/`serve` mặc định đi đường có ràng buộc; `run` đi stream.

### Hình dạng trên đĩa

Payload nhỏ (≤512B) nằm thẳng trong JSONL; lớn hơn thì tách ra
`noi-dung/<stt>-<ten>` kèm số byte và sha. Nhờ vậy `vet-tich.jsonl` luôn mở
được bằng `head`, còn payload thì `diff` được giữa hai lượt.

Ghi bằng I/O **đồng bộ**, có chủ đích: lượt đáng giá nhất là lượt cuối trước
khi mọi thứ hỏng, và đó đúng là lượt dễ mất nhất nếu còn nằm trong bộ đệm lúc
tiến trình bị giết. Một dòng vài trăm byte tốn vài chục micro-giây, không đáng
kể so với một lượt sinh của model 30B tính bằng giây.

### Đọc lại

```
agentweave vet-tich                 dòng thời gian phiên mới nhất
agentweave vet-tich --danh-sach     liệt kê các phiên
agentweave vet-tich --luot 3        chỉ lượt 3
agentweave vet-tich --tang llm      chỉ ranh giới gọi model
agentweave vet-tich --xem 42        đổ NGUYÊN VẸN payload điểm chạm #42
```

Quy trình mổ xẻ đầy đủ + bảng chẩn đoán nhanh: `docs/SO-TAY-VET-TICH.md`.

**Cách dùng khi agent cư xử vô lý:** chạy `--tang llm` trước để xem model nhận
được bao nhiêu và trả về gì; thấy lượt nào lạ thì `--xem <stt>` đổ trọn chuỗi
ra rồi đối chiếu với `agent:guard` cùng lượt — ba thứ đó cạnh nhau trả lời
được "guard có tới được model không, hay nó nổ trong im lặng".
