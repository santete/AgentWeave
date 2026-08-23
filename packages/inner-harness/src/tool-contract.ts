/**
 * Hợp đồng giao tiếp giữa model và tool.
 *
 * Ba việc, cùng một nguyên tắc: **model sai thì phải nhận lại câu nói rõ sai ở
 * đâu và cái đúng trông thế nào** — không phải một bãi lỗi máy sinh.
 *
 *   ① `chuanHoaThamSo`  sửa các kiểu lệch vô hại trước khi kiểm tra
 *   ② `dienGiaiLoiZod`  dịch lỗi kiểm tra sang chữ người (và model) đọc được
 *   ③ `goiYTenGan`      tên tool gõ sai → tên đúng gần nhất
 *
 * VÌ SAO ĐÁNG LÀM RIÊNG MỘT MODULE
 *
 * Bản trước gọi thẳng `tool.parameters.parse(...)` rồi bắt lỗi và trả
 * `err.message`. Với zod, `err.message` là một mảng JSON. Model 30B nhận lại
 * hai chục dòng như thế này cho một tham số thiếu:
 *
 *     [{"code":"invalid_type","expected":"string","received":"undefined",
 *       "path":["path"],"message":"Required"}, ...]
 *
 * Nó không suy ra được "thiếu tham số path" từ đống đó — nó thử lại y hệt,
 * hoặc bỏ cuộc và tuyên bố đã xong. Cả hai đều tốn cả lượt.
 *
 * NGUYÊN TẮC CHỐNG SỬA LẶNG LẼ
 *
 * `chuanHoaThamSo` có sửa gì thì LIỆT KÊ ra để nơi gọi nói lại cho model. Sửa
 * ngầm thì model không bao giờ học được khuôn đúng, và lượt sau lại sai y
 * nguyên — ta trả tiền sửa mãi mãi thay vì trả một lần.
 */

import { z } from "zod";

// ─── ① Chuẩn hoá tham số ─────────────────────────────────────────

export interface KetQuaChuanHoa {
	thamSo: Record<string, unknown>;
	/** Những gì đã sửa, viết cho model đọc. Rỗng = không đụng gì. */
	daSua: string[];
}

/** Lớp vỏ mà model hay bọc thừa quanh tham số thật. */
const VO_THUA = ["input", "arguments", "parameters", "args", "params"] as const;

/**
 * Sửa các kiểu lệch vô hại trước khi kiểm tra.
 *
 * Chỉ sửa khi KHÔNG CÓ NGHI NGỜ NÀO:
 *   · `{"input": {...}}` bọc quanh tham số thật — chỉ gỡ khi lớp ngoài không
 *     có khoá nào trùng với schema, tức là chắc chắn nó là vỏ chứ không phải
 *     một tham số tên `input`
 *   · `"10"` khi schema đòi number — chỉ khi chuỗi là số hợp lệ trọn vẹn
 *   · `"true"`/`"false"` khi schema đòi boolean
 *
 * KHÔNG sửa: chuỗi rỗng, `"abc"` cho number, số cho string (mất kiểu gốc là
 * mất thông tin), hay bất cứ thứ gì cần đoán ý.
 */
export function chuanHoaThamSo(tho: unknown, schema: z.ZodTypeAny): KetQuaChuanHoa {
	const daSua: string[] = [];
	let thamSo: Record<string, unknown> =
		tho && typeof tho === "object" && !Array.isArray(tho)
			? { ...(tho as Record<string, unknown>) }
			: {};

	// Model đôi khi gửi chuỗi JSON thay vì object. Rẻ và an toàn để gỡ.
	if (typeof tho === "string") {
		try {
			const p: unknown = JSON.parse(tho);
			if (p && typeof p === "object" && !Array.isArray(p)) {
				thamSo = { ...(p as Record<string, unknown>) };
				daSua.push("your arguments arrived as a JSON string; send them as a JSON object");
			}
		} catch {
			// Không phải JSON — để nguyên, bước kiểm tra bên dưới sẽ báo lỗi rõ.
		}
	}

	const shape = layShape(schema);

	// ── Gỡ lớp vỏ thừa ──
	const khoa = Object.keys(thamSo);
	if (khoa.length === 1 && VO_THUA.includes(khoa[0] as (typeof VO_THUA)[number])) {
		const trong = thamSo[khoa[0]!];
		// Chỉ gỡ khi schema KHÔNG có tham số cùng tên — nếu có thì `input` là
		// tham số thật, gỡ đi là phá dữ liệu.
		if (trong && typeof trong === "object" && !Array.isArray(trong) && !(shape && khoa[0]! in shape)) {
			thamSo = { ...(trong as Record<string, unknown>) };
			daSua.push(`your arguments were wrapped in an extra "${khoa[0]}" object; send them at the top level`);
		}
	}

	// ── Ép kiểu vô hại theo schema ──
	if (shape) {
		for (const [ten, truong] of Object.entries(shape)) {
			if (!(ten in thamSo)) continue;
			const giaTri = thamSo[ten];
			if (typeof giaTri !== "string") continue;

			const kieu = kieuGoc(truong);
			if (kieu === "number" && laSoTron(giaTri)) {
				thamSo[ten] = Number(giaTri);
				daSua.push(`"${ten}" arrived as the string "${giaTri}"; it must be a number (${giaTri})`);
			} else if (kieu === "boolean" && (giaTri === "true" || giaTri === "false")) {
				thamSo[ten] = giaTri === "true";
				daSua.push(`"${ten}" arrived as the string "${giaTri}"; it must be a boolean (${giaTri})`);
			}
		}
	}

	return { thamSo, daSua };
}

/** Chuỗi biểu diễn TRỌN VẸN một số hữu hạn — `"10"` có, `"10abc"` và `""` không. */
function laSoTron(s: string): boolean {
	const t = s.trim();
	if (t === "") return false;
	const n = Number(t);
	return Number.isFinite(n) && String(n) === t;
}

function layShape(schema: z.ZodTypeAny): Record<string, z.ZodTypeAny> | null {
	const goc = boVo(schema);
	if (goc instanceof z.ZodObject) {
		return goc.shape as Record<string, z.ZodTypeAny>;
	}
	return null;
}

/** Bóc optional/nullable/default để thấy kiểu thật bên trong. */
function boVo(s: z.ZodTypeAny): z.ZodTypeAny {
	let cur = s;
	// Trần lặp: schema tự tham chiếu (z.lazy) không nên treo vòng lặp này.
	for (let i = 0; i < 10; i++) {
		if (cur instanceof z.ZodOptional || cur instanceof z.ZodNullable || cur instanceof z.ZodDefault) {
			cur = (cur._def as { innerType: z.ZodTypeAny }).innerType;
			continue;
		}
		break;
	}
	return cur;
}

function kieuGoc(s: z.ZodTypeAny): "number" | "boolean" | "string" | "khac" {
	const goc = boVo(s);
	if (goc instanceof z.ZodNumber) return "number";
	if (goc instanceof z.ZodBoolean) return "boolean";
	if (goc instanceof z.ZodString) return "string";
	return "khac";
}

// ─── ② Diễn giải lỗi kiểm tra ────────────────────────────────────

/** `['todos', 0, 'activeForm']` → `todos[0].activeForm` */
export function duongDanLoi(path: ReadonlyArray<PropertyKey>): string {
	return path.reduce<string>((acc, doan, i) => {
		if (typeof doan === "number") return `${acc}[${doan}]`;
		return i === 0 ? String(doan) : `${acc}.${String(doan)}`;
	}, "");
}

/**
 * Dịch lỗi zod sang câu model sửa được.
 *
 * Gộp theo LOẠI lỗi chứ không liệt kê tuần tự: model đọc "thiếu 2 tham số"
 * nhanh hơn hẳn hai dòng lỗi rời rạc lẫn giữa các lỗi kiểu.
 */
export function dienGiaiLoiZod(tenTool: string, err: z.ZodError): string {
	const thieu: string[] = [];
	/** Kiểu mong đợi của tham số thiếu — model nhỏ cần biết để điền đúng. */
	const kieuThieu = new Map<string, string>();
	const thua: string[] = [];
	const saiKieu: Array<{ ten: string; can: string; nhan: string }> = [];
	const khac: string[] = [];

	for (const issue of err.issues) {
		const ten = duongDanLoi(issue.path) || "(goc)";
		if (issue.code === "invalid_type") {
			const it = issue as z.ZodInvalidTypeIssue;
			if (it.received === "undefined") {
				thieu.push(ten);
				kieuThieu.set(ten, String(it.expected));
			}
			else saiKieu.push({ ten, can: String(it.expected), nhan: String(it.received) });
		} else if (issue.code === "unrecognized_keys") {
			thua.push(...(issue as z.ZodUnrecognizedKeysIssue).keys);
		} else {
			// Lỗi ở GỐC object (vd `.refine()` đòi "path is required") không gắn với
			// tham số nào, nên đừng in chỗ giữ chỗ `(goc)` — nó là tên nội bộ, lộ
			// ra chỉ làm người đọc tưởng có một tham số tên như vậy.
			khac.push(duongDanLoi(issue.path) === "" ? issue.message : `\`${ten}\`: ${issue.message}`);
		}
	}

	const phan: string[] = [];
	if (thieu.length > 0) {
		// Kèm KIỂU: model nhỏ gọi tool với `{}` rỗng khá thường xuyên (đo thật:
		// `Glob{}` rồi `FileRead{}` liên tiếp lúc đang dò tài liệu). Nói tên tham
		// số thôi thì nó vẫn phải đoán điền chuỗi hay số.
		phan.push(
			`missing ${thieu.map((t) => `\`${t}\`${kieuThieu.get(t) ? ` (${kieuThieu.get(t)})` : ""}`).join(", ")}`,
		);
	}
	for (const s of saiKieu) {
		phan.push(`\`${s.ten}\` must be a ${s.can}, not a ${s.nhan}`);
	}
	if (thua.length > 0) {
		phan.push(`unexpected ${thua.map((t) => `\`${t}\``).join(", ")}`);
	}
	phan.push(...khac);

	// Không nhận ra loại nào thì thà đưa nguyên bản còn hơn nuốt mất thông tin.
	if (phan.length === 0) return `${tenTool} rejected your arguments: ${err.message}`;

	// MỘT DÒNG, và dòng đó phải TỰ ĐỦ NGHĨA.
	//
	// Bản trước viết tiêu đề ở dòng đầu rồi gạch đầu dòng chi tiết bên dưới —
	// đọc trong hội thoại thì rõ, nhưng giao diện chỉ hiện dòng đầu của kết quả
	// tool, nên người dùng thấy đúng câu vô dụng nhất:
	//
	//     ✗ Glob rejected your arguments — fix and call it again:
	//
	// Không biết thiếu tham số gì, mà lỗi thì đỏ chót. Gói tất cả vào một dòng
	// thì cả model lẫn người đọc đều nhận đủ thông tin ở chỗ họ nhìn.
	return `${tenTool}: ${phan.join("; ")} — fix and call it again.`;
}

// ─── ③ Gợi ý tên gần nhất ────────────────────────────────────────

/**
 * Tên hợp lệ gần nhất với tên model gõ sai, hoặc `null` nếu không đủ giống.
 *
 * Ngưỡng theo TỈ LỆ độ dài chứ không phải số tuyệt đối: `Bsh`→`Bash` lệch 1
 * trên 4 ký tự là rất giống, còn lệch 1 trên 4 ký tự với một tên 20 ký tự thì
 * hai tên đó vốn đã khác nhau. Gợi ý bừa còn tệ hơn không gợi ý — model tin
 * ngay và gọi sang tool khác.
 */
export function goiYTenGan(sai: string, hopLe: ReadonlyArray<string>): string | null {
	const a = sai.toLowerCase();
	let tot: { ten: string; d: number } | null = null;

	for (const ten of hopLe) {
		const d = khoangCach(a, ten.toLowerCase());
		if (tot === null || d < tot.d) tot = { ten, d };
	}
	if (tot === null) return null;

	const nguong = Math.max(1, Math.floor(Math.max(sai.length, tot.ten.length) * 0.34));
	return tot.d <= nguong ? tot.ten : null;
}

/** Levenshtein, hai hàng — đủ cho danh sách tool vài chục cái. */
function khoangCach(a: string, b: string): number {
	if (a === b) return 0;
	if (a.length === 0) return b.length;
	if (b.length === 0) return a.length;

	let truoc = Array.from({ length: b.length + 1 }, (_, i) => i);
	let nay = new Array<number>(b.length + 1);

	for (let i = 1; i <= a.length; i++) {
		nay[0] = i;
		for (let j = 1; j <= b.length; j++) {
			const gia = a[i - 1] === b[j - 1] ? 0 : 1;
			nay[j] = Math.min(truoc[j]! + 1, nay[j - 1]! + 1, truoc[j - 1]! + gia);
		}
		[truoc, nay] = [nay, truoc];
	}
	return truoc[b.length]!;
}

/**
 * Thông báo khi model gọi một tool không tồn tại.
 *
 * Nêu tên đúng gần nhất TRƯỚC danh sách đầy đủ: model nhỏ bám vế đầu câu, nên
 * thứ có xác suất đúng cao nhất phải đứng đầu.
 */
export function loiToolKhongCo(sai: string, hopLe: ReadonlyArray<string>): string {
	if (hopLe.length === 0) {
		return `Tool "${sai}" does not exist, and no tools are registered in this session.`;
	}
	const goiY = goiYTenGan(sai, hopLe);
	const dau = goiY
		? `Tool "${sai}" does not exist. Did you mean \`${goiY}\`?`
		: `Tool "${sai}" does not exist.`;
	return `${dau} Available tools: ${hopLe.join(", ")}. Use one of these exact names — do not invent tool names.`;
}

// ─── ④ Trần kích thước kết quả ───────────────────────────────────

/**
 * Trần mặc định khi tool không khai `maxOutputSize`.
 *
 * 30.000 ký tự ≈ 7.500 token ≈ 11% cửa sổ 64K. Đủ rộng cho gần như mọi kết quả
 * thật, đủ chặt để một lệnh lạc lối (`find /`) không nuốt trọn cửa sổ.
 */
export const TRAN_KET_QUA_MAC_DINH = 30_000;

/**
 * Cắt kết quả tool quá dài, GIỮ CẢ HAI ĐẦU.
 *
 * Vì sao không cắt đuôi như thường lệ: với đầu ra của lệnh, thông tin nằm ở
 * hai cực. Đầu có lệnh đã chạy và những dòng khởi động; cuối có mã thoát và
 * lỗi thật — thứ agent cần nhất. Cắt đuôi là vứt đúng phần quan trọng nhất, và
 * đó chính là kiểu "chạy xong, không hiểu vì sao hỏng" khó gỡ nhất.
 *
 * Phần cắt LUÔN kèm câu chỉ đường. Cắt im lặng thì model tưởng đó là toàn bộ
 * sự thật và kết luận trên dữ liệu thiếu.
 */
export function catKetQua(noi: string, tran = TRAN_KET_QUA_MAC_DINH): string {
	if (tran <= 0 || noi.length <= tran) return noi;

	const ghi =
		`\n\n[... đã cắt ${noi.length - tran} / ${noi.length} ký tự ở giữa. ` +
		`Cần phần thiếu thì chạy lại với lệnh lọc hẹp hơn (grep, head, tail) ` +
		`hoặc đọc file theo khoảng dòng. ...]\n\n`;

	// Chia đôi phần còn lại; trần quá nhỏ để chứa cả ghi chú thì ưu tiên phần đầu.
	const conLai = Math.max(0, tran - ghi.length);
	const nua = Math.floor(conLai / 2);
	if (nua <= 0) return noi.slice(0, tran);

	return noi.slice(0, nua) + ghi + noi.slice(noi.length - nua);
}
