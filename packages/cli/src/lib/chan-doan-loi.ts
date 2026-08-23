/**
 * Dịch lỗi thô thành chỉ dẫn hành động được.
 *
 * Trong khu cô lập, thông báo lỗi là toàn bộ thông tin dev có — không có Google
 * để tra `ECONNREFUSED`. Một dòng "fetch failed" khiến dev tưởng agent hỏng,
 * trong khi thực ra chỉ là Ollama chưa bật. Mỗi lần đoán sai là mất thời gian
 * và mất niềm tin vào cả hệ thống.
 *
 * Nguyên tắc: chỉ dịch những lỗi ta NHẬN RA CHẮC CHẮN. Lỗi lạ thì trả nguyên
 * văn — đoán bừa còn tệ hơn im lặng, vì nó dẫn dev đi sai hướng.
 */

/** Địa chỉ Ollama đang cấu hình, để nhét vào chỉ dẫn cho cụ thể. */
function hostOllama(): string {
	return process.env.OLLAMA_HOST?.trim() || "127.0.0.1:11434";
}

export interface LoiCoChiDan {
	/** Câu tóm tắt điều thực sự sai. */
	tomTat: string;
	/** Các bước sửa, theo thứ tự nên thử. Rỗng nếu không nhận ra lỗi. */
	buoc: string[];
}

/**
 * Nhận diện lỗi hạ tầng thường gặp khi chạy model cục bộ.
 *
 * @returns chỉ dẫn nếu nhận ra, hoặc null để chỗ gọi dùng thông báo gốc.
 */
export function chanDoan(loiTho: string): LoiCoChiDan | null {
	const s = loiTho.toLowerCase();
	const host = hostOllama();

	// Ollama chưa chạy — lỗi hay gặp nhất. Node phát ECONNREFUSED; fetch của
	// undici bọc lại thành "fetch failed" với cause bên trong.
	if (
		s.includes("econnrefused") ||
		s.includes("fetch failed") ||
		s.includes("connect econnrefused") ||
		(s.includes("connection") && s.includes("refused"))
	) {
		return {
			tomTat: `Không kết nối được tới Ollama ở ${host}.`,
			buoc: [
				"Kiểm tra Ollama đã chạy chưa: `ollama ps` (hoặc `systemctl --user status ollama`).",
				"Nếu chưa, khởi động: `ollama serve` — hoặc bật dịch vụ đã cài trong gói.",
				`Nếu Ollama chạy ở địa chỉ khác, sửa OLLAMA_HOST (đang trỏ ${host}).`,
			],
		};
	}

	// Máy chủ có đó nhưng phân giải tên hỏng — thường do OLLAMA_HOST sai dạng.
	if (s.includes("enotfound") || s.includes("getaddrinfo")) {
		return {
			tomTat: `Không phân giải được địa chỉ Ollama "${host}".`,
			buoc: [
				"OLLAMA_HOST phải là dạng host:port, KHÔNG kèm http:// (vd 127.0.0.1:11434).",
				"Với máy cục bộ, để trống hoặc dùng 127.0.0.1:11434.",
			],
		};
	}

	// Kết nối được nhưng model chưa nạp về đĩa.
	if (
		(s.includes("model") && (s.includes("not found") || s.includes("no such"))) ||
		s.includes("model not found") ||
		s.includes("try pulling")
	) {
		return {
			tomTat: "Model chưa có trên máy này.",
			buoc: [
				"Xem model đang có: `ollama list`.",
				"Đổi sang model có sẵn bằng lệnh đổi model, hoặc sửa .agentweave/agent.json.",
				"KHÔNG `ollama pull` trong khu cô lập — không có mạng. Model phải nằm sẵn trong gói.",
			],
		};
	}

	// Ollama treo hoặc quá tải: kết nối được, chờ mãi không trả.
	if (s.includes("etimedout") || s.includes("timeout") || s.includes("timed out")) {
		return {
			tomTat: `Ollama ở ${host} nhận kết nối nhưng không trả lời kịp.`,
			buoc: [
				"Model lớn nạp lần đầu có thể lâu — thử lại sau khi nó nạp xong.",
				"Xem Ollama có đang nuốt hết bộ nhớ không: `ollama ps`.",
				"Nếu treo hẳn, khởi động lại Ollama.",
			],
		};
	}

	return null;
}

/**
 * Gộp chỉ dẫn thành một chuỗi nhiều dòng cho CLI, hoặc trả nguyên văn nếu không
 * nhận ra lỗi.
 */
export function moTaLoi(loiTho: string): string {
	const cd = chanDoan(loiTho);
	if (!cd) return loiTho;
	return [cd.tomTat, ...cd.buoc.map((b, i) => `  ${i + 1}. ${b}`)].join("\n");
}
