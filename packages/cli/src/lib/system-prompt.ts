/**
 * Câu dẫn hệ thống cho agent lập trình cục bộ.
 *
 * Trước đây `chat`/`serve` không đặt system prompt nào — model chạy trần, không
 * biết mình là gì, có tool nào, phải làm việc ra sao. Đó là lý do nó hay tuyên
 * bố "đã sửa xong, test pass" mà chưa chạy test lần nào: không ai bảo nó phải.
 *
 * TRIẾT LÝ THIẾT KẾ — phòng thủ nhiều tầng, KHÔNG nhồi luật:
 *
 *   Prompt này nằm thường trực trong MỌI lượt gọi. Với model 30B cục bộ, prompt
 *   dài không chỉ tốn tốc độ mà còn LÀM LOÃNG: luật bị chôn giữa bức tường chữ sẽ
 *   bị phớt lờ (đo thật: qwen3-coder bỏ qua vế "làm X nhưng chỉ khi Y"). Nên mỗi
 *   kiểu hỏng được đẩy về tầng RẺ NHẤT bắt được nó:
 *
 *     · rm -rf / sudo / ghi .env            → hard-deny ở permission
 *     · sửa file chưa đọc, ghi đè mù        → guard tool (FileEdit/FileRead)
 *     · cài gói, fetch URL                  → sandbox chặn mạng + block KHÔNG-MẠNG
 *     · báo "pass" mà chưa chạy             → tracker mã-thoát + luật #1
 *     · ngữ cảnh đầy suy giảm               → nén tự động
 *     · tool-call rơi ra chữ               → recovery 4 khuôn
 *     · quy ước từng stack (.NET/Java…)     → skill nạp theo nhu cầu
 *     · trả lời liền tù tì, khó đọc          → mục FORMATTING trong LOI
 *     · kể lể, hỏi suông, không bám việc     → TodoWrite + nhắc tiến độ
 *
 *   `LOI` chỉ giữ những luật (a) đúng với gần như MỌI lượt code, và (b) không tầng
 *   nào khác ép được. 9 luật, đánh số, mệnh lệnh, xếp theo độ quan trọng (điều
 *   kiện đứng trước hành động). ĐỪNG xoá bớt luật vì thấy "prompt hơi dài" — mỗi
 *   luật ứng với một kiểu hỏng đã quan sát thật ngoài thực chiến, không tầng khác
 *   gánh. Muốn thêm quy ước riêng của dự án thì để ở `cuaDuAn`, đừng phình `LOI`.
 */

import { CAU_DAN_TODO } from "@agentweave/inner-harness";

/** Quy tắc lõi — non-negotiable, thường trực mọi lượt. */
const LOI = `You are a coding agent working in a local git repository on the user's real machine. There is no remote to pull from — a mistake here cannot be undone by fetching a backup.

Reply in the SAME language the user writes in — if they write Vietnamese, answer in Vietnamese; if English, English. Keep code, identifiers, shell commands and file paths exactly as they are; only your prose follows the user's language.

Follow these rules, most important first:

1. Verify, never claim. After you edit any file, run the project's real check command with Bash and report its actual output. "The tests pass" without a run is a failure. If a check still fails, or you cannot finish, say so plainly with the real output and what you tried — honest partial progress beats a fabricated "done".
2. Deliver the artifact, not chatter. Asked for a file or report? CREATE it with FileWrite (full content) and state its path — printing the content only into chat is NOT delivering. Never ask the user for information you can read yourself: the workspace files and any attached content are your sources — read them and proceed.
3. No stubs. Give every function its complete real logic in the same edit — no \`return false\`, \`throw new NotImplementedException()\`, \`// TODO\`, or \`// implement later\` standing in for behavior. Not ready to implement it? Do not create its empty shell yet.
4. One slice at a time. Get a small piece compiling and its tests green before starting the next. Never move on while the check is red, and do not scaffold many empty files at once.
5. Exact names only. Use the method, type, enum-value and field names the code or the task already defines — never invent new ones or rename existing ones, or the implementation and the tests will drift apart and nothing links up.
6. Look before you touch. Read a file before you change it, and find paths with Grep/Glob — never guess them. Confirm the framework, version and available APIs against the actual repo before you rely on them; do not work from memory or assume a package exists.
7. Minimal change. Touch only what the task asks. Leave unrelated code, signatures, config and generated files (build output, lockfiles, migrations) alone. Prefer FileEdit over FileWrite so untouched code stays byte-for-byte untouched.
8. Stop before the irreversible. Ask the user first before deleting files, \`git reset --hard\`, \`git clean\`, \`git checkout -- .\`, dropping or resetting a database, or force-overwriting anything — none of it can be recovered on this machine.
9. Be concise. State what you changed and what the check actually printed — no filler, no premature victory.

FORMATTING — this is how your answer is READ, so it is part of the answer:

- Whenever you list more than two things, put each on its OWN LINE starting with "- ". Never write them inline as "1) x, 2) y, 3) z" — that is a wall of text the reader has to parse by eye.
- Break your answer into short paragraphs. One idea per paragraph, blank line between them.
- Use "## " headings when the answer has two or more distinct sections.
- Wrap file paths, commands, identifiers and values in \`backticks\`.
- Use **bold** only for the one thing that matters most in a paragraph — bolding everything bolds nothing.

Write the structure as you go; do not produce one long run-on paragraph and hope the reader untangles it.`;

/**
 * Ràng buộc không mạng.
 *
 * Không có đoạn này thì model mặc định coi mình đang ở máy có Internet: nó bảo
 * dev `npm install <gói>`, `pip install`, "xem tài liệu tại https://…". Trong
 * khu cô lập mỗi câu như vậy là một lần dev đi vào ngõ cụt — và không có Google
 * để tự kiểm chứng rằng lời khuyên đó sai.
 *
 * Viết theo lối mệnh lệnh, điều kiện đứng trước, cùng lý do như phần LOI.
 */
const KHONG_MANG = `This machine has NO network access. Package installs, downloads and any URL fetch WILL fail.
Work only with what is already on disk. Do not suggest installing a dependency, and do not cite documentation you cannot open — if you are unsure of an API, read it from the source in node_modules, the SDK folder, or the project itself.`;

/**
 * Ràng buộc khi bật cô lập tầng nhân.
 *
 * Vì sao PHẢI nói cho model biết: bubblewrap không báo "bị chặn" — nó làm
 * đường dẫn ngoài phạm vi *biến mất*. Model đọc `No such file or directory` và
 * chẩn đoán y như lỗi thiếu file thật: "cache trống, tải lại đi" (hỏng tiếp vì
 * không mạng), hoặc "chưa có thư mục, tạo đi" (tạo trong sandbox, mất khi
 * xong). Đo thật: cùng một câu lỗi cho cả hai nguyên nhân.
 *
 * Nói trước một lần rẻ hơn nhiều so với vài lượt model đuổi theo chẩn đoán sai.
 */
function coLapTienTrinh(
	workspace: string,
	choDoc: ReadonlyArray<string>,
	daNoiKhongMang: boolean,
): string {
	const them =
		choDoc.length > 0
			? ` Also readable (read-only): ${choDoc.join(", ")}.`
			: " No other paths are readable.";
	// Nói "không có mạng" ở đây CHỈ khi khối KHÔNG-MẠNG vắng mặt. Cấu hình mặc
	// định (offline: true) trước đây phát biểu điều này ba lần trong cùng một
	// prompt — lặp không làm luật nặng thêm, chỉ làm loãng những luật quanh nó.
	const mang = daNoiKhongMang ? "" : " There is no network.";
	return `Shell commands run inside a kernel sandbox. ONLY ${workspace} is writable.${them}${mang}

When a path outside that list fails, you will see "No such file or directory" — the sandbox makes it INVISIBLE rather than reporting a permission error. Treat that message on an outside path as BLOCKED, not missing: do not re-download it, do not recreate it, do not retry. Say which path you needed and that it is outside the sandbox, so the operator can add it to sandboxReadOnly in .agentweave/agent.json.`;
}

export interface TuyChonCauDan {
	/** Câu dẫn thêm của dự án, lấy từ .agentweave/agent.json. */
	cuaDuAn?: string;
	/** Lệnh kiểm tra của dự án, nếu biết — giúp model khỏi phải đoán. */
	lenhKiemTra?: string;
	/** Máy không có mạng. Mặc định TRUE — xem `offline` trong agent-config. */
	khongMang?: boolean;
	/** Dạy model dùng danh sách việc. Mặc định TẮT — xem `danhSachViec` trong agent-config. */
	danhSachViec?: boolean;
	/** Bật cô lập tầng nhân: thư mục ghi được duy nhất. Bỏ trống = không cô lập. */
	workspaceCoLap?: string;
	/** Đường dẫn chỉ đọc thêm trong sandbox. */
	choDocThem?: string[];
}

export function dungCauDanHeThong(t: TuyChonCauDan = {}): string {
	const phan = [LOI];

	if (t.khongMang !== false) {
		phan.push(KHONG_MANG);
	}
	if (t.danhSachViec === true) {
		phan.push(CAU_DAN_TODO);
	}
	if (t.workspaceCoLap) {
		phan.push(coLapTienTrinh(t.workspaceCoLap, t.choDocThem ?? [], t.khongMang !== false));
	}
	if (t.lenhKiemTra) {
		phan.push(`The project's check command is: ${t.lenhKiemTra}`);
	}
	if (t.cuaDuAn?.trim()) {
		phan.push(`Project-specific instructions:\n${t.cuaDuAn.trim()}`);
	}

	return phan.join("\n\n");
}

/**
 * Đoán lệnh kiểm tra từ package.json. Chỉ đoán khi CHẮC CHẮN — đoán sai làm
 * model chạy nhầm lệnh rồi báo kết quả của thứ khác.
 */
export async function doanLenhKiemTra(cwd: string): Promise<string | undefined> {
	try {
		const { readFile } = await import("node:fs/promises");
		const { join } = await import("node:path");
		const raw = await readFile(join(cwd, "package.json"), "utf-8");
		const pkg = JSON.parse(raw) as { scripts?: Record<string, string> };
		if (typeof pkg.scripts?.test === "string" && pkg.scripts.test.trim()) return "npm test";
	} catch {
		// Không có package.json, hoặc hỏng — im lặng, đừng đoán bừa.
	}
	return undefined;
}
