/**
 * Bộ đo hiệu năng một LƯỢT của agent: tok/s, thời gian chờ token đầu (TTFT),
 * thời gian sinh, số tool. Tách khỏi serve.ts để test được — vì chính chỗ này
 * từng cho ra số vô lý.
 *
 * BUG đã sửa (đo thật, model cục bộ trên Jetson):
 *   Bản cũ lấy mẫu số tok/s = tổng các khoảng có TEXT delta (stream_delta→
 *   stream_end). Nhưng khi model nhả một TOOL-CALL lớn (vd FileWrite ghi 8 KB —
 *   nội dung nằm trong ARGUMENT), phần đó KHÔNG đi qua textStream nên KHÔNG có
 *   stream_delta nào. Kết quả: token vẫn tính vào outputTokens, còn thời gian
 *   sinh thì bằng 0 → tok/s nổ (đo được 517 tok/s cho model thực ~40), và TTFT
 *   nuốt luôn thời gian sinh tool-call.
 *
 * CÁCH ĐO ĐÚNG — theo TỪNG lượt gọi LLM:
 *   · lượt có text delta  → thời gian sinh = end − (text delta đầu)  [chuẩn]
 *   · lượt KHÔNG có delta (chỉ tool-call) → tính CẢ cửa sổ end − start là sinh.
 *     Có kèm phần nạp prompt nên hơi tính dư THỜI GIAN ⇒ tok/s hơi THẤP hơn
 *     thực. Sai về phía an toàn: thà báo chậm hơn chứ không bịa 517.
 *   · TTFT = phần nạp prompt của lượt ĐẦU TIÊN sinh được chữ (end − start của
 *     riêng lượt đó). Turn chỉ toàn tool-call thì TTFT có thể không có → null.
 *
 * Nhờ vậy `chờ + sinh ≤ agent` luôn đúng, và tok/s không bao giờ vượt tốc độ
 * thật của máy.
 */

export interface KetQuaHieuNang {
	/** Thời gian AGENT làm việc (đã trừ lúc người dùng ngồi duyệt). */
	totalMs: number;
	/** Thời gian người dùng ngồi quyết định — không tính là lỗi tốc độ của máy. */
	waitUserMs: number;
	/** Chờ token đầu (nạp prompt) của lượt gọi đầu tiên sinh chữ; null nếu không đo được. */
	ttftMs: number | null;
	/** Tổng thời gian model thật sự sinh (mẫu số của tok/s). */
	genMs: number;
	/** Token/giây — null khi khoảng sinh quá ngắn để có nghĩa. */
	tokPerSec: number | null;
	toolCalls: number;
}

export class DoHieuNang {
	private readonly t0: number;
	private msSinh = 0;
	private ttft: number | null = null;
	private reqStart: number | null = null;
	private firstDelta: number | null = null;
	private soTool = 0;

	constructor(batDauMs: number) {
		this.t0 = batDauMs;
	}

	/** `llm:request_start` — một lượt gọi LLM bắt đầu. */
	moLoiGoi(nowMs: number): void {
		this.reqStart = nowMs;
		this.firstDelta = null;
	}

	/**
	 * `llm:stream_delta` (text). Trả về TTFT (ms) NẾU đây là token chữ đầu tiên
	 * của cả lượt agent — để nơi gọi phát `first_token`. Ngược lại trả null.
	 */
	moDelta(nowMs: number): number | null {
		if (this.firstDelta !== null) return null; // đã có delta trong lượt gọi này
		this.firstDelta = nowMs;
		if (this.ttft === null && this.reqStart !== null) {
			this.ttft = Math.max(0, nowMs - this.reqStart);
			return this.ttft;
		}
		return null;
	}

	/** `llm:stream_end` — chốt thời gian sinh của lượt gọi vừa xong. */
	dongLoiGoi(nowMs: number): void {
		if (this.reqStart === null) return;
		// Có text delta → chỉ tính từ token chữ đầu (bỏ nạp prompt).
		// Không có (chỉ tool-call) → tính cả cửa sổ, vì đó chính là lúc model sinh.
		const batSinh = this.firstDelta ?? this.reqStart;
		this.msSinh += Math.max(0, nowMs - batSinh);
		this.reqStart = null;
		this.firstDelta = null;
	}

	themTool(): void {
		this.soTool++;
	}

	/** Chốt cả lượt agent. `outputTokens` là tổng token model sinh trong lượt. */
	chot(nowMs: number, outputTokens: number, waitUserMs: number): KetQuaHieuNang {
		const total = Math.max(0, nowMs - this.t0 - waitUserMs);
		return {
			totalMs: total,
			waitUserMs,
			ttftMs: this.ttft,
			genMs: this.msSinh,
			// `null` = KHÔNG ĐO ĐƯỢC, và nơi gọi phải ẩn ô đó đi. Hai điều kiện:
			//   · khoảng sinh ≤ 500ms — quá ngắn, con số chỉ là nhiễu
			//   · provider không báo token (Ollama đôi khi trả usage rỗng) —
			//     lúc đó `outputTokens` bằng 0, và in "0.0 tok/s" là BỊA một phép
			//     đo: người dùng đọc thành "máy chậm tới mức không sinh nổi chữ
			//     nào", trong khi thật ra là ta không biết.
			tokPerSec:
				this.msSinh > 500 && outputTokens > 0 ? (outputTokens / this.msSinh) * 1000 : null,
			toolCalls: this.soTool,
		};
	}
}
