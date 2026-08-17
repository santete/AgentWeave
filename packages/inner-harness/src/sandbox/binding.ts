/**
 * Gắn sandbox tầng nhân vào ngữ cảnh thực thi tool.
 *
 * Lớp sandbox (bubblewrap/seatbelt) đã có từ trước nhưng CHƯA AI DÙNG:
 * `ToolExecutor` tự kiểm bằng cách so khớp chuỗi trong tham số tool, và chính
 * mã đó ghi rõ hạn chế — chỉ soi vài tên trường biết trước, tool nào đặt tên
 * khác là lọt. Tức tiêu chuẩn "cô lập" mới đạt ở tầng chính sách, chưa có
 * ranh giới cứng nào.
 *
 * Tệp này nối hai phần lại: dựng một `ProcessSandboxBinding` để tool chạy
 * tiến trình (Bash) bọc lệnh trước khi chạy.
 */

import type { ProcessSandboxBinding } from "@agentweave/types";
import { detectSandbox } from "./index";
import type { SandboxPolicy } from "./types";

export interface TuyChonCoLap {
	/** Thư mục DUY NHẤT được ghi. Mặc định cwd của tiến trình. */
	workspace?: string;
	/** Đường dẫn chỉ đọc thêm — toolchain node/dotnet/jdk… */
	readOnlyPaths?: string[];
	/**
	 * Cho tool gọi mạng. Mặc định FALSE.
	 * Trong air-gap thì bật cũng vô nghĩa, mà tắt còn chặn được trường hợp tool
	 * vô tình gọi thẳng vào endpoint LLM (harness chạy ngoài, tool chạy trong).
	 */
	allowNetwork?: boolean;
}

/**
 * Dựng binding để truyền vào `ToolContext.processSandbox`.
 *
 * @throws SandboxUnavailableError khi máy không có cơ chế nào và người vận
 *         hành chưa chủ động đặt AGENTWEAVE_ALLOW_UNSANDBOXED=1. Thà dừng còn
 *         hơn âm thầm chạy không cô lập rồi tưởng là có.
 */
export async function taoRangBuocSandbox(
	tuyChon: TuyChonCoLap = {},
): Promise<ProcessSandboxBinding> {
	const sandbox = await detectSandbox();
	const chinhSach: SandboxPolicy = {
		workspace: tuyChon.workspace ?? process.cwd(),
		readOnlyPaths: tuyChon.readOnlyPaths,
		allowNetwork: tuyChon.allowNetwork ?? false,
		privateTmp: true,
	};

	return {
		id: sandbox.id,
		wrap: (argv) => sandbox.wrap(argv, chinhSach),
	};
}
