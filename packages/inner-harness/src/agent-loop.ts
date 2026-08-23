/**
 * REFERENCE IMPLEMENTATION — not production path (post-pivot 2026-04-22).
 *
 * AgentWeave's production positioning (see product-spec/POSITIONING.md) is
 * a governance + QA layer that delegates agent-loop execution to Claude Code,
 * Cursor, or any MCP-compatible agent via packages/adapters/. This file is
 * kept for: (1) offline/local use, (2) teaching the agent-loop contract,
 * (3) test infrastructure for the outer-harness.
 *
 * New feature work should extend Pillar 2 (packages/inner-harness/src/sdlc/)
 * or an adapter — NOT this loop.
 *
 * ---
 *
 * AgentLoop — Core execution engine implementing InnerHarnessProvider.
 * Runs as an AsyncGenerator that yields InnerEvents.
 * Uses Vercel AI SDK with maxSteps:1 (we control the loop).
 */

import { isAbsolute, resolve } from "node:path";
import type {
	BoGhiVetTich,
	ContentBlock,
	ControlPlane,
	InjectableMessage,
	InnerConfig,
	InnerEvent,
	InnerEventPayload,
	InnerHarnessProvider,
	InnerState,
	Message,
	ProcessSandboxBinding,
	RunOptions,
	TerminalResult,
	ToolDecision,
	ToolDefinition,
} from "@agentweave/types";
import { LOAI_DIEM_CHAM, createEmptyContextUsage, createEmptyTokenUsage } from "@agentweave/types";
import type { ContextUsage, TokenUsage } from "@agentweave/types";
import { nanoid } from "nanoid";
import { type NguonNhac, bocNhacHeThong, nhacGuard, thuNhac } from "./attachments/index";
import { chuanHoaCapTool } from "./cap-tool";
import {
	CAC_MUC_NEN,
	MAX_NEN_THAT_BAI_LIEN_TIEP,
	canNen,
	capNhatDoDay,
	daBoDoLau,
	mucNen,
	nenManhTay,
	nenTheoThoiGian,
	suyRaCuaSo,
} from "./context-manager";
import { cauKemKetQua, kiemCuPhap } from "./kiem-cu-phap";
import { NHAN_KHOI_BO_NHO } from "./memory/types";
import { MessageStore } from "./message-store";
import { createNoopControlPlane } from "./noop-control-plane";
import {
	type ModelProvider,
	type ProviderRegistry,
	createDefaultRegistry,
	normalizeOllamaBaseUrl,
} from "./provider-registry";
import { mapTinNhanChoSdk, renderChoOllama } from "./render-lich-su";
import { TokenCounter } from "./token-counter";
import { boBocKhoiJson, cuuToolCall } from "./tool-call-recovery";
import { ToolExecutor } from "./tool-executor";
import type { ToolCall } from "./tool-executor";
import { ToolRegistry } from "./tool-registry";

export interface AgentLoopConfig {
	/** Control plane for governance integration. If omitted, runs standalone (all tools allowed, no output filtering). */
	controlPlane?: ControlPlane;
	model: string;
	fallbackModel?: string;
	tools?: ToolDefinition[];
	systemPrompt?: string;
	maxTurns?: number;
	thinkingEnabled?: boolean;
	/**
	 * Giao thức CÓ RÀNG BUỘC: ép model (Ollama) trả envelope JSON qua `format`
	 * schema thay vì tự do rồi cứu. Đo thật (bench-format): parse 100%, code
	 * không tệ đi, tốc độ ngang. Mặc định TẮT để không đổi hành vi bản sẵn có.
	 */
	structuredProtocol?: boolean;
	/**
	 * Cửa sổ ngữ cảnh của model, tính bằng token. Không khai thì suy ra: model
	 * cục bộ lấy theo OLLAMA_CONTEXT_LENGTH (mặc định 65.536), model đám mây
	 * 200.000. Khai sai làm cơ chế nén kích hoạt nhầm lúc.
	 */
	contextWindow?: number;
	/** Tự nén khi ngữ cảnh đầy tới ngưỡng. Mặc định bật. */
	autoCompact?: boolean;
	/**
	 * Cô lập tool chạy tiến trình bằng sandbox tầng nhân (bubblewrap/seatbelt).
	 * Không khai thì KHÔNG cô lập — giữ nguyên hành vi cũ để không phá bản dùng
	 * sẵn có; nơi nào cần thì bật tường minh.
	 */
	processSandbox?: ProcessSandboxBinding;
	/**
	 * Hạn chờ quyết định quyền, ms. `0` = chờ vô hạn (mặc định).
	 *
	 * Mặc định của ControlPlane là 30 giây — hợp cho interceptor tự động, nhưng
	 * SAI khi quyết định thuộc về con người: người dùng đọc diff lâu hơn 30 giây
	 * là bị từ chối, mà thông báo lại nói "Interceptor timeout" nên trông như
	 * lỗi hệ thống chứ không phải như chính mình chưa bấm.
	 * Pipeline SDLC không dùng vòng lặp này nên không bị ảnh hưởng.
	 */
	toolRequestTimeoutMs?: number;
	/**
	 * Nhận biết một lệnh Bash có phải là lệnh KIỂM CHỨNG mã nguồn không
	 * (test/build/lint/typecheck). Truyền vào thì bật cổng chặn "sửa file mà
	 * chưa kiểm chứng" — xem `chuaKiemChung` trong vòng lặp.
	 *
	 * Là hàm truyền vào chứ không phải logic viết ở đây: bộ nhận biết sống ở
	 * `cli/lib/theo-doi-kiem-tra.ts` và đã được dùng cho phần cảnh báo. Chép
	 * lại thành bản thứ hai thì sớm muộn hai bản lệch nhau.
	 */
	laLenhKiemTra?: (command: string) => boolean;
	/** Tham số bộ sinh của model. Xem `ThamSoSinh`. */
	thamSoSinh?: ThamSoSinh;
	/**
	 * Nơi nhận vết tích. Không truyền = không ghi gì, không tốn gì.
	 *
	 * CHỈ QUAN SÁT: bật nó lên không được đổi một quyết định nào của vòng lặp.
	 */
	vetTich?: BoGhiVetTich;
}

/**
 * Tham số điều khiển BỘ SINH của model.
 *
 * Rà soát `docs/RA-SOAT-DIEU-KHIEN.md` (F5/KT-07): trước đợt này AgentWeave
 * không truyền MỘT tham số sinh nào ở cả hai đường — tức là cố sửa hành vi
 * sampler bằng văn bản trong khi mọi nút chỉnh sampler bỏ trống. Không có seed
 * thì một phiên hỏng cũng không tái lập được để mà sửa.
 *
 * Bỏ trống trường nào thì KHÔNG gửi trường đó: mặc định của Ollama/model là
 * lựa chọn hợp lý, và gửi một con số "trông có vẻ đúng" sẽ ghi đè cấu hình
 * Modelfile mà người vận hành đã cân.
 */
export interface ThamSoSinh {
	temperature?: number;
	topP?: number;
	/**
	 * `repeat_penalty` của Ollama (mặc định 1.1, nhân chứ không cộng).
	 *
	 * Đường stream đi qua endpoint tương thích OpenAI, ở đó không có tham số
	 * này — nó được quy sang `frequencyPenalty = repeatPenalty - 1`. Hai thang
	 * đo KHÔNG tương đương chính xác; đây là quy đổi thực dụng để cùng một cấu
	 * hình không im lặng mất tác dụng khi đổi đường.
	 */
	repeatPenalty?: number;
	/** Cố định seed để tái lập được một phiên hỏng. */
	seed?: number;
}

/** Mốc `repeat_penalty` khi leo thang mà người dùng chưa đặt giá trị nền. */
const REPEAT_PENALTY_NEN = 1.1;
/** Mỗi nấc leo thang cộng thêm ngần này. */
const BUOC_REPEAT_PENALTY = 0.1;
/**
 * Trần `repeat_penalty`. Quá 1.5 thì model bắt đầu né cả từ khoá bắt buộc của
 * ngôn ngữ lập trình — chữa lặp bằng cách làm hỏng cú pháp.
 */
const TRAN_REPEAT_PENALTY = 1.5;

/** Nối phần chữ của một prompt nhiều khối — dùng cho cổng kiểm duyệt và log. */
export function trichChu(khoi: ContentBlock[]): string {
	return khoi
		.filter((b): b is Extract<ContentBlock, { type: "text" }> => b.type === "text")
		.map((b) => b.text)
		.join("\n");
}

/**
 * Thay phần chữ của prompt bằng chữ đã qua cổng, GIỮ nguyên mọi khối khác (ảnh).
 * Nếu prompt chưa có khối chữ nào thì chèn khối chữ mới lên đầu.
 */
export function thayChu(khoi: ContentBlock[], chuMoi: string): ContentBlock[] {
	let daThay = false;
	const ra = khoi.map((b) => {
		if (b.type === "text" && !daThay) {
			daThay = true;
			return { type: "text" as const, text: chuMoi };
		}
		return b;
	});
	if (!daThay) ra.unshift({ type: "text", text: chuMoi });
	return ra;
}

/**
 * Chuyển tin nhắn nội bộ sang khuôn CoreMessage của AI SDK.
 *
 * Thân hàm nằm ở `render-lich-su.ts` — TẦNG 0 của hệ điều khiển, có test
 * riêng. Vẫn xuất lại từ đây vì đó là điểm nhập mọi nơi đang dùng.
 */
export { mapTinNhanChoSdk, renderChoOllama } from "./render-lich-su";

// ─── Bắt "tuyên bố rồi dừng" ─────────────────────────────────────
// Model cục bộ hay kết lượt bằng "Tôi sẽ kiểm tra..." / "Bạn cho tôi biết..."
// mà KHÔNG gọi tool nào — người dùng bảo "làm đi" và nhận lại một lời hứa.
// Khớp mẫu tuyên-bố-tương-lai hoặc hỏi-xin-thông-tin (vi + en, có/không dấu).
const MAU_TUYEN_BO =
	/(tôi sẽ|toi se|sẽ bắt đầu|se bat dau|để bắt đầu|de bat dau|tôi cần xác định|toi can xac dinh|i will|i'll|let me|bạn có thể cho tôi biết|ban co the cho toi biet|hãy cho tôi biết|vui lòng cung cấp|please provide|could you (tell|provide))/i;

/** Tool GHI file. */
const LA_TOOL_GHI: ReadonlySet<string> = new Set(["FileWrite", "FileEdit"]);

// ─── Mặt nạ tool — đòn bẩy CƯỠNG CHẾ của hệ ghì ──────────────────
//
// Bản trước là một cờ boolean `epChiViet`, và nó có hai lỗ mà rà soát
// `docs/RA-SOAT-DIEU-KHIEN.md` (F1, NS-4) chỉ đúng:
//
//   · chỉ được ĐỌC ở đường có ràng buộc — vô hiệu hoàn toàn ở stream, tức là
//     đòn bẩy cưỡng chế duy nhất chết ở một trong hai cấu hình;
//   · chỉ biết ép VIẾT. Ý "sửa xong phải kiểm chứng" được phát biểu ở 6 chỗ
//     trên 3 tầng nhưng KHÔNG có cách nào diễn đạt "lượt sau chỉ được Bash",
//     nên nó mãi mãi chỉ là lời khuyên bằng văn.
//
// Mặt nạ là tập tên tool được phép ở lượt gọi KẾ TIẾP. Đường có ràng buộc đưa
// nó vào enum của format schema (sampler không sinh nổi tên ngoài danh sách);
// đường stream lọc danh sách tool gửi cho model. `respond`/trả lời bằng chữ
// luôn được phép ở cả hai — mặt nạ thu hẹp lựa chọn, không nhốt model.
//
// LUẬT KHI THÊM CHỖ ĐẶT MẶT NẠ: câu nhắc đi kèm phải nói ĐÚNG tập này. Đo
// thật kiểu hỏng ngược lại: cảnh báo bảo "run the check command with Bash"
// trong khi enum vừa loại Bash — model không có nước đi hợp lệ nào.

/** Chỉ được VIẾT: khi model trinh sát mãi mà không sản xuất gì. */
const MAT_NA_VIET = ["FileWrite", "FileEdit"];
/** Phải TIẾN TRIỂN: tạo ra thứ gì đó, hoặc chạy thứ gì đó. */
const MAT_NA_TIEN_TRIEN = ["FileWrite", "FileEdit", "Bash"];
/** Chỉ được CHẠY: cổng kiểm chứng nhịp 2 — đã sửa file, giờ phải chạy kiểm. */
const MAT_NA_CHAY = ["Bash"];

// ── Ngưỡng của bộ đếm gọi-LIÊN-TIẾP (cùng tool, tham số đổi vặt) ──
// Ba mốc chứ không một: chặn → cảnh cuối → dừng. Bản trước chỉ có mốc đầu và
// lặp lại y nguyên bài răn ở mọi lần sau đó, nên "loop biến thể" nghiền hết
// 50 lượt mà không gì dừng được nó.
const NHAC_LIEN_TIEP = 4;
const CANH_CUOI_LIEN_TIEP = 6;
const CAT_LIEN_TIEP = 8;

const NHAC_HANH_DONG = `Do NOT announce plans and do NOT ask the user — ACT NOW. Your next call must CHANGE something: FileWrite/FileEdit to produce the deliverable, or Bash to run a command. Stop searching; if something is genuinely unknown, make your best reasonable choice and note it in a comment. Reply with text only when the work is actually DONE.`;

export class AgentLoop implements InnerHarnessProvider {
	private controlPlane: ControlPlane;
	private model: string;
	private structuredProtocol = false;
	private fallbackModel?: string;
	private systemPrompt: string;
	/** Các mục prompt đặt qua setSystemPromptSection(), giữ theo tên để không lặp. */
	private promptSections = new Map<string, string>();
	private maxTurns: number;
	private thinkingEnabled: boolean;

	private registry = new ToolRegistry();
	private providers: ProviderRegistry = createDefaultRegistry();
	private messages = new MessageStore();
	private tokenCounter = new TokenCounter();
	private abortController: AbortController | null = null;
	private sessionId = "";
	private agentId: string;
	private autoCompact = true;
	private toolRequestTimeoutMs = 0;
	private processSandbox?: ProcessSandboxBinding;
	/** Đặt bởi lệnh force_compact — nén ở đầu lượt kế tiếp. */
	private yeuCauNen = false;
	/** Mức nén hiện tại. Tăng khi nén xong vẫn chưa đủ chỗ. */
	private mucNenHienTai = 0;
	/** Số lượt liên tiếp đã nén hết mức mà vẫn tràn — chạm trần thì ngắt mạch. */
	private soLanNenVoIch = 0;
	/** Thời điểm lượt gần nhất, để biết phiên có bị bỏ dở rồi quay lại không. */
	private lucHoatDongCuoi = 0;
	// ── Bộ đếm ghì model ────────────────────────────────────────
	//
	// PHẠM VI THẬT: MỘT CÂU của người dùng, không phải cả phiên trò chuyện.
	//
	// `chat` và `serve` dựng harness MỚI cho mỗi câu (thiết kế có chủ đích cho
	// REPL: đổi model, đổi quyền, đổi cấu hình giữa chừng đều phải ăn ngay), rồi
	// nạp lại lịch sử qua `initialMessages`. Bộ đếm là trạng thái của đối tượng
	// nên nó chết theo harness — mọi chỗ trong mã và tài liệu viết "trong phiên"
	// đều phải đọc là "trong câu này".
	//
	// Hệ quả phải biết khi chỉnh ngưỡng: cổng kiểm chứng tái vũ trang ở MỖI câu
	// (người dùng thấy là "cứ nhắc mãi một luật"), và một model quẩn xuyên nhiều
	// câu thì không bộ đếm nào cộng dồn được.
	private demGoiTrung = new Map<string, number>();
	// Phát hiện gọi LIÊN TIẾP cùng một tool với tham số đổi vặt — thứ mà bộ đếm
	// theo (tool+input) ở trên bỏ lọt hoàn toàn.
	private toolLienTiepTruoc = "";
	private soToolLienTiep = 0;
	// Bắt bệnh "tuyên bố rồi dừng": số tool ĐÃ thực thi + đã nhắc hành động chưa.
	private soToolThucThi = 0;
	private fileDaSua = new Set<string>();
	private soLanNhacHanhDong = 0;
	/** Lượt gần nhất có FileWrite/FileEdit chạy xong. 0 = chưa lần nào. */
	private luotGhiCuoi = 0;
	// ── Cổng "sửa file mà chưa kiểm chứng" ──
	private laLenhKiemTra?: (command: string) => boolean;
	/** Đã có LỆNH kiểm chứng nào chạy xong trong phiên chưa. */
	private daChayKiemTra = false;
	/** Số lần đã chặn kết thúc vì chưa kiểm chứng. */
	private soLanEpKiemTra = 0;
	private soLanEpTiepTuc = 0;
	// Bắt bệnh "vẹt": câu trả lời assistant GẦN NHẤT trong lịch sử (phiên trước).
	private traLoiTruocDo = "";
	private daNhacVet = false;
	private soDocTuKhiViet = 0;
	/**
	 * Mặt nạ tool cho lượt gọi KẾ TIẾP — null nghĩa là không thu hẹp.
	 *
	 * Một phát: `layMatNa()` đọc xong là xoá, nên không cờ nào rò rỉ sang lượt
	 * sau hay sang đường chạy khác. Bản cũ chỉ xoá ở đường có ràng buộc, nên
	 * chạy cấu hình stream là cờ bật vĩnh viễn mà không ai tiêu thụ.
	 */
	private matNaTool: ReadonlySet<string> | null = null;
	private thamSoSinh?: ThamSoSinh;
	private vetTich?: BoGhiVetTich;
	/**
	 * Số nấc đã leo của `repeat_penalty`.
	 *
	 * Phát hiện lặp mà chỉ tiêm THÊM CHỮ là chữa triệu chứng ở sai tầng: cái
	 * lặp sinh ra từ bộ sinh, nên nấc này vặn đúng chỗ. Đặt lại khi có tiến
	 * triển thật (ghi file thành công).
	 */
	private nacRepeatPenalty = 0;
	/**
	 * Câu răn của guard chờ bơm, gom trong MỘT lượt.
	 *
	 * Không bơm ngay tại chỗ phát hiện: chèn một tin nhắn vào GIỮA dãy
	 * tool_result sẽ tách cặp `tool_use`/`tool_result` mà `chuanHoaCapTool` phải
	 * đi dọn. Gom rồi bơm một lần sau khi dãy kết quả đã khép cũng đúng với
	 * thiết kế kênh nhắc: một tin nhắn cho cả lượt (xem `bocNhacHeThong`).
	 */
	private nhacGuardChoLuot: string[] = [];

	// ── Ống dẫn attachment (xem attachments/types.ts) ──────────────
	/** Nguồn sinh nhắc, đăng ký từ ngoài: rule theo đường dẫn, skill theo đường dẫn, hẹn giờ. */
	private nguonNhac: NguonNhac[] = [];
	/** Khoá đã bơm trong phiên — chống bơm lại cùng một rule ở mỗi lượt. */
	private daBomNhac = new Set<string>();
	/** File model chạm ở lượt VỪA RỒI. Đọc xong thì xoá, không cộng dồn cả phiên. */
	private fileVuaCham: string[] = [];
	/** Câu người dùng của lượt này — nguồn bộ nhớ chấm điểm liên quan dựa vào đây. */
	private promptNguoiDung = "";

	private state: InnerState = {
		status: "idle",
		turnIndex: 0,
		model: "",
		usage: createEmptyTokenUsage(),
		contextUsage: createEmptyContextUsage(200_000),
		activeTool: null,
		messageCount: 0,
		recoveryAttempts: 0,
	};

	constructor(config: AgentLoopConfig) {
		this.controlPlane = config.controlPlane ?? createNoopControlPlane();
		this.model = config.model;
		this.fallbackModel = config.fallbackModel;
		this.systemPrompt = config.systemPrompt ?? "";
		this.maxTurns = config.maxTurns ?? 100;
		this.thinkingEnabled = config.thinkingEnabled ?? true;
		this.autoCompact = config.autoCompact ?? true;
		this.toolRequestTimeoutMs = config.toolRequestTimeoutMs ?? 0;
		// Cờ từ config; nếu không khai thì cho phép bật nhanh qua env để test/vá gấp.
		this.structuredProtocol =
			config.structuredProtocol ?? process.env.AGENTWEAVE_STRUCTURED === "1";
		this.processSandbox = config.processSandbox;
		this.laLenhKiemTra = config.laLenhKiemTra;
		this.thamSoSinh = config.thamSoSinh;
		this.vetTich = config.vetTich;
		this.agentId = `agent_${nanoid(8)}`;
		this.state.model = this.model;
		// Cửa sổ ngữ cảnh THẬT của model. Mặc định cũ là 200.000 — cửa sổ của
		// Claude — nên với model cục bộ 64K thì số đo sai gấp ba lần.
		this.state.contextUsage = createEmptyContextUsage(suyRaCuaSo(this.model, config.contextWindow));

		if (config.tools) {
			for (const tool of config.tools) {
				this.registry.register(tool);
			}
		}

		this.setupCommandHandler();
	}

	async *run(
		prompt: string | ContentBlock[],
		options?: RunOptions,
	): AsyncGenerator<InnerEvent, TerminalResult, void> {
		if (this.state.status !== "idle") {
			throw new Error(
				"AgentLoop.run() can only be called once per instance. Create a new harness with createHarness() for a new session.",
			);
		}

		this.abortController = new AbortController();
		this.sessionId = `ses_${nanoid(12)}`;
		this.state.status = "running";
		this.state.turnIndex = 0;

		const maxTurns = options?.maxTurns ?? this.maxTurns;
		const maxBudget = options?.maxBudgetUsd;
		// ── Trần THỜI GIAN cho cả lượt ──
		//
		// `RunOptions.timeoutMs` và `TerminalReason: "timeout"` đã nằm trong kiểu
		// từ lâu mà KHÔNG ai nối — bản đồ phanh trông đủ mà thực tế thủng. Hai
		// phanh còn lại đều không đỡ được ca này:
		//
		//   · `maxBudgetUsd` luôn = 0 với Ollama (model cục bộ tính giá MIEN_PHI),
		//     nên nó không bao giờ kích. Một phanh đọc thì có mà đạp thì không.
		//   · `maxTurns` đếm LƯỢT, không đếm giờ. 50 lượt của một model 30B trên
		//     Jetson có thể là 40 phút, và người dùng không có cách nào biết trước.
		//
		// Kiểm ở ĐẦU LƯỢT chứ không giữa lượt: cắt giữa một lệnh Bash đang chạy
		// thì để lại tiến trình mồ côi và file ghi dở. `bashTimeoutMs` đã chặn
		// đúng ca lệnh đơn lẻ chạy quá lâu, nên trần này chỉ cần chặn phần TÍCH LUỸ.
		const hanChotMs =
			options?.timeoutMs !== undefined ? Date.now() + options.timeoutMs : Number.POSITIVE_INFINITY;
		const signal = options?.signal;

		// Abort if external signal fires
		if (signal) {
			signal.addEventListener("abort", () => this.abortController?.abort(), { once: true });
		}

		// Load initial messages if resuming
		if (options?.initialMessages) {
			this.messages.setMessages([...options.initialMessages]);
			// Ghi lại câu trả lời assistant gần nhất — để so bắt bệnh "vẹt" (model
			// yếu dán lại nguyên văn câu cũ thay vì xử lý yêu cầu mới).
			for (let i = options.initialMessages.length - 1; i >= 0; i--) {
				const m = options.initialMessages[i]!;
				if (m.role === "assistant") {
					this.traLoiTruocDo =
						typeof m.content === "string" ? m.content : trichChu(m.content as ContentBlock[]);
					break;
				}
			}
		}

		// Input gate (via Control Plane).
		//
		// Cổng làm việc trên CHỮ, nên với prompt nhiều khối (có ảnh) chỉ trích
		// phần chữ ra để kiểm duyệt. Nếu cổng biến đổi chữ thì thay đúng phần
		// chữ, GIỮ NGUYÊN khối ảnh — trước đây cả prompt bị JSON.stringify nên
		// ảnh biến thành chuỗi JSON và mất hẳn với model thị giác.
		const inputText = typeof prompt === "string" ? prompt : trichChu(prompt);
		this.promptNguoiDung = inputText;
		const inputDecision = await this.controlPlane.intercept("input_received", {
			text: inputText,
			sessionId: this.sessionId,
			timestamp: Date.now(),
		});

		if (inputDecision.action === "reject") {
			this.state.status = "completed";
			return { reason: "input_rejected" };
		}

		if (typeof prompt === "string") {
			this.messages.append({ role: "user", content: inputDecision.transformedInput ?? prompt });
		} else if (inputDecision.transformedInput !== undefined) {
			this.messages.append({
				role: "user",
				content: thayChu(prompt, inputDecision.transformedInput),
			});
		} else {
			this.messages.append({ role: "user", content: prompt });
		}

		// ─── Main Agent Loop ─────────────────────────────────────────
		while (this.state.turnIndex < maxTurns) {
			if (this.abortController.signal.aborted) {
				this.state.status = "aborted";
				return { reason: "aborted", usage: this.tokenCounter.getUsage() };
			}

			// Pause support — status may be changed by command handler
			while ((this.state.status as string) === "paused") {
				await new Promise((r) => setTimeout(r, 100));
				if (this.abortController.signal.aborted) {
					this.state.status = "aborted";
					return { reason: "aborted", usage: this.tokenCounter.getUsage() };
				}
			}

			if (Date.now() >= hanChotMs) {
				// Chốt hạ cánh trước khi dừng — cùng lý do như max_turns: bỏ người
				// dùng chỏng chơ sau 30 phút là kiểu kết thúc tệ nhất.
				const tomTg = await this.tomTatHaCanh("the time limit was reached");
				if (tomTg) {
					this.messages.appendAssistant(tomTg);
					yield this.makeEvent({ type: "llm:stream_delta", delta: tomTg, blockType: "text" });
				}
				this.state.status = "completed";
				const usage = this.tokenCounter.getUsage();
				yield this.makeEvent({ type: "terminal", reason: "timeout", usage });
				return { reason: "timeout", usage };
			}

			this.state.turnIndex++;

			yield this.makeEvent({ type: "turn:start", turnIndex: this.state.turnIndex });

			// ── Dọn theo THỜI GIAN ──
			// Tín hiệu khác hẳn ngưỡng đầy: khoảng lặng dài nghĩa là người dùng đã
			// rời đi rồi quay lại với việc khác. Lịch sử cũ vừa không còn liên quan
			// vừa làm chậm mọi lượt còn lại, nên dọn ngay chứ đừng đợi chạm 0,8.
			if (this.autoCompact && daBoDoLau(this.lucHoatDongCuoi, Date.now())) {
				const kqTg = nenTheoThoiGian(this.messages.getMessages());
				if (kqTg.daNen) {
					this.messages.setMessages(kqTg.messages);
					this.state.messageCount = this.messages.getMessageCount();
					yield this.makeEvent({
						type: "context:compacted",
						freedTokens: Math.round(kqTg.kyTuBoDi / 4),
						strategy: "bo-do-lau",
						messagesRemoved: 0,
					});
				}
			}
			this.lucHoatDongCuoi = Date.now();

			// ── Nén ngữ cảnh TRƯỚC khi gọi LLM ──
			// Phải nén trước chứ không phải sau: gọi khi đã tràn thì Ollama lặng
			// lẽ cắt phần đầu hội thoại, agent quên đề bài mà không báo gì.
			if (this.yeuCauNen || (this.autoCompact && canNen(this.state.contextUsage))) {
				const truoc = this.messages.getMessageCount();
				// Leo thang: nén ở mức hiện tại. Nếu lượt trước đã nén mà vẫn chật
				// thì mức tăng lên, giữ ít lượt hơn và cắt tool result ngắn hơn.
				const muc = mucNen(this.mucNenHienTai);
				const kq = nenManhTay(this.messages.getMessages(), muc.giuGanNhat, muc.tranToolResult);
				this.yeuCauNen = false;
				this.mucNenHienTai++;

				if (kq.daNen) {
					// KHÔNG đặt lại bộ đếm ngắt mạch ở đây. `daNen` chỉ nói "có thay
					// đổi gì đó", không nói "có giúp được không" — và nén leo thang
					// thì gần như lượt nào cũng bỏ được vài tin nhắn. Thước đo đúng
					// là độ đầy có tụt xuống dưới ngưỡng không, kiểm sau lượt gọi LLM.
					this.messages.setMessages(kq.messages);
					this.state.contextUsage = {
						...this.state.contextUsage,
						compactionCount: this.state.contextUsage.compactionCount + 1,
					};
					this.state.messageCount = this.messages.getMessageCount();

					this.vet("agent", LOAI_DIEM_CHAM.AGENT_NEN, {
						muc: this.mucNenHienTai - 1,
						cach: kq.cach,
						kyTuBoDi: kq.kyTuBoDi,
						tinNhanBoDi: truoc - kq.messages.length,
						doDay: this.state.contextUsage.usedTokens,
						cuaSo: this.state.contextUsage.maxTokens,
					});
					yield this.makeEvent({
						type: "context:compacted",
						// ~4 ký tự một token — ước lượng thô, đủ để người vận hành
						// thấy quy mô. Số chính xác sẽ có ở lượt gọi LLM kế tiếp.
						freedTokens: Math.round(kq.kyTuBoDi / 4),
						strategy: kq.cach,
						messagesRemoved: truoc - kq.messages.length,
					});
				}

				// ── NGẮT MẠCH ──
				// Đã leo qua hết các mức nén mà ngữ cảnh VẪN trên ngưỡng: nén thêm
				// không cứu được nữa. Bộ đếm chỉ leo khi thật sự kẹt — nó được đặt
				// lại ngay khi độ đầy tụt xuống dưới ngưỡng (xem sau lượt gọi LLM).
				//
				// Bản gốc ghi số liệu thật: 1.279 phiên có 50+ lần nén thất bại liên
				// tiếp, cao nhất 3.272. Vòng lặp không chết hẳn — nó chỉ đốt token và
				// không tiến triển, nên không ai nhận ra cho tới khi xem hoá đơn.
				if (this.mucNenHienTai > CAC_MUC_NEN.length) {
					this.soLanNenVoIch++;
					if (this.soLanNenVoIch >= MAX_NEN_THAT_BAI_LIEN_TIEP) {
						const loi =
							`Ngu canh van day (${this.state.contextUsage.usedTokens}/${this.state.contextUsage.maxTokens} token) ` +
							`sau ${this.soLanNenVoIch} lan nen o muc cao nhat. Nen them cung khong cuu duoc. ` +
							`Dung han thay vi dot token vo ich — hay bat dau phien moi hoac chia nho de bai.`;
						this.state.status = "completed";
						const usage = this.tokenCounter.getUsage();
						yield this.makeEvent({ type: "error", error: loi, recoverable: false });
						yield this.makeEvent({ type: "terminal", reason: "error", usage });
						return { reason: "error", usage };
					}
				}
			}

			// ── Thu nhắc rồi bơm vào ngữ cảnh ──
			// Đặt SAU bước nén: nén xong mới còn chỗ, và câu nhắc vừa bơm không bị
			// chính lượt nén này cắt mất. Toàn bộ khối này KHÔNG BAO GIỜ ném và
			// không bao giờ chạy quá 1 giây — xem attachments/thu-thap.ts.
			if (this.nguonNhac.length > 0) {
				const kqNhac = await thuNhac(this.nguonNhac, {
					luot: this.state.turnIndex,
					fileVuaCham: this.fileVuaCham,
					daBom: this.daBomNhac,
					promptNguoiDung: this.promptNguoiDung,
					// Đếm LẠI từ nội dung hội thoại mỗi lượt, không giữ biến song song:
					// nén xoá khối bộ nhớ cũ đi thì con số này tự lùi, và bơm lại là
					// hợp lệ vì thứ cũ đã không còn trong ngữ cảnh.
					byteBoNhoDaBom: demByteBoNho(this.messages.getMessages()),
					signal: this.abortController.signal,
				});
				// Xoá dù có nhắc hay không: tín hiệu là "file chạm ở lượt VỪA RỒI",
				// giữ lại thì lượt sau bơm nhầm theo file cũ.
				this.fileVuaCham = [];

				const tinNhac = bocNhacHeThong(kqNhac.nhac);
				if (tinNhac) {
					for (const n of kqNhac.nhac) if (n.khoa) this.daBomNhac.add(n.khoa);
					this.messages.append(tinNhac);
					this.state.messageCount = this.messages.getMessageCount();
					this.vet(
						"agent",
						LOAI_DIEM_CHAM.AGENT_NHAC,
						{ nguon: "tri-thuc", loai: kqNhac.nhac.map((n) => n.loai) },
						{ "nhac.txt": tinNhac.content as string },
					);
					yield this.makeEvent({
						type: "context:reminder",
						loai: kqNhac.nhac.map((n) => n.loai),
						bytes: Buffer.byteLength(tinNhac.content as string, "utf-8"),
					});
				}

				// Nguồn hỏng không chặn lượt, nhưng KHÔNG được im lặng: một rule âm
				// thầm không nạp được nghĩa là chính sách mất hiệu lực mà không ai biết.
				if (kqNhac.loi.length > 0 || kqNhac.quaHan.length > 0) {
					const phan = [
						...kqNhac.loi.map((l) => `${l.ten}: ${l.lyDo}`),
						...kqNhac.quaHan.map((t) => `${t}: qua han 1s, bo qua luot nay`),
					];
					yield this.makeEvent({
						type: "error",
						error: `nguon nhac gap su co — ${phan.join("; ")}`,
						recoverable: true,
					});
				}
			}

			// ── Chuẩn hoá cặp tool trước khi gửi ──
			// Tầng phòng thủ cuối, độc lập với bước nén: `initialMessages` cắt giữa
			// lượt, `injectMessage` từ ngoài, hay một nhánh `continue` thoát sớm đều
			// để lại cặp lệch mà bước nén không biết. Xem cap-tool.ts.
			{
				const kqCap = chuanHoaCapTool(this.messages.getMessages());
				if (kqCap.daSua) {
					this.vet("agent", LOAI_DIEM_CHAM.AGENT_CHUAN_HOA_CAP, { sua: kqCap.changes });
					this.messages.setMessages(kqCap.messages);
					this.state.messageCount = this.messages.getMessageCount();
					yield this.makeEvent({
						type: "recovery:retry",
						reason: `chuan hoa cap tool: ${kqCap.changes.join("; ")}`,
						attempt: this.state.turnIndex,
					});
				}
			}

			// ── LLM Call ──
			// Provider được phân giải qua ProviderRegistry (xem provider-registry.ts).
			// Có thể tiêm llmCaller để test tất định mà không gọi mạng.
			yield this.makeEvent({
				type: "llm:request_start",
				model: this.model,
				estimatedInputTokens: this.messages.getMessageCount() * 100, // rough estimate
			});

			// The LLM response will be injected via the adapter pattern.
			// For the MVP, we use a pluggable LLM caller interface.
			//
			// Lỗi gọi LLM PHẢI kết thúc bằng reason "error". Bản trước nuốt lỗi và
			// trả về kết quả rỗng, nên endpoint sai vẫn báo "completed" với 0 token —
			// nhìn y hệt một câu trả lời rỗng hợp lệ.
			let llmResult: LLMCallResult;
			try {
				// Vừa nhận vừa phát: mỗi mẩu chữ ra ngoài ngay, không đợi hết câu.
				const luong = this.goiLLM();
				for (;;) {
					const { value, done } = await luong.next();
					if (done) {
						llmResult = value;
						break;
					}
					yield this.makeEvent({
						type: "llm:stream_delta",
						delta: value,
						blockType: "text",
					});
				}
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				this.state.status = "completed";
				const usage = this.tokenCounter.getUsage();
				yield this.makeEvent({ type: "error", error: msg, recoverable: false });
				yield this.makeEvent({ type: "terminal", reason: "error", usage });
				return { reason: "error", usage };
			}

			// Track usage
			if (llmResult.usage) {
				this.tokenCounter.add(llmResult.usage);
				this.tokenCounter.recalculateCost(this.model);
			}

			this.state.usage = this.tokenCounter.getUsage();
			this.state.messageCount = this.messages.getMessageCount();

			// Độ đầy ngữ cảnh THẬT: số token đầu vào provider vừa báo chính là
			// lượng ngữ cảnh đang dùng. Trước đây trường này luôn bằng 0, nên
			// không có tín hiệu nào để biết khi nào cần nén.
			this.state.contextUsage = capNhatDoDay(this.state.contextUsage, llmResult.usage?.inputTokens);
			// Đã xuống dưới ngưỡng thì hạ mức nén về mặc định, để lượt sau không
			// bị cắt gắt hơn mức cần thiết.
			if (!canNen(this.state.contextUsage)) {
				this.mucNenHienTai = 0;
				this.soLanNenVoIch = 0;
			}
			yield this.makeEvent({
				type: "context:usage",
				usedTokens: this.state.contextUsage.usedTokens,
				maxTokens: this.state.contextUsage.maxTokens,
			});

			yield this.makeEvent({
				type: "llm:stream_end",
				usage: this.tokenCounter.getUsage(),
				stopReason: llmResult.stopReason,
			});

			// ── Check for tool calls ──
			let toolCalls = llmResult.toolCalls;

			// Model cục bộ đôi khi nhả tool-call ra dạng CHỮ (khuôn Hermes XML
			// hoặc JSON) thay vì tool call thật. Không cứu thì vòng lặp tưởng
			// model đã trả lời xong và kết thúc "completed" mà chưa làm gì.
			if ((!toolCalls || toolCalls.length === 0) && llmResult.text) {
				const cuu = cuuToolCall(llmResult.text, this.registry.names());

				// ── Cứu nhầm: model đang KỂ LẠI, không phải đang GỌI ──
				//
				// `cuuToolCall` chỉ so khuôn chữ, nó không phân biệt được "tôi gọi
				// FileWrite" (yêu cầu) với "tôi đã gọi FileWrite" (thuật lại). Nay
				// model ĐỌC ĐƯỢC lịch sử tool của chính nó (xem `render-lich-su.ts`),
				// nên nó nhại lại khuôn `[GOI TOOL …] {…}` trong văn xuôi là chuyện
				// bình thường — và mỗi lần nhại là một lần lệnh THẬT chạy lại.
				//
				// Đây là ứng viên trực tiếp cho ground truth "lần 3 GHI ĐÈ bản đúng
				// bằng bản sai": không nudge nào chặn được, vì với vòng lặp thì đó
				// là một lời gọi tool hợp lệ như mọi lời gọi khác.
				//
				// Luật: lời gọi được CỨU mà trùng khít một lời gọi đã có trong lượt
				// làm việc này thì bỏ. Dùng chung `demGoiTrung` nên thừa hưởng luôn
				// ngữ nghĩa "kể từ lần ghi gần nhất" — ghi file thành công xoá bộ đếm
				// của lệnh đọc, nên vòng đọc-sửa-chạy hợp lệ không bị chặn nhầm.
				// Chỉ áp cho đường CỨU: tool call thật thì model chủ ý gọi, và bộ
				// phát hiện lặp ở dưới mới là chỗ xử nó.
				const cuuThat = cuu.toolCalls.filter(
					(tc) => !this.demGoiTrung.has(`${tc.toolName}:${JSON.stringify(tc.toolInput)}`),
				);
				const boDiViNhaiLai = cuu.toolCalls.length - cuuThat.length;
				if (cuu.toolCalls.length > 0) {
					this.vet("agent", LOAI_DIEM_CHAM.AGENT_CUU_TOOL_CALL, {
						khuon: cuu.khuon,
						cuuDuoc: cuu.toolCalls.length,
						boViNhaiLai: boDiViNhaiLai,
						tenTool: cuuThat.map((t) => t.toolName),
					});
				}
				if (boDiViNhaiLai > 0) {
					yield this.makeEvent({
						type: "recovery:retry",
						reason: `bo ${boDiViNhaiLai} loi goi "cuu" duoc vi trung khit lenh da chay — coi la model ke lai, khong phai goi`,
						attempt: this.state.turnIndex,
					});
				}

				if (cuuThat.length > 0) {
					toolCalls = cuuThat;
					llmResult.text = cuu.conLai;
					// Phát sự kiện để việc cứu nằm trong nhật ký kiểm toán.
					// Chữ thô ĐÃ chảy lên giao diện qua llm:stream_delta trước khi ta
					// kịp nhận ra đó là tool-call. Phát lại phần đã làm sạch để giao
					// diện thay thế — nếu không, người dùng thấy nguyên khối JSON.
					yield this.makeEvent({
						type: "llm:text_corrected",
						text: cuu.conLai,
					});
					yield this.makeEvent({
						type: "recovery:retry",
						reason: `tool-call dang chu (khuon ${cuu.khuon}) — da cuu ${cuuThat.length} loi goi`,
						attempt: this.state.turnIndex,
					});
				} else if (boDiViNhaiLai > 0) {
					// Cứu được toàn thứ nhại lại → coi như KHÔNG có tool call. Rơi
					// xuống nhánh dưới là đúng: ở đó bộ bắt vẹt và cổng kiểm chứng
					// mới là thứ nên xử một lượt chỉ toàn kể lể.
					llmResult.text = cuu.conLai;
					yield this.makeEvent({ type: "llm:text_corrected", text: cuu.conLai });
				}
			}

			if (!toolCalls || toolCalls.length === 0) {
				// "Tuyên bố rồi dừng": chưa chạy tool nào cả phiên mà câu cuối lại là
				// lời hứa "sẽ làm" / câu hỏi xin info → KHÔNG cho kết thúc. Tiêm nhắc
				// hành động và quay vòng (chỉ một lần mỗi phiên, maxTurns vẫn chặn trần).
				const vanBanCuoi = llmResult.text ?? "";
				// Bệnh "VẸT": dán lại nguyên văn câu trả lời cũ thay vì xử lý yêu cầu
				// MỚI (đo thật: hỏi Phase 2, model dán đúng từng chữ đoạn tổng kết
				// Phase 1 của lượt trước). So chuỗi chuẩn hoá; trùng → không cho dừng.
				const chuan = (x: string) => x.replace(/\s+/g, " ").trim().slice(0, 400);
				if (
					!this.daNhacVet &&
					this.traLoiTruocDo &&
					vanBanCuoi.length > 80 &&
					chuan(vanBanCuoi) === chuan(this.traLoiTruocDo)
				) {
					this.daNhacVet = true;
					this.vetGuard("tra-loi-vet", 1, 1, "", { chu: vanBanCuoi.slice(0, 400) });
					this.bomNhacGuard(
						"You just repeated your PREVIOUS answer word-for-word. That answer was about earlier work and does NOT address the CURRENT request. Re-read the latest user message (and any attached file content above), then do THAT work now — with tools if needed. Do not repeat old text again.",
					);
					yield this.makeEvent({
						type: "recovery:retry",
						reason: "tra loi vet (lap nguyen van cau cu) — ep xu ly yeu cau moi",
						attempt: this.state.turnIndex,
					});
					continue;
				}
				// Model TỰ KHAI chưa xong (done=false, schema ép) → KHÔNG cho dừng.
				// Tin cậy hơn dò mẫu câu; giới hạn 3 nhịp để không thành vòng vô hạn.
				if (llmResult.chuaXong && this.soLanEpTiepTuc < 3) {
					this.soLanEpTiepTuc++;
					// Lì tới nhịp 2 thì thôi khuyên — thu hẹp lựa chọn còn "làm gì đó".
					const mnTiep = this.soLanEpTiepTuc >= 2 ? this.thuHepTool(MAT_NA_TIEN_TRIEN) : "";
					this.vetGuard("tu-khai-chua-xong", this.soLanEpTiepTuc, 3, mnTiep);
					if (vanBanCuoi) this.messages.appendAssistant(vanBanCuoi);
					this.bomNhacGuard(
						"You declared done=false — the request is NOT finished. Do NOT stop, do NOT promise, do NOT ask the user to wait. Call the next tool NOW and keep working until you can honestly respond with done=true.",
					);
					yield this.makeEvent({
						type: "recovery:retry",
						reason: `model tu khai chua xong (done=false) — ep lam tiep (${this.soLanEpTiepTuc}/3)${mnTiep}`,
						attempt: this.state.turnIndex,
					});
					continue;
				}
				// Điều kiện theo TIẾN TRIỂN thật (chưa GHI file nào) chứ không phải
				// "chưa chạy tool nào" — đo thật sau reload: model đọc 2-3 tool rồi
				// mới tuyên bố "bây giờ tôi sẽ..." và dừng, detector 0-tool bó tay.
				// Nhắc tối đa 2 lần/phiên; nhắc xong THU HẸP enum để lượt sau chỉ
				// còn viết-hoặc-chốt (đòn đã chứng minh kéo được model vào việc).
				// Điều kiện là "CHƯA CÓ TIẾN TRIỂN GẦN ĐÂY", không phải "chưa ghi file
				// nào cả phiên". Bản trước dùng `fileDaSua.size === 0`, nên chỉ cần
				// ghi được MỘT file ở lượt 3 là bộ phát hiện tắt hẳn — model kể lể và
				// hỏi suông thoải mái từ lượt 4 tới hết phiên mà không gì bắt được.
				// Đúng giai đoạn dài nhất của một việc nhiều bước.
				// Chưa ghi lần nào thì luôn đủ điều kiện (ca lượt đầu, giữ như bản cũ);
				// đã ghi rồi thì phải im ắng vài lượt mới tính là mất tiến triển.
				const chuaCoTienTrien =
					this.luotGhiCuoi === 0 || this.state.turnIndex - this.luotGhiCuoi >= 3;
				if (this.soLanNhacHanhDong < 4 && chuaCoTienTrien && MAU_TUYEN_BO.test(vanBanCuoi)) {
					this.soLanNhacHanhDong++;
					const mnHanhDong = this.thuHepTool(MAT_NA_TIEN_TRIEN);
					this.vetGuard("tuyen-bo-roi-dung", this.soLanNhacHanhDong, 4, mnHanhDong, {
						chu: vanBanCuoi.slice(0, 400),
					});
					this.messages.appendAssistant(vanBanCuoi);
					this.bomNhacGuard(NHAC_HANH_DONG);
					yield this.makeEvent({
						type: "recovery:retry",
						reason: `tuyen bo ma khong lam — da nhac hanh dong ngay${mnHanhDong}`,
						attempt: this.state.turnIndex,
					});
					continue;
				}
				// ── CỔNG: sửa file mà chưa kiểm chứng lần nào ──
				//
				// Ba bộ bắt bệnh phía trên đều soi CHỮ model viết (hứa hẹn, lặp
				// nguyên văn, tự khai done=false). Model viết một câu khẳng định
				// tự tin — "Đã tạo thue.js với hàm tinhThue" — thì không mẫu nào
				// khớp, và nó ra khỏi vòng lặp với việc còn dở.
				//
				// Cổng này soi VIỆC chứ không soi chữ, và dùng tín hiệu KHÁCH QUAN
				// duy nhất có được: đã sửa file mà chưa từng chạy một lệnh kiểm
				// chứng nào. Đo thật ba vòng trước khi thêm cổng: 3/3 lần agent
				// tạo file nguồn rồi dừng, không viết test, không chạy gì.
				//
				// Chỉ chặn khi CHƯA CHẠY LẦN NÀO. Chạy rồi mà hỏng thì model đã có
				// kết luận thật để báo cáo — ép tiếp là đẩy nó vào vòng sửa mù.
				if (
					this.laLenhKiemTra !== undefined &&
					this.fileDaSua.size > 0 &&
					!this.daChayKiemTra &&
					this.soLanEpKiemTra < 2
				) {
					this.soLanEpKiemTra++;
					// Đòn bẩy CƠ HỌC cho ý "sửa xong phải kiểm chứng" — trước đây ý này
					// được phát biểu ở 6 chỗ trên 3 tầng mà không có gì ép nổi. Nhịp 1
					// còn cho viết (có thể còn thiếu test); nhịp 2 chỉ còn Bash.
					const mnKiem = this.thuHepTool(
						this.soLanEpKiemTra >= 2 ? MAT_NA_CHAY : MAT_NA_TIEN_TRIEN,
					);
					this.vetGuard("cong-kiem-chung", this.soLanEpKiemTra, 2, mnKiem, {
						fileDaSua: [...this.fileDaSua],
					});
					if (vanBanCuoi) this.messages.appendAssistant(vanBanCuoi);
					this.bomNhacGuard(
						`You changed ${this.fileDaSua.size} file(s) but have not run ANY check — ` +
							`no test, no build, no typecheck. Nothing you just said is verified.\n\n` +
							`Do NOT stop here. If the task asked for tests, write them now. Then run the ` +
							`project's check command with Bash and report its REAL output. ` +
							`If the check fails, say so with the output — honest failure beats an ` +
							`unverified "done".`,
					);
					yield this.makeEvent({
						type: "recovery:retry",
						reason: `sua ${this.fileDaSua.size} file ma chua kiem chung — ep chay kiem tra (${this.soLanEpKiemTra}/2)${mnKiem}`,
						attempt: this.state.turnIndex,
					});
					continue;
				}

				// Terminal: LLM did not request any tools
				if (llmResult.text) {
					// Model cục bộ đôi khi nhả TRỌN câu trả lời cuối dưới dạng JSON
					// content-block ([{"type":"text","result":"..."}]) — không có
					// tool-call nên recovery bỏ qua. Gỡ vỏ để khỏi in nguyên khối JSON.
					const sach = boBocKhoiJson(llmResult.text);
					if (sach !== llmResult.text) {
						llmResult.text = sach;
						yield this.makeEvent({ type: "llm:text_corrected", text: sach });
					}
					this.messages.appendAssistant(llmResult.text);
					yield this.makeEvent({
						type: "message:assistant",
						content: [{ type: "text", text: llmResult.text }],
					});
				}

				// Output gate
				await this.controlPlane.intercept("output_ready", {
					text: llmResult.text ?? "",
					contentBlocks: llmResult.text ? [{ type: "text", text: llmResult.text }] : [],
					usage: this.tokenCounter.getUsage(),
					turnIndex: this.state.turnIndex,
					toolCallCount: 0,
					model: this.model,
				});

				this.state.status = "completed";
				const finalUsage = this.tokenCounter.getUsage();
				yield this.makeEvent({ type: "terminal", reason: "completed", usage: finalUsage });
				return { reason: "completed", usage: finalUsage };
			}

			// ── Append assistant message with tool_use blocks ──
			const assistantContent: ContentBlock[] = [];
			if (llmResult.text) {
				assistantContent.push({ type: "text", text: llmResult.text });
			}
			for (const tc of toolCalls) {
				assistantContent.push({
					type: "tool_use",
					id: tc.toolUseId,
					name: tc.toolName,
					input: tc.toolInput as Record<string, unknown>,
				});
			}
			this.messages.appendAssistant(assistantContent);

			// ── Process each tool call ──
			const executor = new ToolExecutor(this.registry, {
				sessionId: this.sessionId,
				agentId: this.agentId,
				cwd: process.cwd(),
				signal: this.abortController.signal,
				processSandbox: this.processSandbox,
			});

			const permittedCalls: ToolCall[] = [];

			for (const tc of toolCalls) {
				// ── Ngân sách trinh sát ────────────────────────────────
				// Đo thật khi lái phiên: model TÌM THẤY thứ nó cần rồi vẫn tiếp tục
				// Grep biến thể — 12 tool toàn đọc, 0 file được viết. Sau 8 tool mà
				// chưa ghi gì, chặn lệnh đọc kế tiếp và ép chuyển sang viết (1 lần).
				if (this.soDocTuKhiViet >= 6 && tc.toolName !== "FileWrite" && tc.toolName !== "FileEdit") {
					this.soDocTuKhiViet = 0; // tái kích sau mỗi 6 lệnh đọc chay
					const mnTrinhSat = this.thuHepTool(MAT_NA_VIET);
					this.vetGuard("ngan-sach-trinh-sat", 6, 6, mnTrinhSat, { toolBiChan: tc.toolName });
					// tool_result giữ NGẮN và chỉ nêu SỰ KIỆN. Bản trước nhét cả bài
					// răn vào đây, mà kết quả này mượn id của một tool nằm trong
					// `TOOL_NEN_DUOC` nên nén mức 2 cắt còn 80 ký tự — lời cấm đứt
					// giữa chừng. Phần răn đi kênh nhắc, nơi nó không bị nén như một
					// kết quả tool.
					yield* this.chanLoiGoi(
						tc.toolUseId,
						`${tc.toolName} was blocked: exploration budget exhausted.`,
						`You keep exploring without producing anything new. You know enough. STOP searching — your NEXT call must be FileWrite or FileEdit that implements the task. If something is genuinely unknown, make your best reasonable choice and note it in a comment.`,
					);
					yield this.makeEvent({
						type: "recovery:retry",
						reason: `chi trinh sat khong viet — da ep chuyen sang viet${mnTrinhSat}`,
						attempt: this.state.turnIndex,
					});
					continue;
				}

				// ── Phát hiện loop / quẩn tại chỗ ──────────────────────
				// Nguyên tắc: LẶP MÀ KHÔNG CÓ TIẾN TRIỂN mới là loop. Đếm CỘNG DỒN
				// mọi tool (kể cả Bash — từng miễn trừ và model chui đúng lỗ đó:
				// ls -la / find biến thể hàng chục lần). Bộ đếm được XOÁ mỗi khi
				// FileWrite/FileEdit thành công — có sửa file là có tiến triển, nên
				// vòng build/test lặp xen kẽ edit không bao giờ bị chặn nhầm.
				// Nudge ở lần 3, cắt hẳn ở lần 5.
				// Đếm gọi LIÊN TIẾP cùng một tool. Chỉ ĐẾM ở đây; việc chặn nằm sau
				// bộ phát hiện lặp-y-hệt bên dưới, để không cắt mất đường leo thang
				// của nó (nudge lần 3 → cắt hẳn lần 5).
				if (tc.toolName === this.toolLienTiepTruoc) {
					this.soToolLienTiep++;
				} else {
					this.toolLienTiepTruoc = tc.toolName;
					this.soToolLienTiep = 1;
				}

				// MIỄN TRỪ lệnh kiểm chứng khỏi bộ đếm (tool+tham số).
				//
				// Chạy lại ĐÚNG một lệnh test sau mỗi lần sửa là vòng làm việc hợp
				// lệ, không phải quẩn — và lệnh đó dĩ nhiên giống hệt nhau từng chữ.
				// Bản trước chặn nó ở lần 3 với thông điệp "STOP repeating searches"
				// (sai hẳn loại việc), rồi CẮT PHIÊN ở lần 5 với `reason: "loop"`.
				// Bộ đếm gọi-liên-tiếp bên dưới vẫn phủ trường hợp chạy test mãi mà
				// không sửa gì, nên miễn trừ ở đây không mở lỗ hổng nào.
				const laLenhKiemChung =
					tc.toolName === "Bash" &&
					this.laLenhKiemTra !== undefined &&
					typeof (tc.toolInput as Record<string, unknown>).command === "string" &&
					this.laLenhKiemTra((tc.toolInput as Record<string, unknown>).command as string);

				const chuKy = `${tc.toolName}:${JSON.stringify(tc.toolInput)}`;
				const soLan = laLenhKiemChung ? 0 : (this.demGoiTrung.get(chuKy) ?? 0) + 1;
				if (!laLenhKiemChung) this.demGoiTrung.set(chuKy, soLan);
				if (soLan >= 3) {
					// Mặt nạ "phải tiến triển" chứ không phải "chỉ được viết": bộ đếm
					// này khoá theo (tool + THAM SỐ), nên thứ bị chặn là ĐÚNG lời gọi
					// đó — ghi một file KHÁC vẫn là tiến triển hợp lệ và phải còn
					// đường. Bản cũ ép về {FileWrite,FileEdit} kể cả khi model đang
					// kẹt ở chính FileWrite: đo thật, nó ghi thue.js ba lần, bị chặn,
					// rồi ghi tiếp tới khi phiên bị cắt vì loop.
					const mnLoop = this.thuHepTool(MAT_NA_TIEN_TRIEN);
					// Vặn đúng tầng sinh ra cái lặp, không chỉ tiêm thêm chữ.
					this.nacRepeatPenalty++;
					this.vetGuard("lap-y-het", soLan, 5, mnLoop, {
						toolBiChan: tc.toolName,
						nacRepeatPenalty: this.nacRepeatPenalty,
						seCatPhien: soLan >= 5,
					});
					yield* this.chanLoiGoi(
						tc.toolUseId,
						`${tc.toolName} was blocked: identical call already made ${soLan} times.`,
						`Loop detected: you already made this exact ${tc.toolName} call ${soLan} times in this session and it did not help. STOP repeating it. You already have enough from earlier results — produce the requested output NOW (e.g. write the file), or state the ONE specific thing you are missing.`,
					);
					yield this.makeEvent({
						type: "recovery:retry",
						reason: `loop: ${tc.toolName} lap ${soLan} lan (cong don)${mnLoop}`,
						attempt: this.state.turnIndex,
					});
					if (soLan >= 5) {
						const tom = await this.tomTatHaCanh("stuck in a loop");
						if (tom) {
							this.messages.appendAssistant(tom);
							yield this.makeEvent({ type: "llm:stream_delta", delta: tom, blockType: "text" });
						}
						this.state.status = "completed";
						const usage = this.tokenCounter.getUsage();
						yield this.makeEvent({ type: "terminal", reason: "loop", usage });
						return { reason: "loop", usage };
					}
					continue; // bỏ qua thực thi lệnh lặp
				}

				// ── Cùng một TOOL gọi liên tiếp, tham số đổi vặt ──
				// Bộ đếm (tool+input) ở trên bỏ lọt kiểu hỏng phổ biến nhất của
				// model nhỏ: gọi mãi một tool với tham số nhích một chút. Đo thật
				// hai lần trong cùng một buổi — 6 lệnh Grep gần trùng trả về đúng
				// một kết quả, và 33 lệnh TodoWrite liên tiếp không kèm việc nào.
				// Mỗi lời gọi là một lượt sinh của model 30B: vài giây người dùng
				// ngồi nhìn màn hình không tiến triển.
				//
				// Đếm theo TÊN tool, đặt lại khi có tool khác chen vào — nên vòng
				// đọc-sửa-chạy xen kẽ bình thường không bao giờ bị chặn nhầm.
				if (this.soToolLienTiep >= NHAC_LIEN_TIEP) {
					const n = this.soToolLienTiep;

					// ── Trần cứng ──
					// Bản trước chỉ CHẶN, không bao giờ dừng. "Loop biến thể" — đổi
					// tham số một chút mỗi lần — né được bộ đếm (tool+tham số) ở trên
					// và nghiền đủ 50 lượt: đo thật, guard nổ ở lần 4, 6, 7, 8, 9 rồi
					// hết lượt. Chặn mà không có trần thì chỉ là đốt token chậm hơn.
					if (n >= CAT_LIEN_TIEP) {
						const tom = await this.tomTatHaCanh("stuck calling the same tool");
						if (tom) {
							this.messages.appendAssistant(tom);
							yield this.makeEvent({ type: "llm:stream_delta", delta: tom, blockType: "text" });
						}
						this.state.status = "completed";
						const usage = this.tokenCounter.getUsage();
						yield this.makeEvent({ type: "terminal", reason: "loop", usage });
						return { reason: "loop", usage };
					}

					// Ở đây thứ hỏng là CHÍNH CÁI TOOL đó gọi mãi, nên mặt nạ phải loại
					// nó ra — và câu nhắc phải nói đúng tập còn lại. Ghi mãi không chạy
					// thì bước kế tiếp là CHẠY, không phải ghi thêm.
					const ghi = LA_TOOL_GHI.has(tc.toolName);
					const mnLienTiep = this.thuHepTool(ghi ? MAT_NA_CHAY : MAT_NA_TIEN_TRIEN);
					this.nacRepeatPenalty++;
					this.vetGuard("goi-lien-tiep", n, CAT_LIEN_TIEP, mnLienTiep, {
						toolBiChan: tc.toolName,
						nacRepeatPenalty: this.nacRepeatPenalty,
					});

					// LEO THANG, không nổ phẳng. Bản trước lặp lại y nguyên bài răn ở
					// mỗi lần từ 4 trở đi; model đã phớt nó ở lần 4 thì lần 7 cũng thế,
					// mà mỗi lần lặp lại là một khối chữ nữa chiếm chỗ trong cửa sổ.
					// Chỉ nói đủ lời ở hai mốc, và mốc thứ hai báo trước là sẽ dừng.
					const ran =
						n >= CANH_CUOI_LIEN_TIEP
							? `LAST WARNING: ${tc.toolName} has been your only move for ${n} calls in a row. ` +
								`The session will STOP if this continues. Either do something genuinely ` +
								`different now, or reply with what you have and what is blocking you.`
							: ghi
								? `You have written files ${n} times in a row without running anything. ` +
									`Writing again will not help. Run the project's check command with Bash now ` +
									`and report its real output — that is the only way to know whether what you ` +
									`wrote works.`
								: `You have called ${tc.toolName} ${n} times in a row with nothing else in ` +
									`between, and it is not moving the task forward. STOP calling ` +
									`${tc.toolName}. Your next call must be a DIFFERENT tool that changes ` +
									`something (FileWrite/FileEdit/Bash), or reply with what you have.`;
					const noiRan = n === NHAC_LIEN_TIEP || n >= CANH_CUOI_LIEN_TIEP;

					yield* this.chanLoiGoi(
						tc.toolUseId,
						`${tc.toolName} was blocked: called ${n} times in a row.`,
						noiRan ? ran : "",
					);
					yield this.makeEvent({
						type: "recovery:retry",
						reason: `${tc.toolName} goi lien tiep ${n} lan — da chan${mnLienTiep}`,
						attempt: this.state.turnIndex,
					});
					continue;
				}

				yield this.makeEvent({
					type: "tool:requested",
					toolName: tc.toolName,
					toolInput: tc.toolInput,
					toolUseId: tc.toolUseId,
				});

				// Permission check via Control Plane
				const mocXinQuyen = Date.now();
				const tool = this.registry.get(tc.toolName);
				const decision: ToolDecision = await this.controlPlane.intercept(
					"tool_request",
					{
						toolName: tc.toolName,
						toolInput: tc.toolInput as Record<string, unknown>,
						toolUseId: tc.toolUseId,
						turnIndex: this.state.turnIndex,
						isReadOnly: tool?.metadata.isReadOnly ?? false,
						isDestructive: tool?.metadata.isDestructive ?? false,
					},
					{ timeoutMs: this.toolRequestTimeoutMs },
				);

				this.vet("agent", LOAI_DIEM_CHAM.AGENT_QUYEN, {
					tool: tc.toolName,
					quyetDinh: decision.behavior,
					nguon: decision.source,
					lyDo: decision.reason,
					msChoQuyetDinh: Date.now() - mocXinQuyen,
				});

				if (decision.behavior === "deny") {
					// ── HOÀN LẠI bộ đếm ──
					// Lời gọi này KHÔNG chạy, và lý do là NGƯỜI DÙNG bấm từ chối. Đếm
					// nó vào bộ phát hiện lặp thì chuỗi tự nhiên "người dùng từ chối →
					// model thử cách khác → lại bị từ chối" tích luỹ thẳng tới ngưỡng
					// cắt phiên `reason: "loop"` — đổ lỗi cho model về một quyết định
					// của con người. Đếm ở trên chạy trước cửa quyền nên phải lùi lại
					// ở đây; đặt bộ đếm sau cửa quyền thì mất đường leo thang của
					// chính guard (chặn ở lần 3 sẽ không bao giờ tới được lần 5).
					if (!laLenhKiemChung) {
						const cu = this.demGoiTrung.get(chuKy) ?? 0;
						if (cu <= 1) this.demGoiTrung.delete(chuKy);
						else this.demGoiTrung.set(chuKy, cu - 1);
					}
					this.soToolLienTiep = Math.max(0, this.soToolLienTiep - 1);

					yield this.makeEvent({
						type: "permission:denied",
						toolName: tc.toolName,
						toolUseId: tc.toolUseId,
						reason: decision.reason,
						source: decision.source,
					});
					// Báo cho LLM RÕ ràng: hành động KHÔNG chạy. Model yếu hay bỏ qua
					// "denied" rồi khai đã xong — nên nói thẳng file không được tạo.
					const lyDoTuChoi = `Permission denied by the user: ${decision.reason}. The action did NOT run — nothing was written, created, or changed on disk. Do NOT claim it succeeded; tell the user it was denied.`;
					this.messages.appendToolResult(tc.toolUseId, lyDoTuChoi, true);
					yield this.makeEvent({
						type: "message:tool_result",
						toolUseId: tc.toolUseId,
						content: lyDoTuChoi,
						isError: true,
					});
				} else {
					yield this.makeEvent({
						type: "permission:allowed",
						toolName: tc.toolName,
						toolUseId: tc.toolUseId,
						source: decision.source,
					});
					permittedCalls.push(tc);
				}
			}

			// ── Execute permitted tools ──
			if (permittedCalls.length > 0) {
				const results = await executor.execute(permittedCalls);

				for (const result of results) {
					// Câu kiểm cú pháp gắn thêm vào kết quả của lệnh GHI. Dựng TRƯỚC
					// khi phát `tool:completed` để người dùng và model thấy cùng một
					// thứ — hai bên nhìn hai bản khác nhau là cách chắc chắn để gỡ rối
					// sai chỗ về sau.
					let kemTheo = "";
					if (result.isError) {
						this.vet(
							"tool",
							LOAI_DIEM_CHAM.TOOL_HONG,
							{
								tool: permittedCalls.find((c) => c.toolUseId === result.toolUseId)?.toolName,
								ms: result.durationMs,
							},
							{ "ket-qua.txt": String(result.result) },
						);
						yield this.makeEvent({
							type: "tool:failed",
							toolUseId: result.toolUseId,
							error: String(result.result),
							durationMs: result.durationMs,
						});
					} else {
						// Sửa file thành công = có tiến triển → xoá bộ đếm loop, để
						// build/test lặp SAU MỖI edit luôn hợp lệ (xem khối detect).
						const goiGoc = permittedCalls.find((c) => c.toolUseId === result.toolUseId);
						if (goiGoc?.toolName === "FileWrite" || goiGoc?.toolName === "FileEdit") {
							// Xoá bộ đếm CHỈ cho lệnh ĐỌC — giữ nguyên đếm của lệnh GHI.
							// Đo thật: model ghi cùng một file y hệt 15 lần; nếu ghi nào
							// cũng xoá sạch đếm thì ghi-lặp vô hình với loop-detect.
							for (const k of [...this.demGoiTrung.keys()])
								if (!k.startsWith("FileWrite:") && !k.startsWith("FileEdit:"))
									this.demGoiTrung.delete(k);
							this.soDocTuKhiViet = 0; // viết = tiến triển, cấp lại ngân sách đọc
							this.nacRepeatPenalty = 0; // hết lặp thì trả sampler về nền
							this.luotGhiCuoi = this.state.turnIndex;
							const vao = goiGoc.toolInput as Record<string, unknown>;
							const p = vao.path ?? vao.file ?? vao.file_path ?? vao.filename;
							if (typeof p === "string") {
								this.fileDaSua.add(p);
								// Trục "làm ĐÚNG hay SAI" — thứ mà mọi cơ chế ghì khác bỏ
								// trống: chúng đo nhịp điệu của agent, không nhìn thứ nó vừa
								// ghi ra. Vài chục mili-giây, không bao giờ ném.
								kemTheo = cauKemKetQua(
									await kiemCuPhap(isAbsolute(p) ? p : resolve(process.cwd(), p)),
								);
							}
						} else {
							this.soDocTuKhiViet++;
						}
						this.vet(
							"tool",
							LOAI_DIEM_CHAM.TOOL_XONG,
							{ tool: goiGoc?.toolName, ms: result.durationMs, kiemCuPhap: kemTheo.trim() || null },
							{
								"vao.json": JSON.stringify(goiGoc?.toolInput ?? {}, null, 2),
								"ket-qua.txt":
									typeof result.result === "string"
										? result.result
										: JSON.stringify(result.result, null, 2),
							},
						);
						yield this.makeEvent({
							type: "tool:completed",
							toolUseId: result.toolUseId,
							result:
								kemTheo === "" || typeof result.result !== "string"
									? result.result
									: `${result.result}${kemTheo}`,
							durationMs: result.durationMs,
						});
						// Lệnh kiểm chứng đã chạy xong — dù đạt hay hỏng, model đã có
						// kết luận thật để báo cáo. Cổng chặn bên dưới chỉ quan tâm
						// "có chạy hay không", còn đạt/hỏng thì phần cảnh báo ở CLI lo.
						if (goiGoc?.toolName === "Bash" && this.laLenhKiemTra) {
							const lenh = (goiGoc.toolInput as Record<string, unknown>).command;
							if (typeof lenh === "string" && this.laLenhKiemTra(lenh)) {
								this.daChayKiemTra = true;
							}
						}
						// Tín hiệu kích hoạt rule/skill có điều kiện. Ghi cả lệnh ĐỌC:
						// model mở `src/api/user.ts` ra xem là đã cần quy ước tầng API,
						// không phải đợi tới lúc nó ghi.
						this.ghiNhanCham(goiGoc);
					}

					this.soToolThucThi++;
					const content =
						(typeof result.result === "string" ? result.result : JSON.stringify(result.result)) +
						kemTheo;
					this.messages.appendToolResult(result.toolUseId, content, result.isError);

					yield this.makeEvent({
						type: "message:tool_result",
						toolUseId: result.toolUseId,
						content,
						isError: result.isError,
					});
				}
			}

			// ── Xả nhắc guard của lượt ──
			// Đặt SAU dãy tool_result: chèn vào giữa sẽ tách cặp tool. Một tin
			// nhắn cho cả lượt, đúng khung `<system-reminder>` như mọi nhắc khác.
			{
				const tin = nhacGuard(this.nhacGuardChoLuot);
				this.nhacGuardChoLuot = [];
				if (tin) {
					this.messages.append(tin);
					this.state.messageCount = this.messages.getMessageCount();
					this.vet(
						"agent",
						LOAI_DIEM_CHAM.AGENT_NHAC,
						{ nguon: "guard" },
						{
							"nhac.txt": tin.content as string,
						},
					);
					yield this.makeEvent({
						type: "context:reminder",
						loai: ["guard"],
						bytes: Buffer.byteLength(tin.content as string, "utf-8"),
					});
				}
			}

			// ── Budget check ──
			if (maxBudget !== undefined && this.tokenCounter.getUsage().totalCost >= maxBudget) {
				this.state.status = "completed";
				const usage = this.tokenCounter.getUsage();
				yield this.makeEvent({ type: "terminal", reason: "budget_exceeded", usage });
				return { reason: "budget_exceeded", usage };
			}

			yield this.makeEvent({
				type: "turn:end",
				turnIndex: this.state.turnIndex,
				stopReason: "continue",
			});
		}

		// Max turns reached — chốt hạ cánh rồi mới dừng, đừng bỏ người dùng chỏng chơ.
		const tom = await this.tomTatHaCanh("turn limit reached");
		if (tom) {
			this.messages.appendAssistant(tom);
			yield this.makeEvent({ type: "llm:stream_delta", delta: tom, blockType: "text" });
		}
		this.state.status = "completed";
		const usage = this.tokenCounter.getUsage();
		yield this.makeEvent({ type: "terminal", reason: "max_turns", usage });
		return { reason: "max_turns", usage };
	}

	// ─── LLM Caller (pluggable) ──────────────────────────────────

	/** Override this for real LLM integration or mock in tests. */
	protected llmCaller:
		| ((messages: ReadonlyArray<Message>, model: string) => Promise<LLMCallResult>)
		| null = null;

	setLLMCaller(
		caller: (messages: ReadonlyArray<Message>, model: string) => Promise<LLMCallResult>,
	): void {
		this.llmCaller = caller;
	}

	/**
	 * Gọi LLM, vừa chảy chữ ra vừa trả kết quả cuối.
	 *
	 * Là generator chứ không phải Promise: vòng lặp chính cần PHÁT được sự kiện
	 * `llm:stream_delta` ngay khi từng mẩu chữ tới. Kiểu sự kiện đó có trong
	 * events.ts từ lâu nhưng chưa ai phát — nên người dùng ngồi im lặng chờ hết
	 * câu trả lời. Với model cục bộ 40-60 tok/s thì một câu 500 token là 10 giây
	 * không thấy gì, rất giống lúc treo máy.
	 *
	 * @yields từng mẩu chữ
	 * @returns kết quả đầy đủ của lượt gọi
	 */
	private async *goiLLM(): AsyncGenerator<string, LLMCallResult, void> {
		// Tiêu thụ mặt nạ NGAY ĐẦU, trước mọi nhánh: cả hai đường thật đều nhận
		// được nó, và cờ được xoá dù đi đường nào — kể cả đường mock. Bản cũ chỉ
		// đọc/xoá ở nhánh có ràng buộc, nên cấu hình stream vừa mất đòn bẩy vừa
		// giữ cờ bẩn từ lượt này sang lượt khác.
		const matNa = this.layMatNa();

		// llmCaller do test/mock tiêm vào: không có gì để chảy, trả thẳng.
		if (this.llmCaller) {
			return await this.llmCaller(this.messages.getMessages(), this.model);
		}

		// KHÔNG bắt lỗi ở đây — vòng lặp chính phải thấy để kết thúc reason "error".
		if (process.env.AGENTWEAVE_DEBUG) {
			console.error(`[AgentWeave:debug] goi LLM that voi model: ${this.model}`);
		}
		// Giao thức có ràng buộc: chỉ khi bật cờ và không có ảnh (đường này phẳng
		// ảnh thành chữ). Xem chayCoRangBuoc.
		if (this.structuredProtocol && this.laModelCucBo() && !this.coAnhTrongLichSu()) {
			return yield* this.chayCoRangBuoc(matNa);
		}
		return yield* this.chayStream(matNa);
	}

	private async *chayStream(
		matNa: ReadonlySet<string> | null,
	): AsyncGenerator<string, LLMCallResult, void> {
		// Mốc thời gian đặt TRƯỚC mọi thứ có thể ném, để lượt gọi hỏng cũng có số
		// đo. Hỏng ở giây thứ 0 khác hẳn hỏng sau 90 giây chờ.
		const batDau = Date.now();

		// Dynamic import — avoids crash if provider SDK not installed
		const { streamText, tool } = await import("ai");

		// Auto-detect provider from model name.
		//
		// Bọc vết tích quanh đây vì bước này ném TRƯỚC mọi điểm chạm khác: model
		// không phân giải được provider thì lượt chết mà không để lại một dòng
		// `llm:*` nào — đúng loại sự cố cần soi nhất lại là loại không ghi được.
		let llmModel: Awaited<ReturnType<typeof this.resolveModel>>;
		try {
			llmModel = await this.resolveModel();
		} catch (e) {
			this.vet("llm", LOAI_DIEM_CHAM.LLM_HONG, {
				duong: "stream",
				giaiDoan: "phan-giai-provider",
				model: this.model,
				ms: Date.now() - batDau,
				loi: e instanceof Error ? e.message : String(e),
			});
			throw e;
		}

		// Mặt nạ ở đường này = LỌC DANH SÁCH TOOL gửi cho model. Không mạnh bằng
		// enum của format schema (model vẫn có thể nhả tên tool dưới dạng chữ và
		// bị `cuuToolCall` nhặt lên), nhưng đó là đòn bẩy mạnh nhất mà giao thức
		// tool-call thường có — và trước đây đường này KHÔNG có đòn bẩy nào.
		const tools: Record<string, unknown> = {};
		for (const toolDef of this.registry.getAll()) {
			if (matNa !== null && !matNa.has(toolDef.name)) continue;
			tools[toolDef.name] = tool({
				description: toolDef.description,
				parameters: toolDef.parameters,
			});
		}

		const system = this.getSystemPrompt();

		// Lỗi trong lúc chảy: KHÔNG được nuốt. Khi request hỏng (vd model không
		// hỗ trợ tool, gửi kèm ảnh sai định dạng), `textStream` kết thúc rỗng mà
		// KHÔNG ném, còn `finishReason`/`usage` thì không bao giờ resolve — nên
		// `await Promise.all([...])` bên dưới treo vĩnh viễn. Đã đo: request trả
		// 400 trong 0,14s nhưng agent treo 200s+ không một dấu hiệu. Bắt qua
		// onError rồi ném ngay sau vòng chảy, biến cái treo im thành lỗi rõ.
		// ── ĐIỂM CHẠM: bytes THẬT gửi cho model, đường stream ──
		// Đường này đi qua AI SDK nên payload cuối cùng do SDK dựng; thứ ghi ở đây
		// là ĐẦU VÀO của SDK — vẫn đủ để đối chiếu, và là chỗ gần nhất còn thấy
		// được hình dạng CoreMessage trước khi nó thành JSON trên dây.
		const tinNhanSdk = mapTinNhanChoSdk(this.messages.getMessages());
		this.vet(
			"llm",
			LOAI_DIEM_CHAM.LLM_GUI,
			{
				duong: "stream",
				model: this.model,
				soTinNhan: tinNhanSdk.length,
				// Cùng đơn vị với đường có ràng buộc để hai đường so được với nhau:
				// system prompt cộng toàn bộ lịch sử đã tuần tự hoá.
				tongKyTu: system.length + JSON.stringify(tinNhanSdk).length,
				toolChoPhep: Object.keys(tools),
				coMatNa: matNa !== null,
				// `num_ctx` KHÔNG đi được đường này (endpoint tương thích OpenAI).
				thamSoSinh: {
					temperature: this.thamSoSinh?.temperature,
					topP: this.thamSoSinh?.topP,
					seed: this.thamSoSinh?.seed,
					repeatPenalty: this.repeatPenaltyHieuLuc(),
				},
			},
			{
				"gui-system.txt": system,
				"gui-messages.json": JSON.stringify(tinNhanSdk, null, 2),
			},
		);

		let loiStream: unknown = null;
		const result = streamText({
			model: llmModel,
			// Trước đây systemPrompt được lưu nhưng không bao giờ gửi đi: mọi thứ
			// đặt qua setSystemPromptSection() (kể cả chỉ mục skill) đều vô hình
			// với model mà không có dấu hiệu nào báo sai.
			system: system.trim() === "" ? undefined : system,
			// Dựng ảnh thành "parts" đa phương thức cho tin nhắn người dùng; phần
			// còn lại giữ nguyên cách cũ. Kiểu của AI SDK cho content khá lỏng
			// (chuỗi hoặc mảng part), nên ép qua đây là an toàn.
			messages: tinNhanSdk as Parameters<typeof streamText>[0]["messages"],
			tools: tools as Parameters<typeof streamText>[0]["tools"],
			// Tham số sinh. `num_ctx` KHÔNG có đường đi ở đây: endpoint tương thích
			// OpenAI của Ollama không nhận nó, cửa sổ do server quyết
			// (`OLLAMA_CONTEXT_LENGTH`). Đó là một lý do nữa để đường có ràng buộc
			// là mặc định — chỉ nó gửi được `num_ctx`.
			temperature: this.thamSoSinh?.temperature,
			topP: this.thamSoSinh?.topP,
			seed: this.thamSoSinh?.seed,
			frequencyPenalty: (() => {
				const rp = this.repeatPenaltyHieuLuc();
				return rp === undefined ? undefined : Number((rp - 1).toFixed(3));
			})(),
			maxSteps: 1,
			abortSignal: this.abortController?.signal,
			onError: (ev) => {
				loiStream = (ev as { error?: unknown })?.error ?? ev;
			},
		});

		// Chảy chữ ra ngoài ngay khi tới.
		let text = "";
		for await (const mau of result.textStream) {
			text += mau;
			yield mau;
		}

		if (loiStream !== null) {
			this.vet("llm", LOAI_DIEM_CHAM.LLM_HONG, {
				duong: "stream",
				ms: Date.now() - batDau,
				loi: String((loiStream as { message?: string })?.message ?? loiStream),
			});
			const g = loiStream as { message?: string };
			throw loiStream instanceof Error
				? loiStream
				: new Error(g?.message ? String(g.message) : String(loiStream));
		}

		// Các trường này chỉ chốt được SAU khi luồng chảy hết.
		const [toolCallsTho, usage, finishReason] = await Promise.all([
			result.toolCalls,
			result.usage,
			result.finishReason,
		]);

		if (process.env.AGENTWEAVE_DEBUG) {
			console.error(`[AgentWeave:debug] text=${text.slice(0, 100)}`);
			console.error(`[AgentWeave:debug] toolCalls=${JSON.stringify(toolCallsTho ?? [])}`);
			console.error(`[AgentWeave:debug] finishReason=${finishReason}`);
			console.error(`[AgentWeave:debug] usage=${JSON.stringify(usage)}`);
		}

		const toolCalls = (toolCallsTho ?? []).map((tc) => ({
			toolUseId: tc.toolCallId,
			toolName: tc.toolName,
			toolInput: tc.args as Record<string, unknown>,
		}));

		// ── ĐIỂM CHẠM: model trả về gì, đường stream ──
		this.vet(
			"llm",
			LOAI_DIEM_CHAM.LLM_NHAN,
			{
				duong: "stream",
				ms: Date.now() - batDau,
				kyTu: text.length,
				soToolCall: toolCalls.length,
				tenTool: toolCalls.map((t) => t.toolName),
				stopReason: finishReason,
				tokenVao: usage?.promptTokens,
				tokenRa: usage?.completionTokens,
			},
			{ "nhan.txt": text, "nhan-toolcalls.json": JSON.stringify(toolCalls, null, 2) },
		);

		return {
			text,
			toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
			stopReason: finishReason ?? "end_turn",
			// Provider có thể trả null (Ollama khi thiếu stream_options). Lọc ở đây
			// để số không hữu hạn không lan xuống bộ đếm rồi thành NaN.
			usage:
				soHopLe(usage?.promptTokens) || soHopLe(usage?.completionTokens)
					? {
							inputTokens: soHopLe(usage?.promptTokens) ? usage!.promptTokens : 0,
							outputTokens: soHopLe(usage?.completionTokens) ? usage!.completionTokens : 0,
						}
					: undefined,
		};
	}

	/**
	 * Auto-detect LLM provider from model name.
	 * Supports: gemini-* → @ai-sdk/google, gpt-* → @ai-sdk/openai, default → @ai-sdk/anthropic
	 */
	/**
	 * CHỐT HẠ CÁNH khi lượt dừng bất thường (max_turns / loop): ép model tóm tắt
	 * "đã làm gì — còn thiếu gì" trong MỘT lượt gọi cuối KHÔNG tool. Không có nó,
	 * agent chạm trần rồi im lặng đi luôn — người dùng bị bỏ chỏng chơ, không biết
	 * việc xong chưa (đo thật: 50 tool rồi kết thúc trống trơn).
	 * Trả null khi không gọi được (mock/test, model đám mây, lỗi mạng) — nơi gọi
	 * tự bỏ qua, đã có notice của serve làm lưới.
	 */
	private async tomTatHaCanh(lyDo: string): Promise<string | null> {
		if (this.llmCaller) return null; // test/mock — không gọi thật
		if (!this.laModelCucBo()) return null;
		try {
			const base = normalizeOllamaBaseUrl(process.env.OLLAMA_HOST).replace(/\/v1$/, "");
			const messages = [
				// Render CÓ NHÃN chứ không `trichChu`: bản tóm tắt hạ cánh phải nói
				// đúng những gì đã làm, mà `trichChu` vứt sạch tool_use/tool_result
				// nên model chỉ còn đoán mò từ phần văn xuôi của chính nó.
				...renderChoOllama(this.messages.getMessages()),
				{
					role: "user",
					content: `The session was STOPPED (${lyDo}). HARD FACTS from the harness — these override anything you remember: tools executed: ${this.soToolThucThi}; files actually written/edited: ${this.fileDaSua.size > 0 ? [...this.fileDaSua].join(", ") : "NONE — you did not create or change ANY file"}. Do NOT call any tool. In 3-5 sentences, in the SAME language the user wrote in (Vietnamese if they wrote Vietnamese), state plainly: (1) what actually got done — consistent with the HARD FACTS, never claim work beyond them, (2) what is still NOT done, (3) the single next step you recommend. Inventing work you did not do is the worst possible answer.`,
				},
			];
			const r = await fetch(`${base}/api/chat`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					model: this.model.replace(/^ollama\//, ""),
					stream: false,
					think: false,
					messages,
					format: {
						type: "object",
						properties: { message: { type: "string" } },
						required: ["message"],
					},
					options: this.tuyChonOllama(),
				}),
				signal: AbortSignal.timeout(90_000),
			});
			if (!r.ok) return null;
			const j = (await r.json()) as { message?: { content?: string } };
			const o = JSON.parse(j.message?.content ?? "") as { message?: string };
			return typeof o.message === "string" && o.message.trim() ? o.message.trim() : null;
		} catch {
			return null;
		}
	}

	/**
	 * Thu hẹp lựa chọn tool cho lượt gọi KẾ TIẾP.
	 *
	 * Lọc theo registry trước khi đặt: mặt nạ trỏ tới tool KHÔNG đăng ký (vd
	 * `Bash` bị tắt trong cấu hình chỉ-đọc) sẽ thành tập rỗng, và tập rỗng thì
	 * model không còn nước đi nào — thà không thu hẹp còn hơn khoá cứng.
	 */
	private thuHepTool(cacTen: ReadonlyArray<string>): string {
		const co = cacTen.filter((n) => this.registry.get(n) !== undefined);
		if (co.length === 0) return "";
		this.matNaTool = new Set(co);
		// Trả về mô tả để nơi gọi gắn vào `recovery:retry`: một đòn bẩy cưỡng chế
		// mà người vận hành không thấy thì không phân biệt được với việc nó chết
		// im — đúng kiểu hỏng đã mất nhiều buổi mới tìm ra ở bản cờ boolean.
		return ` — thu hep tool con {${co.join(",")}}`;
	}

	/** Lấy mặt nạ của lượt này rồi XOÁ. Cả hai đường gọi đều đi qua đây. */
	private layMatNa(): ReadonlySet<string> | null {
		const m = this.matNaTool;
		this.matNaTool = null;
		return m;
	}

	/**
	 * Bơm NGAY một câu răn của guard, đúng khung `<system-reminder>`.
	 *
	 * Dùng ở nhánh KHÔNG có tool call: ở đó không có cặp tool nào để làm lệch,
	 * và nhánh nào cũng `continue` ngay sau nên bơm ngay là đúng thời điểm.
	 */
	private bomNhacGuard(ran: string): void {
		const tin = nhacGuard([ran]);
		if (tin) {
			this.messages.append(tin);
			this.state.messageCount = this.messages.getMessageCount();
		}
	}

	/**
	 * Chặn một lời gọi: khép cặp tool bằng một kết quả NGẮN, đẩy phần răn sang
	 * kênh nhắc.
	 *
	 * Tách hai vai là có chủ đích. `tool_result` phải tồn tại để cặp
	 * `tool_use`/`tool_result` không lệch, nhưng nó mượn id của một tool nằm
	 * trong `TOOL_NEN_DUOC` nên bước nén đối xử với nó y như một kết quả
	 * FileWrite: mức 2 cắt còn 80 ký tự, và lời cấm đứt giữa câu. Sự kiện thì
	 * ngắn nên cắt cũng không mất gì; lời răn đi kênh nhắc, nơi nó được đóng
	 * khung như mọi nhắc khác và không bị nén nhầm loại.
	 */
	private *chanLoiGoi(
		toolUseId: string,
		suKien: string,
		ran: string,
	): Generator<InnerEvent, void, void> {
		this.messages.appendToolResult(toolUseId, suKien, true);
		this.nhacGuardChoLuot.push(ran);
		yield this.makeEvent({
			type: "message:tool_result",
			toolUseId,
			content: suKien,
			isError: true,
		});
	}

	/**
	 * Ghi một điểm chạm. Nuốt mọi lỗi — xem luật ② ở `types/vet-tich.ts`.
	 *
	 * Bọc trong hàm riêng thay vì gọi thẳng để nơi dùng chỉ còn một dòng, và để
	 * cái `try` nằm đúng MỘT chỗ chứ không rải ra hai chục chỗ gọi.
	 */
	private vet(
		tang: "user" | "host" | "agent" | "llm" | "tool",
		loai: string,
		chiTiet?: Record<string, unknown>,
		noiDungLon?: Record<string, string>,
	): void {
		if (!this.vetTich) return;
		try {
			this.vetTich.ghi({ tang, loai, luot: this.state.turnIndex, chiTiet, noiDungLon });
		} catch {
			// Ghi nhận hỏng KHÔNG được làm hỏng lượt trả lời.
		}
	}

	/**
	 * Ghi một lần NỔ của cơ chế ghì.
	 *
	 * Gom về một hàm vì đây là thứ đọc lại nhiều nhất khi mổ xẻ một phiên hỏng:
	 * cơ chế nào nổ, ở nhịp mấy trên mấy, và nó đặt mặt nạ gì cho lượt sau. Ba
	 * con số đó cạnh nhau mới trả lời được "guard có tới được model không".
	 */
	private vetGuard(
		coChe: string,
		nhip: number,
		tran: number,
		moTaMatNa: string,
		them?: Record<string, unknown>,
	): void {
		this.vet("agent", LOAI_DIEM_CHAM.AGENT_GUARD, {
			coChe,
			nhip,
			tran,
			matNa: this.matNaTool ? [...this.matNaTool] : null,
			daThuHep: moTaMatNa !== "",
			...them,
		});
	}

	/** `repeat_penalty` đang có hiệu lực, tính cả nấc leo thang. */
	private repeatPenaltyHieuLuc(): number | undefined {
		const goc = this.thamSoSinh?.repeatPenalty;
		// Chưa ai đặt và cũng chưa leo nấc nào → KHÔNG gửi, để mặc định của model.
		if (goc === undefined && this.nacRepeatPenalty === 0) return undefined;
		const nen = goc ?? REPEAT_PENALTY_NEN;
		return Math.min(TRAN_REPEAT_PENALTY, nen + this.nacRepeatPenalty * BUOC_REPEAT_PENALTY);
	}

	/**
	 * Khối `options` cho Ollama `/api/chat`.
	 *
	 * `num_ctx` LUÔN được gửi, và đó là điểm chính: cửa sổ 65.536 mà harness
	 * dùng để tính ngưỡng nén trước nay chỉ là giả định phía client — server có
	 * thể đang chạy `num_ctx` nhỏ hơn và cắt cụt prompt trong im lặng. Khi đó
	 * agent quên đề bài mà mọi số đo vẫn xanh.
	 */
	private tuyChonOllama(): Record<string, number> {
		const o: Record<string, number> = { num_ctx: this.state.contextUsage.maxTokens };
		const t = this.thamSoSinh;
		if (t?.temperature !== undefined) o.temperature = t.temperature;
		if (t?.topP !== undefined) o.top_p = t.topP;
		if (t?.seed !== undefined) o.seed = t.seed;
		const rp = this.repeatPenaltyHieuLuc();
		if (rp !== undefined) o.repeat_penalty = rp;
		return o;
	}

	/** Model cục bộ (Ollama)? Đường có ràng buộc gọi /api/chat, không dùng cho model đám mây. */
	private laModelCucBo(): boolean {
		return !/^(claude|gpt-|gemini|anthropic|openai|o1|o3)/i.test(
			this.model.replace(/^ollama\//, ""),
		);
	}

	/** Có ảnh trong lịch sử không — đường có ràng buộc phẳng ảnh thành chữ nên né. */
	private coAnhTrongLichSu(): boolean {
		return this.messages
			.getMessages()
			.some((m) => Array.isArray(m.content) && m.content.some((b) => b.type === "image"));
	}

	/** Câu dẫn giao thức: liệt kê tool để model chọn đúng envelope. */
	private dungGiaoThuc(ten: string[]): string {
		const ds = this.registry
			.getAll()
			.map((t) => `- ${t.name}: ${t.description}`)
			.join("\n");
		return `RESPONSE PROTOCOL (bat buoc): moi luot tra ve DUY NHAT mot JSON object, khong kem chu nao khac.
- Goi tool: {"tool":"<ten>","input":{<tham so>}} — <ten> thuoc [${ten.join(", ")}].
- Tra loi nguoi dung: {"tool":"respond","message":"<cau tra loi>","done":true|false}. done=true CHI khi yeu cau da hoan tat that su; neu con viec phai lam thi DUNG respond — goi tool tiep.
Cac tool:
${ds}

HANH DONG truoc, hoi sau: neu nguoi dung can file/report thi goi FileWrite voi noi dung DAY DU roi moi respond xac nhan. KHONG dung respond de hoi xin thong tin co the tu doc bang tool (FileRead/Grep) hoac da co san trong ngu canh.
Khi da HOAN THANH yeu cau, dung {"tool":"respond","message":"..."} de KET THUC — dung lap lai viec da lam. Trong message ket thuc, CHI ke nhung file ma tool result phia tren xac nhan da ghi ("Written ... bytes") — ke file chua ghi la noi doi.`;
	}

	/**
	 * Đường gọi LLM CÓ RÀNG BUỘC (constrained decoding) — Ollama `format` = JSON
	 * schema. Model KHÔNG THỂ nhả sai định dạng: envelope luôn hợp lệ, chuỗi luôn
	 * escape đúng. Xoá tận gốc lớp "tool-call lọt ra chat" mà recovery phải dọn.
	 * Đo thật (bench-format): parse 100%, code không tệ đi, tốc độ ngang.
	 *
	 * Hạn chế bản này: non-stream (không stream token) và phẳng ảnh thành chữ —
	 * nên chỉ dùng khi bật cờ và không có ảnh (goiLLM đã né).
	 */
	private async *chayCoRangBuoc(
		matNa: ReadonlySet<string> | null,
	): AsyncGenerator<string, LLMCallResult, void> {
		// Nudge bằng chữ thì model 30B phớt được; enum trong format schema thì
		// KHÔNG — sampler không sinh nổi tên tool ngoài danh sách. Đây là đòn bẩy
		// cưỡng chế thật duy nhất của hệ ghì, nên mặt nạ phải tới được đây.
		const tatCa = this.registry.names();
		const ten = matNa === null ? tatCa : tatCa.filter((n) => matNa.has(n));
		const envelope = {
			type: "object",
			properties: {
				reasoning: { type: "string" },
				tool: { type: "string", enum: [...ten, "respond"] },
				input: { type: "object" },
				message: { type: "string" },
				// Bắt buộc TỰ KHAI: yêu cầu của người dùng đã xong chưa. Schema ép
				// nên không né được — thay cho việc dò mẫu câu "tôi sẽ/xin chờ".
				done: { type: "boolean" },
			},
			required: ["tool", "done"],
		};
		const base = normalizeOllamaBaseUrl(process.env.OLLAMA_HOST).replace(/\/v1$/, "");
		const messages: Array<{ role: string; content: string }> = [
			{ role: "system", content: `${this.getSystemPrompt()}\n\n${this.dungGiaoThuc(ten)}` },
			// TẦNG 0: render CÓ NHÃN. Bản trước dùng `trichChu` nên model nhận chuỗi
			// rỗng thay cho mọi lời gọi tool của chính nó VÀ mọi cảnh báo guard
			// (guard tiêm qua `appendToolResult`) — hệ ghì nói chuyện với người điếc.
			...renderChoOllama(this.messages.getMessages()),
		];
		const than = {
			model: this.model.replace(/^ollama\//, ""),
			stream: false,
			think: false,
			messages,
			format: envelope,
			options: this.tuyChonOllama(),
		};

		// ── ĐIỂM CHẠM: bytes THẬT gửi cho model ──
		// Đây là thứ trước nay không tồn tại ở bất kỳ tầng nào. `llm:request_start`
		// chỉ mang {model, estimatedInputTokens}, nên khi model cư xử lạ thì không
		// có cách nào biết nó đã ĐỌC được gì — phải chặn ở tầng mạng mới thấy.
		const batDau = Date.now();
		this.vet(
			"llm",
			LOAI_DIEM_CHAM.LLM_GUI,
			{
				duong: "co-rang-buoc",
				model: than.model,
				soTinNhan: messages.length,
				// Danh sách tool SAU mặt nạ — đối chiếu với `agent:guard` để thấy
				// đòn bẩy cưỡng chế có thật sự tới được sampler không.
				toolChoPhep: [...ten, "respond"],
				coMatNa: matNa !== null,
				options: than.options,
				tongKyTu: messages.reduce((n, m) => n + m.content.length, 0),
			},
			{ "gui.json": JSON.stringify(than, null, 2) },
		);

		let r: Response;
		try {
			r = await fetch(`${base}/api/chat`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(than),
				signal: this.abortController?.signal,
			});
		} catch (e) {
			this.vet("llm", LOAI_DIEM_CHAM.LLM_HONG, {
				duong: "co-rang-buoc",
				loi: e instanceof Error ? e.message : String(e),
				ms: Date.now() - batDau,
			});
			throw e;
		}
		if (!r.ok) {
			this.vet("llm", LOAI_DIEM_CHAM.LLM_HONG, {
				duong: "co-rang-buoc",
				ma: r.status,
				ms: Date.now() - batDau,
			});
			throw new Error(`Ollama /api/chat tra ma ${r.status}`);
		}
		const j = (await r.json()) as {
			message?: { content?: string };
			prompt_eval_count?: number;
			eval_count?: number;
		};
		const raw = j.message?.content ?? "";
		// ── ĐIỂM CHẠM: bytes THẬT model trả về, TRƯỚC mọi bước diễn giải ──
		this.vet(
			"llm",
			LOAI_DIEM_CHAM.LLM_NHAN,
			{
				duong: "co-rang-buoc",
				ms: Date.now() - batDau,
				kyTu: raw.length,
				tokenVao: j.prompt_eval_count,
				tokenRa: j.eval_count,
			},
			{ "nhan.json": raw },
		);
		const usage = {
			inputTokens: typeof j.prompt_eval_count === "number" ? j.prompt_eval_count : 0,
			outputTokens: typeof j.eval_count === "number" ? j.eval_count : 0,
		};
		let env: Record<string, unknown> | null = null;
		try {
			const p = JSON.parse(raw);
			if (p && typeof p === "object") env = p as Record<string, unknown>;
		} catch {
			// Constrained nên gan nhu khong xay ra.
		}
		const tenTool = typeof env?.tool === "string" ? (env.tool as string) : null;
		if (tenTool && tenTool !== "respond" && ten.includes(tenTool)) {
			const input =
				env && typeof env.input === "object" && env.input !== null
					? (env.input as Record<string, unknown>)
					: {};
			return {
				text: typeof env?.reasoning === "string" ? (env.reasoning as string) : "",
				toolCalls: [{ toolUseId: `struct_${nanoid(8)}`, toolName: tenTool, toolInput: input }],
				stopReason: "tool_use",
				usage,
			};
		}
		const msg =
			typeof env?.message === "string"
				? (env.message as string)
				: typeof env?.reasoning === "string"
					? (env.reasoning as string)
					: raw;
		yield msg;
		return { text: msg, stopReason: "end_turn", usage, chuaXong: env?.done === false };
	}

	private async resolveModel(): Promise<Parameters<typeof import("ai").generateText>[0]["model"]> {
		return (await this.providers.resolve(this.model)) as Parameters<
			typeof import("ai").generateText
		>[0]["model"];
	}

	/** Đăng ký provider tuỳ chỉnh (vd: endpoint nội bộ của công ty). */
	registerProvider(provider: ModelProvider): void {
		this.providers.register(provider);
	}

	/** Provider nào sẽ xử lý model hiện tại — dùng để chẩn đoán. */
	whichProvider(): string | null {
		return this.providers.whichProvider(this.model);
	}

	// ─── InnerHarnessProvider interface ──────────────────────────

	abort(reason?: string): void {
		this.abortController?.abort(reason);
		this.state.status = "aborted";
	}

	getState(): InnerState {
		return { ...this.state };
	}

	getMessages(): ReadonlyArray<Message> {
		return this.messages.getMessages();
	}

	getContextUsage(): ContextUsage {
		return { ...this.state.contextUsage };
	}

	getUsage(): TokenUsage {
		return this.tokenCounter.getUsage();
	}

	getTools(): ReadonlyArray<ToolDefinition> {
		return this.registry.getAll();
	}

	registerTool(tool: ToolDefinition): void {
		this.registry.register(tool);
	}

	unregisterTool(name: string): void {
		this.registry.unregister(name);
	}

	injectMessage(message: InjectableMessage): void {
		this.messages.append({
			role: message.role === "tool_result" ? "user" : message.role,
			content: message.content,
		});
	}

	/**
	 * Đặt/xoá một mục có tên trong system prompt.
	 *
	 * Giữ theo Map thay vì nối chuỗi rồi cắt bằng regex, vì bản cũ có hai lỗi:
	 * đặt lại cùng một tên thì mục bị lặp, và nội dung chứa "[" làm regex xoá
	 * cắt nhầm chỗ. Chỉ mục skill dính cả hai.
	 */
	/**
	 * Đăng ký một nguồn nhắc.
	 *
	 * Gọi trước `run()`. Nguồn được chạy ở đầu MỖI lượt, song song, với hạn giờ
	 * cứng — nên nguồn chậm hay hỏng không ảnh hưởng tới lượt trả lời.
	 */
	themNguonNhac(nguon: NguonNhac): void {
		this.nguonNhac.push(nguon);
	}

	/**
	 * File model vừa chạm — tín hiệu cho rule và skill có điều kiện.
	 *
	 * Chỉ ba tool đọc/ghi tệp. Grep/Glob cố tình KHÔNG tính: chúng trả về danh
	 * sách đường dẫn chứ model chưa thật sự làm việc với file nào, mà một lệnh
	 * Glob `**\/*.ts` sẽ kéo theo mọi rule của mọi tầng cùng lúc — đúng thứ cơ
	 * chế có điều kiện sinh ra để tránh.
	 */
	private ghiNhanCham(goi: ToolCall | undefined): void {
		if (!goi) return;
		if (goi.toolName !== "FileRead" && goi.toolName !== "FileWrite" && goi.toolName !== "FileEdit")
			return;

		const vao = goi.toolInput as Record<string, unknown>;
		const p = vao.path ?? vao.file ?? vao.file_path ?? vao.filename;
		if (typeof p !== "string" || p === "") return;

		const tuyetDoi = isAbsolute(p) ? p : resolve(process.cwd(), p);
		if (!this.fileVuaCham.includes(tuyetDoi)) this.fileVuaCham.push(tuyetDoi);
	}

	setSystemPromptSection(name: string, content: string | null): void {
		if (content === null) {
			this.promptSections.delete(name);
		} else {
			this.promptSections.set(name, content);
		}
	}

	/**
	 * System prompt thật sự gửi tới model — prompt gốc cộng các mục đã đặt.
	 * Công khai để bộ tự kiểm tra xác nhận được chỉ mục skill đã vào prompt,
	 * thay vì tin là đã vào.
	 */
	getSystemPrompt(): string {
		let out = this.systemPrompt;
		for (const [name, content] of this.promptSections) {
			out += `\n[${name}]\n${content}\n`;
		}
		return out;
	}

	setModel(model: string): void {
		this.model = model;
		this.state.model = model;
	}

	getConfig(): InnerConfig {
		return {
			model: this.model,
			fallbackModel: this.fallbackModel,
			maxTurns: this.maxTurns,
			thinkingEnabled: this.thinkingEnabled,
			tools: this.registry.names(),
		};
	}

	// ─── Internal ────────────────────────────────────────────────

	private makeEvent(payload: InnerEventPayload): InnerEvent {
		return {
			id: nanoid(),
			timestamp: Date.now(),
			sessionId: this.sessionId,
			agentId: this.agentId,
			...payload,
		} as InnerEvent;
	}

	private setupCommandHandler(): void {
		this.controlPlane.onCommand(async (cmd) => {
			switch (cmd.type) {
				case "pause":
					this.state.status = "paused";
					return { accepted: true };
				case "resume":
					this.state.status = "running";
					return { accepted: true };
				case "abort":
					this.abort(cmd.reason);
					return { accepted: true };
				case "set_model":
					this.setModel(cmd.model);
					return { accepted: true };
				case "set_max_turns":
					this.maxTurns = cmd.maxTurns;
					return { accepted: true };
				case "inject":
					this.injectMessage(cmd.message);
					return { accepted: true };
				case "force_compact":
					// Lệnh này đã có trong kiểu dữ liệu từ lâu nhưng KHÔNG có nhánh
					// xử lý, nên gọi vào chỉ nhận "Unknown command". Nén ngay giữa
					// lượt sẽ đụng danh sách tin nhắn đang dùng, nên đặt cờ và nén
					// ở đầu lượt kế tiếp.
					this.yeuCauNen = true;
					return { accepted: true };
				default:
					return { accepted: false, reason: `Unknown command: ${cmd.type}` };
			}
		});
	}
}

/** Số dùng được: có thật, hữu hạn, không âm. */
function soHopLe(x: unknown): x is number {
	return typeof x === "number" && Number.isFinite(x) && x >= 0;
}

export interface LLMCallResult {
	text?: string;
	toolCalls?: ToolCall[];
	stopReason: string;
	/** Model TỰ KHAI chưa xong (done=false trong envelope respond). Schema ép khai
	 * nên tin cậy hơn mọi kiểu dò mẫu câu "tôi sẽ/xin chờ" — đã lọt lưới nhiều lần. */
	chuaXong?: boolean;
	usage?: {
		inputTokens?: number;
		outputTokens?: number;
		thinkingTokens?: number;
	};
}

/**
 * Đếm số byte khối bộ nhớ còn nằm trong hội thoại.
 *
 * Trạng thái suy ra từ NỘI DUNG, không giữ song song: sau khi nén xoá bớt khối
 * cũ, con số tự lùi và bơm lại là hợp lệ. Một biến đếm riêng thì không có cách
 * nào biết nội dung nó đang đếm đã biến mất.
 */
function demByteBoNho(messages: ReadonlyArray<Message>): number {
	let tong = 0;
	for (const m of messages) {
		const chu = typeof m.content === "string" ? m.content : "";
		if (chu.includes(NHAN_KHOI_BO_NHO)) tong += Buffer.byteLength(chu, "utf-8");
	}
	return tong;
}
