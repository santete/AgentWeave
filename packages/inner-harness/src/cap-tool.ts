/**
 * Chuẩn hoá cặp `tool_use` / `tool_result` trước khi gửi model.
 *
 * VÌ SAO CÓ TẦNG NÀY KHI BƯỚC NÉN ĐÃ ĐƯỢC SỬA
 *
 * Nén không phải nguồn duy nhất làm lệch cặp. Còn ba đường khác, và mỗi đường
 * đều đã xảy ra thật ở đâu đó:
 *
 *   · `initialMessages` khi mở lại phiên — lịch sử có thể bị cắt giữa lượt,
 *     tin nhắn đầu tiên là một `tool_result` không còn lời gọi
 *   · `injectMessage` từ ngoài — chèn tuỳ ý vào giữa
 *   · các nhánh `continue` trong vòng lặp — thoát sớm giữa lúc xử lý một loạt
 *     tool call, để lại `tool_use` chưa có kết quả
 *
 * Sửa ở gốc từng đường một là trò đuổi bắt. Một bước kiểm tra tất định ngay
 * trước lượt gọi thì bao hết, và rẻ (một lượt duyệt danh sách).
 *
 * AgentWeave hiện gửi lịch sử tool dưới dạng chữ JSON nên lệch cặp KHÔNG làm
 * API trả 400 như bản gốc. Nhưng model vẫn nhìn thấy một kết quả từ trên trời
 * rơi xuống, hoặc một lời gọi biến mất không dấu vết — nó suy luận trên một
 * hội thoại không có thật. Đó là kiểu hỏng âm thầm, đắt hơn hẳn một lỗi 400.
 */

import type { ContentBlock, Message } from "@agentweave/types";

/**
 * Nội dung thay cho kết quả không bao giờ tới.
 *
 * Nói RÕ là bị gián đoạn chứ không phải thất bại: model đọc "lỗi" sẽ đi sửa
 * cái không hỏng, đọc "gián đoạn" thì biết chỉ cần gọi lại.
 */
export const KET_QUA_GIAN_DOAN =
	"[This tool call was interrupted and never ran. Nothing was changed. Call it again if you still need it.]";

/** Chỗ giữ chỗ khi gỡ hết khối làm tin nhắn rỗng — API nào cũng từ chối content rỗng. */
const GIU_CHO_ASSISTANT = "[Tool use interrupted]";
const GIU_CHO_USER = "[Orphaned tool result removed]";

export interface KetQuaChuanHoaCap {
	messages: Message[];
	/** Có sửa gì không. false thì nơi gọi khỏi phát sự kiện. */
	daSua: boolean;
	/** Mô tả từng chỗ sửa, cho nhật ký kiểm toán. Không bao giờ sửa lặng lẽ. */
	changes: string[];
}

/**
 * Bảo đảm mọi `tool_use` có đúng một `tool_result`, và ngược lại.
 *
 * Bốn hướng hỏng, xử lý theo đúng thứ tự này:
 *   ① `tool_use` trùng id     → giữ cái đầu, bỏ các cái sau
 *   ② `tool_result` trùng id  → giữ cái đầu
 *   ③ `tool_result` mồ côi    → gỡ bỏ
 *   ④ `tool_use` thiếu kết quả → chèn kết quả tổng hợp NGAY SAU tin nhắn đó
 *
 * ③ trước ④ là bắt buộc: gỡ mồ côi xong mới biết `tool_use` nào thật sự thiếu.
 */
export function chuanHoaCapTool(messages: ReadonlyArray<Message>): KetQuaChuanHoaCap {
	const changes: string[] = [];

	// ── Lượt 1: khử trùng id, thu thập id còn sống ──
	const idGoi = new Set<string>();
	const idKetQua = new Set<string>();

	const buoc1: Message[] = messages.map((m) => {
		if (!Array.isArray(m.content)) return m;

		let doi = false;
		const khoi: ContentBlock[] = [];
		for (const k of m.content) {
			if (k.type === "tool_use") {
				if (idGoi.has(k.id)) {
					changes.push(`bo tool_use trung id "${k.id}"`);
					doi = true;
					continue;
				}
				idGoi.add(k.id);
			} else if (k.type === "tool_result") {
				if (idKetQua.has(k.tool_use_id)) {
					changes.push(`bo tool_result trung id "${k.tool_use_id}"`);
					doi = true;
					continue;
				}
				idKetQua.add(k.tool_use_id);
			}
			khoi.push(k);
		}
		return doi ? { ...m, content: khoi } : m;
	});

	// ── Lượt 2: gỡ tool_result mồ côi ──
	const buoc2: Message[] = [];
	for (const m of buoc1) {
		if (!Array.isArray(m.content)) {
			buoc2.push(m);
			continue;
		}

		const khoi = m.content.filter((k) => {
			if (k.type !== "tool_result") return true;
			if (idGoi.has(k.tool_use_id)) return true;
			changes.push(`go tool_result mo coi "${k.tool_use_id}"`);
			idKetQua.delete(k.tool_use_id);
			return false;
		});

		if (khoi.length === m.content.length) {
			buoc2.push(m);
		} else if (khoi.length > 0) {
			buoc2.push({ ...m, content: khoi });
		} else {
			// Gỡ sạch thì để lại chỗ giữ chỗ thay vì bỏ hẳn tin nhắn: bỏ hẳn có thể
			// làm hội thoại mở đầu bằng assistant, một kiểu hỏng khác.
			buoc2.push({ ...m, content: GIU_CHO_USER });
		}
	}

	// ── Lượt 3: chèn kết quả tổng hợp cho tool_use thiếu ──
	const ra: Message[] = [];
	for (const m of buoc2) {
		// Tin nhắn assistant rỗng sau khi khử trùng — API từ chối content rỗng.
		if (Array.isArray(m.content) && m.content.length === 0) {
			ra.push({ ...m, content: GIU_CHO_ASSISTANT });
			continue;
		}
		ra.push(m);

		if (m.role !== "assistant" || !Array.isArray(m.content)) continue;

		const thieu = m.content
			.filter((k): k is Extract<ContentBlock, { type: "tool_use" }> => k.type === "tool_use")
			.filter((k) => !idKetQua.has(k.id));

		if (thieu.length === 0) continue;

		for (const k of thieu) {
			changes.push(`chen ket qua gian doan cho tool_use "${k.id}" (${k.name})`);
			idKetQua.add(k.id);
			ra.push({
				role: "user",
				content: [
					{
						type: "tool_result",
						tool_use_id: k.id,
						content: KET_QUA_GIAN_DOAN,
						is_error: true,
					},
				],
			});
		}
	}

	return { messages: ra, daSua: changes.length > 0, changes };
}
