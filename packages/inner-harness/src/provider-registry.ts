/**
 * ProviderRegistry — Điểm mở rộng để đăng ký nhà cung cấp model.
 *
 * Thay thế chuỗi if hardcode trong AgentLoop.resolveModel(), vốn có 3 vấn đề:
 *   ① OPENROUTER_API_KEY chiếm quyền TẤT CẢ model, kể cả model chạy cục bộ
 *   ② Tên model không khớp mẫu nào thì âm thầm gửi tới Anthropic thay vì báo lỗi
 *   ③ Không thêm được provider nếu không sửa mã lõi
 *
 * Quy tắc phân giải:
 *   1. Có tiền tố tường minh "provider/model" → dùng đúng provider đó
 *   2. Không có tiền tố → chạy matches() theo thứ tự priority giảm dần
 *   3. Không khớp gì → NÉM LỖI kèm danh sách provider đã đăng ký (không đoán)
 */

/** Kiểu model của Vercel AI SDK. Dùng unknown để không phụ thuộc cứng vào SDK. */
export type ResolvedModel = unknown;

export interface ModelProvider {
	/** Định danh, dùng làm tiền tố: "ollama" → "ollama/qwen2.5:7b" */
	id: string;
	/** Mô tả ngắn, hiển thị trong thông báo lỗi */
	description?: string;
	/** Provider có nhận tên model này không (khi KHÔNG có tiền tố tường minh) */
	matches(model: string): boolean;
	/** Trả về đối tượng model của AI SDK */
	resolve(model: string): Promise<ResolvedModel>;
	/** Số lớn được thử trước. Mặc định 0. */
	priority?: number;
}

export class UnknownProviderError extends Error {
	constructor(model: string, known: string[]) {
		super(
			`Khong xac dinh duoc provider cho model "${model}".\n` +
				`Provider da dang ky: ${known.join(", ")}\n` +
				`Hay dung tien to tuong minh, vi du: "ollama/${model}"`,
		);
		this.name = "UnknownProviderError";
	}
}

export class ProviderRegistry {
	private providers = new Map<string, ModelProvider>();

	register(provider: ModelProvider): this {
		this.providers.set(provider.id, provider);
		return this;
	}

	unregister(id: string): boolean {
		return this.providers.delete(id);
	}

	list(): ReadonlyArray<ModelProvider> {
		return [...this.providers.values()].sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));
	}

	has(id: string): boolean {
		return this.providers.has(id);
	}

	/** Tách "provider/model" thành cặp. Trả về null nếu không có tiền tố hợp lệ. */
	private splitPrefix(model: string): { provider: ModelProvider; rest: string } | null {
		const i = model.indexOf("/");
		if (i <= 0) return null;
		const p = this.providers.get(model.slice(0, i));
		if (!p) return null;
		const rest = model.slice(i + 1);
		return rest ? { provider: p, rest } : null;
	}

	async resolve(model: string): Promise<ResolvedModel> {
		const explicit = this.splitPrefix(model);
		if (explicit) return explicit.provider.resolve(explicit.rest);

		for (const p of this.list()) {
			if (p.matches(model)) return p.resolve(model);
		}

		throw new UnknownProviderError(model, [...this.providers.keys()]);
	}

	/** Cho biết provider nào sẽ xử lý model này — dùng để chẩn đoán, không gọi mạng. */
	whichProvider(model: string): string | null {
		const explicit = this.splitPrefix(model);
		if (explicit) return explicit.provider.id;
		for (const p of this.list()) if (p.matches(model)) return p.id;
		return null;
	}
}

// ─── Provider dựng sẵn ────────────────────────────────────────────

/**
 * Chuẩn hoá OLLAMA_HOST thành baseURL đầy đủ.
 *
 * Tài liệu của Ollama quy định OLLAMA_HOST là "host:port" KHÔNG có scheme
 * (vd `OLLAMA_HOST=0.0.0.0:11434`, đúng dạng nằm trong systemd override).
 * Bản trước ghép thẳng thành "127.0.0.1:11434/v1" → `Failed to parse URL`,
 * mà AgentLoop lại nuốt lỗi và báo "completed" nên rất khó truy ra.
 *
 * `0.0.0.0` là địa chỉ LẮNG NGHE, không phải địa chỉ để gọi tới — đổi sang
 * loopback giống cách client của Ollama làm.
 */
export function normalizeOllamaBaseUrl(raw?: string): string {
	const base = (raw ?? "").trim() || "http://127.0.0.1:11434";
	const coScheme = /^https?:\/\//i.test(base) ? base : `http://${base}`;
	const goiLoopback = coScheme.replace("//0.0.0.0", "//127.0.0.1").replace("//[::]", "//[::1]");
	const boGachCuoi = goiLoopback.replace(/\/+$/, "");
	return boGachCuoi.endsWith("/v1") ? boGachCuoi : `${boGachCuoi}/v1`;
}

/** Ollama — model chạy cục bộ, qua endpoint tương thích OpenAI. */
export const ollamaProvider: ModelProvider = {
	id: "ollama",
	description: "Model chay cuc bo qua Ollama",
	priority: 10,
	// Chỉ tự nhận khi người dùng khai báo rõ ràng, tránh cướp tên model của provider khác.
	matches: () => process.env.AGENTWEAVE_DEFAULT_PROVIDER === "ollama",
	async resolve(model) {
		const { createOpenAI } = await import("@ai-sdk/openai");
		const ollama = createOpenAI({
			baseURL: normalizeOllamaBaseUrl(process.env.OLLAMA_HOST),
			apiKey: process.env.OLLAMA_API_KEY ?? "ollama", // Ollama bỏ qua giá trị này
			name: "ollama",
			// BẮT BUỘC khi chảy chữ: chỉ ở chế độ "strict" thì AI SDK mới gửi
			// `stream_options: {include_usage: true}`. Thiếu nó, Ollama trả
			// usage toàn null — mất số token nghĩa là mù luôn cơ chế đo ngữ cảnh
			// và nén. Đã đo: "compatible" → null, "strict" → 34/10 token.
			compatibility: "strict",
		});
		return ollama(model);
	},
};

/** OpenRouter — CHỈ dùng khi khai báo rõ, không còn chiếm quyền qua biến môi trường. */
export const openrouterProvider: ModelProvider = {
	id: "openrouter",
	description: "Cong gop nhieu nha cung cap",
	priority: 5,
	matches: () => process.env.AGENTWEAVE_DEFAULT_PROVIDER === "openrouter",
	async resolve(model) {
		const { createOpenAI } = await import("@ai-sdk/openai");
		const key = process.env.OPENROUTER_API_KEY;
		if (!key) throw new Error("Thieu OPENROUTER_API_KEY");
		const openrouter = createOpenAI({
			baseURL: "https://openrouter.ai/api/v1",
			apiKey: key,
			headers: {
				"HTTP-Referer": "https://github.com/santete/AgentWeave",
				"X-Title": "AgentWeave",
			},
			name: "openrouter",
		});
		return openrouter(model);
	},
};

export const googleProvider: ModelProvider = {
	id: "google",
	description: "Google Gemini",
	matches: (m) => m.startsWith("gemini"),
	async resolve(model) {
		const { google } = await import("@ai-sdk/google");
		return google(model);
	},
};

export const openaiProvider: ModelProvider = {
	id: "openai",
	description: "OpenAI GPT / o-series",
	matches: (m) =>
		m.startsWith("gpt") || m.startsWith("o1") || m.startsWith("o3") || m.startsWith("o4"),
	async resolve(model) {
		const { openai } = await import("@ai-sdk/openai");
		return openai(model);
	},
};

export const anthropicProvider: ModelProvider = {
	id: "anthropic",
	description: "Anthropic Claude",
	matches: (m) => m.startsWith("claude"),
	async resolve(model) {
		const { anthropic } = await import("@ai-sdk/anthropic");
		return anthropic(model);
	},
};

/** Registry mặc định, đã nạp sẵn các provider dựng sẵn. */
export function createDefaultRegistry(): ProviderRegistry {
	return new ProviderRegistry()
		.register(ollamaProvider)
		.register(openrouterProvider)
		.register(googleProvider)
		.register(openaiProvider)
		.register(anthropicProvider);
}
