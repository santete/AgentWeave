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

	for (const thu of [bocHermesXml, bocToolCallJson, bocJsonBlock]) {
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
		const doiTuong = thuParse(khop[1] ?? "");
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

	const doiTuong = thuParse(trong);
	const calls = chuanHoa(doiTuong, hopLe);
	if (calls.length === 0) return { ...RONG, conLai: text };

	// Khối JSON thường kèm cả phần "text" của model — giữ lại cho người đọc.
	const chu = layChu(doiTuong);
	return { toolCalls: calls, conLai: chu, khuon: "json-block" };
}

// ─── Phụ trợ ─────────────────────────────────────────────────────

function thuParse(s: string): unknown {
	try {
		return JSON.parse(s.trim());
	} catch {
		return null;
	}
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
