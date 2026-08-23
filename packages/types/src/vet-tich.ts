/**
 * Vết tích — hợp đồng ghi nhận MỌI điểm chạm dữ liệu của một lượt agent.
 *
 * VÌ SAO CẦN MỘT TẦNG RIÊNG
 *
 * Đã có ba thứ trông như log, và không thứ nào trả lời được câu hỏi "vì sao
 * agent với LLM không ăn ý":
 *
 *   · `AuditLogger` (outer-harness) — chỉ nằm trong RAM, trần 10.000 mục,
 *     KHÔNG BAO GIỜ ghi ra đĩa. Tắt tiến trình là mất sạch.
 *   · `.agentweave/audit.log` — chỉ lệnh `guard` ghi vào, và chỉ ghi quyết
 *     định cho phép/chặn. Không có đường chạy chat/serve nào đụng tới.
 *   · `InnerEvent` (31 loại) — giàu, nhưng `llm:request_start` chỉ mang
 *     `{model, estimatedInputTokens}`. **Nội dung THẬT gửi cho model không
 *     tồn tại ở bất kỳ đâu**, và đó chính là thứ cần soi.
 *
 * Rà soát `docs/RA-SOAT-DIEU-KHIEN.md` phải dựng lại chuỗi gửi Ollama bằng
 * cách chạy thật rồi chặn ở tầng mạng mới phát hiện được lỗi tầng 0. Việc đó
 * đáng lẽ phải đọc được từ một tệp.
 *
 * BA LUẬT BẤT BIẾN
 *
 *   ① **Chỉ QUAN SÁT.** Bật vết tích không được đổi một quyết định nào của
 *      agent. Ghi nhận mà làm đổi hành vi thì cái ghi được là hành vi khác.
 *   ② **Không bao giờ ném, không bao giờ chặn.** Đây là việc phụ chạy giữa
 *      vòng lặp chính trên máy Jetson. Ghi hỏng thì mất vết tích, không được
 *      mất lượt trả lời.
 *   ③ **Tầng trong KHÔNG chạm đĩa.** `inner-harness` phát `DiemCham`, host
 *      quyết định ghi đi đâu — đúng ranh giới ở §0 bản đồ kỹ thuật.
 */

/** Tầng phát sinh điểm chạm. Dùng để lọc nhanh khi đọc lại. */
export type TangVetTich =
	/** Con người: gõ câu, bấm duyệt, bấm dừng. */
	| "user"
	/** Tiến trình chủ: ghép prompt, nạp tri thức, chốt lượt. */
	| "host"
	/** Vòng lặp agent: nén, nhắc, guard, cứu tool-call. */
	| "agent"
	/** Ranh giới mạng tới model — nơi duy nhất thấy được BYTES thật. */
	| "llm"
	/** Thực thi tool và hệ quả của nó. */
	| "tool";

/**
 * Một điểm chạm.
 *
 * `luot` và `chiTiet` do nơi phát điền; `phien`, `stt`, thời điểm và đường dẫn
 * tệp payload do bộ ghi điền — nơi phát không cần biết nó được ghi đi đâu.
 */
export interface DiemCham {
	tang: TangVetTich;
	/** Nhãn loại, dạng `nhom:viec`. Xem `LOAI_DIEM_CHAM` để biết bộ nhãn chuẩn. */
	loai: string;
	/** Lượt agent hiện tại. Bỏ trống khi điểm chạm nằm ngoài vòng lặp. */
	luot?: number;
	/** Dữ liệu nhỏ, đi thẳng vào dòng JSONL. */
	chiTiet?: Record<string, unknown>;
	/**
	 * Payload LỚN, theo tên → nội dung đầy đủ.
	 *
	 * Bộ ghi tách mỗi mục ra một tệp riêng cạnh JSONL và chỉ để lại đường dẫn +
	 * số byte + sha256. Cắt ngắn ở đây là hỏng mục đích: chuỗi gửi model phải
	 * NGUYÊN VẸN thì mới đối chiếu được với thứ model trả lời.
	 */
	noiDungLon?: Record<string, string>;
}

/**
 * Nơi nhận điểm chạm.
 *
 * Cố tình đồng bộ và trả `void`: nơi gọi nằm giữa vòng lặp nóng, không được
 * phép `await` một việc phụ. Bộ ghi tự lo đệm và xả.
 */
export interface BoGhiVetTich {
	ghi(d: DiemCham): void;
}

/**
 * Bộ nhãn chuẩn.
 *
 * Gom về một chỗ vì bộ đọc phải khớp đúng chuỗi này. Thêm nhãn thì bộ đọc cũ
 * hiện nó dưới dạng thô — an toàn; ĐỔI tên nhãn thì bộ đọc mất dấu.
 */
export const LOAI_DIEM_CHAM = {
	// ── user ──
	/** Người dùng gửi một câu. */
	USER_CAU_HOI: "user:cau-hoi",
	/** Người dùng quyết định một lời xin quyền. */
	USER_DUYET_QUYEN: "user:duyet-quyen",
	/** Lệnh điều khiển từ editor: abort/reset/undo/set_model/resume. */
	USER_LENH: "user:lenh",

	// ── host ──
	/** Câu đầy đủ sau khi host ghép thêm (đính kèm, cây thư mục…). */
	HOST_CAU_DAY_DU: "host:cau-day-du",
	/** Rule/skill/memory nào đã được đặt vào system prompt. */
	HOST_NAP_TRI_THUC: "host:nap-tri-thuc",
	/** Chốt cuối lượt: reason, usage, file đã sửa, số đo. */
	HOST_CHOT_LUOT: "host:chot-luot",

	// ── agent ──
	/** Nén ngữ cảnh: mức nào, bỏ bao nhiêu. */
	AGENT_NEN: "agent:nen",
	/** Bơm nhắc vào giữa hội thoại. */
	AGENT_NHAC: "agent:nhac",
	/** Chuẩn hoá cặp tool_use/tool_result. */
	AGENT_CHUAN_HOA_CAP: "agent:chuan-hoa-cap",
	/** Một cơ chế ghì nổ: tên cơ chế, ngưỡng, mặt nạ đặt cho lượt sau. */
	AGENT_GUARD: "agent:guard",
	/** Cứu tool-call dạng chữ: cứu mấy lời gọi, bỏ mấy vì nhại lại. */
	AGENT_CUU_TOOL_CALL: "agent:cuu-tool-call",
	/** Quyết định quyền do tầng quản trị trả về. */
	AGENT_QUYEN: "agent:quyen",

	// ── llm ── (hai nhãn quan trọng nhất của cả hệ)
	/** BYTES gửi đi: system prompt, toàn bộ messages, tool sau mặt nạ, options. */
	LLM_GUI: "llm:gui",
	/** BYTES nhận về: raw response, usage, thời lượng. */
	LLM_NHAN: "llm:nhan",
	/** Lượt gọi hỏng: mã lỗi, thông báo. */
	LLM_HONG: "llm:hong",

	// ── tool ──
	/** Tool chạy xong. */
	TOOL_XONG: "tool:xong",
	/** Tool hỏng. */
	TOOL_HONG: "tool:hong",
	/** Kiểm cú pháp sau khi ghi file. */
	TOOL_KIEM_CU_PHAP: "tool:kiem-cu-phap",
} as const;
