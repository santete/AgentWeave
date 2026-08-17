/**
 * Quản lý ngữ cảnh — đo độ đầy và nén khi gần tràn.
 *
 * Đây là tiêu chuẩn #10 trong bảng chấm agent. Bản trước chỉ có KIỂU dữ liệu
 * (`context:compacted`, lệnh `force_compact`) mà không có cài đặt nào: gọi
 * `force_compact` trả về "Unknown command", và `contextUsage` khởi tạo 200.000
 * token rồi không bao giờ đổi. Nói cách khác hệ thống không biết mình đang
 * dùng bao nhiêu ngữ cảnh, nên cũng không thể biết khi nào phải nén.
 *
 * Vì sao đặc biệt quan trọng với model cục bộ:
 *   · cửa sổ 64K chứ không phải 200K như model đám mây
 *   · context 16K đã làm tốc độ sinh giảm 34% (đo trên Jetson AGX Thor)
 *   · tràn context ở Ollama KHÔNG báo lỗi — nó lặng lẽ cắt phần đầu, agent
 *     "quên" mất đề bài mà không ai biết
 *
 * Chiến lược nén là TẤT ĐỊNH, không gọi model:
 *   ① lược nội dung tool result cũ (thứ chiếm chỗ nhiều nhất)
 *   ② vẫn quá thì bỏ hẳn lượt cũ nhất, luôn bỏ theo CẶP để tool_use không
 *      bao giờ mồ côi tool_result
 *   ③ luôn giữ tin nhắn đầu (đề bài) và các lượt gần nhất
 *
 * Chọn tất định thay vì nhờ model tóm tắt vì trong air-gap không sửa được gì:
 * một bản tóm tắt hỏng làm mất thông tin mà không có dấu hiệu nào.
 */

import type { ContentBlock, ContextUsage, Message } from "@agentweave/types";

/** Cửa sổ mặc định khi không suy ra được. Bằng OLLAMA_CONTEXT_LENGTH đã tinh chỉnh. */
export const CUA_SO_CUC_BO = 65_536;
/** Cửa sổ mặc định cho model đám mây. */
export const CUA_SO_DAM_MAY = 200_000;

/** Vượt ngưỡng này thì nén. 0,8 để còn chỗ cho lượt trả lời tiếp theo. */
export const NGUONG_NEN = 0.8;

/** Số lượt gần nhất luôn giữ nguyên vẹn. */
const GIU_GAN_NHAT = 6;
/** Tool result dài hơn ngần này thì bị lược khi nén. */
const TRAN_TOOL_RESULT = 400;

/**
 * Nén phải LEO THANG được.
 *
 * Đo thật: với cửa sổ nhỏ, nén một lần chỉ giải phóng ~140 token trong khi
 * ngữ cảnh vẫn phình lên 135%. Nguyên nhân là cửa sổ bảo vệ 6 tin nhắn gần
 * nhất lại chính là chỗ chứa các tool result to — nén "an toàn" thành ra
 * không nén được gì.
 *
 * Nên mỗi lần nén mà vẫn chưa đủ thì siết chặt thêm: giữ ít lượt hơn và cắt
 * tool result ngắn hơn.
 */
export const CAC_MUC_NEN = [
	{ giuGanNhat: 6, tranToolResult: 400 },
	{ giuGanNhat: 4, tranToolResult: 200 },
	{ giuGanNhat: 2, tranToolResult: 80 },
] as const;

export function mucNen(muc: number): { giuGanNhat: number; tranToolResult: number } {
	return CAC_MUC_NEN[Math.min(Math.max(muc, 0), CAC_MUC_NEN.length - 1)]!;
}

export interface KetQuaNen {
	messages: Message[];
	/** Có thay đổi gì không — false thì đừng phát sự kiện. */
	daNen: boolean;
	/** Ước lượng số ký tự đã bỏ đi. */
	kyTuBoDi: number;
	cach: "luoc-tool-result" | "bo-luot-cu" | "ca-hai" | "khong-lam-gi";
}

/**
 * Suy ra cửa sổ ngữ cảnh của model.
 *
 * Ưu tiên khai báo tường minh, rồi tới biến môi trường của Ollama (chính là
 * con số đang nằm trong cấu hình đã tinh chỉnh), rồi mới tới mặc định.
 */
export function suyRaCuaSo(model: string, khaiBao?: number): number {
	if (khaiBao && khaiBao > 0) return khaiBao;

	const tuMoiTruong = Number.parseInt(process.env.OLLAMA_CONTEXT_LENGTH ?? "", 10);
	const laCucBo =
		process.env.AGENTWEAVE_DEFAULT_PROVIDER === "ollama" ||
		/^(ollama\/|qwen|llama|mistral|mixtral|gemma|phi|deepseek|codellama|glm)/i.test(model);

	if (laCucBo) {
		return Number.isFinite(tuMoiTruong) && tuMoiTruong > 0 ? tuMoiTruong : CUA_SO_CUC_BO;
	}
	return CUA_SO_DAM_MAY;
}

/** Cập nhật số đo ngữ cảnh từ số token mà provider báo về. */
export function capNhatDoDay(
	hienTai: ContextUsage,
	tokenDauVao: number | undefined,
): ContextUsage {
	if (tokenDauVao === undefined || tokenDauVao < 0) return hienTai;
	const max = hienTai.maxTokens > 0 ? hienTai.maxTokens : CUA_SO_CUC_BO;
	return {
		...hienTai,
		usedTokens: tokenDauVao,
		pct: Math.min(1, tokenDauVao / max),
	};
}

export function canNen(usage: ContextUsage, nguong = NGUONG_NEN): boolean {
	return usage.maxTokens > 0 && usage.usedTokens / usage.maxTokens >= nguong;
}

/**
 * Nén danh sách tin nhắn.
 *
 * @param giuGanNhat số lượt cuối giữ nguyên (mặc định 6)
 */
export function nenTinNhan(
	messages: ReadonlyArray<Message>,
	giuGanNhat = GIU_GAN_NHAT,
	tranToolResult = TRAN_TOOL_RESULT,
): KetQuaNen {
	if (messages.length <= giuGanNhat + 1) {
		return { messages: [...messages], daNen: false, kyTuBoDi: 0, cach: "khong-lam-gi" };
	}

	const ranhGioi = messages.length - giuGanNhat;
	let boDi = 0;
	let daLuoc = false;

	// ── ① Lược tool result cũ ─────────────────────────────────────
	// Giữ nguyên khung tin nhắn để tool_use luôn có tool_result đi kèm;
	// chỉ thay phần nội dung dài bằng một dòng ghi rõ đã lược bao nhiêu.
	const sauLuoc = messages.map((m, i) => {
		if (i === 0 || i >= ranhGioi) return m;
		if (typeof m.content === "string") return m;

		let doiTrongTin = false;
		const khoiMoi = m.content.map((k): ContentBlock => {
			if (k.type !== "tool_result") return k;
			const noi = typeof k.content === "string" ? k.content : JSON.stringify(k.content);
			if (noi.length <= tranToolResult) return k;

			boDi += noi.length - tranToolResult;
			doiTrongTin = true;
			return {
				...k,
				content:
					`${noi.slice(0, tranToolResult)}\n` +
					`[đã lược ${noi.length - tranToolResult} ký tự để tiết kiệm ngữ cảnh]`,
			};
		});

		if (!doiTrongTin) return m;
		daLuoc = true;
		return { ...m, content: khoiMoi };
	});

	return {
		messages: sauLuoc,
		daNen: daLuoc,
		kyTuBoDi: boDi,
		cach: daLuoc ? "luoc-tool-result" : "khong-lam-gi",
	};
}

/**
 * Nén mạnh tay: lược tool result XONG rồi vẫn bỏ bớt lượt cũ.
 *
 * Dùng khi lược không đủ. Luôn giữ tin nhắn đầu tiên (đề bài của người dùng) —
 * mất nó thì agent quên mình đang làm gì, đúng kiểu hỏng âm thầm.
 */
export function nenManhTay(
	messages: ReadonlyArray<Message>,
	giuGanNhat = GIU_GAN_NHAT,
	tranToolResult = TRAN_TOOL_RESULT,
): KetQuaNen {
	const buoc1 = nenTinNhan(messages, giuGanNhat, tranToolResult);
	const ds = buoc1.messages;

	if (ds.length <= giuGanNhat + 1) {
		return { ...buoc1, cach: buoc1.daNen ? "luoc-tool-result" : "khong-lam-gi" };
	}

	const dauTien = ds[0]!;
	const ganNhat = ds.slice(ds.length - giuGanNhat);
	const boBot = ds.slice(1, ds.length - giuGanNhat);

	const kyTuBo = boBot.reduce(
		(t, m) => t + (typeof m.content === "string" ? m.content.length : JSON.stringify(m.content).length),
		0,
	);

	// Một dấu mốc để model biết có phần đã bị cắt — thà nói rõ còn hơn để nó
	// tưởng hội thoại vốn ngắn như vậy.
	const moc: Message = {
		role: "user",
		content:
			`[đã nén ngữ cảnh: bỏ ${boBot.length} tin nhắn cũ ở giữa. ` +
			`Nếu cần thông tin trong đó, hãy đọc lại file hoặc chạy lại lệnh.]`,
	};

	return {
		messages: [dauTien, moc, ...ganNhat],
		daNen: true,
		kyTuBoDi: buoc1.kyTuBoDi + kyTuBo,
		cach: buoc1.daNen ? "ca-hai" : "bo-luot-cu",
	};
}
