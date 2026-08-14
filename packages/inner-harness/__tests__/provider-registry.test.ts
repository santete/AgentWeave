import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	ProviderRegistry,
	UnknownProviderError,
	createDefaultRegistry,
	normalizeOllamaBaseUrl,
	type ModelProvider,
} from "../src/provider-registry";

const fake = (id: string, match: (m: string) => boolean, priority = 0): ModelProvider => ({
	id,
	priority,
	matches: match,
	resolve: async (m) => ({ __provider: id, __model: m }),
});

describe("ProviderRegistry", () => {
	const saved = { ...process.env };
	beforeEach(() => {
		process.env.OPENROUTER_API_KEY = undefined;
		process.env.AGENTWEAVE_DEFAULT_PROVIDER = undefined;
	});
	afterEach(() => {
		process.env = { ...saved };
	});

	describe("phân giải cơ bản", () => {
		it("dùng tiền tố tường minh provider/model", async () => {
			const r = new ProviderRegistry().register(fake("acme", () => false));
			const got = (await r.resolve("acme/llama-9b")) as Record<string, string>;
			expect(got.__provider).toBe("acme");
			expect(got.__model).toBe("llama-9b"); // tiền tố đã được cắt
		});

		it("tiền tố tường minh thắng cả matches()", async () => {
			const r = new ProviderRegistry()
				.register(fake("a", () => true, 100))
				.register(fake("b", () => false));
			const got = (await r.resolve("b/x")) as Record<string, string>;
			expect(got.__provider).toBe("b");
		});

		it("chạy matches() theo priority giảm dần", async () => {
			const r = new ProviderRegistry()
				.register(fake("thap", () => true, 1))
				.register(fake("cao", () => true, 99));
			const got = (await r.resolve("bat-ky")) as Record<string, string>;
			expect(got.__provider).toBe("cao");
		});
	});

	describe("SỬA LỖI ②: không âm thầm rơi về Anthropic", () => {
		it("model lạ thì NÉM LỖI thay vì đoán", async () => {
			const r = new ProviderRegistry().register(fake("openai", (m) => m.startsWith("gpt")));
			await expect(r.resolve("model-la-hoac")).rejects.toBeInstanceOf(UnknownProviderError);
		});

		it("thông báo lỗi liệt kê provider đã đăng ký để người dùng biết đường sửa", async () => {
			const r = new ProviderRegistry().register(fake("ollama", () => false));
			await expect(r.resolve("qwen2.5:7b")).rejects.toThrow(/ollama/);
		});
	});

	describe("SỬA LỖI ①: OPENROUTER_API_KEY không còn chiếm quyền toàn cục", () => {
		it("model cục bộ KHÔNG bị đẩy sang OpenRouter dù có API key", () => {
			process.env.OPENROUTER_API_KEY = "sk-test";
			process.env.AGENTWEAVE_DEFAULT_PROVIDER = "ollama";
			const r = createDefaultRegistry();
			expect(r.whichProvider("qwen2.5:7b")).toBe("ollama");
		});

		it("chỉ dùng OpenRouter khi khai báo rõ ràng", () => {
			process.env.OPENROUTER_API_KEY = "sk-test";
			const r = createDefaultRegistry();
			expect(r.whichProvider("openrouter/meta-llama/llama-3-70b")).toBe("openrouter");
		});

		it("có API key nhưng model là claude thì vẫn về anthropic", () => {
			process.env.OPENROUTER_API_KEY = "sk-test";
			const r = createDefaultRegistry();
			expect(r.whichProvider("claude-sonnet-4")).toBe("anthropic");
		});
	});

	describe("SỬA LỖI ③: thêm provider không cần sửa mã lõi", () => {
		it("đăng ký được provider tuỳ chỉnh lúc chạy", async () => {
			const r = createDefaultRegistry();
			r.register(fake("noi-bo", (m) => m.startsWith("cty-")));
			const got = (await r.resolve("cty-model-v1")) as Record<string, string>;
			expect(got.__provider).toBe("noi-bo");
		});

		it("gỡ đăng ký được", () => {
			const r = createDefaultRegistry();
			expect(r.has("google")).toBe(true);
			expect(r.unregister("google")).toBe(true);
			expect(r.has("google")).toBe(false);
		});
	});

	describe("provider dựng sẵn định tuyến đúng", () => {
		it.each([
			["gemini-2.0-flash", "google"],
			["gpt-4o", "openai"],
			["o3-mini", "openai"],
			["claude-opus-4", "anthropic"],
			["ollama/qwen3-coder:30b", "ollama"],
		])("%s → %s", (model, expected) => {
			expect(createDefaultRegistry().whichProvider(model)).toBe(expected);
		});
	});
});

describe("normalizeOllamaBaseUrl", () => {
	// Tài liệu Ollama quy định OLLAMA_HOST là "host:port" KHÔNG scheme.
	// Bản trước ghép thẳng → "Failed to parse URL from 127.0.0.1:11434/v1/...".
	it.each([
		["127.0.0.1:11434", "http://127.0.0.1:11434/v1"],
		["localhost:11434", "http://localhost:11434/v1"],
		["http://127.0.0.1:11434", "http://127.0.0.1:11434/v1"],
		["http://127.0.0.1:11434/v1", "http://127.0.0.1:11434/v1"],
		["http://127.0.0.1:11434/", "http://127.0.0.1:11434/v1"],
		["https://ollama.noi-bo:443", "https://ollama.noi-bo:443/v1"],
	])("%s → %s", (dauVao, mongDoi) => {
		expect(normalizeOllamaBaseUrl(dauVao)).toBe(mongDoi);
	});

	it("không khai thì dùng loopback mặc định", () => {
		expect(normalizeOllamaBaseUrl(undefined)).toBe("http://127.0.0.1:11434/v1");
		expect(normalizeOllamaBaseUrl("")).toBe("http://127.0.0.1:11434/v1");
		expect(normalizeOllamaBaseUrl("   ")).toBe("http://127.0.0.1:11434/v1");
	});

	it("0.0.0.0 là địa chỉ LẮNG NGHE — phải đổi sang loopback khi gọi tới", () => {
		// Đúng dạng đang nằm trong systemd override của máy này.
		expect(normalizeOllamaBaseUrl("0.0.0.0:11434")).toBe("http://127.0.0.1:11434/v1");
		expect(normalizeOllamaBaseUrl("http://0.0.0.0:11434")).toBe("http://127.0.0.1:11434/v1");
	});
});
