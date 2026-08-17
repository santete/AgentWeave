/**
 * Câu dẫn hệ thống mặc định cho agent lập trình cục bộ.
 *
 * Trước đây `chat` và `serve` KHÔNG đặt system prompt nào cả — model chạy trần,
 * không biết mình là gì, có tool nào, và phải làm việc theo quy trình ra sao.
 * Đó là lý do nó hay tuyên bố "đã sửa xong, các test đều pass" mà chưa hề chạy
 * test lần nào: không ai bảo nó phải chạy.
 *
 * Hai ràng buộc chi phối cách viết:
 *
 *   ① NGẮN. Câu dẫn nằm thường trực trong mọi lượt gọi. Context 16K đã làm tốc
 *      độ giảm 34% trên máy này, nên mỗi dòng thừa phải trả giá suốt phiên.
 *   ② MỆNH LỆNH, điều kiện đặt TRƯỚC hành động. Đo thật khi làm hệ thống Skill:
 *      qwen3-coder:30b bỏ qua hoàn toàn câu "làm X, nhưng chỉ khi Y" — model 30B
 *      bám vế đầu câu, vế nhượng bộ đứng sau bị loãng.
 */

/** Quy tắc lõi. Giữ dưới ~200 token. */
const LOI = `You are a coding agent working in a local repository. Tools run on the user's real machine.

If you edited any file, you MUST run the project's check command with Bash before you finish, and report its real output. Saying "the tests pass" without running them is a failure, even if the change looks correct.

Other rules:
- Read a file before rewriting it. Use Glob or Grep to find paths — never invent them.
- Change only what the task asks for. Leave unrelated defaults, signatures and config alone.
- Prefer FileEdit over FileWrite so untouched parts of the file stay untouched.
- Be concise: say what you changed and what the check actually printed.`;

export interface TuyChonCauDan {
	/** Câu dẫn thêm của dự án, lấy từ .agentweave/agent.json. */
	cuaDuAn?: string;
	/** Lệnh kiểm tra của dự án, nếu biết — giúp model khỏi phải đoán. */
	lenhKiemTra?: string;
}

export function dungCauDanHeThong(t: TuyChonCauDan = {}): string {
	const phan = [LOI];

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
