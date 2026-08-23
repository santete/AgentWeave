/**
 * Cấu hình agent theo dự án: `.agentweave/agent.json`.
 *
 * Vì sao cần: không có nó thì mỗi lần chạy phải gõ lại `--model`, `--mode`,
 * `--max-turns`. Tệ hơn, mỗi dự án một stack khác nhau nên luật quyền cũng
 * khác — gõ tay thì sớm muộn cũng sai một lần, mà sai theo hướng nới lỏng thì
 * không ai nhận ra.
 *
 * Thứ tự ưu tiên: cờ dòng lệnh > tệp dự án > mặc định. Cờ luôn thắng để còn
 * ghi đè nhanh khi cần.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";

export const DUONG_CAU_HINH = ".agentweave/agent.json";

export interface LuatQuyen {
	pattern: string;
	behavior: "allow" | "deny" | "ask";
	message?: string;
}

export interface CauHinhAgent {
	model?: string;
	permissionMode?: "default" | "strict" | "permissive" | "plan";
	maxTurns?: number;
	budget?: number;
	contextWindow?: number;
	/** Ép Ollama trả tool-call qua format schema (constrained) thay vì tự do + cứu. */
	structuredProtocol?: boolean;
	/** Câu dẫn thêm vào system prompt cho riêng dự án này. */
	systemPrompt?: string;
	/** Luật quyền BỔ SUNG. Luật chặn cứng dựng sẵn không bị ghi đè. */
	rules?: LuatQuyen[];
	/** Thư mục skill của tổ chức, nếu để ngoài repo. */
	orgSkillsDir?: string;
	/** Thư mục rule của tổ chức. Chính sách bắt buộc, nạp trước mọi tầng khác. */
	orgRulesDir?: string;
	/**
	 * Cô lập lệnh Bash ở TẦNG NHÂN (bubblewrap trên Linux, seatbelt trên macOS).
	 *
	 * MẶC ĐỊNH TẮT — và đó là lựa chọn có chủ đích, không phải quên. Bật sandbox
	 * đổi hành vi chạy lệnh thật: chỉ thư mục dự án được ghi, không có mạng,
	 * `/tmp` là riêng. Một dự án dựa vào cache ngoài `~/.m2` hay `~/.nuget` sẽ
	 * build hỏng cho tới khi khai vào `sandboxReadOnly`. Nên phải bật tường minh
	 * sau khi thử trên chính máy đích, chứ không bật hộ rồi để người vận hành
	 * phát hiện lúc build đỏ.
	 */
	sandbox?: boolean;
	/**
	 * Bật tool `TodoWrite` để model ghi kế hoạch và bám tiến độ.
	 *
	 * MẶC ĐỊNH TẮT, và lý do là số liệu chứ không phải sở thích. Đo với
	 * qwen3-coder:30b trên cùng một việc ba bước, năm lần chạy: có lần model gọi
	 * TodoWrite 33-42 lần trên tổng 40-46 lời gọi tool — nó cập nhật danh sách
	 * thay cho làm việc; có lần bỏ qua hoàn toàn. Không lần nào việc được làm
	 * xong hơn so với khi tắt.
	 *
	 * Model mạnh hơn có thể dùng tốt. Hãy bật rồi tự đo trên việc thật của mình,
	 * đừng tin con số của ai khác — kể cả con số ở đây.
	 */
	danhSachViec?: boolean;
	/** Đường dẫn CHỈ ĐỌC thêm khi bật sandbox — toolchain, cache gói. */
	sandboxReadOnly?: string[];
	/**
	 * Hạn giờ cho mỗi lệnh Bash, mili-giây. Mặc định 10 phút.
	 *
	 * Cỡ build chênh nhau hàng chục lần giữa các dự án: một gói Node test xong
	 * trong 20 giây, còn `mvn clean install` trên monorepo Spring có thể 15 phút.
	 * Một con số cứng không vừa cho tất cả, mà đặt quá ngắn thì lệnh kiểm tra bị
	 * giết giữa chừng — agent mất đúng thứ nó cần nhất.
	 */
	bashTimeoutMs?: number;
	/**
	 * Máy có mạng hay không. MẶC ĐỊNH LÀ KHÔNG.
	 *
	 * Sản phẩm này sinh ra cho khu cô lập, nên mặc định phải là trạng thái ở đó.
	 * Đoán sai theo hướng "tưởng không có mạng" chỉ làm agent thận trọng thừa,
	 * sửa bằng một dòng cấu hình. Đoán sai theo hướng ngược lại thì trong khu
	 * bảo mật agent cứ bảo dev `npm install`, không có đường sửa.
	 */
	offline?: boolean;
	/**
	 * Model thị giác để TỰ CHUYỂN sang khi đầu vào có ảnh mà model chính không
	 * đọc được ảnh. Bỏ trống thì agent tự dò trong các model đã cài. Chỉ đổi
	 * cho đúng lượt có ảnh, xong quay lại model chính (model thị giác không chạy
	 * được công cụ nên không giữ nó cho việc sửa code).
	 */
	visionModel?: string;
	/**
	 * Tham số bộ sinh của model — `temperature`, `topP`, `repeatPenalty`, `seed`.
	 *
	 * Trước đợt rà soát `docs/RA-SOAT-DIEU-KHIEN.md` không có trường nào trong
	 * số này: hệ cố sửa hành vi sampler bằng văn bản trong khi mọi nút chỉnh
	 * sampler bỏ trống, và không có seed nên một phiên hỏng không tái lập được.
	 *
	 * Bỏ trống = KHÔNG gửi, để mặc định của model. Đặt một con số "trông có vẻ
	 * đúng" sẽ ghi đè Modelfile mà người vận hành đã cân.
	 */
	temperature?: number;
	topP?: number;
	/** `repeat_penalty` của Ollama. Lặp bị phát hiện thì harness tự leo thêm nấc. */
	repeatPenalty?: number;
	seed?: number;
	/**
	 * Trần THỜI GIAN cho một lượt agent (một câu của người dùng), mili-giây.
	 *
	 * Bỏ trống = không có trần. Đây là phanh duy nhất còn hiệu lực với model cục
	 * bộ: `budget` tính bằng USD mà Ollama luôn tính giá 0, nên nó không bao giờ
	 * kích; còn `maxTurns` đếm LƯỢT chứ không đếm giờ — 50 lượt của một model
	 * 30B trên Jetson có thể là 40 phút.
	 *
	 * Kiểm ở đầu mỗi lượt, nên một lệnh Bash đang chạy không bị cắt ngang (đó là
	 * việc của `bashTimeoutMs`). Trần này chặn phần TÍCH LUỸ.
	 */
	maxDurationMs?: number;
	/**
	 * Ghi VẾT TÍCH: mọi điểm chạm dữ liệu giữa người dùng, agent và model.
	 *
	 * **MẶC ĐỊNH BẬT** — lựa chọn có chủ đích cho giai đoạn sản phẩm còn chạy
	 * chưa ổn định. Mỗi phiên sinh `.agentweave/vet-tich/<phien>/` chứa dòng
	 * thời gian JSONL cộng payload NGUYÊN VẸN của từng lượt gọi model, kể cả
	 * chuỗi prompt đầy đủ — thứ không tồn tại ở bất kỳ tầng log nào khác.
	 *
	 * Tốn đĩa: một phiên dài cỡ vài chục MB, giữ 20 phiên gần nhất rồi tự dọn.
	 * Đổi lại, một lần agent hỏng mà không tái hiện được là một buổi phải chạy
	 * lại — đắt hơn nhiều so với chỗ đĩa.
	 *
	 * Tắt bằng `false`, hoặc `AGENTWEAVE_TRACE=0`. Khi sản phẩm ổn định thì đảo
	 * mặc định lại trong `lib/vet-tich-tep.ts` → `batVetTich`.
	 */
	vetTich?: boolean;
}

const CHE_DO = ["default", "strict", "permissive", "plan"] as const;
const HANH_VI = ["allow", "deny", "ask"] as const;

/**
 * Kiểm tra thủ công thay vì dùng zod: gói cli không có zod, mà thêm phụ thuộc
 * chỉ để đọc 8 trường thì không đáng — gói bàn giao air-gap phải mang theo mọi
 * thứ. Đổi lại, thông báo lỗi viết được rõ ràng hơn.
 */
function kiemTra(x: unknown): { ok: true; giaTri: CauHinhAgent } | { ok: false; loi: string[] } {
	const loi: string[] = [];
	if (typeof x !== "object" || x === null || Array.isArray(x)) {
		return { ok: false, loi: ["gốc phải là một object JSON"] };
	}
	const o = x as Record<string, unknown>;
	const ra: CauHinhAgent = {};

	const chuoi = (k: keyof CauHinhAgent, max = 20_000) => {
		const v = o[k];
		if (v === undefined) return;
		if (typeof v !== "string" || v.length === 0 || v.length > max) {
			loi.push(`${k}: phải là chuỗi 1..${max} ký tự`);
			return;
		}
		(ra as Record<string, unknown>)[k] = v;
	};
	const so = (k: keyof CauHinhAgent, min: number, max: number, nguyen = true) => {
		const v = o[k];
		if (v === undefined) return;
		if (
			typeof v !== "number" ||
			!Number.isFinite(v) ||
			v < min ||
			v > max ||
			(nguyen && !Number.isInteger(v))
		) {
			loi.push(`${k}: phải là số ${nguyen ? "nguyên " : ""}trong khoảng ${min}..${max}`);
			return;
		}
		(ra as Record<string, unknown>)[k] = v;
	};

	const mangChuoi = (k: keyof CauHinhAgent, max = 64) => {
		const v = o[k];
		if (v === undefined) return;
		if (!Array.isArray(v) || v.length > max || v.some((x) => typeof x !== "string" || x === "")) {
			loi.push(`${k}: phải là mảng tối đa ${max} chuỗi không rỗng`);
			return;
		}
		(ra as Record<string, unknown>)[k] = v;
	};

	const bool = (k: keyof CauHinhAgent) => {
		const v = o[k];
		if (v === undefined) return;
		if (typeof v !== "boolean") {
			loi.push(`${k}: phải là true hoặc false`);
			return;
		}
		(ra as Record<string, unknown>)[k] = v;
	};

	chuoi("model", 200);
	chuoi("systemPrompt");
	chuoi("orgSkillsDir", 4096);
	chuoi("orgRulesDir", 4096);
	bool("sandbox");
	bool("danhSachViec");
	mangChuoi("sandboxReadOnly");
	chuoi("visionModel", 200);
	so("maxTurns", 1, 10_000);
	so("contextWindow", 1, 10_000_000);
	so("budget", 0, 10_000, false);
	// Trần 2 giờ: quá đó thì vấn đề nằm ở build chứ không phải ở hạn giờ.
	so("bashTimeoutMs", 1_000, 7_200_000);
	// Khoảng hợp lệ theo tài liệu Ollama; ra ngoài là gõ nhầm chứ không phải
	// chủ ý, mà sai theo hướng nới thì model nói nhảm chứ không báo lỗi gì.
	so("temperature", 0, 2, false);
	so("topP", 0, 1, false);
	so("repeatPenalty", 0.5, 2, false);
	so("seed", 0, 2_147_483_647);
	// Trần 8 giờ: quá đó thì vấn đề nằm ở cách chia việc chứ không ở hạn giờ.
	so("maxDurationMs", 10_000, 28_800_000);
	bool("offline");
	bool("vetTich");

	if (o.permissionMode !== undefined) {
		if (!CHE_DO.includes(o.permissionMode as (typeof CHE_DO)[number])) {
			loi.push(`permissionMode: phải là một trong ${CHE_DO.join(", ")}`);
		} else {
			ra.permissionMode = o.permissionMode as CauHinhAgent["permissionMode"];
		}
	}

	if (o.rules !== undefined) {
		if (!Array.isArray(o.rules) || o.rules.length > 200) {
			loi.push("rules: phải là mảng, tối đa 200 phần tử");
		} else {
			const ds: LuatQuyen[] = [];
			o.rules.forEach((r, i) => {
				const l = r as Record<string, unknown>;
				if (typeof l?.pattern !== "string" || l.pattern.length === 0) {
					loi.push(`rules[${i}].pattern: thiếu hoặc rỗng`);
					return;
				}
				if (!HANH_VI.includes(l.behavior as (typeof HANH_VI)[number])) {
					loi.push(`rules[${i}].behavior: phải là một trong ${HANH_VI.join(", ")}`);
					return;
				}
				ds.push({
					pattern: l.pattern,
					behavior: l.behavior as LuatQuyen["behavior"],
					message: typeof l.message === "string" ? l.message : undefined,
				});
			});
			ra.rules = ds;
		}
	}

	return loi.length > 0 ? { ok: false, loi } : { ok: true, giaTri: ra };
}

export interface KetQuaDoc {
	config: CauHinhAgent;
	/** Đường dẫn tệp đã đọc, null nghĩa là không có tệp nào. */
	nguon: string | null;
	/** Tệp có nhưng hỏng — PHẢI hiện ra, đừng lặng lẽ dùng mặc định. */
	loi: string | null;
}

/**
 * Đọc cấu hình dự án.
 *
 * Tệp hỏng KHÔNG bị nuốt: trả về `loi` để chỗ gọi in cảnh báo. Lặng lẽ rơi về
 * mặc định là kiểu hỏng khó chịu nhất — người dùng sửa cấu hình rồi tưởng đã
 * có hiệu lực.
 */
export async function docCauHinhAgent(cwd: string): Promise<KetQuaDoc> {
	const duong = join(cwd, DUONG_CAU_HINH);

	let raw: string;
	try {
		raw = await readFile(duong, "utf-8");
	} catch {
		return { config: {}, nguon: null, loi: null };
	}

	let tho: unknown;
	try {
		tho = JSON.parse(raw);
	} catch (e) {
		return { config: {}, nguon: duong, loi: `JSON hỏng: ${(e as Error).message}` };
	}

	const kq = kiemTra(tho);
	if (!kq.ok) return { config: {}, nguon: duong, loi: kq.loi.join("; ") };

	return { config: kq.giaTri, nguon: duong, loi: null };
}

/** Gộp: cờ dòng lệnh thắng tệp cấu hình, tệp thắng mặc định. */
export function gop<T extends Record<string, unknown>>(
	tuCo: Partial<T>,
	tuTep: Partial<T>,
	macDinh: T,
): T {
	const ra = { ...macDinh };
	for (const k of Object.keys(macDinh) as Array<keyof T>) {
		if (tuCo[k] !== undefined) ra[k] = tuCo[k] as T[keyof T];
		else if (tuTep[k] !== undefined) ra[k] = tuTep[k] as T[keyof T];
	}
	return ra;
}
