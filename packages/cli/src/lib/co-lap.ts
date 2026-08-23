/**
 * Dựng ràng buộc cô lập tầng nhân cho một phiên.
 *
 * Gộp vào một chỗ vì cả `chat`, `serve` lẫn `run` đều cần, và cả ba phải xử lý
 * giống hệt nhau ở ca hỏng — bật sandbox mà máy không có bwrap thì phải DỪNG,
 * không được lặng lẽ chạy trần. Người vận hành bật cờ đó vì họ tin là có cô
 * lập; chạy tiếp mà không có nó là phản bội đúng niềm tin ấy.
 */

import { taoRangBuocSandbox } from "@agentweave/inner-harness";
import type { ProcessSandboxBinding } from "@agentweave/types";
import type { CauHinhAgent } from "./agent-config";

export interface KetQuaCoLap {
	binding?: ProcessSandboxBinding;
	/** Dòng báo cho người vận hành. Rỗng khi không bật. */
	thongBao: string;
	/** true = bật nhưng dựng hỏng; nơi gọi phải DỪNG chứ không chạy tiếp. */
	hong: boolean;
}

export async function dungCoLap(goc: string, cauHinh: CauHinhAgent): Promise<KetQuaCoLap> {
	if (cauHinh.sandbox !== true) return { thongBao: "", hong: false };

	try {
		const binding = await taoRangBuocSandbox({
			workspace: goc,
			readOnlyPaths: cauHinh.sandboxReadOnly,
			// Air-gap: mạng tắt là đúng mặc định, và còn chặn được trường hợp
			// tool vô tình gọi thẳng vào endpoint LLM.
			allowNetwork: false,
		});
		return {
			binding,
			thongBao: `cô lập tiến trình: ${binding.id} · chỉ ghi được ${goc} · không mạng`,
			hong: false,
		};
	} catch (e) {
		return {
			thongBao:
				`BẬT sandbox nhưng không dựng được: ${(e as Error).message}\n` +
				`  Cài bubblewrap (Linux: apt install bubblewrap), hoặc bỏ "sandbox": true ` +
				`trong .agentweave/agent.json nếu chấp nhận chạy không cô lập.`,
			hong: true,
		};
	}
}
