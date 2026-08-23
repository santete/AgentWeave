/**
 * Bộ ghi vết tích ra đĩa.
 *
 * Sống ở tầng HOST vì đĩa là của host — `inner-harness` chỉ phát `DiemCham`
 * (xem `types/vet-tich.ts`). Cùng ranh giới với đồng hồ hẹn giờ và bộ đo hiệu
 * năng, và cùng lý do: thứ phải sống lâu hơn một lượt agent thì không đặt ở
 * inner-harness được.
 *
 * HÌNH DẠNG TRÊN ĐĨA
 *
 *   .agentweave/vet-tich/<phien>/
 *   ├─ vet-tich.jsonl              một dòng một điểm chạm, đọc tuần tự được
 *   └─ noi-dung/<stt>-<ten>        payload lớn, NGUYÊN VẸN không cắt
 *
 * Vì sao tách payload ra tệp riêng thay vì nhét vào JSONL: chuỗi gửi model có
 * thể tới 64K token. Nhét vào một dòng JSON thì tệp vừa không mở nổi bằng mắt,
 * vừa mất chính thứ cần soi nếu ai đó "tối ưu" bằng cách cắt bớt. Tách ra thì
 * JSONL luôn đọc được bằng `head`, còn payload thì `diff` được giữa hai lượt —
 * đó mới là cách tìm ra chỗ ngữ cảnh trôi.
 *
 * Cùng khuôn với `sessions/<id>/tool-results/*.txt` đã có (§10 bản đồ).
 */

import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { BoGhiVetTich, DiemCham } from "@agentweave/types";

const THU_MUC = ".agentweave/vet-tich";

/** Payload nhỏ hơn ngần này thì để thẳng trong JSONL, khỏi đẻ tệp vụn. */
const NGUONG_TACH_TEP = 512;

/**
 * Trần payload MỘT mục. 8 MB — rộng rãi có chủ đích.
 *
 * Chuỗi gửi model ở cửa sổ 64K cỡ 250KB, nên trần này không bao giờ chạm trong
 * dùng bình thường; nó chỉ để một lỗi vòng lặp nào đó không ghi đầy đĩa Jetson.
 */
const TRAN_MOT_PAYLOAD = 8 * 1024 * 1024;

/**
 * Giữ tối đa ngần này phiên, cũ hơn thì xoá.
 *
 * Bắt buộc phải có kể từ khi vết tích BẬT MẶC ĐỊNH: không dọn thì mỗi buổi làm
 * việc để lại vài chục MB và đĩa Jetson đầy dần trong im lặng — kiểu hỏng tệ
 * nhất, vì nó không báo gì cho tới lúc mọi thứ cùng hỏng. Cùng con số và cùng
 * cách làm với `session-store.ts`, để hai thư mục cạnh nhau không lệch quy tắc.
 */
const GIU_TOI_DA_PHIEN = 20;

/** Một dòng trong `vet-tich.jsonl`. */
export interface DongVetTich {
	stt: number;
	t: number;
	/** ISO, thừa so với `t` nhưng để đọc bằng mắt không phải quy đổi. */
	gio: string;
	phien: string;
	luot: number;
	tang: string;
	loai: string;
	chiTiet?: Record<string, unknown>;
	/** Payload: tên → mô tả chỗ để. `noiDung` khi nhỏ, `tep` khi đã tách ra. */
	payload?: Record<string, { noiDung?: string; tep?: string; byte: number; sha: string }>;
}

export interface TuyChonGhiVetTich {
	/** Gốc dự án. Vết tích nằm ở `<goc>/.agentweave/vet-tich/<phien>/`. */
	goc: string;
	phien: string;
	/** Báo lỗi ghi ra đâu. Bỏ trống = im lặng. */
	nhatKy?: (s: string) => void;
}

/**
 * Ghi vết tích bằng I/O ĐỒNG BỘ — có chủ đích.
 *
 * Lý do: thứ đáng giá nhất của vết tích là lượt cuối cùng trước khi mọi thứ
 * hỏng, và đó đúng là lượt dễ mất nhất nếu còn nằm trong bộ đệm khi tiến trình
 * bị giết. `appendFileSync` một dòng vài trăm byte tốn cỡ vài chục micro-giây,
 * không đáng kể so với một lượt sinh của model 30B tính bằng giây.
 *
 * Đổi lại phải giữ đúng luật ②: mọi lỗi bị nuốt. Không ghi được vết tích thì
 * mất vết tích, không được mất lượt trả lời.
 */
export class GhiVetTichTep implements BoGhiVetTich {
	private stt = 0;
	private readonly thuMuc: string;
	private readonly tepJsonl: string;
	private thuMucNoiDung: string | null = null;
	/** Hỏng một lần thì thôi hẳn — đừng bơm hàng nghìn dòng lỗi ra terminal. */
	private daHong = false;

	constructor(private readonly tuyChon: TuyChonGhiVetTich) {
		this.thuMuc = join(tuyChon.goc, THU_MUC, tuyChon.phien);
		this.tepJsonl = join(this.thuMuc, "vet-tich.jsonl");
		try {
			mkdirSync(this.thuMuc, { recursive: true });
			donPhienCu(join(tuyChon.goc, THU_MUC));
		} catch (e) {
			this.hong(e);
		}
	}

	/** Đường dẫn thư mục vết tích — để CLI in ra cho người dùng biết chỗ mà xem. */
	get duong(): string {
		return this.thuMuc;
	}

	ghi(d: DiemCham): void {
		if (this.daHong) return;
		try {
			this.stt++;
			const t = Date.now();
			const dong: DongVetTich = {
				stt: this.stt,
				t,
				gio: new Date(t).toISOString(),
				phien: this.tuyChon.phien,
				luot: d.luot ?? 0,
				tang: d.tang,
				loai: d.loai,
			};
			if (d.chiTiet && Object.keys(d.chiTiet).length > 0) dong.chiTiet = d.chiTiet;

			if (d.noiDungLon) {
				dong.payload = {};
				for (const [ten, noi] of Object.entries(d.noiDungLon)) {
					dong.payload[ten] = this.datPayload(this.stt, ten, noi);
				}
			}

			appendFileSync(this.tepJsonl, `${JSON.stringify(dong)}\n`, "utf-8");
		} catch (e) {
			this.hong(e);
		}
	}

	/** Nhỏ thì nhét thẳng vào dòng; lớn thì ra tệp riêng. */
	private datPayload(
		stt: number,
		ten: string,
		noi: string,
	): { noiDung?: string; tep?: string; byte: number; sha: string } {
		const byte = Buffer.byteLength(noi, "utf-8");
		const sha = createHash("sha256").update(noi).digest("hex").slice(0, 12);

		if (byte <= NGUONG_TACH_TEP) return { noiDung: noi, byte, sha };

		if (byte > TRAN_MOT_PAYLOAD) {
			// Cắt là mất mục đích, nên nói THẲNG là đã cắt và cắt bao nhiêu — im
			// lặng cắt thì người đọc sẽ kết luận sai trên một bản không đầy đủ.
			noi = `${noi.slice(0, TRAN_MOT_PAYLOAD)}\n\n[!! CAT BOT ${byte - TRAN_MOT_PAYLOAD} byte — vuot tran mot payload]`;
		}

		if (this.thuMucNoiDung === null) {
			this.thuMucNoiDung = join(this.thuMuc, "noi-dung");
			mkdirSync(this.thuMucNoiDung, { recursive: true });
		}
		const ten2 = `${String(stt).padStart(5, "0")}-${ten}`;
		writeFileSync(join(this.thuMucNoiDung, ten2), noi, "utf-8");
		return { tep: `noi-dung/${ten2}`, byte, sha };
	}

	private hong(e: unknown): void {
		if (this.daHong) return;
		this.daHong = true;
		this.tuyChon.nhatKy?.(
			`vet tich: ngung ghi vi loi — ${e instanceof Error ? e.message : String(e)}`,
		);
	}
}

/**
 * Xoá bớt phiên cũ, giữ `GIU_TOI_DA_PHIEN` phiên mới nhất.
 *
 * Chạy MỘT lần lúc dựng bộ ghi chứ không chạy sau mỗi dòng: đây là việc quét
 * thư mục, làm mỗi lần ghi thì tốn hơn chính việc ghi.
 */
function donPhienCu(goc: string): void {
	let ten: string[];
	try {
		ten = readdirSync(goc);
	} catch {
		return;
	}
	if (ten.length <= GIU_TOI_DA_PHIEN) return;

	const theoGio: Array<{ t: string; m: number }> = [];
	for (const t of ten) {
		try {
			theoGio.push({ t, m: statSync(join(goc, t)).mtimeMs });
		} catch {
			// thư mục biến mất giữa chừng — bỏ qua
		}
	}
	// Sắp theo mtime, HOÀ thì theo tên. Tiêu chí phụ không thừa: nhiều phiên tạo
	// trong cùng một mili-giây (chạy loạt, hoặc đĩa có độ phân giải mtime thô)
	// thì so mtime cho ra thứ tự tuỳ ý và bộ dọn xoá nhầm phiên MỚI. Id phiên
	// dạng `YYYYMMDD-HHMMSS` nên thứ tự chữ cái đúng bằng thứ tự thời gian.
	theoGio.sort((a, b) => b.m - a.m || (a.t < b.t ? 1 : a.t > b.t ? -1 : 0));
	for (const { t } of theoGio.slice(GIU_TOI_DA_PHIEN)) {
		try {
			rmSync(join(goc, t), { recursive: true, force: true });
		} catch {
			// Dọn hỏng không được làm hỏng việc ghi.
		}
	}
}

/**
 * Bật vết tích không?
 *
 * Ba nguồn, cờ mạnh hơn env, env mạnh hơn cấu hình — cùng thứ tự ưu tiên với
 * mọi tuỳ chọn khác của CLI. Env có mặt vì extension VS Code sinh tiến trình
 * `serve` qua script bọc, ở đó đặt biến môi trường là đường nhanh nhất; cấu
 * hình có mặt vì nó theo dự án và không phải sửa script bọc.
 */
export function batVetTich(cauHinh: boolean | undefined, co?: boolean): boolean {
	if (co !== undefined) return co;
	const env = process.env.AGENTWEAVE_TRACE;
	if (env !== undefined && env !== "") return env !== "0" && env.toLowerCase() !== "false";
	// MẶC ĐỊNH BẬT. Chọn có chủ đích cho giai đoạn sản phẩm còn chạy chưa ổn
	// định: thiếu dữ liệu lúc agent cư xử vô lý đắt hơn nhiều so với tốn đĩa,
	// và một lần hỏng không tái hiện được là một lần phải chạy lại cả buổi.
	// Tắt bằng `"vetTich": false` hoặc `AGENTWEAVE_TRACE=0`.
	// Khi sản phẩm ổn định thì đảo lại thành `cauHinh === true`.
	return cauHinh !== false;
}
