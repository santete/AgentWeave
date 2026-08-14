/**
 * REFERENCE IMPLEMENTATION — not production path (post-pivot 2026-04-22).
 * Production agents (Claude Code, Cursor) ship their own Bash tool; AgentWeave
 * governs them via hooks + adapters, not by re-implementing. Kept for the
 * reference agent-loop and outer-harness tests. See product-spec/POSITIONING.md.
 *
 * ---
 *
 * Bash — Execute shell commands with timeout and cwd support.
 *
 * SECURITY NOTE: This tool intentionally uses shell execution (exec, not execFile).
 * In standalone mode (noop control plane), ALL commands are auto-allowed.
 * When connected to a real ControlPlane + OuterHarness, the PermissionEngine
 * gates every command via tool_request intercept before execution.
 *
 * For standalone usage without governance, consider restricting tools passed to AgentLoop.
 */

import { exec } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";
import type { ToolDefinition } from "@agentweave/types";

const execAsync = promisify(exec);

export const BashTool: ToolDefinition<{ command: string; timeout?: number }, string> = {
	name: "Bash",
	description: "Execute a bash/shell command and return stdout + stderr.",
	parameters: z.object({
		command: z.string().describe("The shell command to execute"),
		timeout: z.number().positive().optional().describe("Timeout in ms (default 120000)"),
	}),
	execute: async ({ command, timeout }, context) => {
		try {
			const { stdout, stderr } = await execAsync(command, {
				cwd: context.cwd,
				timeout: timeout ?? 120_000,
				signal: context.signal,
			});
			return format(stdout, stderr, 0, false);
		} catch (err) {
			// `exec` NÉM LỖI khi lệnh trả mã thoát ≠ 0 — nhưng với agent lập trình
			// thì đó chính là lúc output quan trọng nhất: `npm test`, `pytest`,
			// `dotnet test` đều trả mã ≠ 0 đúng khi ta cần biết test nào hỏng.
			//
			// Bản trước để lỗi lọt lên ToolExecutor, nơi chỉ giữ lại `err.message`
			// ("Command failed: node --test test/") và vứt toàn bộ stdout/stderr.
			// Đo thật: mất 1.241 ký tự chứa đúng dòng "-90 !== 0". Model mù hoàn toàn.
			const e = err as NodeJS.ErrnoException & {
				stdout?: string;
				stderr?: string;
				code?: number | string;
				killed?: boolean;
			};

			// Không có stdout/stderr nghĩa là không spawn được (lệnh không tồn tại,
			// cwd sai…) — đó mới là lỗi thật, phải ném tiếp.
			if (e.stdout === undefined && e.stderr === undefined) throw err;

			const ma = typeof e.code === "number" ? e.code : 1;
			return format(e.stdout ?? "", e.stderr ?? "", ma, e.killed === true);
		}
	},
	metadata: {
		isReadOnly: false,
		isDestructive: true,
		isConcurrencySafe: false,
		category: "shell",
		maxDurationMs: 120_000,
		maxOutputSize: 100_000,
	},
};

const TRAN_OUTPUT = 100_000;

/**
 * Gộp output thành một chuỗi model đọc được.
 *
 * Mã thoát đứng ĐẦU và chỉ hiện khi ≠ 0: model phải biết lệnh hỏng ngay dòng
 * đầu, chứ không phải đoán từ nội dung. Cắt phần GIỮA thay vì phần cuối vì lỗi
 * biên dịch và tóm tắt test thường nằm ở cuối.
 */
function format(stdout: string, stderr: string, ma: number, bienGioi: boolean): string {
	const dau =
		bienGioi
			? `[lệnh bị giết vì quá hạn giờ — mã thoát ${ma}]\n`
			: ma !== 0
				? `[mã thoát ${ma}]\n`
				: "";
	const than = stdout + (stderr ? `${stdout ? "\n" : ""}stderr:\n${stderr}` : "");
	const full = dau + than;

	if (full.length <= TRAN_OUTPUT) return full || dau || "(không có output)";

	const nua = Math.floor((TRAN_OUTPUT - 200) / 2);
	return (
		`${full.slice(0, nua)}\n\n… [cắt bớt ${full.length - nua * 2} ký tự ở giữa] …\n\n` +
		full.slice(full.length - nua)
	);
}
