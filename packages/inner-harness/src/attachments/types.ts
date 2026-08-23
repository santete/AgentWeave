/**
 * Kiểu dữ liệu cho ống dẫn attachment — chữ bơm vào GIỮA hội thoại.
 *
 * Phân biệt với system prompt: system prompt nằm thường trực mọi lượt và phải
 * ổn định (prefix đổi = KV-cache cục bộ phải prefill lại, ăn thẳng vào tốc độ
 * trên Jetson). Attachment thì ngược lại — bơm đúng lúc cần rồi thôi.
 *
 * Vì sao cần một module riêng thay vì nhắc rải rác trong `agent-loop.ts`:
 *
 *   ① Nhắc hardcode trong vòng lặp thì không test được tách rời, và mỗi lần
 *      thêm một kiểu nhắc là một lần sửa vòng lặp chính — nơi rủi ro nhất.
 *   ② Không có bộ đếm nhịp thì hoặc nhắc mỗi lượt (model NHỜN, và tốn context
 *      suốt phiên) hoặc nhắc một lần rồi thôi (model QUÊN sau chục lượt).
 *   ③ Không có hàng rào lỗi thì một collector hỏng làm chết cả lượt trả lời.
 *      Thà thiếu một câu nhắc còn hơn treo — nên `thuNhac()` KHÔNG BAO GIỜ ném.
 *
 * Thiết kế `Nhac` cố tình PHẲNG (một `loai` dạng chuỗi + nội dung dựng sẵn)
 * chứ không phải union đóng: rule và skill tự dựng nội dung của mình, module
 * này không cần biết chúng tồn tại.
 */

/** Một mẩu chữ sẽ nằm trong `<system-reminder>` của lượt kế tiếp. */
export interface Nhac {
	/** Nhãn phân loại, dùng cho nhịp nhắc và nhật ký kiểm toán. vd: "luat-theo-duong-dan". */
	loai: string;
	/** Nội dung đã dựng sẵn. Collector chịu trách nhiệm cắt gọn trước khi trả về. */
	noiDung: string;
	/**
	 * Khoá chống bơm lặp. Cùng khoá đã bơm rồi thì lần sau bỏ qua.
	 *
	 * Bỏ trống nghĩa là "bơm lại được" — dùng cho nhắc định kỳ. Có khoá nghĩa
	 * là "một lần là đủ" — dùng cho rule/skill theo đường dẫn: nạp lại cùng một
	 * rule ở mỗi lượt chỉ tổ đốt context mà không thêm thông tin nào.
	 */
	khoa?: string;
}

/** Bối cảnh một lượt, truyền cho mọi collector. */
export interface BoiCanhLuot {
	/** Số thứ tự lượt hiện tại, bắt đầu từ 1. */
	luot: number;
	/**
	 * File mà lượt VỪA RỒI đã chạm (đọc hoặc ghi), đường dẫn tuyệt đối.
	 *
	 * Đây là tín hiệu kích hoạt rule và skill có điều kiện: model đang làm việc
	 * với `src/api/*.ts` thì mới nạp quy ước tầng API, không nạp sẵn từ đầu.
	 */
	fileVuaCham: ReadonlyArray<string>;
	/** Khoá đã bơm trong phiên. `thuNhac()` tự lọc, collector không cần nhớ. */
	daBom: ReadonlySet<string>;
	/** Câu người dùng vừa gõ. Nguồn bộ nhớ chấm điểm liên quan dựa vào đây. */
	promptNguoiDung?: string;
	/**
	 * Số byte bộ nhớ ĐÃ bơm và vẫn còn trong hội thoại.
	 *
	 * Suy ra bằng cách quét messages chứ không giữ biến riêng: nén xoá khối cũ
	 * đi thì con số này tự lùi, và bơm lại là hợp lệ vì thứ cũ không còn trong
	 * ngữ cảnh nữa. Biến song song thì sớm muộn cũng lệch khỏi sự thật.
	 */
	byteBoNhoDaBom: number;
	/** Huỷ khi lượt bị abort. */
	signal?: AbortSignal;
}

/**
 * Một nguồn sinh nhắc.
 *
 * Hợp đồng: `thu()` được phép chậm, được phép ném — cả hai đều bị `thuNhac()`
 * cô lập. Điều DUY NHẤT nó không được làm là thay đổi trạng thái hội thoại.
 */
export interface NguonNhac {
	/** Tên hiển thị trong nhật ký khi nguồn này hỏng hoặc quá hạn. */
	ten: string;
	thu(ctx: BoiCanhLuot): Promise<Nhac[]>;
}

/**
 * Kết quả thu.
 *
 * Lỗi và quá hạn được TRẢ VỀ chứ không nuốt im: air-gap thì không ai đọc log
 * sau khi bàn giao, nhưng người vận hành lúc chạy thử phải thấy được nguồn nào
 * đang hỏng. `maybe()` của Claude Code chỉ `logError` rồi trả mảng rỗng —
 * ở đây đưa lên tới người gọi để CLI in ra được.
 */
export interface KetQuaThuNhac {
	nhac: Nhac[];
	/** Nguồn ném lỗi. */
	loi: Array<{ ten: string; lyDo: string }>;
	/** Nguồn chưa xong khi hết hạn giờ. */
	quaHan: string[];
}

/**
 * Hạn giờ cứng cho CẢ CỤM collector, mili-giây.
 *
 * Nguyên tắc: việc phụ không bao giờ được chặn lượt chính. Đọc vài file rule
 * từ đĩa cục bộ mất vài mili-giây; chạm 1 giây nghĩa là có gì đó bất thường
 * (đĩa mạng, file khổng lồ) và lúc đó bỏ qua là lựa chọn đúng.
 */
export const TIMEOUT_THU_NHAC = 1_000;
