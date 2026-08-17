/**
 * Lớp trừu tượng sandbox — đa nền tảng.
 *
 * Mục tiêu: cô lập tool có tác dụng phụ (bash, file-write, file-edit) khỏi
 * phần còn lại của máy. Đây là ranh giới CỨNG ở tầng hệ điều hành, bổ sung
 * cho permission-engine vốn chỉ chặn được ở tầng chính sách.
 *
 * Vì sao cần trừu tượng hoá: cơ chế cô lập khác nhau hoàn toàn giữa các nền tảng.
 *   Linux  → bubblewrap (namespace của nhân, không cần image)
 *   macOS  → sandbox-exec / Seatbelt (đã deprecated nhưng chưa có thay thế)
 *   khác   → không hỗ trợ
 */

export interface SandboxPolicy {
	/** Thư mục DUY NHẤT được ghi. Bắt buộc. */
	workspace: string;

	/** Đường dẫn chỉ đọc thêm — toolchain (node, dotnet, jdk…). */
	readOnlyPaths?: string[];

	/**
	 * Cho phép truy cập mạng.
	 * Mặc định FALSE — trong môi trường air-gap thì bật cũng vô nghĩa,
	 * mà tắt lại chặn được cả trường hợp tool vô tình gọi thẳng LLM endpoint.
	 */
	allowNetwork?: boolean;

	/** Cấp /tmp riêng, không dùng chung với máy chủ. Mặc định true. */
	privateTmp?: boolean;

	/** Biến môi trường truyền vào sandbox. */
	env?: Record<string, string>;
}

export interface SandboxCapabilities {
	/** Chặn được ghi ngoài workspace */
	filesystemIsolation: boolean;
	/** Chặn được mạng */
	networkIsolation: boolean;
	/** Chặn được nhìn thấy tiến trình khác */
	processIsolation: boolean;
}

export interface Sandbox {
	/** Định danh: "bubblewrap" | "seatbelt" | "none" */
	readonly id: string;

	/** Nền tảng hỗ trợ, để báo lỗi cho rõ */
	readonly platform: string;

	/** Cơ chế này có dùng được trên máy hiện tại không (kiểm tra binary + nhân). */
	isAvailable(): Promise<boolean>;

	/** Sandbox này cô lập được những gì — dùng để cảnh báo khi thiếu. */
	capabilities(): SandboxCapabilities;

	/**
	 * Bọc một lệnh. Trả về argv đã bọc, chưa chạy.
	 * Tách hẳn khỏi việc thực thi để test được mà không cần chạy thật.
	 */
	wrap(argv: string[], policy: SandboxPolicy): string[];
}

export class SandboxUnavailableError extends Error {
	constructor(id: string, platform: string, reason: string) {
		super(
			`Sandbox "${id}" khong dung duoc tren nen tang nay (${platform}): ${reason}\n` +
				`AgentWeave TU CHOI chay tool co tac dung phu khi khong co sandbox.\n` +
				`Neu chap nhan rui ro, dat AGENTWEAVE_ALLOW_UNSANDBOXED=1 (KHONG khuyen nghi).`,
		);
		this.name = "SandboxUnavailableError";
	}
}
