# Distil harness Claude Code → AgentWeave

Nguồn: `agent-coding-opensource` (snapshot source Claude Code, ~512K dòng TS).
Đích: `AgentWeave-goc` (inner-harness / outer-harness, model cục bộ, context 64K, air-gap).

Tài liệu này rút gọn 5 hệ con: **context, rule, skill, memory, loop**. Mỗi phần gồm:
cơ chế → hằng số thật → vì sao thiết kế vậy → cách port sang AgentWeave.

---

## 0. Bản đồ tổng thể: harness = 4 lớp bơm chữ

Claude Code không có "một" system prompt. Nó có **4 kênh bơm chữ vào model**, mỗi kênh
có vòng đời cache khác nhau. Hiểu được 4 kênh này là hiểu được toàn bộ harness:

| Kênh | Nội dung | Vòng đời | File |
|---|---|---|---|
| **1. System prompt tĩnh** | identity, tone, tool guidance | bất biến cả phiên → cache prefix toàn cục | `src/constants/prompts.ts:getSystemPrompt` |
| **2. System prompt động** | memory prompt, env, output style, MCP instructions | memo hoá, xoá khi `/clear` `/compact` | `src/constants/systemPromptSections.ts` |
| **3. Context đầu hội thoại** | git status, CLAUDE.md, ngày | 1 message user `isMeta`, đầu mảng messages | `src/context.ts` + `src/utils/api.ts:prependUserContext` |
| **4. Attachment giữa hội thoại** | ~60 loại `<system-reminder>` | bơm mỗi lượt, có thể biến mất | `src/utils/attachments.ts` (3998 dòng) |

Ranh giới quan trọng nhất trong file prompts.ts:

```ts
// === BOUNDARY MARKER - DO NOT MOVE OR REMOVE ===
...(shouldUseGlobalCacheScope() ? [SYSTEM_PROMPT_DYNAMIC_BOUNDARY] : []),
```

Mọi thứ **trước** mốc này phải bất biến giữa các phiên (để hash prefix dùng chung toàn
fleet). Mọi bit runtime (`hasSkills`, `hasAgentTool`, `isNonInteractive`...) bị đẩy
xuống **sau** mốc — vì N bit boolean trước mốc sẽ đẻ ra 2^N biến thể hash prefix.
Comment trong code ghi rõ đây là bug class đã lặp lại (PR #24490, #24171).

> **Port sang AgentWeave**: `promptSections: Map<string,string>` hiện tại của `AgentLoop`
> đã đúng hướng nhưng chưa có (a) phân biệt cached / uncached, (b) mốc ranh giới tĩnh-động.
> Với Ollama không có prompt cache phía server, nhưng **KV-cache cục bộ vẫn quan trọng**:
> prefix ổn định = không phải prefill lại. Đây là ăn tiền trực tiếp trên Jetson.

### Cơ chế cache section

```ts
systemPromptSection(name, compute)                    // memo, mặc định
DANGEROUS_uncachedSystemPromptSection(name, compute, reason)  // tính lại mỗi lượt, BẮT BUỘC ghi lý do
```

Chi tiết đáng chép: API bắt buộc truyền `_reason` cho biến thể phá cache — tham số
không dùng đến, chỉ tồn tại để ép người viết code phải biện minh. Đây là *policy encoded
in the type signature*.

---

## 1. CONTEXT — lắp ráp và co giãn

### 1.1 Hai loại context đầu hội thoại

`src/context.ts` — cả hai đều `memoize` (tính 1 lần / phiên):

- `getSystemContext()` → `{ gitStatus }`. Git status bị chặn ở **2000 ký tự**, cắt kèm
  câu "truncated because it exceeds 2k characters. If you need more information, run
  `git status` using BashTool" — tức là *dạy model cách tự lấy phần thiếu*, không im lặng cắt.
- `getUserContext()` → `{ claudeMd, currentDate }`.

Chèn vào hội thoại qua `prependUserContext` (`src/utils/api.ts:449`):

```
<system-reminder>
As you answer the user's questions, you can use the following context:
# gitStatus
...
IMPORTANT: this context may or may not be relevant to your tasks.
You should not respond to this context unless it is highly relevant to your task.
</system-reminder>
```

Câu cuối là **liều giải độc**: không có nó, model nhỏ sẽ chào hỏi git status.

### 1.2 Attachment — hệ thần kinh của harness

`getAttachments()` chạy ~30 collector song song, mỗi cái bọc trong `maybe(label, fn)`:

```ts
async function maybe<A>(label: string, f: () => Promise<A[]>): Promise<A[]> {
  try { return await f() } catch (e) { logError(e); return [] }   // KHÔNG BAO GIỜ ném
}
```

Toàn bộ có **timeout cứng 1000ms** cho cả cụm (`setTimeout(ac => ac.abort(), 1000)`).
Triết lý: *context injection không bao giờ được chặn lượt trả lời*. Thà thiếu reminder
còn hơn treo.

Phân tầng theo luồng:
- `userInputAttachments` — chỉ khi có input (@-mention file, MCP resource, agent mention)
- `allThreadAttachments` — an toàn cho subagent (todo, nested memory, skill listing, diff file)
- `mainThreadAttachments` — chỉ luồng chính (IDE selection, diagnostics, token usage)

Toàn bộ đổ ra qua `normalizeAttachmentForAPI()` (`src/utils/messages.ts:3453`) →
`wrapInSystemReminder()` → `<system-reminder>\n...\n</system-reminder>`.

Mẹo hay: attachment loại `directory` không render text — nó **giả lập một cặp
tool_use/tool_result của BashTool `ls`**. Model thấy như thể chính nó đã chạy lệnh.
Rẻ hơn về token và khớp với schema model đã quen.

### 1.3 Nhịp nhắc — chống nhờn

Reminder không bơm mỗi lượt. Mỗi loại có bộ đếm riêng:

```ts
TODO_REMINDER_CONFIG       = { TURNS_SINCE_WRITE: 10, TURNS_BETWEEN_REMINDERS: 10 }
PLAN_MODE_ATTACHMENT_CONFIG= { TURNS_BETWEEN_ATTACHMENTS: 5, FULL_REMINDER_EVERY_N_ATTACHMENTS: 5 }
AUTO_MODE_ATTACHMENT_CONFIG= { TURNS_BETWEEN_ATTACHMENTS: 5, FULL_REMINDER_EVERY_N_ATTACHMENTS: 5 }
VERIFY_PLAN_REMINDER_CONFIG= { TURNS_BETWEEN_REMINDERS: 10 }
```

Và có **hai mức**: `full` / `sparse`. Cứ 5 lần nhắc mới nhắc bản đầy đủ một lần:

```ts
// full  (~200 token): 6 gạch đầu dòng đầy đủ về Auto Mode
// sparse (~20 token): "Auto mode still active (see full instructions earlier in
//                      conversation). Execute autonomously, minimize interruptions."
```

> **Port**: `AgentLoop` hiện đã có `NHAC_HANH_DONG` và nhắc "quẩn tại chỗ" nhưng
> **hardcode inline trong vòng lặp**, không có bộ đếm, không có full/sparse. Cần tách
> thành module `attachments/` với hợp đồng `(messages, state) => Attachment[]`. Đây là
> refactor có giá trị cao nhất trong toàn bộ danh sách — nó biến các heuristic rải rác
> thành một hệ có thể test và mở rộng.

### 1.4 Thang co giãn context — 4 tầng, chạy theo thứ tự

Trong `queryLoop` (`src/query.ts:241`), trước mỗi lần gọi LLM:

```
① applyToolResultBudget   → chặn kích thước tool_result theo từng tool
② snipCompactIfNeeded     → cắt lịch sử (HISTORY_SNIP)
③ microcompact            → xoá NỘI DUNG tool_result cũ, GIỮ khung message
④ autoCompactIfNeeded     → gọi model tóm tắt toàn bộ, đặt mốc compact boundary
```

**Vì sao ③ trước ④**: microcompact rẻ (0 token model), không mất cấu trúc hội thoại.
Chỉ khi nó không đủ mới trả tiền cho ④.

Microcompact chỉ đụng vào tool có tính chất "kết quả đọc được lại":

```ts
const COMPACTABLE_TOOLS = new Set([
  FileRead, Bash(+shell), Grep, Glob, WebSearch, WebFetch, FileEdit, FileWrite
])
```

Không đụng vào AskUserQuestion, Agent, Skill... — những thứ mà kết quả không thể lấy lại.

Biến thể **time-based microcompact**: nếu khoảng cách từ assistant message cuối vượt
ngưỡng (người dùng bỏ đi rồi quay lại), xoá hết tool_result trừ N cái gần nhất, thay
bằng `'[Old tool result content cleared]'`. Có `Math.max(1, keepRecent)` — vì `slice(-0)`
trả về **toàn bộ mảng**, một bug kinh điển được ghi comment lại.

Ngưỡng autocompact:

```ts
MAX_OUTPUT_TOKENS_FOR_SUMMARY      = 20_000  // p99.99 độ dài summary thực đo
AUTOCOMPACT_BUFFER_TOKENS          = 13_000
WARNING_THRESHOLD_BUFFER_TOKENS    = 20_000
ERROR_THRESHOLD_BUFFER_TOKENS      = 20_000
MANUAL_COMPACT_BUFFER_TOKENS       =  3_000
MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES = 3     // ngắt mạch

effectiveWindow = contextWindow - min(maxOutputTokens, 20_000)
autoCompactThreshold = effectiveWindow - 13_000
```

Chi tiết đắt: **ngắt mạch 3 lần lỗi liên tiếp**. Comment ghi thẳng số liệu BigQuery:
1.279 phiên có 50+ lần thất bại liên tiếp (cao nhất 3.272), đốt ~250K lệnh gọi API/ngày
toàn cầu. Không có ngắt mạch = vòng lặp chết.

Prompt tóm tắt (`src/services/compact/prompt.ts`) có 9 mục cố định, đáng chép nguyên:
1 Primary Request and Intent · 2 Key Technical Concepts · 3 Files and Code Sections ·
4 Errors and fixes · 5 Problem Solving · **6 All user messages** · 7 Pending Tasks ·
8 Current Work · 9 Optional Next Step (kèm **trích dẫn nguyên văn** để tránh trôi ý định).

Mở đầu prompt là `NO_TOOLS_PREAMBLE` viết bằng chữ hoa và giải thích *hậu quả*:
"Tool calls will be REJECTED and will waste your only turn — you will fail the task."
Lý do trong comment: trên Sonnet 4.6 adaptive-thinking, tỉ lệ gọi tool sai là 2.79%
so với 0.01% ở 4.5. Câu cảnh báo mềm không đủ. **Model càng nhỏ càng cần lời cảnh
báo nêu hậu quả, không phải lời cấm.**

> **Port**: AgentWeave `nenTinNhan` / `nenManhTay` đã đúng triết lý (tất định, leo thang
> 3 mức) và **tốt hơn** Claude Code cho air-gap. Ba thứ nên thêm:
> 1. **Danh sách trắng tool được nén** — hiện đang nén mọi tool_result, kể cả kết quả
>    không lấy lại được.
> 2. **Ngắt mạch** — `mucNenHienTai` leo tới mức 3 rồi vẫn tràn thì phải dừng hẳn, báo lỗi
>    rõ, chứ không nén vô hạn.
> 3. **Nén theo thời gian** — phiên bị bỏ dở rồi quay lại thì xoá tool result cũ ngay,
>    không đợi chạm ngưỡng 0.8.

---

## 2. RULE — phân tầng chỉ dẫn

### 2.1 Thứ tự nạp (docstring đầu `src/utils/claudemd.ts`)

```
1. Managed  /etc/claude-code/CLAUDE.md          ← policy tổ chức
2. User     ~/.claude/CLAUDE.md + ~/.claude/rules/*.md
3. Project  CLAUDE.md, .claude/CLAUDE.md, .claude/rules/*.md   (đi từ gốc → cwd)
4. Local    CLAUDE.local.md                     ← không commit
5. AutoMem / TeamMem  MEMORY.md
```

**Nạp theo thứ tự ngược của độ ưu tiên** — file nạp sau cùng được model chú ý nhất.
File gần cwd hơn thắng file xa hơn. Đây là quy ước ngầm về vị trí trong prompt = trọng số.

Đóng gói:

```ts
const MEMORY_INSTRUCTION_PROMPT =
  'Codebase and user instructions are shown below. Be sure to adhere to these instructions. ' +
  'IMPORTANT: These instructions OVERRIDE any default behavior and you MUST follow them exactly as written.'
```

Mỗi file kèm nhãn nguồn để model biết trọng lượng:
`" (project instructions, checked into the codebase)"` / `" (user's private project instructions, not checked in)"` / `" (user's auto-memory, persists across conversations)"`.

### 2.2 Rule có điều kiện — đóng góp lớn nhất về context

`.claude/rules/*.md` có frontmatter `paths:`:

```markdown
---
paths: "src/api/**, **/*.sql"
---
Quy tắc chỉ áp dụng cho tầng API và migration.
```

- Không có `paths` → **rule vô điều kiện**, nạp lúc khởi động.
- Có `paths` → **rule có điều kiện**, KHÔNG nạp lúc khởi động. Chỉ khi model
  Read/Write/Edit một file khớp glob thì rule mới được bơm vào dưới dạng attachment
  `nested_memory`.

Khớp bằng thư viện `ignore` (cú pháp gitignore, không phải picomatch), cùng engine với
`.gitignore`. `**` đơn thuần bị coi như không có điều kiện. Đuôi `/**` bị cắt bỏ vì
`ignore` vốn coi `path` khớp cả chính nó lẫn bên trong.

Cơ sở glob khác nhau theo loại:
- Project rules → tương đối với thư mục cha của `.claude`
- Managed/User rules → tương đối với `originalCwd`

Và có bộ lọc an toàn: `relativePath` rỗng, bắt đầu bằng `..`, hoặc tuyệt đối → loại
(vì `ignore()` ném lỗi, và file ngoài baseDir vốn không thể khớp).

> **Đây là kỹ thuật nên bê nguyên sang AgentWeave.** Với context 64K, mọi rule luôn
> thường trú là lãng phí. Rule theo đường dẫn = trả tiền đúng lúc cần.

### 2.3 @include

Cú pháp `@path`, `@./rel`, `@~/home`, `@/abs`. Chỉ hoạt động ở **leaf text node** của
markdown lexer (marked) — không trong code block, không trong inline code. Bảo vệ:
- `MAX_INCLUDE_DEPTH = 5`
- `processedPaths: Set` chống vòng lặp, chuẩn hoá path (Windows `C:` vs `c:`)
- `TEXT_FILE_EXTENSIONS` — danh sách trắng ~40 đuôi, chặn nhị phân
- File ngoài cwd cần người dùng phê duyệt (`hasClaudeMdExternalIncludesApproved`)
- `MAX_MEMORY_CHARACTER_COUNT = 40000` — cảnh báo file quá to
- Strip HTML comment `<!-- -->` ở mức block (giữ nguyên trong code fence);
  comment chưa đóng thì **giữ nguyên** để lỗi gõ không nuốt cả file

### 2.4 Hook — rule dạng thực thi

27 sự kiện (`src/entrypoints/sdk/coreTypes.ts:25`):

```
PreToolUse PostToolUse PostToolUseFailure Notification UserPromptSubmit
SessionStart SessionEnd Stop StopFailure SubagentStart SubagentStop
PreCompact PostCompact PermissionRequest PermissionDenied Setup
TeammateIdle TaskCreated TaskCompleted Elicitation ElicitationResult
ConfigChange WorktreeCreate WorktreeRemove InstructionsLoaded CwdChanged FileChanged
```

Hook trả JSON trên stdout, có `hookSpecificOutput.hookEventName` **được kiểm chứng khớp
với sự kiện đang chạy** — hook trả sai tên sự kiện bị coi là lỗi, không bị bỏ qua.
Hook có thể chặn tool (`PreToolUse`), chặn dừng (`Stop`), thêm context (`UserPromptSubmit`).

Điểm tinh tế: **skill có thể khai hook trong frontmatter của chính nó**
(`parseHooksFromFrontmatter`) — nạp skill = kích hoạt hook của nó. Rule đi kèm quy trình.

> **Port**: AgentWeave `HookEventType` mới có ~6 sự kiện. Ba cái đáng thêm ngay:
> `UserPromptSubmit` (bơm context), `PreCompact` / `PostCompact` (air-gap cần audit
> mỗi lần mất thông tin), `SessionEnd` (chốt bộ nhớ).

### 2.5 Permission rule

Định dạng `Tool(content)` — `Bash(git *)`, `FileEdit(/src/*)`. Ba hành vi: `allow` /
`deny` / `ask`. Escape theo thứ tự bắt buộc: backslash trước, ngoặc sau
(`\` → `\\`, rồi `(` → `\(`). Có `LEGACY_TOOL_NAME_ALIASES` để đổi tên tool không phá
rule người dùng đã lưu. Có `shadowedRuleDetection.ts` — phát hiện rule bị rule khác che.

---

## 3. SKILL — tiết lộ tiệm tiến

### 3.1 Hợp đồng frontmatter (`parseSkillFrontmatterFields`)

```yaml
---
name: ten-hien-thi
description: bắt buộc (fallback: dòng đầu markdown)
when_to_use: khi nào dùng — vào chỉ mục cùng description
allowed-tools: [Bash(git *), FileRead]
argument-hint: "[interval] <prompt>"
arguments: [a, b]              # tên tham số cho $1 $2
model: sonnet | inherit
effort: low|medium|high|xhigh|max | <số nguyên>
disable-model-invocation: false   # chỉ người dùng gọi được
user-invocable: true              # false → ẩn khỏi danh sách /
context: fork                     # chạy trong subagent riêng
agent: <agent type>
paths: "src/**"                   # SKILL CÓ ĐIỀU KIỆN
hooks: {...}                      # hook riêng của skill
shell: {...}
version: "1.0"
---
```

### 3.2 Ngân sách chỉ mục — con số quan trọng nhất

```ts
SKILL_BUDGET_CONTEXT_PERCENT = 0.01     // chỉ mục skill = 1% cửa sổ context
CHARS_PER_TOKEN              = 4
DEFAULT_CHAR_BUDGET          = 8_000    // = 1% × 200k × 4
MAX_LISTING_DESC_CHARS       = 250      // trần cứng mỗi dòng
MIN_DESC_LENGTH              = 20       // dưới mức này thì bỏ hẳn mô tả
FILTERED_LISTING_MAX         = 30
```

Thuật toán `formatCommandsWithinBudget` xuống thang 3 nấc:
1. Vừa ngân sách → mô tả đầy đủ.
2. Không vừa → chia ngân sách còn lại đều cho các skill *không phải bundled*, cắt mô tả.
   **Skill bundled không bao giờ bị cắt.**
3. `maxDescLen < 20` → skill thường chỉ còn `- <tên>`, bundled vẫn giữ mô tả đầy đủ.

Đây là *ưu tiên có phân tầng dưới sức ép*, không phải cắt đều.

### 3.3 Bơm chỉ mục theo delta

`sentSkillNames: Map<agentKey, Set<name>>` — chỉ bơm skill **chưa từng bơm**, khoá theo
`agentId` (subagent có chỉ mục riêng). Không bơm lại sau compact:
"post-compact re-injection costs ~4K tokens/event for marginal benefit."

Có `suppressNextSkillListing()` cho đường `--resume`: tiến trình trước đã bơm rồi, và
`sentSkillNames` là module-scope nên tiến trình mới mất sạch. Không có cờ này thì mỗi
lần resume tốn lại ~600 token.

### 3.4 Ba cơ chế phát hiện

**a) Skill động theo thư mục** — khi model đọc/ghi `sub/dir/file.ts`, harness đi ngược
lên tìm `*/.claude/skills/`, nạp skill tìm được. Sâu hơn thắng nông hơn.
`dynamicSkillDirs: Set` ghi nhớ **cả hit lẫn miss** để không stat lại thư mục không
tồn tại ở mỗi lệnh Read. Có kiểm tra `git check-ignore` — chặn
`node_modules/pkg/.claude/skills` tự nạp. Fail-open ngoài git repo, vì hàng rào an ninh
thật là hộp thoại tin cậy lúc gọi.

**b) Skill có điều kiện** — `paths:` frontmatter, cùng cơ chế rule có điều kiện.

**c) Skill discovery bằng model rẻ** — gọi Haiku phân loại. Comment ghi: 97% lệnh gọi
`assistant_turn` không tìm thấy gì trong production → chuyển thành **prefetch bất đồng bộ**
chạy song song với lượt chính, thu hoạch sau khi tool chạy xong. Không chặn.

### 3.5 Gọi skill

- **inline**: `processPromptSlashCommand` → nội dung SKILL.md thành `newMessages` gắn
  `sourceToolUseID`, và `contextModifier(ctx)` mở rộng `allowedTools` trong phạm vi skill.
- **fork**: `context: fork` → chạy subagent riêng, chỉ trả kết quả về. Cách ly context.

Thay thế biến trong nội dung: `${CLAUDE_SKILL_DIR}` (đổi `\` → `/` trên Windows),
`${CLAUDE_SESSION_ID}`, `$ARGUMENTS` / `$1..$n`, và **thực thi shell nhúng** `` !`cmd` ``.

Chốt an toàn quan trọng:

```ts
// Security: MCP skills are remote and untrusted — never execute inline
// shell commands (!`…` / ```! … ```) from their markdown body.
if (loadedFrom !== 'mcp') { finalContent = await executeShellCommandsInPrompt(...) }
```

Prompt của SkillTool có câu đắt giá:

> "When a skill matches the user's request, this is a BLOCKING REQUIREMENT: invoke the
> relevant Skill tool BEFORE generating any other response about the task."
> "NEVER mention a skill without actually calling this tool."

Và chống lặp vô hạn: *"If you see a `<command-name>` tag in the current conversation turn,
the skill has ALREADY been loaded — follow the instructions directly instead of calling
this tool again."*

> **Port**: `SkillRegistry` của AgentWeave đã có 3 scope + shadow detection + báo cáo lỗi
> không im lặng — thiết kế tốt hơn Claude Code ở khoản chẩn đoán. Bốn thứ thiếu:
> 1. **Ngân sách chỉ mục theo % context** — hiện chỉ có `DEFAULT_MAX_SKILLS_PER_SCOPE = 50`
>    (đếm số lượng, không đếm byte). Nên đổi sang thuật toán xuống thang 3 nấc, ngân sách
>    1% × 64K × 4 = **2.560 ký tự**.
> 2. **Skill có điều kiện theo `paths`** — lợi lớn nhất với context nhỏ.
> 3. **Bơm delta** thay vì chỉ mục tĩnh trong system prompt (khi có skill nạp thêm giữa phiên).
> 4. **Câu "BLOCKING REQUIREMENT"** trong mô tả `LoadSkill` — model nhỏ hay "nhắc tên
>    skill rồi tự làm theo trí nhớ" thay vì nạp thật.

---

## 4. MEMORY — bộ nhớ liên phiên

### 4.1 Bốn loại, cố ý hẹp

`src/memdir/memoryTypes.ts`:

| Loại | Nội dung |
|---|---|
| `user` | vai trò, mục tiêu, chuyên môn, sở thích của người dùng |
| `feedback` | chỉ dẫn về **cách làm việc** — cả lời sửa lẫn lời xác nhận |
| `project` | bối cảnh công việc không suy ra được từ code |
| `reference` | con trỏ tới tài nguyên ngoài (URL, dashboard, ticket) |

Danh sách **KHÔNG lưu** quan trọng ngang danh sách lưu:

> Code pattern, kiến trúc, đường dẫn, cấu trúc dự án — *suy ra được bằng cách đọc code*.
> Git history — `git log`/`git blame` mới là nguồn chuẩn.
> Cách sửa bug — bản sửa nằm trong code, bối cảnh nằm trong commit message.
> Thứ đã có trong CLAUDE.md.
> Chi tiết tạm thời của lượt việc hiện tại.

Và cổng chặn lệnh tường minh:

> "These exclusions apply even when the user explicitly asks you to save. If they ask you
> to save a PR list or activity summary, ask what was *surprising* or *non-obvious* about
> it — that is the part worth keeping."

Comment ghi: eval-validated, case 3 từ 0/2 → 3/3.

Ghi chú `feedback` bắt buộc theo cấu trúc: **quy tắc → `**Why:**` → `**How to apply:**`**.

### 4.2 Kiến trúc 2 tầng: chỉ mục + file

```
MEMORY.md            ← chỉ mục, LUÔN trong context
  - [Tiêu đề](file.md) — móc câu một dòng
<slug>.md            ← nội dung, nạp khi cần
```

Ràng buộc:
```ts
ENTRYPOINT_NAME       = 'MEMORY.md'
MAX_ENTRYPOINT_LINES  = 200
MAX_ENTRYPOINT_BYTES  = 25_000
```
Prompt nói thẳng với model: *"lines after 200 will be truncated, so keep the index concise"*
— giới hạn kỹ thuật được **nói ra**, không âm thầm.

Quy trình ghi 2 bước bắt buộc: ① ghi file có frontmatter → ② thêm 1 dòng vào MEMORY.md.
Và: *"MEMORY.md is an index, not a memory... Never write memory content directly into MEMORY.md."*

Liên kết chéo `[[tên-khac]]`. Prompt khuyến khích link **rộng tay**: link tới memory
chưa tồn tại không phải lỗi — nó đánh dấu thứ đáng viết sau.

### 4.3 Recall — mô hình rẻ chọn hộ

`findRelevantMemories()`:
1. `scanMemoryFiles()` đọc **30 dòng đầu** mỗi file (chỉ frontmatter), tối đa
   `MAX_MEMORY_FILES = 200`, sắp xếp mtime mới nhất trước.
2. Tạo manifest `- [type] filename (ISO-timestamp): description`.
3. Gọi **Sonnet** với `output_format: json_schema`, `max_tokens: 256`, chọn tối đa 5 file.
4. Lọc lại kết quả theo `validFilenames` — model bịa tên file thì loại.

System prompt của bộ chọn có một luật rất tinh:

> "If a list of recently-used tools is provided, do not select memories that are usage
> reference or API documentation for those tools (Claude Code is already exercising them).
> DO still select memories containing **warnings, gotchas, or known issues** about those
> tools — active use is exactly when those matter."

`collectRecentSuccessfulTools()` chỉ tính tool **đã chạy thành công, chưa từng lỗi**.
Tool có lỗi → vẫn cho phép nạp tài liệu (model đang vật lộn thì cần trợ giúp).

### 4.4 Ngân sách bơm

```ts
MAX_MEMORY_LINES  = 200
MAX_MEMORY_BYTES  = 4_096          // 5 file × 4KB = 20KB/lượt
RELEVANT_MEMORIES_CONFIG.MAX_SESSION_BYTES = 60 * 1024   // ~3 lần bơm đầy/phiên
```

Trần theo phiên đếm bằng cách **quét messages**, không lưu biến — nên `/compact` tự động
reset bộ đếm (attachment cũ đã biến mất khỏi context thì bơm lại là hợp lệ). Thiết kế
đẹp: state suy ra từ nội dung thay vì giữ song song.

File bị cắt thì kèm dòng chỉ đường:
`"> This memory file was truncated (4096 byte limit). Use the FileRead tool to view the complete file at: <path>"`

### 4.5 Chống lệch cache — chi tiết dễ bỏ sót

```ts
header?: string   // "saved 3 days ago" tính MỘT LẦN lúc tạo attachment
```
Comment: nếu tính lại `memoryAge(mtimeMs)` lúc render, "saved 3 days ago" sẽ thành
"saved 4 days ago" ở lượt sau → **byte khác → vỡ prompt cache**. Mọi chuỗi phụ thuộc
`Date.now()` trong context phải được đóng băng lúc tạo.

### 4.6 Chống trôi khi đọc lại

Hai mục prompt đắt giá, đều eval-validated:

**`## Before recommending from memory`** — tiêu đề này thắng "Trusting what you recall"
3/3 vs 0/3. Cùng nội dung, chỉ khác tiêu đề. *Tiêu đề nêu thời điểm hành động thắng
tiêu đề trừu tượng.*

> "A memory that names a specific function, file, or flag is a claim that it existed
> *when the memory was written*. It may have been renamed, removed, or never merged."
> — nếu nêu path: kiểm tra file tồn tại. Nếu nêu hàm/flag: grep.
> "The memory says X exists" is not the same as "X exists now."

**Luật "ignore"**:
> "If the user says to *ignore* or *not use* memory: proceed as if MEMORY.md were empty.
> Do not apply remembered facts, cite, compare against, or mention memory content."

Comment giải thích lỗi thật: model đọc code đúng nhưng vẫn thêm "không phải Y như ghi
trong memory" — coi "ignore" thành "thừa nhận rồi bỏ qua".

### 4.7 Ranh giới với plan và task

Prompt dạy model phân biệt 3 cơ chế lưu trữ:
- **Plan** — thống nhất cách tiếp cận trước khi làm việc lớn. Đổi hướng thì cập nhật plan.
- **Task** — chia nhỏ và theo dõi tiến độ trong phiên hiện tại.
- **Memory** — chỉ những gì **hữu ích cho phiên sau**.

> **Port**: AgentWeave **chưa có memory**. Đề xuất tối giản, hợp air-gap:
> - Thư mục `.agentweave/memory/` — cùng mô hình 2 tầng `MEMORY.md` + `<slug>.md`.
> - **Không dùng model để recall.** Air-gap có 1 model, gọi phụ = trả tiền 2 lần trên
>   Jetson. Thay bằng recall tất định: chấm điểm khớp từ khoá giữa prompt người dùng và
>   `description` trong frontmatter (BM25 nhẹ hoặc chỉ cần đếm token chung + boost mtime).
>   Kém chính xác hơn nhưng có thể giải thích, có thể test, chi phí bằng 0.
> - Giữ nguyên: 4 loại, danh sách KHÔNG lưu, cổng chặn lệnh tường minh, mục "Before
>   recommending from memory", luật "ignore", đóng băng chuỗi tuổi lúc tạo.
> - Ngân sách cho 64K: chỉ mục ≤ 60 dòng, mỗi file bơm ≤ 2KB, ≤ 3 file/lượt,
>   ≤ 20KB/phiên.

---

## 5. LOOP — lặp và hẹn giờ

Có **hai** thứ tên "loop", đừng lẫn:

### 5.1 Vòng lặp agent (`queryLoop`)

`src/query.ts:241` — `while(true)` với state gói trong một object duy nhất:

```ts
let state: State = {
  messages, toolUseContext, maxOutputTokensOverride,
  autoCompactTracking, stopHookActive,
  maxOutputTokensRecoveryCount, hasAttemptedReactiveCompact,
  turnCount, pendingToolUseSummary, transition,
}
```

Comment giải thích: có ~7 điểm `continue`; gói state thành 1 object để mỗi điểm ghi
`state = {...}` thay vì 9 phép gán rời — không quên trường nào.

Prefetch dùng `using` (explicit resource management):

```ts
using pendingMemoryPrefetch = startRelevantMemoryPrefetch(state.messages, state.toolUseContext)
```

`[Symbol.dispose]()` chạy trên **mọi** đường thoát generator (return, throw, `.return()`),
huỷ request đang bay + ghi telemetry — không phải nhét dọn dẹp vào 13 điểm return.

Mô hình prefetch tổng quát, đáng bê nguyên:

```ts
type Prefetch = {
  promise: Promise<Attachment[]>
  settledAt: number | null       // do .finally() đặt
  consumedOnIteration: number    // do điểm thu hoạch đặt
  [Symbol.dispose](): void
}
```

Điểm thu hoạch **poll `settledAt`, không bao giờ await**. Xong thì dùng, chưa xong thì
để vòng sau. *Công việc phụ không bao giờ kéo dài lượt chính.*

### 5.2 Cron / `/loop`

**Skill `/loop`** (`src/skills/bundled/loop.ts`, 93 dòng) là ví dụ mẫu mực về skill
"chỉ có chữ": không code parse nào cả, toàn bộ luật parse viết cho model đọc.

Ba luật parse theo thứ tự ưu tiên:
1. Token đầu khớp `^\d+[smhd]$` → đó là khoảng.
2. Đuôi `every <N><unit>` / `every <N> <unit-word>` → tách ra. **Chỉ khớp khi sau
   "every" là biểu thức thời gian** — `check every PR` không có khoảng.
3. Mặc định `10m`.

Bảng đổi khoảng → cron nằm ngay trong prompt:

| Mẫu | Cron | Ghi chú |
|---|---|---|
| `Nm`, N ≤ 59 | `*/N * * * *` | |
| `Nm`, N ≥ 60 | `0 */H * * *` | H = N/60, phải chia hết 24 |
| `Nh`, N ≤ 23 | `0 */N * * *` | |
| `Nd` | `0 0 */N * *` | nửa đêm giờ địa phương |
| `Ns` | `ceil(N/60)m` | cron nhỏ nhất là 1 phút |

Và luật xử lý số lẻ: `7m` → `*/7` cho khoảng lệch ở :56→:00; `90m` cron không biểu diễn
được. → **làm tròn về khoảng sạch gần nhất và NÓI CHO NGƯỜI DÙNG BIẾT đã làm tròn thành gì.**

Bước cuối quan trọng nhất:
> "**Then immediately execute the parsed prompt now** — don't wait for the first cron fire."

Không có câu này, `/loop 1h check deploy` sẽ im lặng 1 tiếng và người dùng tưởng hỏng.

### 5.3 Scheduler (`src/utils/cronScheduler.ts`)

Ba loại state:
```ts
let tasks: CronTask[]                 // task ghi trên đĩa (durable)
const nextFireAt = new Map<id, ms>()  // thời điểm bắn kế tiếp
const missedAsked = new Set<id>()     // đã hỏi về task lỡ
const inFlight   = new Set<id>()      // chống bắn kép khi đang xoá bất đồng bộ
```

**Neo thời gian** — chi tiết tinh vi nhất:
```ts
next = t.recurring
  ? jitteredNextCronRunMs(t.cron, t.lastFiredAt ?? t.createdAt, t.id, cfg)
  : oneShotJitteredNextCronRunMs(t.cron, t.createdAt, t.id, cfg)
```
Task lặp neo từ `lastFiredAt`, **không phải `now`**. Comment ghi bug thật: daemon con
tắt lúc rảnh làm mất `nextFireAt` trong bộ nhớ; lần khởi động sau neo lại từ `createdAt`
10 ngày trước → bắn mọi task mỗi chu kỳ. Ghi `lastFiredAt` xuống đĩa để tiến trình mới
dựng lại đúng cùng một `newNext`.

Sau khi bắn, task lặp **lên lịch lại từ `now`, không phải từ `next`** — tránh bắn dồn
bù nếu phiên bị chặn.

**Jitter tất định** — chống thundering herd:
```ts
DEFAULT_CRON_JITTER_CONFIG = {
  recurringFrac : 0.1,                    // 10% khoảng cách giữa 2 lần bắn
  recurringCapMs: 15 * 60 * 1000,
  oneShotMaxMs  : 90 * 1000,
  oneShotMinuteMod: 30,
  recurringMaxAgeMs: 7 * 24 * 60 * 60 * 1000,   // task lặp tự hết hạn sau 7 ngày
}
jitterFrac(taskId) = parseInt(taskId.slice(0,8), 16) / 0x100000000   // [0,1) ổn định
```
Độ trễ **tỉ lệ với khoảng cách giữa hai lần bắn**: task hàng giờ trải trong `[:00, :06)`,
task mỗi phút chỉ trải vài giây. Suy từ taskId nên ổn định qua các lần khởi động lại.

**Tự hết hạn 7 ngày** cho task lặp — bắn lần cuối rồi xoá. Comment ghi rõ task hệ thống
(morning-checkin, dream) đặt `0` = vô hạn vì `writeIfMissing()` không tạo lại được.

**Task lỡ** (máy tắt lúc đến hạn): chỉ xử lý ở lần nạp **đầu tiên**, chỉ với task một lần,
và hỏi người dùng (chạy ngay / bỏ luôn). Task lặp không hỏi — `check()` tự xử đúng.

**Durable vs session**: mặc định `durable: false`, sống trong phiên, không ghi đĩa.
`durable: true` ghi `.claude/scheduled_tasks.json`. Prompt dạy model:
*"Most 'remind me in 5 minutes' / 'check back in an hour' requests should stay session-only."*

### 5.4 Loop tự định nhịp (bản mới hơn snapshot này)

Bản Claude Code hiện hành có `ScheduleWakeup` — model tự chọn `delaySeconds` mỗi lượt
thay vì cron cố định. Nguyên tắc chọn nhịp:
- Đang poll trạng thái ngoài (CI, deploy): chọn theo tốc độ thay đổi thật. CI 8 phút →
  **một** lần kiểm tra ~480s, không phải tám lần 60s.
- Có tín hiệu đánh thức khác (harness tự gọi lại khi task xong): đặt nhịp dự phòng dài
  1200s+.
- Không có tín hiệu cụ thể: 1200–1800s.
- Cờ `noop: true/false` để gộp các lần "không có gì mới" trong UI.

Snapshot này chưa có, nhưng ý tưởng đáng chép: **đừng poll thứ mà harness có thể thông
báo**; nhịp phải khớp với tốc độ thay đổi của cái đang đợi.

> **Port**: AgentWeave chưa có cron. Nếu làm:
> - Bắt đầu bằng **session-only** (Map trong bộ nhớ), bỏ qua durable — đủ 90% nhu cầu.
> - Bê nguyên: neo từ `lastFiredAt`, lên lịch lại từ `now`, `inFlight` chống bắn kép,
>   jitter tất định từ taskId, tự hết hạn.
> - Bê nguyên **skill `/loop` dạng chữ thuần** — 93 dòng prompt, 0 dòng parser. Đây là
>   minh hoạ tốt nhất cho triết lý "skill = tri thức quy trình đóng gói thành chữ" mà
>   `skills/types.ts` của AgentWeave đã viết ra.

---

## 6. Bảng đối chiếu AgentWeave

| Hệ con | AgentWeave hiện có | Thiếu | Ưu tiên |
|---|---|---|---|
| **Context — lắp ráp** | `promptSections: Map` | mốc tĩnh/động, API cached vs `DANGEROUS_uncached` + lý do bắt buộc | Trung bình |
| **Context — attachment** | reminder hardcode trong `agent-loop.ts` | module attachment, `maybe()` nuốt lỗi, timeout cứng, bộ đếm nhịp, full/sparse | **CAO NHẤT** |
| **Context — nén** | `nenTinNhan`/`nenManhTay`, 3 mức, tất định ✅ | danh sách trắng tool, ngắt mạch, nén theo thời gian | Cao |
| **Rule** | không có | phân tầng org/user/project/local, `paths:` có điều kiện, `@include` | **Cao** |
| **Hook** | 6 sự kiện | `UserPromptSubmit`, `PreCompact`/`PostCompact`, `SessionEnd`, hook trong frontmatter skill | Trung bình |
| **Skill** | 3 scope, shadow detect, báo lỗi rõ ✅ | ngân sách theo % context, `paths:` có điều kiện, bơm delta, câu BLOCKING | **Cao** |
| **Memory** | không có | toàn bộ | **Cao** |
| **Loop/cron** | không có | scheduler + skill `/loop` | Thấp |
| **Vòng lặp agent** | có, có chống quẩn ✅ | mô hình prefetch (`settledAt`, không await), state gói 1 object | Trung bình |

---

## 7. Kế hoạch tích hợp đề xuất

### Giai đoạn 1 — Attachment pipeline (nền cho mọi thứ sau)

`packages/inner-harness/src/attachments/`:

```ts
export type Attachment =
  | { type: "nhac_hanh_dong" }
  | { type: "nhac_quan_tai_cho"; soLanDoc: number }
  | { type: "rule_theo_duong_dan"; path: string; content: string }
  | { type: "memory_lien_quan"; files: {path, content, header}[] }
  | { type: "skill_index_delta"; skills: {name, whenToUse}[] }
  | { type: "canh_bao_nen"; mucNen: number }

export interface AttachmentCollector {
  ten: string
  thu(ctx: BoiCanhLuot): Promise<Attachment[]>
}

// Nuốt lỗi + timeout cứng, sao chép maybe()
export async function thuAttachment(
  collectors: AttachmentCollector[], ctx: BoiCanhLuot, timeoutMs = 1000
): Promise<Attachment[]>

export function bocNhacHeThong(a: Attachment): Message   // → <system-reminder>
```

Việc đầu tiên: chuyển `NHAC_HANH_DONG` và nhắc "quẩn tại chỗ" ra khỏi `agent-loop.ts`
thành collector, kèm bộ đếm lượt và biến thể sparse.

### Giai đoạn 2 — Rule phân tầng

`packages/inner-harness/src/rules/`:
- `.agentweave/rules/*.md` + `AGENTS.md` ở gốc, đi từ gốc repo → cwd
- frontmatter `paths:` khớp bằng `ignore` (gitignore syntax)
- rule vô điều kiện → system prompt section; rule có điều kiện → attachment khi
  FileRead/FileWrite/FileEdit chạm file khớp
- `@include` depth ≤ 5, danh sách trắng đuôi file, chống vòng lặp
- Header đóng gói: câu OVERRIDE + nhãn nguồn từng file

### Giai đoạn 3 — Memory tất định

`packages/inner-harness/src/memory/`:
- `.agentweave/memory/MEMORY.md` + `<slug>.md`, 4 loại
- Recall **không dùng model**: chấm điểm khớp từ khoá `description` + boost mtime
- Ngân sách 64K: chỉ mục ≤ 60 dòng, file ≤ 2KB, ≤ 3 file/lượt, ≤ 20KB/phiên
- Đóng băng chuỗi tuổi lúc tạo attachment
- Bê nguyên văn: danh sách KHÔNG lưu, cổng chặn lệnh tường minh, "Before recommending
  from memory", luật "ignore"

### Giai đoạn 4 — Nâng cấp skill

- Đổi `DEFAULT_MAX_SKILLS_PER_SCOPE` (đếm skill) → ngân sách byte 1% × cửa sổ × 4
- Thuật toán xuống thang 3 nấc, org-scope không bị cắt (tương đương bundled)
- Thêm `paths:` vào `SkillManifestSchema`
- Thêm câu BLOCKING REQUIREMENT + chống gọi lại vào mô tả `LoadSkill`

### Giai đoạn 5 — Nén và loop

- Danh sách trắng tool nén + ngắt mạch + nén theo thời gian
- Cron session-only + skill `/loop` dạng chữ thuần

---

## 8. Hằng số đáng chép nguyên

```
CONTEXT
  git status                     2.000 ký tự (kèm câu chỉ cách lấy thêm)
  timeout thu attachment         1.000 ms
  ngưỡng nén                     0,8 cửa sổ
  dự trữ cho summary             20.000 token
  đệm autocompact                13.000 token
  ngắt mạch autocompact          3 lần lỗi liên tiếp

RULE
  MAX_INCLUDE_DEPTH              5
  MAX_MEMORY_CHARACTER_COUNT     40.000 ký tự (cảnh báo)

SKILL
  ngân sách chỉ mục              1% cửa sổ × 4 ký tự/token
    → 200K: 8.000 ký tự   |   64K: 2.560 ký tự
  trần mô tả mỗi dòng            250 ký tự
  sàn mô tả                      20 ký tự (dưới → chỉ còn tên)

MEMORY
  MEMORY.md                      200 dòng / 25.000 byte
  quét frontmatter               30 dòng đầu / tối đa 200 file
  bơm mỗi file                   200 dòng / 4.096 byte
  bơm mỗi lượt                   ≤ 5 file (~20KB)
  trần cả phiên                  60 KB (reset khi compact)

CRON
  jitter lặp                     10% khoảng cách, tối đa 15 phút
  jitter một lần                 tối đa 90 giây
  tự hết hạn task lặp            7 ngày
  cron tối thiểu                 1 phút
```

---

## 9. Bảy nguyên tắc rút ra

1. **Tiết lộ tiệm tiến ở mọi tầng.** Skill: index → nội dung. Memory: MEMORY.md → file.
   Rule: vô điều kiện → có điều kiện theo path. Tool result: đầy đủ → lược → xoá.
   Cùng một hình dạng lặp lại 4 lần.

2. **Ngân sách là % cửa sổ, không phải số tuyệt đối.** `1% × contextWindow` co giãn từ
   200K xuống 64K mà không cần sửa code. Mọi hằng số byte trong AgentWeave nên viết lại
   theo dạng này.

3. **Cắt bớt phải nói ra.** Mọi chỗ cắt đều kèm câu chỉ đường: file nào, tool nào để lấy
   phần thiếu. Cắt im lặng = model tưởng đó là toàn bộ sự thật.

4. **Xuống thang có phân tầng, không cắt đều.** Dưới sức ép, skill bundled giữ nguyên mô
   tả còn skill thường mất hết. Biết cái gì hy sinh trước.

5. **Việc phụ không bao giờ chặn lượt chính.** Prefetch + poll `settledAt`, `maybe()` nuốt
   mọi lỗi, timeout cứng 1s. Harness hỏng thì lượt vẫn chạy.

6. **State suy ra từ nội dung, đừng giữ song song.** Trần memory theo phiên đếm bằng cách
   quét messages → `/compact` tự reset. Không có biến nào để lệch.

7. **Prompt cho model nhỏ phải nêu hậu quả, không phải nêu lệnh cấm.** "Tool calls will be
   REJECTED and will waste your only turn — you will fail the task" hiệu quả hơn "do not
   call tools". Và vị trí tiêu đề quyết định: "Before recommending from memory" thắng
   "Trusting what you recall" 3/3 vs 0/3 với **cùng một nội dung**.
