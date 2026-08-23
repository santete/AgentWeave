/**
 * Render lịch sử hội thoại cho model — TẦNG 0 của hệ điều khiển.
 *
 * VÌ SAO MODULE NÀY TỒN TẠI
 *
 * Hai đường gọi LLM có hai cách dựng messages khác nhau, và trước đợt rà soát
 * `docs/RA-SOAT-DIEU-KHIEN.md` thì CẢ HAI đều làm model mù về hành động của
 * chính nó:
 *
 *   · đường có ràng buộc (`/api/chat` + format schema) dùng `trichChu`, mà
 *     `trichChu` chỉ giữ khối `type:"text"` — nên mọi `tool_use` và
 *     `tool_result` biến thành CHUỖI RỖNG. Model ghi file xong không biết mình
 *     đã ghi; và mọi cảnh báo guard tiêm qua `appendToolResult` không tới được
 *     nó — guard nổ mà chỉ người vận hành thấy.
 *   · đường stream `JSON.stringify` cả mảng content rồi gán role "user", nên
 *     model đọc lời gọi tool của CHÍNH NÓ như lời người dùng, dưới dạng JSON
 *     escape (phồng ~48% ký tự) — khuôn mà nó chưa từng được huấn luyện.
 *
 * Mọi cơ chế ghì model ở tầng trên đều giả định model ĐỌC ĐƯỢC lịch sử tool.
 * Sai giả định đó thì cả 13 cơ chế là nói chuyện với người điếc — nên phần
 * render tách hẳn ra đây, có test riêng, không lẫn vào vòng lặp.
 */

import type { ContentBlock, Message } from "@agentweave/types";

/**
 * Trần ký tự cho MỖI giá trị chuỗi trong tham số tool khi render thành chữ.
 *
 * Không có trần này thì nội dung file vừa ghi bị lặp lại nguyên vẹn ở MỌI lượt
 * còn lại của phiên: một FileWrite 5KB nhân 20 lượt là 100KB nhồi vào cửa sổ
 * 64K. Cắt theo TỪNG giá trị chứ không cắt cả chuỗi JSON, để mọi tên trường
 * vẫn hiện diện — model cần biết nó ghi vào ĐƯỜNG DẪN nào, còn nội dung thì
 * `tool_result` ("Written N bytes") đã xác nhận hộ.
 */
export const MAX_CHU_THAM_SO = 200;

/** Nhãn mở đầu lời gọi tool khi render thành chữ. Test khoá theo hằng số này. */
export const NHAN_GOI_TOOL = "[GOI TOOL";
/** Nhãn mở đầu kết quả tool khi render thành chữ. */
export const NHAN_KET_QUA = "[KET QUA";

/** Rút gọn từng giá trị chuỗi, giữ nguyên hình dạng object để JSON vẫn hợp lệ. */
function rutGonThamSo(vao: unknown): unknown {
	if (typeof vao === "string") {
		return vao.length <= MAX_CHU_THAM_SO
			? vao
			: `${vao.slice(0, MAX_CHU_THAM_SO)}…[+${vao.length - MAX_CHU_THAM_SO} ky tu]`;
	}
	if (Array.isArray(vao)) return vao.map(rutGonThamSo);
	if (vao !== null && typeof vao === "object") {
		const ra: Record<string, unknown> = {};
		for (const [k, v] of Object.entries(vao as Record<string, unknown>)) ra[k] = rutGonThamSo(v);
		return ra;
	}
	return vao;
}

/**
 * Render một mảng khối thành chữ có nhãn.
 *
 * `datNhan` cấp nhãn ngắn (t1, t2…) theo thứ tự xuất hiện và dùng CHUNG cho
 * `tool_use` lẫn `tool_result` — nhờ vậy model nhìn thấy cặp gọi/kết quả nối
 * với nhau thay vì hai dòng rời rạc.
 */
function renderKhoi(khoi: ReadonlyArray<ContentBlock>, datNhan: (id: string) => string): string {
	const phan: string[] = [];
	for (const k of khoi) {
		if (k.type === "text") {
			if (k.text.trim() !== "") phan.push(k.text);
		} else if (k.type === "tool_use") {
			phan.push(
				`${NHAN_GOI_TOOL} ${k.name} ${datNhan(k.id)}] ${JSON.stringify(rutGonThamSo(k.input))}`,
			);
		} else if (k.type === "tool_result") {
			const noi = typeof k.content === "string" ? k.content : JSON.stringify(k.content);
			phan.push(`${NHAN_KET_QUA} ${datNhan(k.tool_use_id)}${k.is_error ? " LOI" : ""}] ${noi}`);
		} else if (k.type === "image") {
			// Đường này phẳng ảnh thành chữ (xem goiLLM). Nói rõ là có ảnh mà không
			// đọc được, còn hơn để khoảng trống — model sẽ tưởng người dùng không
			// gửi gì và hỏi lại.
			phan.push("[anh dinh kem — duong goi nay khong doc duoc anh]");
		}
	}
	return phan.join("\n");
}

/**
 * Dựng messages dạng CHỮ cho Ollama `/api/chat` (đường có ràng buộc và chốt
 * hạ cánh).
 *
 * Tin nhắn rỗng bị bỏ: Ollama từ chối content rỗng, và một tin nhắn không nội
 * dung cũng không nói gì với model.
 */
export function renderChoOllama(
	messages: ReadonlyArray<Message>,
): Array<{ role: string; content: string }> {
	const nhan = new Map<string, string>();
	const datNhan = (id: string): string => {
		let n = nhan.get(id);
		if (n === undefined) {
			n = `t${nhan.size + 1}`;
			nhan.set(id, n);
		}
		return n;
	};

	const ra: Array<{ role: string; content: string }> = [];
	for (const m of messages) {
		const content =
			typeof m.content === "string" ? m.content : renderKhoi(m.content as ContentBlock[], datNhan);
		if (content.trim() === "") continue;
		ra.push({ role: m.role, content });
	}
	return ra;
}

/** Một phần tử message theo khuôn CoreMessage của AI SDK. */
export interface TinNhanSdk {
	role: "user" | "assistant" | "tool";
	content: unknown;
}

/**
 * Chuyển tin nhắn nội bộ sang khuôn CoreMessage của AI SDK.
 *
 * Ba luật, mỗi luật ứng với một kiểu hỏng đã đo:
 *
 *   ① `tool_use` → part `tool-call` trong tin nhắn assistant. Trước đây cả mảng
 *      bị `JSON.stringify` và gán role "user", nên model đọc lời gọi của chính
 *      nó như lời người dùng.
 *   ② `tool_result` → tin nhắn `role:"tool"` riêng, đúng khuôn model được huấn
 *      luyện (`message-store.ts` có sẵn TODO ghi nhận đúng khoảng cách này).
 *   ③ khối ảnh của người dùng → part đa phương thức, giữ nguyên hành vi đã có.
 *
 * `toolName` của kết quả tra ngược từ lời gọi cùng id — hợp đồng `tool_result`
 * nội bộ chỉ mang id. Không tra ra (lịch sử đã bị cắt mất lời gọi) thì ghi
 * "unknown" chứ không bỏ kết quả: `chuanHoaCapTool` mới là nơi dọn cặp lệch,
 * chỗ này chỉ dịch khuôn.
 */
export function mapTinNhanChoSdk(messages: ReadonlyArray<Message>): TinNhanSdk[] {
	const tenTheoId = new Map<string, string>();
	for (const m of messages) {
		if (!Array.isArray(m.content)) continue;
		for (const b of m.content) if (b.type === "tool_use") tenTheoId.set(b.id, b.name);
	}

	const ra: TinNhanSdk[] = [];
	for (const m of messages) {
		const role = m.role as "user" | "assistant";
		if (typeof m.content === "string") {
			ra.push({ role, content: m.content });
			continue;
		}

		const khoi = m.content as ContentBlock[];
		const ketQua = khoi.filter(
			(b): b is Extract<ContentBlock, { type: "tool_result" }> => b.type === "tool_result",
		);
		const conLai = khoi.filter((b) => b.type !== "tool_result");

		// Kết quả đi TRƯỚC phần còn lại: tin nhắn `role:"tool"` phải nối ngay sau
		// lượt assistant đã gọi tool, chen tin khác vào giữa là phá cặp.
		if (ketQua.length > 0) {
			ra.push({
				role: "tool",
				content: ketQua.map((b) => ({
					type: "tool-result" as const,
					toolCallId: b.tool_use_id,
					toolName: tenTheoId.get(b.tool_use_id) ?? "unknown",
					result: typeof b.content === "string" ? b.content : JSON.stringify(b.content),
					...(b.is_error === true ? { isError: true } : {}),
				})),
			});
		}

		if (conLai.length === 0) continue;

		const parts = conLai
			.map((b) => {
				if (b.type === "text") return { type: "text" as const, text: b.text };
				if (b.type === "tool_use")
					return {
						type: "tool-call" as const,
						toolCallId: b.id,
						toolName: b.name,
						args: b.input as Record<string, unknown>,
					};
				if (b.type === "image") {
					// Chỉ lượt NGƯỜI DÙNG mới được mang ảnh: không API nào nhận part
					// ảnh trong tin nhắn assistant. Giữ dấu vết bằng một dòng chữ chứ
					// đừng bỏ hẳn — model cần biết lượt đó có ảnh.
					if (role !== "user") return { type: "text" as const, text: "[anh dinh kem]" };
					return b.mimeType
						? { type: "image" as const, image: b.image, mimeType: b.mimeType }
						: { type: "image" as const, image: b.image };
				}
				return null;
			})
			.filter((p): p is NonNullable<typeof p> => p !== null);

		if (parts.length > 0) ra.push({ role, content: parts });
	}

	return ra;
}
