/**
 * Nhịp nhắc — chống nhờn mà không chống quên.
 *
 * Bài toán: một câu nhắc bơm MỖI LƯỢT thì model ngừng nhìn nó (và ta trả tiền
 * context suốt phiên cho một câu bị bỏ qua). Bơm MỘT LẦN rồi thôi thì sau chục
 * lượt và một lần nén ngữ cảnh, câu đó biến mất khỏi context — model quên sạch.
 *
 * Cách xử: nhắc thưa, và **hai mức độ**. Bản đầy đủ nêu đủ lý do, tốn chữ; bản
 * gọn chỉ một dòng trỏ ngược về bản đầy đủ đã nằm đâu đó phía trên. Cứ vài lần
 * gọn mới có một lần đầy — đủ để câu nhắc luôn còn dấu vết trong cửa sổ mà
 * không phải trả giá đầy đủ mỗi lần.
 *
 * Lớp này CHỈ quản nhịp. Điều kiện "có nên nhắc hay không" (vd: đã lâu không
 * cập nhật danh sách việc) do người gọi quyết — tách ra thì mỗi phần test được
 * riêng, và cùng một bộ đếm dùng lại được cho mọi loại nhắc.
 */

export type MucNhac = "day" | "gon";

export interface CauHinhNhip {
	/** Số lượt tối thiểu giữa hai lần nhắc. */
	luotGiuaHaiLan: number;
	/** Cứ N lần nhắc thì một lần dùng bản đầy đủ. Lần đầu tiên luôn đầy đủ. */
	dayMoiNLan: number;
	/**
	 * Lượt sớm nhất được nhắc lần đầu. Mặc định 1.
	 *
	 * Đặt lớn hơn 1 cho những thứ ĐÃ có trong system prompt: nhắc lại ngay lượt
	 * đầu chỉ là nói hai lần cùng một câu trong cùng một cửa sổ.
	 */
	batDauTuLuot?: number;
}

export class NhipNhac {
	private luotNhacCuoi = 0;
	private soLanNhac = 0;
	private readonly batDauTuLuot: number;

	constructor(private readonly cauHinh: CauHinhNhip) {
		this.batDauTuLuot = cauHinh.batDauTuLuot ?? 1;
	}

	/**
	 * Hỏi xem lượt này có tới nhịp nhắc chưa. Gọi hàm này ĐƯỢC COI LÀ đã nhắc —
	 * nó tự dời mốc. Đừng gọi để "xem thử".
	 *
	 * @returns mức nhắc, hoặc `null` nếu chưa tới nhịp.
	 */
	nen(luot: number): MucNhac | null {
		if (luot < this.batDauTuLuot) return null;
		if (this.soLanNhac > 0 && luot - this.luotNhacCuoi < this.cauHinh.luotGiuaHaiLan) {
			return null;
		}

		this.luotNhacCuoi = luot;
		this.soLanNhac++;
		// Lần 1, 1+N, 1+2N... dùng bản đầy đủ.
		return (this.soLanNhac - 1) % this.cauHinh.dayMoiNLan === 0 ? "day" : "gon";
	}

	/** Số lần đã nhắc — phục vụ kiểm toán và test. */
	get soLan(): number {
		return this.soLanNhac;
	}

	/**
	 * Đặt lại bộ đếm khi điều kiện nhắc không còn đúng nữa.
	 *
	 * Vd: nhắc "lâu rồi chưa cập nhật danh sách việc" phải reset ngay khi model
	 * gọi TodoWrite — nếu không, lần chểnh mảng sau sẽ nhận bản "gọn" trong khi
	 * model đã quên bản đầy đủ từ lâu.
	 */
	datLai(): void {
		this.luotNhacCuoi = 0;
		this.soLanNhac = 0;
	}
}
