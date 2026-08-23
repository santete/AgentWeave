/**
 * Chữ dạy model dùng bộ nhớ.
 *
 * Bốn mục dưới đây được bê gần như nguyên văn vì bản gốc ghi rõ chúng đã qua
 * eval, và **cách diễn đạt mới là thứ tạo ra khác biệt**, không phải nội dung:
 *
 *   ① Danh sách KHÔNG lưu — dài ngang danh sách lưu, cố ý
 *   ② Cổng chặn lệnh tường minh — "kể cả khi người dùng bảo lưu"
 *   ③ "Before recommending from memory" — tiêu đề nêu THỜI ĐIỂM HÀNH ĐỘNG.
 *      Bản gốc đo: cùng một nội dung, tiêu đề này thắng "Trusting what you
 *      recall" 3/3 so với 0/3. Đừng đổi tiêu đề cho "hay hơn".
 *   ④ Luật "ignore" — model từng biến "bỏ qua bộ nhớ" thành "thừa nhận rồi bỏ
 *      qua", tức là vẫn nhắc tới nội dung nó vừa được bảo là đừng dùng.
 *
 * Viết bằng tiếng Anh cho đồng bộ với mô tả tool và chỉ mục skill; phần văn
 * xuôi model trả lời vẫn theo ngôn ngữ người dùng (luật đó nằm ở system prompt).
 */

import { MAX_DONG_CHI_MUC, TEP_CHI_MUC } from "./types";

export function cauDanBoNho(duongThuMuc: string): string {
	return `# Memory

You have a persistent memory at ${duongThuMuc}. Each memory is ONE file holding ONE fact:

\`\`\`markdown
---
name: <short-kebab-case-slug>
description: <one line — this is the ONLY text used to find this memory later>
type: user | feedback | project | reference
---

<the fact. For feedback and project, follow with **Why:** and **How to apply:** lines.>
\`\`\`

The \`description\` line is how the memory gets found again. Write it with the words
someone would actually type when they need this fact — not a title.

**The four types.** \`user\`: who the person is — role, expertise, preferences.
\`feedback\`: how they want you to work, both corrections and confirmed approaches;
always include the why. \`project\`: goals or constraints not derivable from the code;
convert relative dates to absolute. \`reference\`: pointers to external resources.

## What NOT to save

- Code structure, architecture, file paths — **readable from the code**
- How a bug was fixed — the fix is in the code, the context is in the commit message
- Anything \`git log\` or \`git blame\` answers better
- Anything already in AGENTS.md or the project rules
- Temporary details of the task you are doing right now

These exclusions hold **even when the user explicitly tells you to save**. If they ask
you to save something on this list, ask what was *surprising* or *non-obvious* about it
— that part is worth keeping, the rest is not.

## Writing a memory — two steps, both required

1. Write \`<slug>.md\` with the frontmatter above.
2. Add ONE line to \`${TEP_CHI_MUC}\`: \`- [Title](slug.md) — one-line hook\`

\`${TEP_CHI_MUC}\` is an **index, not a memory**. Never write memory content into it.
Lines past ${MAX_DONG_CHI_MUC} are cut, so keep it short. Link related memories with
\`[[other-slug]]\`; linking to one that does not exist yet is fine — it marks something
worth writing later.

Before saving, check whether an existing file already covers it and update that one
instead. Delete memories that turn out to be wrong.

## Before recommending from memory

A memory that names a specific file, function, or flag is a claim that it existed
**when the memory was written**. It may have been renamed, removed, or never merged.

- Memory names a path → check the file exists before relying on it
- Memory names a function or flag → grep for it first

"The memory says X exists" is not the same as "X exists now". Verify, then recommend.

## If the user says to ignore memory

Proceed as if there were no memory at all. Do not apply remembered facts, do not cite
them, do not compare your answer against them, and do not mention that memory exists.
"Ignore memory" does not mean "acknowledge it and then set it aside" — it means the
memory is not part of this conversation.`;
}

/**
 * Bản LƯỜI, dùng khi thư mục bộ nhớ RỖNG.
 *
 * `cauDanBoNho` là 2.845 byte (~711 token) và nó nằm thường trực ở MỌI lượt —
 * mục lớn thứ hai trong system prompt sau chính bộ luật lõi. Trả cái giá đó
 * khi chưa có lấy một tệp bộ nhớ nào là vi phạm đúng nguyên tắc tiết lộ tiệm
 * tiến mà bản thân bộ nhớ được xây trên đó.
 *
 * Bản này giữ đủ để model TẠO ĐƯỢC mẩu nhớ đầu tiên đúng khuôn — bỏ hẳn thì
 * bộ nhớ rỗng vĩnh viễn — nhưng cắt phần tinh chỉnh (bốn loại giải thích dài,
 * danh sách không-lưu, luật xác minh, luật "ignore"). Những phần đó chỉ có ý
 * nghĩa khi đã có bộ nhớ để mà dùng sai, và chúng quay lại ngay ở tệp đầu tiên.
 */
export function cauDanBoNhoRong(duongThuMuc: string): string {
	return `# Memory

Persistent memory lives at ${duongThuMuc} and is currently EMPTY, so there is nothing to recall. To keep a fact across sessions, write \`<slug>.md\` there with frontmatter \`name\`, \`description\` (the words someone would search for) and \`type\` (user | feedback | project | reference), then add one line to \`${TEP_CHI_MUC}\`: \`- [Title](slug.md) — hook\`.

Save only what the code and \`git log\` cannot answer — never architecture, file paths, or how a bug was fixed.`;
}

/** Khối chỉ mục kèm câu dẫn, đặt ngay sau `cauDanBoNho`. */
export function khoiChiMuc(chiMuc: string): string {
	if (chiMuc.trim() === "") {
		return `Your memory is currently empty. Save something only when it meets the rules above.`;
	}
	return `## ${TEP_CHI_MUC} (index — the memory files themselves load only when relevant)\n\n${chiMuc.trim()}`;
}
