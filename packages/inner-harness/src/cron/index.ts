/**
 * Hẹn giờ — điểm vào duy nhất.
 *
 * Lịch bắn VÀO ỐNG DẪN ATTACHMENT chứ không tự gọi model: việc đến hạn trở
 * thành một `<system-reminder>` ở đầu lượt kế tiếp. Nhờ vậy không cần luồng
 * chạy nền, không cần transport riêng, và mọi lần bắn đều nằm trong dòng sự
 * kiện của phiên nên kiểm toán được.
 *
 * HẠN CHẾ CẦN BIẾT TRƯỚC KHI DÙNG: đồng hồ của cơ chế này là LƯỢT của agent,
 * không phải thời gian thực. Phiên chỉ sống 30 giây thì một hẹn 5 phút không
 * bao giờ tới hạn. Nó dùng được cho phiên dài (`serve`, agent chạy liên tục),
 * không dùng được cho lệnh chạy một phát rồi thoát.
 */

import type { ToolDefinition } from "@agentweave/types";
import { z } from "zod";
import type { NguonNhac, Nhac } from "../attachments/index";
import { KHOANG_TOI_THIEU_MS, type LichHen } from "./lich-hen";

export {
	LichHen,
	phanJitter,
	doTre,
	KHOANG_TOI_THIEU_MS,
	TU_HET_HAN_MAC_DINH_MS,
	JITTER,
} from "./lich-hen";
export type { CongViecHen, YeuCauHen, KetQuaThem } from "./lich-hen";

export const SCHEDULE_TOOL_NAME = "ScheduleTask";

/**
 * Nguồn nhắc bắn việc đến hạn.
 *
 * Đánh dấu xong NGAY sau khi dựng câu nhắc: ở đây "bắn" nghĩa là câu nhắc đã
 * vào ngữ cảnh, còn việc thật do model làm ở lượt sau. Đợi model xác nhận mới
 * đánh dấu thì một lượt bị bỏ dở sẽ khoá cứng task đó mãi mãi.
 */
export function nguonHenGio(lich: LichHen, dongHo: () => number = Date.now): NguonNhac {
	return {
		ten: "hen-gio",
		async thu(): Promise<Nhac[]> {
			const bayGio = dongHo();
			const denHan = lich.kiemTra(bayGio);
			const ra: Nhac[] = [];

			for (const v of denHan) {
				ra.push({
					loai: "hen-gio",
					noiDung:
						`Scheduled task "${v.id}" is due now. Do this, then continue what you were doing:\n` +
						`${v.viec}\n` +
						(v.lapLai
							? `It repeats every ${Math.round(v.khoangMs / 1000)}s — you do not need to reschedule it.`
							: `This was a one-off; it will not fire again.`),
					// Không đặt khoá: hẹn lặp PHẢI bơm lại được ở lần đến hạn sau.
				});
				lich.xong(v.id, bayGio);
			}
			return ra;
		},
	};
}

/**
 * Tool cho model tự đặt hẹn.
 *
 * Ba hành động trong một tool thay vì ba tool riêng: model nhỏ chọn sai giữa
 * `ScheduleTaskAdd` / `ScheduleTaskList` / `ScheduleTaskCancel` nhiều hơn hẳn
 * so với chọn sai một tham số `hanhDong` có enum ràng buộc.
 */
export function createScheduleTool(
	lich: LichHen,
	dongHo: () => number = Date.now,
): ToolDefinition<
	{
		action: "add" | "list" | "cancel";
		id?: string;
		task?: string;
		everySeconds?: number;
		repeat?: boolean;
	},
	string
> {
	return {
		name: SCHEDULE_TOOL_NAME,
		description:
			"Schedule work to repeat later in this session, list what is scheduled, or cancel one. " +
			`The shortest interval is ${KHOANG_TOI_THIEU_MS / 1000}s — anything shorter is rounded up ` +
			"and the result tells you what it became, so say that to the user. " +
			"Scheduled work only fires while this session is alive; it is not written to disk. " +
			"After scheduling, do the task once RIGHT NOW — do not wait for the first fire, " +
			"or the user sees nothing happen and assumes it is broken.",
		parameters: z.object({
			action: z.enum(["add", "list", "cancel"]),
			id: z
				.string()
				.max(64)
				.optional()
				.describe("Short name for the task. Required for add and cancel."),
			task: z.string().max(2000).optional().describe("What to do each time. Required for add."),
			everySeconds: z
				.number()
				.int()
				.positive()
				.max(86_400)
				.optional()
				.describe("Interval in seconds. Required for add."),
			repeat: z.boolean().optional().describe("Default true. false = fire once then forget."),
		}),
		execute: async ({ action, id, task, everySeconds, repeat }) => {
			const bayGio = dongHo();

			if (action === "list") {
				const ds = lich.danhSach();
				if (ds.length === 0) return "Nothing is scheduled in this session.";
				return ds
					.map(
						(v) =>
							`- ${v.id}: every ${Math.round(v.khoangMs / 1000)}s${v.lapLai ? "" : " (one-off)"}, ` +
							`next in ${Math.max(0, Math.round((v.denHanLuc - bayGio) / 1000))}s — ${v.viec}`,
					)
					.join("\n");
			}

			if (action === "cancel") {
				if (!id) return "cancel needs an id. Call list first to see the ids.";
				return lich.huy(id) ? `Cancelled "${id}".` : `No scheduled task named "${id}".`;
			}

			if (!id || !task || everySeconds === undefined) {
				return "add needs id, task and everySeconds.";
			}

			const kq = lich.them(
				{ id, viec: task, khoangMs: everySeconds * 1000, lapLai: repeat ?? true },
				bayGio,
			);
			const tron = kq.daLamTron
				? ` (you asked for ${kq.daLamTron.xin / 1000}s; rounded up to the ${kq.daLamTron.thanh / 1000}s minimum — tell the user)`
				: "";
			return (
				`Scheduled "${id}" every ${kq.viec.khoangMs / 1000}s${tron}. ` +
				`Now do it once immediately instead of waiting for the first fire.`
			);
		},
		metadata: {
			isReadOnly: false,
			isDestructive: false,
			isConcurrencySafe: false,
			category: "custom",
			maxOutputSize: 4_096,
		},
	};
}
