/**
 * Đồng hồ cho hẹn giờ — chạy ở TIẾN TRÌNH CLI, không ở vòng lặp agent.
 *
 * VÌ SAO PHẢI Ở ĐÂY
 *
 * Bản trước nối `LichHen` vào ống dẫn attachment, mà attachment chỉ được thu ở
 * đầu mỗi lượt agent. Hệ quả: đặt "mỗi 5 phút kiểm tra build", agent trả lời
 * xong trong 30 giây rồi hết lượt — và đồng hồ đứng luôn. Nó chỉ bắn nếu agent
 * tình cờ vẫn đang chạy đúng lúc đến hạn, tức là gần như không bao giờ.
 *
 * Tiến trình CLI thì sống suốt phiên, kể cả lúc agent rảnh chờ người dùng gõ.
 * Đó mới là chỗ giữ đồng hồ.
 *
 * KHÔNG TIÊM GIỮA LƯỢT ĐANG CHẠY
 *
 * Việc đến hạn được xếp vào hàng đợi rồi rút ra GIỮA hai lượt, chạy như thể
 * người dùng vừa gõ câu đó. Tiêm vào giữa một lượt đang chảy chữ sẽ trộn hai
 * mạch việc vào nhau, và model nhỏ không tách nổi.
 */

import { LichHen, type CongViecHen } from "@agentweave/inner-harness";

/** Nhịp kiểm tra. 1 giây đủ mịn cho hẹn tính bằng phút, và gần như không tốn gì. */
export const NHIP_KIEM_TRA_MS = 1_000;

export interface DongHoHen {
	lich: LichHen;
	/** Rút toàn bộ prompt đang chờ. Gọi giữa hai lượt. */
	rutChoDoi(): string[];
	/** Promise nhả khi có việc mới vào hàng đợi. Dùng để chờ song song với readline. */
	doiViec(): Promise<void>;
	/** Dừng hẳn. Bắt buộc gọi lúc thoát, nếu không tiến trình không kết thúc. */
	dung(): void;
}

export interface TuyChonDongHo {
	nhipMs?: number;
	dongHo?: () => number;
	/** Gọi mỗi khi một việc đến hạn — để CLI in ra cho người dùng biết vì sao agent tự chạy. */
	khiDenHan?: (viec: CongViecHen) => void;
}

/**
 * Khởi động đồng hồ.
 *
 * `unref()` để cái hẹn này không giữ tiến trình sống: người dùng gõ `/thoat`
 * thì CLI phải thoát ngay, không phải đợi hết chu kỳ.
 */
export function batDauDongHo(lich: LichHen, t: TuyChonDongHo = {}): DongHoHen {
	const hangDoi: string[] = [];
	const layGio = t.dongHo ?? Date.now;
	let baoCoViec: (() => void) | null = null;
	let choViec: Promise<void> | null = null;

	const hen = setInterval(() => {
		const bayGio = layGio();
		for (const v of lich.kiemTra(bayGio)) {
			hangDoi.push(v.viec);
			t.khiDenHan?.(v);
			// Đánh dấu xong NGAY: ở đây "bắn" nghĩa là việc đã vào hàng đợi. Đợi
			// agent chạy xong mới đánh dấu thì một lượt bị bỏ dở sẽ khoá cứng
			// task đó mãi mãi.
			lich.xong(v.id, bayGio);
		}
		if (hangDoi.length > 0 && baoCoViec) {
			baoCoViec();
			baoCoViec = null;
			choViec = null;
		}
	}, t.nhipMs ?? NHIP_KIEM_TRA_MS);
	hen.unref?.();

	return {
		lich,
		rutChoDoi() {
			return hangDoi.splice(0, hangDoi.length);
		},
		doiViec() {
			// Một promise dùng chung, dựng lại sau mỗi lần nhả — tạo promise mới ở
			// mỗi lần gọi sẽ để lại một chuỗi promise không bao giờ được giải quyết.
			if (hangDoi.length > 0) return Promise.resolve();
			if (!choViec) {
				choViec = new Promise<void>((resolve) => {
					baoCoViec = resolve;
				});
			}
			return choViec;
		},
		dung() {
			clearInterval(hen);
			// Nhả mọi bên đang chờ, nếu không `nguonDong()` treo vĩnh viễn lúc thoát.
			baoCoViec?.();
			baoCoViec = null;
			choViec = null;
		},
	};
}
