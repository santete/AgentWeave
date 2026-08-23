/**
 * LichHen — hẹn giờ trong phiên.
 *
 * VÌ SAO KHOẢNG THỜI GIAN CHỨ KHÔNG PHẢI CHUỖI CRON
 *
 * Bản gốc dùng cron vì lịch của nó sống qua nhiều tiến trình và phải diễn đạt
 * được "8 giờ sáng thứ Hai". Ở đây lịch chỉ sống trong một phiên, và mọi nhu
 * cầu thật đều có dạng "cứ N phút lại làm lại". Một bộ phân tích cron đầy đủ
 * là vài trăm dòng cho phần biểu đạt không ai dùng — mà mỗi dòng là một chỗ
 * hỏng thầm lặng trong khu cô lập. Nên: một số nguyên mili-giây.
 *
 * VÌ SAO KHÔNG GHI ĐĨA
 *
 * Bản gốc mặc định `durable: false` và prompt của nó dạy model rằng phần lớn
 * yêu cầu "nhắc tôi sau 5 phút" nên ở lại trong phiên. Ta bắt đầu thẳng từ đó.
 * Thêm ghi đĩa sau vẫn dễ; gỡ một tệp trạng thái đã lỡ bàn giao thì không.
 *
 * BỐN CHI TIẾT BÊ NGUYÊN, mỗi cái ứng với một lỗi thật đã ghi trong bản gốc:
 *
 *   ① Neo từ `banLanCuoi`, không phải `now`. Bản gốc từng mất `nextFireAt`
 *      trong bộ nhớ khi tiến trình con tắt lúc rảnh; lần dựng lại neo từ
 *      `taoLuc` của 10 ngày trước nên MỌI task đến hạn ngay lập tức.
 *   ② Sau khi bắn thì lên lịch lại từ `now`, KHÔNG phải từ mốc đến hạn cũ.
 *      Neo từ mốc cũ thì một phiên bị chặn 40 phút sẽ bắn dồn 8 lần bù.
 *   ③ `dangChay` chống bắn kép: `kiemTra()` gọi lại trong lúc việc trước chưa
 *      xong thì không được trả lại chính nó.
 *   ④ Jitter TẤT ĐỊNH suy từ id. Ngẫu nhiên thật thì hai lần chạy cùng một
 *      kịch bản cho hai kết quả khác nhau — thứ air-gap không kiểm chứng nổi.
 */

/** Cron nhỏ nhất là 1 phút; giữ nguyên trần đó để hành vi khớp bản gốc. */
export const KHOANG_TOI_THIEU_MS = 60_000;

/** Task lặp tự hết hạn sau 7 ngày. `0` = vô hạn. */
export const TU_HET_HAN_MAC_DINH_MS = 7 * 24 * 60 * 60 * 1000;

export const JITTER = {
	/** Task lặp trải trong 10% khoảng cách giữa hai lần bắn... */
	phanLap: 0.1,
	/** ...nhưng không quá 15 phút. */
	tranLapMs: 15 * 60 * 1000,
	/** Task một lần trải tối đa 90 giây. */
	tranMotLanMs: 90_000,
} as const;

export interface CongViecHen {
	id: string;
	/** Việc cần làm, viết cho model đọc. */
	viec: string;
	khoangMs: number;
	lapLai: boolean;
	taoLuc: number;
	/** Lần bắn gần nhất, `null` nếu chưa bắn lần nào. */
	banLanCuoi: number | null;
	/** Mốc đến hạn kế tiếp. */
	denHanLuc: number;
	/** Tự hết hạn sau ngần này kể từ `taoLuc`. 0 = vô hạn. */
	tuHetHanMs: number;
}

export interface YeuCauHen {
	id: string;
	viec: string;
	khoangMs: number;
	/** Mặc định true. */
	lapLai?: boolean;
	tuHetHanMs?: number;
}

export interface KetQuaThem {
	viec: CongViecHen;
	/**
	 * Khoảng người dùng xin, nếu KHÁC khoảng thật sự dùng.
	 *
	 * Làm tròn im lặng là kiểu hỏng tệ nhất của mọi bộ hẹn giờ: người dùng xin
	 * 30 giây, hệ thống lặng lẽ cho 1 phút, rồi họ ngồi đếm và tưởng máy hỏng.
	 * Trường này tồn tại để nơi gọi BẮT BUỘC có cái mà nói ra.
	 */
	daLamTron?: { xin: number; thanh: number };
}

/** Phần lẻ tất định trong [0,1), suy từ id. Cùng id thì mọi lần chạy như nhau. */
export function phanJitter(id: string): number {
	// Băm FNV-1a 32-bit: ngắn, không phụ thuộc, và trải đều với id dạng nanoid.
	let h = 0x811c9dc5;
	for (let i = 0; i < id.length; i++) {
		h ^= id.charCodeAt(i);
		h = Math.imul(h, 0x01000193) >>> 0;
	}
	return h / 0x1_0000_0000;
}

/**
 * Độ trễ jitter TỈ LỆ với khoảng cách giữa hai lần bắn.
 *
 * Task hàng giờ trải trong [0, 6 phút); task mỗi phút chỉ trải vài giây. Một
 * hằng số chung sẽ hoặc vô nghĩa với task dài, hoặc nuốt trọn task ngắn.
 */
export function doTre(viec: Pick<CongViecHen, "id" | "khoangMs" | "lapLai">): number {
	const tran = viec.lapLai
		? Math.min(viec.khoangMs * JITTER.phanLap, JITTER.tranLapMs)
		: Math.min(viec.khoangMs, JITTER.tranMotLanMs);
	return Math.floor(phanJitter(viec.id) * tran);
}

export class LichHen {
	private viec = new Map<string, CongViecHen>();
	/** Chống bắn kép khi việc trước còn đang chạy. */
	private dangChay = new Set<string>();

	/**
	 * Thêm một hẹn.
	 *
	 * @param bayGio thời điểm hiện tại, truyền vào chứ không đọc đồng hồ — để
	 *   test chạy tất định và không phải chờ thật.
	 */
	them(yc: YeuCauHen, bayGio: number): KetQuaThem {
		const xin = yc.khoangMs;
		const khoangMs = Math.max(KHOANG_TOI_THIEU_MS, Math.round(xin));
		const lapLai = yc.lapLai ?? true;

		const viec: CongViecHen = {
			id: yc.id,
			viec: yc.viec,
			khoangMs,
			lapLai,
			taoLuc: bayGio,
			banLanCuoi: null,
			denHanLuc: 0,
			tuHetHanMs: yc.tuHetHanMs ?? (lapLai ? TU_HET_HAN_MAC_DINH_MS : 0),
		};
		// Neo lần đầu từ `taoLuc` — chưa bắn lần nào thì đó là mốc duy nhất có.
		viec.denHanLuc = viec.taoLuc + khoangMs + doTre(viec);
		this.viec.set(viec.id, viec);

		return khoangMs !== xin ? { viec, daLamTron: { xin, thanh: khoangMs } } : { viec };
	}

	huy(id: string): boolean {
		this.dangChay.delete(id);
		return this.viec.delete(id);
	}

	danhSach(): CongViecHen[] {
		return [...this.viec.values()].sort((a, b) => a.denHanLuc - b.denHanLuc);
	}

	get(id: string): CongViecHen | undefined {
		return this.viec.get(id);
	}

	/**
	 * Các việc đã đến hạn. Gọi hàm này ĐÁNH DẤU chúng đang chạy — nên mỗi việc
	 * chỉ trả về một lần cho tới khi `xong()` được gọi.
	 */
	kiemTra(bayGio: number): CongViecHen[] {
		const ra: CongViecHen[] = [];
		for (const v of this.viec.values()) {
			if (this.dangChay.has(v.id)) continue;
			if (bayGio < v.denHanLuc) continue;
			this.dangChay.add(v.id);
			ra.push(v);
		}
		return ra;
	}

	/**
	 * Báo một việc đã chạy xong.
	 *
	 * @returns true nếu việc còn trong lịch; false nếu đã bị gỡ (một lần, hoặc
	 *   task lặp đã tới hạn tự hết hạn).
	 */
	xong(id: string, bayGio: number): boolean {
		const v = this.viec.get(id);
		this.dangChay.delete(id);
		if (!v) return false;

		v.banLanCuoi = bayGio;

		if (!v.lapLai) {
			this.viec.delete(id);
			return false;
		}
		// Tự hết hạn: vừa bắn lần cuối xong thì gỡ. Không có cơ chế này thì mọi
		// task lặp sống mãi tới khi tắt phiên, kể cả khi lý do tạo ra nó đã hết.
		if (v.tuHetHanMs > 0 && bayGio - v.taoLuc >= v.tuHetHanMs) {
			this.viec.delete(id);
			return false;
		}

		// Lên lịch lại từ BÂY GIỜ. Neo từ `denHanLuc` cũ sẽ bắn dồn bù khi phiên
		// bị chặn lâu hơn một chu kỳ.
		v.denHanLuc = bayGio + v.khoangMs + doTre(v);
		return true;
	}

	/**
	 * Dựng lại lịch sau khi khôi phục trạng thái.
	 *
	 * Neo từ `banLanCuoi` chứ không phải `bayGio`: đây chính là chỗ bản gốc từng
	 * hỏng — mất mốc trong bộ nhớ rồi neo lại từ `taoLuc` cũ làm mọi task đến
	 * hạn cùng lúc.
	 */
	dungLai(cac: ReadonlyArray<CongViecHen>): void {
		this.viec.clear();
		this.dangChay.clear();
		for (const v of cac) {
			const moc = v.banLanCuoi ?? v.taoLuc;
			this.viec.set(v.id, { ...v, denHanLuc: moc + v.khoangMs + doTre(v) });
		}
	}

	get soViec(): number {
		return this.viec.size;
	}
}
