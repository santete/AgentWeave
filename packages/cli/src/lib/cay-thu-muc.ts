/**
 * Sinh CÂY THƯ MỤC gọn của workspace để tiêm vào system prompt mỗi lượt.
 *
 * Vì sao: ngồi ghế người dùng lái phiên thật mới thấy — model KHÔNG biết cấu
 * trúc dự án, nó bịa layout ước lệ (`src/**`) rồi Grep mãi trong thư mục không
 * tồn tại → "No matches" → thử biến thể → kẹt loop. Đưa sẵn cây thư mục thật
 * thì khỏi dò: mọi search/read trỏ đúng chỗ ngay từ lượt đầu.
 *
 * Giữ NHỎ (trần mục + độ sâu) vì nằm trong mọi lượt gọi; bỏ thư mục sinh ra
 * (obj/bin/node_modules/.git…) — thứ model không bao giờ cần sửa.
 */
import { readdirSync } from "node:fs";
import { join } from "node:path";

const BO_QUA = new Set([
	"node_modules", ".git", "obj", "bin", "dist", ".agentweave", ".vs", ".idea",
	"__pycache__", ".venv", "target", "build",
]);
const TRAN_MUC = 150;
const SAU_TOI_DA = 4;

export function dungCayThuMuc(goc: string): string {
	const dong: string[] = [];
	let dem = 0;
	let cat = false;

	// In ĐƯỜNG DẪN ĐẦY ĐỦ mỗi dòng (không thụt đầu dòng): lái phiên thật cho thấy
	// model không dựng lại nổi path từ indentation — nó bỏ prefix thư mục ngoài
	// (ghi Helpdesk.Api/... thay vì HelpdeskSolution/Helpdesk.Api/...) nên file
	// rơi ra ngoài solution. Path đầy đủ thì chỉ việc copy nguyên văn.
	const duyet = (duong: string, sau: number, tien: string): void => {
		if (cat || sau > SAU_TOI_DA) return;
		let muc: Array<{ ten: string; laDir: boolean }>;
		try {
			muc = readdirSync(duong, { withFileTypes: true })
				.filter((e) => !BO_QUA.has(e.name) && !e.name.startsWith("."))
				.map((e) => ({ ten: e.name, laDir: e.isDirectory() }))
				.sort((a, b) => Number(b.laDir) - Number(a.laDir) || a.ten.localeCompare(b.ten));
		} catch {
			return;
		}
		for (const m of muc) {
			if (dem >= TRAN_MUC) { cat = true; return; }
			dem++;
			const duongDay = tien ? `${tien}/${m.ten}` : m.ten;
			dong.push(`${duongDay}${m.laDir ? "/" : ""}`);
			if (m.laDir) duyet(join(duong, m.ten), sau + 1, duongDay);
		}
	};
	duyet(goc, 0, "");
	if (dong.length === 0) return "";
	return `Workspace files (REAL paths relative to cwd, generated just now — COPY these exactly, do not invent or shorten paths):\n${dong.join("\n")}${cat ? "\n… (cắt bớt)" : ""}`;
}
