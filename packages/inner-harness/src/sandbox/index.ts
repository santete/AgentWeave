/**
 * Chọn sandbox theo nền tảng.
 *
 * Nguyên tắc: KHÔNG âm thầm chạy không sandbox. Thiếu sandbox thì báo lỗi
 * rõ ràng, trừ khi người vận hành chủ động chấp nhận rủi ro bằng biến
 * môi trường AGENTWEAVE_ALLOW_UNSANDBOXED=1.
 */

import { BubblewrapSandbox } from "./bubblewrap";
import { SeatbeltSandbox } from "./seatbelt";
import { type Sandbox, type SandboxCapabilities, SandboxUnavailableError } from "./types";

export { BubblewrapSandbox } from "./bubblewrap";
export { SeatbeltSandbox } from "./seatbelt";
export { SandboxUnavailableError } from "./types";
export type { Sandbox, SandboxCapabilities, SandboxPolicy } from "./types";

/** Sandbox rỗng — KHÔNG cô lập gì. Chỉ dùng khi người vận hành cố ý bỏ qua. */
export class NoopSandbox implements Sandbox {
	readonly id = "none";
	readonly platform = process.platform;
	async isAvailable(): Promise<boolean> {
		return true;
	}
	capabilities(): SandboxCapabilities {
		return { filesystemIsolation: false, networkIsolation: false, processIsolation: false };
	}
	wrap(argv: string[]): string[] {
		return argv;
	}
}

const REGISTRY: Sandbox[] = [new BubblewrapSandbox(), new SeatbeltSandbox()];

/**
 * Trả về sandbox dùng được trên máy hiện tại.
 * @throws SandboxUnavailableError nếu không có và chưa bật cờ chấp nhận rủi ro.
 */
export async function detectSandbox(): Promise<Sandbox> {
	for (const s of REGISTRY) {
		if (await s.isAvailable()) return s;
	}

	if (process.env.AGENTWEAVE_ALLOW_UNSANDBOXED === "1") {
		console.warn(
			"[AgentWeave] ⚠️  KHONG CO SANDBOX. Tool co tac dung phu se chay truc tiep tren may.",
		);
		return new NoopSandbox();
	}

	const expected =
		process.platform === "linux"
			? "bubblewrap (cai bang: apt install bubblewrap)"
			: process.platform === "darwin"
				? "/usr/bin/sandbox-exec"
				: "khong ho tro nen tang nay";

	throw new SandboxUnavailableError("auto", process.platform, `khong tim thay ${expected}`);
}

/** Đăng ký cài đặt sandbox tuỳ chỉnh (đứng trước các bản dựng sẵn). */
export function registerSandbox(s: Sandbox): void {
	REGISTRY.unshift(s);
}
