/**
 * Danh sách việc trong phiên — buộc model lập kế hoạch và bám tiến độ.
 *
 * VÌ SAO CẦN
 *
 * Quan sát thật trên model 30B: giao một việc nhiều bước, nó kể lể một đoạn
 * dài về việc "sẽ làm gì", hỏi lại người dùng vài câu, làm được một hai bước
 * rồi trôi sang chuyện khác — và không bao giờ quay lại bước còn dở. Nó không
 * có chỗ nào để GHI ra kế hoạch, nên cũng không có gì để đối chiếu.
 *
 * Danh sách việc sửa cả ba chuyện cùng lúc:
 *   · ép nghĩ trước khi làm — phải chia việc ra mới ghi được
 *   · cho model một mỏ neo — mỗi lượt biết mình đang ở bước nào
 *   · cho NGƯỜI DÙNG thấy tiến độ — thứ mà kể lể bằng văn xuôi không cho được
 *
 * VÌ SAO ÉP ĐÚNG MỘT VIỆC `in_progress`
 *
 * Không ép thì model đánh dấu cả năm việc `in_progress` rồi coi như đang làm
 * tất — quay lại đúng kiểu trôi nổi mà danh sách sinh ra để chặn. Đúng một
 * việc nghĩa là luôn có câu trả lời rõ ràng cho "bây giờ đang làm gì".
 */

import { z } from "zod";
import type { ToolDefinition } from "@agentweave/types";
import { NhipNhac, type NguonNhac } from "./attachments/index";

export const TODO_TOOL_NAME = "TodoWrite";

export const TrangThaiViec = z.enum(["pending", "in_progress", "completed"]);
export type TrangThaiViec = z.infer<typeof TrangThaiViec>;

export const ViecSchema = z.object({
	content: z.string().min(1).max(200).describe("Imperative form: 'Run tests', 'Fix login bug'"),
	activeForm: z
		.string()
		.min(1)
		.max(200)
		.describe("Present continuous, shown while running: 'Running tests'"),
	status: TrangThaiViec,
});
export type Viec = z.infer<typeof ViecSchema>;

/**
 * Nhận danh sách ở BẤT KỲ khuôn nào model gửi, rồi quy về `Viec`.
 *
 * VÌ SAO PHẢI DỄ TÍNH Ở ĐÂY
 *
 * Đo thật với qwen3-coder:30b: nó gửi `{"task_list":[{"id":"001","status":
 * "in_progress","description":"..."}]}` — không phải `todos`, không phải
 * `content`, không có `activeForm`. Schema chặt thì mọi lời gọi bị từ chối, và
 * model thử tám khuôn khác nhau rồi bỏ cuộc. Quan sát thật trong một phiên:
 * 8 lần gọi, 8 lần bị từ chối, 0 việc được ghi.
 *
 * Bài học: tool NÀY khác các tool khác. `FileRead` mà thiếu `path` thì từ chối
 * là đúng — không có đường nào đoán ra. Còn danh sách việc thì mọi khuôn model
 * gửi đều nói cùng một ý, nên từ chối chỉ là bắt cả hai bên trả giá cho một
 * bất đồng về TÊN TRƯỜNG.
 *
 * Chỉ suy diễn khi không có gì mơ hồ; thiếu hẳn nội dung thì mới bỏ việc đó.
 */
function doiSangViec(tho: unknown): Viec[] {
	const mang = Array.isArray(tho) ? tho : [];
	const ra: Viec[] = [];

	for (const x of mang) {
		if (!x || typeof x !== "object") continue;
		const o = x as Record<string, unknown>;

		// Tên trường cho nội dung, theo thứ tự model hay dùng.
		const noi = [o.content, o.task, o.title, o.name, o.description, o.step].find(
			(v): v is string => typeof v === "string" && v.trim() !== "",
		);
		if (!noi) continue;

		const tt = typeof o.status === "string" ? o.status.toLowerCase().replace(/[\s-]/g, "_") : "";
		const status: TrangThaiViec =
			tt === "in_progress" || tt === "doing" || tt === "active"
				? "in_progress"
				: tt === "completed" || tt === "done" || tt === "finished"
					? "completed"
					: "pending";

		const dang =
			typeof o.activeForm === "string" && o.activeForm.trim() !== ""
				? o.activeForm
				: `${noi.replace(/\.$/, "")}…`;

		ra.push({
			content: noi.slice(0, 200),
			activeForm: dang.slice(0, 200),
			status,
		});
	}
	return ra;
}

/** Trần số việc. Dài hơn thì kế hoạch đã quá to, nên chia nhỏ việc lớn trước. */
export const MAX_VIEC = 30;

/**
 * Số lần gọi TodoWrite liên tiếp tối đa khi chưa chạm file nào.
 *
 * 2 chứ không phải 5: lập kế hoạch rồi đánh dấu việc đầu là `in_progress` mất
 * đúng hai lời gọi. Lần thứ ba mà vẫn chưa đọc hay ghi gì thì đó không còn là
 * lập kế hoạch nữa.
 */
export const MAX_LIEN_TIEP = 2;

/** Giữ danh sách việc của một phiên. Một thể hiện cho mỗi phiên. */
export class SoTayViec {
	private ds: Viec[] = [];
	/** Lượt gần nhất model cập nhật danh sách — dùng cho nhắc định kỳ. */
	private luotCapNhatCuoi = 0;
	/**
	 * Số lần gọi TodoWrite LIÊN TIẾP mà chưa chạm file nào.
	 *
	 * Đo thật khi chạy với qwen3-coder:30b: giao một việc ba bước, model gọi
	 * TodoWrite 42 lần trên tổng 46 lời gọi tool — chỉ 4 lần ghi file. Nó cập
	 * nhật danh sách thay cho làm việc, và trông rất bận. Đây là kiểu hỏng
	 * NẶNG HƠN kiểu ban đầu: trước thì nó kể lể, giờ nó kể lể có cấu trúc.
	 */
	private lienTiep = 0;

	danhSach(): ReadonlyArray<Viec> {
		return this.ds;
	}

	dat(ds: ReadonlyArray<Viec>, luot: number): void {
		// Xong hết thì xoá sạch — bê nguyên bản gốc (`allDone ? [] : todos`).
		// Giữ lại một danh sách toàn dấu [x] chỉ tổ làm bộ nhắc tưởng còn việc.
		const xongHet = ds.length > 0 && ds.every((v) => v.status === "completed");
		this.ds = xongHet ? [] : [...ds];
		this.luotCapNhatCuoi = luot;
		this.lienTiep++;
	}

	/** Có tiến triển thật (chạm file) → cho phép cập nhật danh sách trở lại. */
	ghiNhanTienTrien(): void {
		this.lienTiep = 0;
	}

	get soLanLienTiep(): number {
		return this.lienTiep;
	}

	/** Danh sách mới có KHÁC bản đang giữ không. */
	khacBanHienTai(ds: ReadonlyArray<Viec>): boolean {
		if (ds.length !== this.ds.length) return true;
		return ds.some(
			(v, i) => v.content !== this.ds[i]?.content || v.status !== this.ds[i]?.status,
		);
	}

	get luotCuoi(): number {
		return this.luotCapNhatCuoi;
	}

	get rong(): boolean {
		return this.ds.length === 0;
	}

	get dangLam(): Viec | undefined {
		return this.ds.find((v) => v.status === "in_progress");
	}

	get conLai(): number {
		return this.ds.filter((v) => v.status !== "completed").length;
	}

	/** Tóm tắt một dòng cho thanh trạng thái. */
	tomTat(): string {
		if (this.rong) return "";
		const xong = this.ds.filter((v) => v.status === "completed").length;
		const dang = this.dangLam;
		return `${xong}/${this.ds.length}${dang ? ` · ${dang.activeForm}` : ""}`;
	}
}

/** Kết xuất danh sách để model đọc lại — có dấu trạng thái nhìn là hiểu. */
export function veDanhSach(ds: ReadonlyArray<Viec>): string {
	if (ds.length === 0) return "(danh sách trống)";
	const dau = { completed: "[x]", in_progress: "[>]", pending: "[ ]" } as const;
	return ds.map((v) => `${dau[v.status]} ${v.content}`).join("\n");
}

/**
 * Câu dẫn dạy model dùng danh sách việc.
 *
 * Bê tinh thần từ bản gốc, giữ cả phần "KHI NÀO KHÔNG DÙNG" — thiếu vế đó thì
 * model lập danh sách cho cả câu hỏi một câu trả lời được ngay, và người dùng
 * phải đọc một bảng tiến độ ba dòng cho việc đáng lẽ xong trong một câu.
 *
 * Viết ngắn hơn bản gốc nhiều: bản gốc dài ~180 dòng với năm ví dụ, nhưng nó
 * nằm trong mô tả TOOL (chỉ gửi khi tool được liệt kê). Câu dẫn này nằm thường
 * trực, mà cửa sổ ở đây là 64K.
 */
export const CAU_DAN_TODO = `## Planning your work

For any task that takes 3 or more steps, call ${TODO_TOOL_NAME} FIRST — before doing anything else — to write down the steps. Then work through them.

- Mark a task \`in_progress\` BEFORE you start it, and \`completed\` the moment it is done. Never batch updates at the end.
- Exactly ONE task is \`in_progress\` at any time. Not zero, not two.
- Only mark \`completed\` when it is truly finished. Tests failing, partial implementation, unresolved error → it stays \`in_progress\`, and you add a new task for the blocker.
- Discovered more work while implementing? Add it to the list instead of doing it silently.

Do NOT use a task list for a single straightforward action, or for a question you can answer in one reply — a progress table for a one-line answer is noise.

This list is how the user sees your progress. Keeping it accurate is part of the job, not paperwork on top of it.`;

export interface KetQuaTodo {
	ds: Viec[];
	/** Cảnh báo gửi kèm khi model dùng sai — sửa được ở lượt sau. */
	canhBao: string[];
}

/**
 * Kiểm và chuẩn hoá danh sách model gửi lên.
 *
 * KHÔNG từ chối vì lỗi số-việc-đang-làm: sửa hộ rồi nói ra thì model học được
 * khuôn đúng mà vẫn tiến việc. Từ chối thì nó mất một lượt chỉ để gửi lại.
 */
export function kiemDanhSach(ds: ReadonlyArray<Viec>): KetQuaTodo {
	const canhBao: string[] = [];
	const ra = ds.slice(0, MAX_VIEC).map((v) => ({ ...v }));

	if (ds.length > MAX_VIEC) {
		canhBao.push(`danh sách bị cắt còn ${MAX_VIEC} việc — kế hoạch quá to, hãy chia việc lớn ra`);
	}

	const dangLam = ra.filter((v) => v.status === "in_progress");
	if (dangLam.length > 1) {
		// Giữ cái ĐẦU TIÊN: đó là việc model nêu sớm nhất, gần với "đang làm" nhất.
		for (const v of dangLam.slice(1)) v.status = "pending";
		canhBao.push(
			`${dangLam.length} việc cùng in_progress — đã để lại "${dangLam[0]!.content}", số còn lại chuyển về pending. Chỉ một việc được đang-làm.`,
		);
	}
	if (dangLam.length === 0 && ra.some((v) => v.status === "pending")) {
		canhBao.push("không việc nào in_progress — hãy đánh dấu việc bạn đang làm trước khi bắt tay vào.");
	}

	return { ds: ra, canhBao };
}

export function createTodoTool(so: SoTayViec, layLuot: () => number): ToolDefinition {
	return {
		name: TODO_TOOL_NAME,
		description:
			"Write or update the task list for this session. Use it for any task of 3+ steps: " +
			"call it BEFORE starting work, then update it as you go — mark in_progress before " +
			"starting a task and completed the moment it is done. Exactly one task in_progress " +
			"at a time. This is what the user sees as your progress; keeping it accurate is part " +
			"of the work. Skip it for single trivial actions.",
		// Schema CỐ Ý lỏng: nhận mọi tên mảng model hay dùng, và không ràng buộc
		// hình dạng từng mục — `doiSangViec` lo phần quy đổi. Chặt ở đây nghĩa là
		// từ chối một lời gọi mà ý định đã rõ mười mươi.
		parameters: z.object({
			todos: z.array(z.unknown()).optional().describe("The FULL list — it replaces the previous one"),
			task_list: z.array(z.unknown()).optional(),
			tasks: z.array(z.unknown()).optional(),
			items: z.array(z.unknown()).optional(),
		}),
		execute: async (vao: Record<string, unknown>) => {
			const tho = vao.todos ?? vao.task_list ?? vao.tasks ?? vao.items;
			const todos = doiSangViec(tho);
			if (todos.length === 0) {
				return (
					`No task could be read from your arguments. Send a list where each item has ` +
					`text describing the task, for example:\n` +
					`{"todos":[{"content":"Read the controllers","status":"in_progress"},` +
					`{"content":"Write the tests","status":"pending"}]}`
				);
			}
			// ── Chặn cập nhật rỗng ──
			// Gửi lại y hệt bản đang giữ là một lượt trắng: không thêm thông tin
			// cho ai, mà vẫn tốn một lượt sinh của model 30B.
			if (!so.rong && !so.khacBanHienTai(todos)) {
				return (
					`The list is UNCHANGED — this call did nothing.\n${veDanhSach(so.danhSach())}\n\n` +
					`Stop updating the list and DO the task marked [>]. Call a real tool now ` +
					`(FileRead/FileWrite/FileEdit/Bash), not ${TODO_TOOL_NAME}.`
				);
			}

			// ── Chặn cập nhật liên tiếp không kèm việc thật ──
			// Đo thật: model gọi TodoWrite 42/46 lần, chỉ 4 lần ghi file.
			if (so.soLanLienTiep >= MAX_LIEN_TIEP) {
				return (
					`You have called ${TODO_TOOL_NAME} ${so.soLanLienTiep} times in a row without ` +
					`touching a single file. Planning is not progress.\n${veDanhSach(so.danhSach())}\n\n` +
					`Your NEXT call must be FileRead, FileWrite, FileEdit or Bash — do the task ` +
					`marked [>]. You may update the list again only after that.`
				);
			}

			const { ds, canhBao } = kiemDanhSach(todos);
			so.dat(ds, layLuot());

			// Trả về một HẰNG SỐ NGẮN, không phải danh sách đã dựng.
			//
			// Đây là khác biệt lớn nhất so với bản đầu của tệp này, và là nguyên
			// nhân của kiểu hỏng đã đo được: trả về danh sách nghĩa là đưa model
			// một thứ để đọc và phản ứng, nên nó đọc rồi cập nhật, rồi lại đọc —
			// 33 lời gọi TodoWrite trên 40 lời gọi tool. Bản gốc trả đúng một câu
			// và câu đó ĐẨY MODEL VỀ VIỆC: "proceed with the current tasks".
			//
			// Cảnh báo (nếu có) vẫn phải nói ra — nhưng ngắn, và vẫn kết bằng lệnh
			// quay lại làm việc.
			const dau = canhBao.length > 0 ? `${canhBao.map((c) => `⚠ ${c}`).join(" ")} ` : "";
			return (
				`${dau}Todo list updated. Continue using it to track progress. ` +
				`Now PROCEED with the task marked in_progress — do not call ${TODO_TOOL_NAME} again ` +
				`until you have done real work on it.`
			);
		},
		metadata: {
			isReadOnly: false,
			isDestructive: false,
			isConcurrencySafe: false,
			category: "custom",
			maxOutputSize: 8_192,
		},
	} as ToolDefinition;
}

// ─── Nhắc định kỳ ────────────────────────────────────────────────

/**
 * Bao lâu không cập nhật danh sách thì coi là đã trôi.
 *
 * 8 lượt: đủ dài để model làm xong một việc thật (đọc → sửa → chạy kiểm tra),
 * đủ ngắn để nó chưa kịp đi lạc hẳn sang chuyện khác.
 */
export const LUOT_COI_LA_TROI = 8;

/**
 * Nguồn nhắc kéo model về danh sách việc.
 *
 * Hai tình huống, hai câu khác nhau — vì hai kiểu hỏng khác nhau:
 *   · chưa có danh sách  → nó chưa từng lập kế hoạch
 *   · có mà lâu không đụng → nó đang làm mà không ghi lại, hoặc đã đi lạc
 */
export function nguonNhacTodo(so: SoTayViec): NguonNhac {
	const nhip = new NhipNhac({ luotGiuaHaiLan: LUOT_COI_LA_TROI, dayMoiNLan: 3, batDauTuLuot: 4 });

	return {
		ten: "nhac-danh-sach-viec",
		async thu(ctx) {
			// Chạm file = có tiến triển thật → cho phép cập nhật danh sách trở lại.
			if (ctx.fileVuaCham.length > 0) so.ghiNhanTienTrien();

			// Vài lượt đầu chưa vội — có thể là việc một bước thật. `batDauTuLuot`
			// của NhipNhac đã lo phần đó, không cần bộ đếm thứ hai.

			if (so.rong) {
				const muc = nhip.nen(ctx.luot);
				if (!muc) return [];
				return [
					{
						loai: "nhac-lap-ke-hoach",
						noiDung:
							muc === "day"
								? `You have run several tools with no task list. If this task takes 3+ steps, call ${TODO_TOOL_NAME} NOW with the remaining steps, then keep working — do not ask the user what to do next, and do not summarise instead of acting. If it really is a single step, finish it and reply.`
								: `Still no task list. Call ${TODO_TOOL_NAME} if this needs 3+ steps.`,
					},
				];
			}

			if (ctx.luot - so.luotCuoi < LUOT_COI_LA_TROI) return [];
			const muc = nhip.nen(ctx.luot);
			if (!muc) return [];

			const dang = so.dangLam;
			return [
				{
					loai: "nhac-tien-do",
					noiDung:
						muc === "day"
							? `Your task list has not been updated for ${ctx.luot - so.luotCuoi} turns. Current state:\n${veDanhSach(so.danhSach())}\n\n` +
								(dang
									? `You are supposedly "${dang.activeForm}". If that is done, mark it completed and start the next one. If you moved on to something else, update the list to match reality.`
									: `No task is in_progress. Mark what you are working on, or mark the list complete and report the result to the user.`) +
								` Do not ask the user what to do next while ${so.conLai} task(s) are still open — work through them.`
							: `Task list is ${ctx.luot - so.luotCuoi} turns stale (${so.conLai} open). Update it.`,
				},
			];
		},
	};
}
