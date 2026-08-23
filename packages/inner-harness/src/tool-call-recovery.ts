/**
 * Cứu tool-call mà model nhả ra dưới dạng CHỮ thay vì tool call thật.
 *
 * Vì sao cần: model chạy cục bộ (qwen3-coder, qwen3.6…) dùng khuôn Hermes.
 * Endpoint tương thích OpenAI của Ollama phần lớn phân giải được, nhưng khi
 * model lệch khuôn một chút thì cả khối rơi xuống `content` dưới dạng chữ.
 * Quan sát thật trên máy này, cùng một phiên có cả hai dạng:
 *
 *     <function=Bash><parameter=command>node --test test/</parameter></function>
 *     [{"type":"tool_use","id":"call_x","name":"Bash","input":{"command":"..."}}]
 *
 * Hậu quả nếu không cứu: vòng lặp thấy "không có tool call" → coi là model đã
 * trả lời xong → kết thúc với reason "completed" trong khi chưa làm gì cả.
 * Đo thật: agent dừng ở lượt 1, 0 tool được gọi, `git diff` trống.
 *
 * Nguyên tắc chống nhận nhầm:
 *   ① chỉ chạy khi KHÔNG có tool call hợp lệ nào
 *   ② chỉ nhận tên tool ĐÃ ĐĂNG KÝ — model bàn "hàm Bash" trong văn xuôi
 *      sẽ không khớp vì phải đúng cú pháp khối
 *   ③ mọi lần cứu đều phát sự kiện để kiểm toán được, không sửa lặng lẽ
 */

import { nanoid } from "nanoid";
import type { ToolCall } from "./tool-executor";

export interface KetQuaCuu {
	toolCalls: ToolCall[];
	/** Phần chữ còn lại sau khi bóc khối tool-call ra. */
	conLai: string;
	/** Khuôn đã nhận ra — ghi vào sự kiện để biết model đang lệch kiểu nào. */
	khuon: "hermes-xml" | "tool_call-json" | "json-block" | null;
}

const RONG: KetQuaCuu = { toolCalls: [], conLai: "", khuon: null };

/**
 * Thử bóc tool call ra khỏi chữ.
 *
 * @param text  nội dung model trả về
 * @param tenToolHopLe tên các tool đã đăng ký — bắt buộc, để không nhận bừa
 */
export function cuuToolCall(text: string, tenToolHopLe: ReadonlyArray<string>): KetQuaCuu {
	if (!text || tenToolHopLe.length === 0) return { ...RONG, conLai: text ?? "" };
	const hopLe = new Set(tenToolHopLe);

	for (const thu of [bocHermesXml, bocToolCallJson, bocJsonBlock, bocJsonNhung]) {
		const kq = thu(text, hopLe);
		if (kq.toolCalls.length > 0) return kq;
	}
	return { ...RONG, conLai: text };
}

// ─── Khuôn 1: Hermes XML ─────────────────────────────────────────
// <function=Bash>
//   <parameter=command>node --test test/</parameter>
// </function>

const HERMES = /<function=([A-Za-z0-9_.-]+)\s*>([\s\S]*?)<\/function\s*>/g;
const THAM_SO = /<parameter=([A-Za-z0-9_.-]+)\s*>([\s\S]*?)<\/parameter\s*>/g;

function bocHermesXml(text: string, hopLe: Set<string>): KetQuaCuu {
	const calls: ToolCall[] = [];
	let conLai = text;

	for (const khop of text.matchAll(HERMES)) {
		const ten = khop[1];
		const than = khop[2];
		if (!ten || than === undefined || !hopLe.has(ten)) continue;

		const input: Record<string, unknown> = {};
		for (const t of than.matchAll(THAM_SO)) {
			const khoa = t[1];
			if (khoa) input[khoa] = doiKieu(t[2] ?? "");
		}

		calls.push({ toolUseId: `cuu_${nanoid(8)}`, toolName: ten, toolInput: input });
		conLai = conLai.replace(khop[0], "");
	}

	if (calls.length === 0) return { ...RONG, conLai: text };
	// Một số khuôn để lại thẻ đóng mồ côi khi model cắt giữa chừng.
	conLai = conLai.replace(/<\/?tool_call\s*>/g, "");
	return { toolCalls: calls, conLai: conLai.trim(), khuon: "hermes-xml" };
}

// ─── Khuôn 2: <tool_call>{"name":…,"arguments":{…}}</tool_call> ──

const TOOL_CALL_JSON = /<tool_call\s*>([\s\S]*?)<\/tool_call\s*>/g;

function bocToolCallJson(text: string, hopLe: Set<string>): KetQuaCuu {
	const calls: ToolCall[] = [];
	let conLai = text;

	for (const khop of text.matchAll(TOOL_CALL_JSON)) {
		const doiTuong = thuParseNoiLong(khop[1] ?? "");
		for (const c of chuanHoa(doiTuong, hopLe)) calls.push(c);
		if (calls.length > 0) conLai = conLai.replace(khop[0], "");
	}

	if (calls.length === 0) return { ...RONG, conLai: text };
	return { toolCalls: calls, conLai: conLai.trim(), khuon: "tool_call-json" };
}

// ─── Khuôn 3: cả tin nhắn là JSON (có thể bọc trong ```json) ─────

function bocJsonBlock(text: string, hopLe: Set<string>): KetQuaCuu {
	const trong = text
		.trim()
		.replace(/^```(?:json)?\s*/i, "")
		.replace(/\s*```$/, "")
		.trim();

	if (!trong.startsWith("[") && !trong.startsWith("{")) return { ...RONG, conLai: text };

	const doiTuong = thuParseNoiLong(trong);
	const calls = chuanHoa(doiTuong, hopLe);
	if (calls.length === 0) return { ...RONG, conLai: text };

	// Khối JSON thường kèm cả phần "text" của model — giữ lại cho người đọc.
	const chu = layChu(doiTuong);
	return { toolCalls: calls, conLai: chu, khuon: "json-block" };
}

// ─── Khuôn 4: JSON NHÚNG giữa chữ ────────────────────────────────
// Model chạy dài (ngữ cảnh lớn) hay nhả: "Tôi sẽ sửa...:" RỒI mới tới khối
//   [{"type":"tool_use","id":"call_x","name":"FileEdit","input":{...}}]
// Khuôn 3 bỏ vì tin nhắn KHÔNG bắt đầu bằng `[`. Đây là nguyên nhân "loop ngáo":
// model nói sẽ sửa, khối tool-call lọt ra chữ, không chạy, lặp mãi không tiến.
// Đo thật: qwen3-coder ở ~50% ngữ cảnh, lượt nào cũng in khối này rồi đứng.

function bocJsonNhung(text: string, hopLe: Set<string>): KetQuaCuu {
	const calls: ToolCall[] = [];
	let conLai = text;

	for (let i = 0; i < text.length; i++) {
		const c = text[i];
		if (c !== "[" && c !== "{") continue;
		const khoi = trichJsonCanBang(text, i);
		if (!khoi) continue;
		// Chỉ xét khối trông như tool-call — tránh nuốt JSON dữ liệu bình thường.
		if (!khoi.includes('"tool_use"') && !khoi.includes('"name"')) continue;
		const c2 = chuanHoa(thuParseNoiLong(khoi), hopLe);
		if (c2.length === 0) continue;
		for (const x of c2) calls.push(x);
		conLai = conLai.replace(khoi, "");
		i += khoi.length - 1; // nhảy qua khối đã bóc, không quét lại bên trong
	}

	if (calls.length === 0) return { ...RONG, conLai: text };
	return { toolCalls: calls, conLai: conLai.trim(), khuon: "json-block" };
}

/**
 * Trích một khối JSON CÂN BẰNG bắt đầu tại `start` (ký tự `[` hoặc `{`).
 *
 * Đếm ngoặc có tôn trọng chuỗi và ký tự thoát, nên `input` lồng nhau nhiều tầng
 * hay dấu ngoặc NẰM TRONG chuỗi (vd command chứa `}`) không làm lệch. Non-greedy
 * regex sẽ hỏng đúng những chỗ này — vì thế phải duyệt tay.
 */
function trichJsonCanBang(s: string, start: number): string | null {
	let sau = 0;
	let trongChuoi = false;
	let thoat = false;
	for (let i = start; i < s.length; i++) {
		const c = s[i];
		if (trongChuoi) {
			if (thoat) thoat = false;
			else if (c === "\\") thoat = true;
			else if (c === '"') trongChuoi = false;
			continue;
		}
		if (c === '"') trongChuoi = true;
		else if (c === "[" || c === "{") sau++;
		else if (c === "]" || c === "}") {
			sau--;
			if (sau === 0) return s.slice(start, i + 1);
			if (sau < 0) return null;
		}
	}
	return null;
}

// ─── Phụ trợ ─────────────────────────────────────────────────────

function thuParse(s: string): unknown {
	try {
		return JSON.parse(s.trim());
	} catch {
		return null;
	}
}

/**
 * Parse JSON NỚI LỎNG cho tool-call model cục bộ nhả ra.
 *
 * Vì sao cần: qwen3-coder khi nhả FileWrite dạng CHỮ hay để nội dung markdown
 * nhiều dòng với ký tự XUỐNG DÒNG THÔ ngay trong chuỗi `content` — mà JSON cấm
 * control char thô trong chuỗi ("Bad control character in string literal"). Thế
 * là `JSON.parse` chết, recovery bỏ qua, tool-call lọt ra chat, KHÔNG ghi file.
 * Đo thật: yêu cầu ghi file .md 3 lần, cả 3 lần đều lọt vì file nào cũng có \n.
 *
 * Cách sửa: thử parse thẳng; hỏng thì escape các control char NẰM TRONG chuỗi
 * (\n \r \t \uXXXX) rồi parse lại. Chỉ đụng ký tự trong chuỗi — khoảng trắng
 * định dạng NGOÀI chuỗi vẫn hợp lệ nên để yên.
 */
function thuParseNoiLong(s: string): unknown {
	const thang = thuParse(s);
	if (thang !== null) return thang;
	return thuParse(escapeControlTrongChuoi(s));
}

function escapeControlTrongChuoi(s: string): string {
	let ra = "";
	let trongChuoi = false;
	let thoat = false;
	for (let i = 0; i < s.length; i++) {
		const c = s[i];
		const ma = s.charCodeAt(i);
		if (trongChuoi) {
			if (thoat) {
				ra += c;
				thoat = false;
			} else if (c === "\\") {
				ra += c;
				thoat = true;
			} else if (c === '"') {
				ra += c;
				trongChuoi = false;
			} else if (ma < 0x20) {
				// control char thô trong chuỗi → escape cho JSON nuốt được.
				ra +=
					c === "\n"
						? "\\n"
						: c === "\r"
							? "\\r"
							: c === "\t"
								? "\\t"
								: "\\u" + ma.toString(16).padStart(4, "0");
			} else {
				ra += c;
			}
			continue;
		}
		if (c === '"') trongChuoi = true;
		ra += c;
	}
	return ra;
}

/** Nhận cả `{type:"tool_use",name,input}` lẫn `{name,arguments}`, đơn lẻ hoặc mảng. */
function chuanHoa(x: unknown, hopLe: Set<string>): ToolCall[] {
	const ds = Array.isArray(x) ? x : [x];
	const ra: ToolCall[] = [];

	for (const m of ds) {
		if (!m || typeof m !== "object") continue;
		const o = m as Record<string, unknown>;
		const ten = typeof o.name === "string" ? o.name : null;
		if (!ten || !hopLe.has(ten)) continue;

		const tho = (o.input ?? o.arguments ?? o.parameters) as unknown;
		const input =
			typeof tho === "string"
				? ((thuParse(tho) as Record<string, unknown>) ?? {})
				: tho && typeof tho === "object"
					? (tho as Record<string, unknown>)
					: {};

		ra.push({
			toolUseId: typeof o.id === "string" ? o.id : `cuu_${nanoid(8)}`,
			toolName: ten,
			toolInput: input,
		});
	}
	return ra;
}

/**
 * Bóc lớp vỏ JSON khi model nhả TRỌN câu trả lời cuối dưới dạng mảng/đối tượng
 * content-block thuần văn bản, thay vì chữ thường. Quan sát thật trên qwen3-coder:
 *
 *     [{"type":"text","result":"Tôi đã build và test xong..."}]
 *
 * Không có tool-call nào nên `cuuToolCall` bỏ qua, và vì key là `result` (không
 * phải `text`) nên khối lọt nguyên đai lên giao diện — người dùng thấy cả dấu
 * ngoặc JSON. Hàm này gỡ vỏ, trả về chữ bên trong.
 *
 * THẬN TRỌNG chống phá dữ liệu thật: chỉ gỡ khi MỌI phần tử là block văn bản
 * (không có `tool_use`/`name` — thứ đó để recovery lo) và trường text là chuỗi.
 * Mảng dữ liệu bình thường như `[{"id":1,"name":"x"}]` có `name` → giữ nguyên.
 */
export function boBocKhoiJson(text: string): string {
	if (!text) return text;
	const trong = text
		.trim()
		.replace(/^```(?:json)?\s*/i, "")
		.replace(/\s*```$/, "")
		.trim();
	if (!trong.startsWith("[") && !trong.startsWith("{")) return text;
	const val = thuParse(trong);
	if (val === null) return text;
	const chu = layChuMoRong(val);
	return chu ?? text;
}

/** Như `layChu` nhưng nhận cả `result`/`content`, và ĐÒI HỎI mọi phần tử là văn bản. */
function layChuMoRong(x: unknown): string | null {
	const ds = Array.isArray(x) ? x : [x];
	const phan: string[] = [];
	for (const m of ds) {
		if (!m || typeof m !== "object") return null;
		const o = m as Record<string, unknown>;
		// Có dáng tool-call → không phải thuần văn bản, để recovery xử lý.
		if (o.type === "tool_use" || typeof o.name === "string") return null;
		const t = o.text ?? o.result ?? o.content;
		if (typeof t !== "string") return null;
		phan.push(t);
	}
	const ra = phan.join("\n").trim();
	return ra.length > 0 ? ra : null;
}

/** Gom các khối `{type:"text"}` để không mất lời giải thích của model. */
function layChu(x: unknown): string {
	const ds = Array.isArray(x) ? x : [x];
	return ds
		.filter(
			(m): m is { type: string; text: string } =>
				!!m && typeof m === "object" && (m as { type?: string }).type === "text",
		)
		.map((m) => m.text)
		.join("\n")
		.trim();
}

/**
 * Giá trị tham số XML luôn là chữ. Chỉ parse khi trông rõ ràng là object/mảng —
 * parse cả số sẽ làm hỏng những trường vốn là chuỗi (vd command="123").
 */
function doiKieu(raw: string): unknown {
	const s = raw.replace(/^\n/, "").replace(/\n$/, "");
	const t = s.trim();
	if (t.startsWith("{") || t.startsWith("[")) {
		const p = thuParse(t);
		if (p !== null) return p;
	}
	return s;
}
