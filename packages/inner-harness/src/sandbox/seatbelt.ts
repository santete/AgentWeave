/**
 * SeatbeltSandbox — cài đặt cho macOS.
 *
 * ⚠️ TRẠNG THÁI: khung đã sẵn, CHƯA kiểm chứng trên máy Mac thật.
 * Chỉ bật khi đã chạy thử và xác nhận 4 tính chất như bản Linux.
 *
 * Bối cảnh kỹ thuật (khảo sát 08/2026):
 *   - `sandbox-exec` (Seatbelt) đã bị Apple đánh dấu deprecated từ macOS 15,
 *     in cảnh báo mỗi lần gọi — NHƯNG vẫn hoạt động và Apple vẫn tự dùng.
 *   - App Sandbox đòi đóng gói .app + entitlement → không hợp lệnh CLI.
 *   - Container của macOS 26 còn thử nghiệm.
 *   → Hiện KHÔNG có cơ chế không-deprecated nào để sandbox tiến trình chưa ký.
 *
 * Kết luận: dùng sandbox-exec, chấp nhận cảnh báo, và ghi rõ hạn chế này
 * cho người vận hành biết thay vì giấu đi.
 */

import { access, constants } from "node:fs/promises";
import type { Sandbox, SandboxCapabilities, SandboxPolicy } from "./types";

export class SeatbeltSandbox implements Sandbox {
	readonly id = "seatbelt";
	readonly platform = "darwin";

	async isAvailable(): Promise<boolean> {
		if (process.platform !== "darwin") return false;
		try {
			await access("/usr/bin/sandbox-exec", constants.X_OK);
			return true;
		} catch {
			return false;
		}
	}

	capabilities(): SandboxCapabilities {
		return {
			filesystemIsolation: true,
			networkIsolation: true,
			// Seatbelt không cô lập bảng tiến trình như namespace của Linux.
			// Khai báo trung thực để người vận hành biết mình đang có gì.
			processIsolation: false,
		};
	}

	wrap(argv: string[], policy: SandboxPolicy): string[] {
		if (argv.length === 0) throw new Error("argv rong");
		if (!policy.workspace) throw new Error("policy.workspace la bat buoc");
		return ["/usr/bin/sandbox-exec", "-p", this.buildProfile(policy), ...argv];
	}

	/**
	 * Sinh profile Seatbelt (cú pháp giống Scheme).
	 * Nguyên tắc: mặc định CẤM, chỉ mở đúng thứ cần.
	 */
	private buildProfile(policy: SandboxPolicy): string {
		const ro = [...(policy.readOnlyPaths ?? []), "/usr", "/bin", "/sbin", "/System", "/Library"];

		const lines = [
			"(version 1)",
			"(deny default)",
			// Đọc: hệ thống + toolchain
			...ro.map((p) => `(allow file-read* (subpath ${q(p)}))`),
			// Ghi: DUY NHẤT workspace
			`(allow file-read* file-write* (subpath ${q(policy.workspace)}))`,
			// Tiến trình con
			"(allow process-exec)",
			"(allow process-fork)",
			"(allow signal (target self))",
			"(allow sysctl-read)",
		];

		if (policy.privateTmp !== false) {
			lines.push("(allow file-read* file-write* (subpath \"/private/tmp\"))");
		}

		// Mạng: mặc định cấm, khớp hành vi của bản Linux
		if (policy.allowNetwork) {
			lines.push("(allow network*)");
		} else {
			lines.push("(deny network*)");
		}

		return lines.join("\n");
	}
}

function q(s: string): string {
	return `"${s.replace(/"/g, '\\"')}"`;
}
