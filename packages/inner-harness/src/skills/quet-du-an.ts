/**
 * Quét dự án MỘT LẦN lúc khởi động, để biết `paths:` của skill nào đã khớp
 * thứ có sẵn trong repo.
 *
 * VẤN ĐỀ NÓ GIẢI QUYẾT
 *
 * Skill có `paths:` chỉ được giới thiệu SAU khi model chạm một file khớp. Với
 * skill quy ước thì thế là muộn đúng lúc quan trọng nhất: đề bài "viết một
 * class C# mới" khiến model **viết xong file .cs đầu tiên** rồi mới nhận được
 * quy ước .NET — mà quy ước sinh ra chính là để định hình lần viết đó.
 *
 * Cách xử: nếu dự án ĐÃ CÓ file khớp `paths:` thì skill vào thẳng chỉ mục nền,
 * có mặt từ lượt 1. Dự án Python không có file `.cs` nào thì dòng quy ước .NET
 * vẫn không xuất hiện — tiết kiệm còn mạnh hơn cả cơ chế theo-đường-dẫn.
 *
 * VÌ SAO CHỈ ÁP DỤNG CHO SKILL, KHÔNG CHO RULE
 *
 * Skill trong chỉ mục là MỘT DÒNG (~70 byte) — chi phí gần bằng không, nên
 * thà có sớm. Rule là cả khối chữ; đưa rule `src/api/**` vào prompt thường
 * trực chỉ vì thư mục đó tồn tại là đánh mất toàn bộ lợi ích của cơ chế có
 * điều kiện. Hai thứ khác chi phí thì phải khác chính sách.
 *
 * CHI PHÍ
 *
 * Một lượt duyệt cây có chặn, dùng chung cho MỌI skill: mỗi tệp gặp được thử
 * với mọi bộ khớp, và bộ nào khớp rồi thì loại khỏi danh sách còn phải thử.
 * Dừng sớm khi mọi bộ khớp đã có kết quả.
 */

import { readdir } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { chuanHoa } from "../rules/khop-duong-dan";

/** Trần số tệp duyệt. Chạm trần thì dừng — quét lâu hơn không đáng cho một dòng chỉ mục. */
export const MAX_TEP_QUET = 4_000;

/** Trần độ sâu, tính từ gốc dự án. */
export const MAX_SAU_QUET = 6;

/**
 * Thư mục bỏ qua.
 *
 * `node_modules` là quan trọng nhất: một thư viện bất kỳ trong đó có tệp `.cs`
 * hay `.py` sẽ làm cả bộ quy ước của ngôn ngữ đó bật lên nhầm cho một dự án
 * không hề dùng ngôn ngữ ấy.
 */
export const THU_MUC_BO_QUA: ReadonlySet<string> = new Set([
	"node_modules", ".git", ".hg", ".svn", "dist", "build", "out", "target",
	"bin", "obj", ".venv", "venv", "__pycache__", "vendor", ".next", ".nuxt",
	"coverage", ".turbo", ".cache", ".gradle", ".idea", ".vscode", ".agentweave",
]);

export interface BoKhopCanQuet {
	khoa: string;
	khop: (duongTuongDoi: string) => boolean;
}

/**
 * Duyệt dự án, trả về khoá của những bộ khớp có ít nhất một tệp khớp.
 *
 * @param projectDir gốc dự án
 * @param cac danh sách bộ khớp cần kiểm tra
 */
export async function quetDuAn(
	projectDir: string,
	cac: ReadonlyArray<BoKhopCanQuet>,
): Promise<Set<string>> {
	const trung = new Set<string>();
	if (cac.length === 0) return trung;

	const goc = resolve(projectDir);
	const conLai = new Map(cac.map((c) => [c.khoa, c.khop]));
	let daDuyet = 0;

	// Duyệt theo BỀ RỘNG: tệp ở tầng nông (package.json, *.csproj ở gốc) là tín
	// hiệu mạnh nhất về stack, nên gặp chúng trước rồi mới đi sâu.
	const hangDoi: Array<{ dir: string; sau: number }> = [{ dir: goc, sau: 0 }];

	while (hangDoi.length > 0 && conLai.size > 0 && daDuyet < MAX_TEP_QUET) {
		const { dir, sau } = hangDoi.shift()!;

		let muc: Array<{ name: string; isDir: boolean }>;
		try {
			muc = (await readdir(dir, { withFileTypes: true })).map((d) => ({
				name: d.name,
				isDir: d.isDirectory(),
			}));
		} catch {
			continue; // không đọc được thư mục con là chuyện bình thường, bỏ qua
		}

		for (const m of muc) {
			if (m.isDir) {
				if (sau + 1 <= MAX_SAU_QUET && !THU_MUC_BO_QUA.has(m.name)) {
					hangDoi.push({ dir: join(dir, m.name), sau: sau + 1 });
				}
				continue;
			}

			daDuyet++;
			if (daDuyet > MAX_TEP_QUET) break;

			const tuongDoi = chuanHoa(relative(goc, join(dir, m.name)));
			for (const [khoa, khop] of conLai) {
				if (!khop(tuongDoi)) continue;
				trung.add(khoa);
				// Đã có kết quả thì khỏi thử bộ khớp này với các tệp còn lại.
				conLai.delete(khoa);
			}
			if (conLai.size === 0) break;
		}
	}

	return trung;
}
