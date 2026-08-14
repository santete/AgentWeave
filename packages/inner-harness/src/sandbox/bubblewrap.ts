/**
 * BubblewrapSandbox — cài đặt cho Linux.
 *
 * Dùng bubblewrap (bwrap): cô lập bằng namespace của nhân, KHÔNG cần
 * container image — điều kiện bắt buộc trong môi trường air-gap.
 *
 * Đã kiểm chứng thực tế trên Jetson AGX Thor / Ubuntu 24.04 aarch64:
 *   ✓ chạy được trong sandbox
 *   ✓ mạng và Ollama bị chặn khi --unshare-all
 *   ✓ /home chỉ đọc, không ghi được
 *   ✓ workspace vẫn ghi bình thường
 */

import { access, constants } from "node:fs/promises";
import type { Sandbox, SandboxCapabilities, SandboxPolicy } from "./types";

/**
 * Thư mục hệ thống cần bind chỉ đọc.
 *
 * ⚠️ KHÔNG có /lib64 — thư mục đó chỉ tồn tại trên x86_64. Mọi hướng dẫn
 * bubblewrap trên mạng đều viết cho x86 và sẽ lỗi ngay dòng đầu trên ARM:
 *   bwrap: Can't find source path /lib64
 * Ta lọc theo đường dẫn thực sự tồn tại thay vì khai cứng.
 */
const CANDIDATE_SYSTEM_PATHS = ["/usr", "/bin", "/sbin", "/lib", "/lib64", "/etc/alternatives"];

export class BubblewrapSandbox implements Sandbox {
	readonly id = "bubblewrap";
	readonly platform = "linux";

	/** Cache kết quả dò đường dẫn để không phải kiểm tra lại mỗi lệnh. */
	private systemPaths: string[] | null = null;

	async isAvailable(): Promise<boolean> {
		if (process.platform !== "linux") return false;
		const found = await which("bwrap");
		if (!found) return false;
		this.systemPaths = await existingPaths(CANDIDATE_SYSTEM_PATHS);
		return this.systemPaths.length > 0;
	}

	capabilities(): SandboxCapabilities {
		return {
			filesystemIsolation: true,
			networkIsolation: true,
			processIsolation: true,
		};
	}

	wrap(argv: string[], policy: SandboxPolicy): string[] {
		if (argv.length === 0) throw new Error("argv rong");
		if (!policy.workspace) throw new Error("policy.workspace la bat buoc");

		// Nếu chưa dò thì dùng danh sách ứng viên — wrap() là hàm đồng bộ nên
		// không await được; isAvailable() nên được gọi trước.
		const sys = this.systemPaths ?? CANDIDATE_SYSTEM_PATHS;

		const args: string[] = [];

		for (const p of sys) args.push("--ro-bind-try", p, p);
		for (const p of policy.readOnlyPaths ?? []) args.push("--ro-bind-try", p, p);

		// ⚠️ THỨ TỰ QUAN TRỌNG: tmpfs phải gắn TRƯỚC khi bind workspace.
		// Nếu ngược lại, tmpfs rỗng sẽ CHE MẤT workspace khi workspace nằm
		// dưới /tmp — lỗi "Can't chdir: No such file or directory", rất khó
		// đoán vì phần chặn vẫn hoạt động đúng nên trông như sandbox ổn.
		if (policy.privateTmp !== false) args.push("--tmpfs", "/tmp");

		// Workspace là chỗ DUY NHẤT ghi được — bind SAU tmpfs
		args.push("--bind", policy.workspace, policy.workspace);

		args.push("--proc", "/proc", "--dev", "/dev");

		// --unshare-all gồm cả mạng. Trong air-gap thì bật là miễn phí,
		// mà lại chặn được tool vô tình gọi thẳng LLM endpoint.
		args.push("--unshare-all");
		if (policy.allowNetwork) args.push("--share-net");

		args.push("--die-with-parent"); // sandbox chết theo tiến trình cha
		args.push("--new-session"); // chống tấn công tiêm lệnh qua TIOCSTI
		args.push("--chdir", policy.workspace);

		for (const [k, v] of Object.entries(policy.env ?? {})) {
			args.push("--setenv", k, v);
		}

		return ["bwrap", ...args, "--", ...argv];
	}
}

// ─── Tiện ích ─────────────────────────────────────────────────────

async function existingPaths(paths: string[]): Promise<string[]> {
	const out: string[] = [];
	for (const p of paths) {
		try {
			await access(p, constants.F_OK);
			out.push(p);
		} catch {
			/* không tồn tại trên nền tảng này — bỏ qua */
		}
	}
	return out;
}

async function which(bin: string): Promise<boolean> {
	const dirs = (process.env.PATH ?? "").split(":").filter(Boolean);
	for (const d of dirs) {
		try {
			await access(`${d}/${bin}`, constants.X_OK);
			return true;
		} catch {
			/* thử tiếp */
		}
	}
	return false;
}
