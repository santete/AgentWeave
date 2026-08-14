# Hệ thống Skill

Skill là **tri thức quy trình đóng gói thành chữ** — thứ agent không suy ra được
từ mã nguồn: quy ước của công ty, ràng buộc nghiệp vụ, thứ tự các bước.

Tool cho agent *làm được việc*. Skill cho agent *biết công ty làm việc thế nào*.

> Skill **không** kèm tool riêng. Kèm tool thì thành plugin — phức tạp hơn nhiều,
> để phiên bản sau. Phiên bản này skill chỉ là chữ.

---

## 1. Nguyên tắc: chỉ mục luôn có mặt, nội dung nạp khi cần

Đây không phải tối ưu sớm mà là ràng buộc vật lý đo được trên Jetson AGX Thor:

| Context | Tốc độ sinh |
|---|---|
| ~30 token | 63,4 tok/s |
| 16.000 token | 41,7 tok/s |

**Context đầy làm tốc độ giảm 34%.** Nhồi sẵn mọi hướng dẫn vào system prompt là
trả giá bằng tốc độ suốt cả phiên. Nên chỉ mục chỉ chứa `name` + `whenToUse`;
nội dung đầy đủ chỉ vào hội thoại khi agent chủ động gọi `LoadSkill`.

---

## 2. Cấu trúc

```
.agentweave/skills/
├── review-pr/
│   ├── skill.json      # siêu dữ liệu — luôn nạp
│   └── SKILL.md        # nội dung đầy đủ — nạp khi cần
└── quy-uoc-dotnet/
    ├── skill.json
    └── SKILL.md
```

`skill.json`:

```json
{
  "name": "review-pr",
  "description": "Quy trinh review pull request cua cong ty",
  "whenToUse": "Khi duoc giao review code truoc khi merge",
  "version": "1.0.0",
  "tags": ["quy-trinh", "chat-luong"]
}
```

| Trường | Bắt buộc | Ghi chú |
|---|---|---|
| `name` | ✅ | kebab-case, **phải trùng tên thư mục** |
| `description` | ✅ | cho người đọc; **không** vào chỉ mục |
| `whenToUse` | ✅ | **vào chỉ mục** — giữ dưới 100 byte |
| `version` | — | ghi vào kết quả `LoadSkill` để kiểm toán |
| `tags` | — | phân loại, tối đa 10 |

Skill hỏng (thiếu `SKILL.md`, JSON sai, tên lệch thư mục) **bị loại khỏi chỉ mục
và báo ra console** — không bao giờ bỏ qua im lặng. Trong air-gap, một skill lỗi
mà không ai biết còn tệ hơn không có skill.

---

## 3. Ba phạm vi

| Phạm vi | Đường dẫn | Dùng cho |
|---|---|---|
| `project` | `<gốc dự án>/.agentweave/skills/` | quy ước riêng của dự án |
| `user` | `~/.agentweave/skills/` | ghi chú cá nhân của dev |
| `org` | `$AGENTWEAVE_ORG_SKILLS` | skill công ty, đóng băng lúc đóng gói |

Trùng tên thì **phạm vi hẹp hơn thắng** (project > user > org). Bản bị che được
ghi lại trong báo cáo để người vận hành biết, không biến mất âm thầm.

---

## 4. Nối vào harness

Một lệnh làm cả ba việc: quét đĩa, chèn chỉ mục vào system prompt, đăng ký tool.

```ts
import { AgentLoop, installSkills } from "@agentweave/inner-harness";

const loop = new AgentLoop({ model: "qwen3-coder:30b", systemPrompt: "..." });

const { registry, report } = await installSkills(loop, {
  orgSkillsDir: "/opt/agentweave/skills",   // mặc định lấy từ AGENTWEAVE_ORG_SKILLS
});

console.log(report.skills.length, report.indexBytes);
```

Gọi lại `installSkills` sau khi thêm skill mới cũng được — chỉ mục không bị lặp
và tool được thay bằng bản trỏ tới registry vừa quét.

Nếu cần tự nối từng bước:

```ts
const registry = new SkillRegistry({ orgSkillsDir });
await registry.discover();
loop.setSystemPromptSection("skills", registry.renderIndex());
loop.registerTool(createLoadSkillTool(registry));
```

---

## 5. Ngân sách context

Đo thật trên 3 skill mẫu trong `examples/skills/`:

| Khoản | Cỡ |
|---|---|
| Khung chỉ mục (cố định, không phụ thuộc số skill) | 236 byte |
| Mỗi skill trong chỉ mục | 60–90 byte |
| 3 skill → tổng chỉ mục | **435 byte** |
| 50 skill → tổng chỉ mục (ngoại suy) | ~3,7 KB ≈ 1.030 token ≈ **1,6% của context 64K** |
| Nạp một skill 2,2 KB | ~820 token cho lượt đó |

**Trần khuyến nghị: 50 skill mỗi phạm vi.** Vượt ngưỡng thì `SkillRegistry` cảnh
báo chứ không chặn — nhưng chỉ mục bắt đầu ăn vào phần dành cho code, và model
nhỏ cũng khó chọn đúng giữa quá nhiều lựa chọn.

`SKILL.md` vượt 32 KB sẽ bị cắt kèm dòng `[TRUNCATED]` ghi rõ đã cắt bao nhiêu —
không cắt lặng lẽ.

---

## 6. Câu dẫn chỉ mục: đo được, không phải ý thích

Bản đầu viết:

> `Available skills. Call LoadSkill ..., but only when the task matches ...`

`qwen3-coder:30b` **bỏ qua hoàn toàn** — trả lời từ trí nhớ dù đề bài khớp hẳn một
skill. Model 30B bám vế đầu câu; vế nhượng bộ đứng sau làm loãng chỉ thị.

Bản hiện tại đặt điều kiện **trước** hành động và dùng thể mệnh lệnh:

> `If the task matches a line below, you MUST call LoadSkill with that name and
> follow it before answering. Do not answer from memory instead.`

Kết quả 6 phép thử với `qwen3-coder:30b` (mỗi phép thử một phiên sạch):

| Đề bài | Kỳ vọng | Kết quả |
|---|---|---|
| "agent chậm và bịa tên file, chẩn đoán giúp" | `xu-ly-su-co-offline` | ✅ đúng |
| "sửa code C# trong dự án này, thêm validation" | `quy-uoc-dotnet` | ✅ đúng |
| "nên dùng model nào cho việc sinh boilerplate" | `chon-model` | ✅ đúng |
| "đổi model sang loại nào để chạy nhanh hơn" | `chon-model` | ✅ đúng |
| "2 cộng 2 bằng mấy" | không nạp gì | ✅ không nạp |
| "viết một hàm C# tính giai thừa" | biên | ⚪ không nạp |

Trường hợp cuối là **giới hạn thật**: đề bài không nhắc tới dự án nên không khớp
`whenToUse` ("... trong dự án này"), model bỏ qua. Muốn bắt được thì phải sửa
`whenToUse` cho rộng hơn — nhưng rộng quá lại nạp nhầm. Đây là đánh đổi phải cân
theo từng skill, không có cấu hình nào giải quyết hộ.

---

## 7. Vì sao là tool chứ không tự động nạp theo từ khoá

1. Tự động dễ nạp nhầm, mà **mỗi lần nạp nhầm mất cả context lẫn tốc độ**.
2. Để model chủ động gọi thì lệnh gọi nằm trong event stream → **kiểm toán được**:
   biết chính xác skill nào đã ảnh hưởng tới câu trả lời nào.

`registry.loadStats()` đếm số lần từng skill được nạp, dùng để phát hiện skill
nạp thừa hoặc skill không bao giờ được dùng.

---

## 8. Khi skill không được nạp — chẩn đoán theo thứ tự

```bash
node examples/skill-demo.mjs          # quét, in chỉ mục, tự kiểm tra — không gọi model
```

| Dấu hiệu | Nguyên nhân |
|---|---|
| `chỉ mục trong system prompt: KHÔNG` | chưa gọi `installSkills`, hoặc không có skill hợp lệ nào |
| Có skill trên đĩa nhưng không vào chỉ mục | xem dòng `BO QUA SKILL` in ra console |
| Chỉ mục có mà model không gọi | `whenToUse` không khớp đề bài, hoặc quá mơ hồ |
| `LoadSkill` báo `Unknown skill` | tên trong manifest lệch tên thư mục |

> ⚠️ Trước phiên bản này, `systemPrompt` của `AgentLoop` được lưu nhưng **không bao
> giờ gửi tới LLM**. Mọi thứ đặt qua `setSystemPromptSection()` đều vô hình mà
> không có dấu hiệu nào báo sai. Đã vá. Dùng `loop.getSystemPrompt()` để xác nhận
> nội dung thật sự được gửi đi, đừng tin là đã vào.

---

## 9. Viết một skill tốt

1. **Chỉ viết thứ không suy ra được từ code** — quy ước ngầm, ràng buộc nghiệp vụ, lý do lịch sử.
2. **Thể mệnh lệnh**, không kể chuyện: "Dùng X" thay vì "Chúng tôi thường dùng X".
3. **Dưới 200 dòng.** Model 30B tuân thủ chỉ thị kém hơn model biên giới; skill dài dễ bị bỏ qua từ giữa chừng.
4. **Một skill một việc.** Trùng lặp giữa các skill làm model nạp thừa.
5. **`whenToUse` dưới 100 byte** — trường này nằm thường trực trong system prompt của mọi phiên.

Xem `examples/skills/` để có ba ví dụ chạy được, trong đó `quy-uoc-dotnet` là
khung mẫu để công ty điền quy ước thật.
