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

import { spawn } from "node:child_process";
import type { ToolDefinition } from "@agentweave/types";
import { z } from "zod";

/**
 * Hạn giờ mặc định — 10 phút.
 *
 * Bản trước để 120 giây, hợp với `npm test` của một gói nhỏ nhưng quá ngắn cho
 * việc thật: `mvn clean install` hay `dotnet test` trên một solution doanh
 * nghiệp chạy vài phút là bình thường. Bị giết giữa chừng thì agent mất đúng
 * cái nó cần nhất — kết quả kiểm tra — mà lại tưởng mình đã kiểm tra xong.
 */
export const TIMEOUT_MAC_DINH_MS = 600_000;

/**
 * Dấu hiệu lệnh hỏng, đặt ở đầu output.
 *
 * Xuất ra ngoài để chỗ khác (CLI đọc kết quả để biết agent có thật sự kiểm tra
 * không) khỏi phải chép lại chuỗi. Chép lại thì đổi câu chữ ở đây là bên kia âm
 * thầm hiểu nhầm thành "lệnh chạy tốt" — đúng loại lỗi báo xanh mà sai.
 */
export const DAU_MA_THOAT = "[mã thoát ";
export const DAU_BI_GIET = "[lệnh bị giết";

/**
 * Thời gian chờ tiến trình tự thoát sau SIGTERM, trước khi SIGKILL.
 *
 * Cho tiến trình cơ hội đóng tệp và dọn dẹp. Ngắn hơn thì nó chết giữa lúc ghi;
 * dài hơn thì người dùng ngồi đợi một thứ đã đằng nào cũng chết.
 */
const AN_HAN_SIGKILL_MS = 2_000;

/**
 * Trần bộ nhớ cho MỖI luồng (stdout, stderr).
 *
 * `exec` cũ có `maxBuffer` mặc định 1 MB và ném ENOBUFS khi vượt. Chuyển sang
 * `spawn` để giết được cả nhóm tiến trình thì mất luôn trần đó — đo thật: lệnh
 * xả 50 MB làm heap tăng 96 MB. Trên Jetson, một `find /` lạc đường là đủ giết
 * agent, mà người dùng chỉ thấy nó "treo".
 *
 * 5 MB rộng hơn hẳn trần hiển thị (16.000 ký tự) nên mọi kết quả thật vẫn được
 * giữ trọn để ghi ra đĩa; chỉ thứ chạy loạn mới bị chặn.
 */
const TRAN_LUONG_BYTE = 5 * 1024 * 1024;

interface TuyChonChay {
	cwd: string;
	timeout: number;
	signal?: AbortSignal;
}

/**
 * Chạy lệnh trong một NHÓM TIẾN TRÌNH riêng, và khi hết hạn thì giết CẢ NHÓM.
 *
 * VÌ SAO KHÔNG DÙNG `exec` VỚI TUỲ CHỌN `timeout`
 *
 * Tuỳ chọn `timeout` của Node chỉ giết ĐÚNG tiến trình con trực tiếp. Với lệnh
 * ghép (`cd x && dotnet build`) thì `sh` mới là con, còn `dotnet` là CHÁU —
 * giết `sh` xong `dotnet` vẫn sống.
 *
 * Tái hiện được: chạy `(sleep 25 &) && sleep 25` với hạn giờ 1,5 giây, sau khi
 * tool bỏ cuộc vẫn còn hai `sleep 25` trong bảng tiến trình.
 *
 * Hậu quả thật, và đây là lý do phải sửa: `dotnet build`/`dotnet test` bỏ lại
 * MSBuild worker và VBCSCompiler đang giữ khoá `bin/obj`. Lượt sau agent gọi
 * `FileEdit` lên đúng những tệp đó và nhận "being used by another process" —
 * do CHÍNH NÓ để lại ở lượt trước, chứ không phải người dùng mở IDE.
 *
 * Cách sửa: `detached: true` cho con làm trưởng nhóm, rồi `kill(-pid)` để tín
 * hiệu tới mọi con cháu. SIGTERM trước cho chúng kịp đóng tệp, SIGKILL sau.
 */
async function chayTheoNhom(
	argv: string[],
	t: TuyChonChay,
): Promise<{ stdout: string; stderr: string }> {
	return await new Promise((resolve, reject) => {
		const con = spawn(argv[0]!, argv.slice(1), {
			cwd: t.cwd,
			// Trưởng nhóm tiến trình — điều kiện để `kill(-pid)` với tới cả cháu.
			detached: true,
		});

		let stdout = "";
		let stderr = "";
		let daGiet = false;
		let tranVo = false;
		let henKill: ReturnType<typeof setTimeout> | null = null;

		/**
		 * Cộng chuỗi có trần. Vượt trần thì DỪNG HẲN lệnh: đã quá chỗ chứa rồi
		 * thì để nó chạy tiếp chỉ tốn CPU cho phần không ai đọc được.
		 */
		const gom = (cu: string, them: unknown): string => {
			if (cu.length >= TRAN_LUONG_BYTE) return cu;
			const moi = cu + String(them);
			if (moi.length < TRAN_LUONG_BYTE) return moi;
			if (!tranVo) {
				tranVo = true;
				daGiet = true;
				gietNhom("SIGTERM");
			}
			return moi.slice(0, TRAN_LUONG_BYTE);
		};

		con.stdout?.on("data", (d) => {
			stdout = gom(stdout, d);
		});
		con.stderr?.on("data", (d) => {
			stderr = gom(stderr, d);
		});

		/** Giết cả nhóm. `-pid` nghĩa là nhóm chứ không phải một tiến trình. */
		function gietNhom(tin: NodeJS.Signals): void {
			if (con.pid === undefined) return;
			try {
				process.kill(-con.pid, tin);
			} catch {
				// Nhóm đã chết, hoặc hệ không cho — thử giết riêng con là hết cách.
				try {
					con.kill(tin);
				} catch {
					// Không làm gì thêm được; để `close` chốt kết quả.
				}
			}
		}

		const hen = setTimeout(() => {
			daGiet = true;
			gietNhom("SIGTERM");
			henKill = setTimeout(() => gietNhom("SIGKILL"), AN_HAN_SIGKILL_MS);
			henKill.unref?.();
		}, t.timeout);
		hen.unref?.();

		const huy = () => {
			daGiet = true;
			gietNhom("SIGTERM");
		};
		t.signal?.addEventListener("abort", huy, { once: true });

		const don = () => {
			clearTimeout(hen);
			if (henKill) clearTimeout(henKill);
			t.signal?.removeEventListener("abort", huy);
		};

		con.on("error", (e) => {
			don();
			reject(e);
		});

		con.on("close", (ma) => {
			don();
			// Vượt trần thì NÓI RA — cắt im lặng là để model kết luận trên một
			// phần sự thật mà tưởng là toàn bộ.
			if (tranVo) {
				stdout += `\n[đầu ra vượt ${TRAN_LUONG_BYTE / 1048576} MB — lệnh đã bị dừng. Hãy lọc hẹp lại (grep, head, --quiet) rồi chạy lại.]`;
			}
			if (ma === 0 && !daGiet) {
				resolve({ stdout, stderr });
				return;
			}
			// Giữ nguyên hình dạng lỗi mà nhánh catch bên dưới đang trông đợi.
			reject(Object.assign(new Error(`exit ${ma}`), { stdout, stderr, code: ma ?? 1, killed: daGiet }));
		});
	});
}

export function taoBashTool(
	msMacDinh: number = TIMEOUT_MAC_DINH_MS,
): ToolDefinition<{ command: string; timeout?: number }, string> {
	return {
		name: "Bash",
		description: "Execute a bash/shell command and return stdout + stderr.",
		parameters: z.object({
			command: z.string().describe("The shell command to execute"),
			timeout: z.number().positive().optional().describe(`Timeout in ms (default ${msMacDinh})`),
		}),
		execute: async ({ command, timeout }, context) => {
			const chung = {
				cwd: context.cwd,
				timeout: timeout ?? msMacDinh,
				signal: context.signal,
			};

			// Có sandbox tầng nhân thì KHÔNG dùng shell của máy chủ nữa: bọc argv
			// rồi chạy thẳng. Đây là ranh giới cứng, chặn được cả lệnh mà
			// permission-engine viết sót luật.
			const argv = context.processSandbox
				? context.processSandbox.wrap(["/bin/sh", "-c", command])
				: ["/bin/sh", "-c", command];

			try {
				const { stdout, stderr } = await chayTheoNhom(argv, chung);
				return format(String(stdout), String(stderr), 0, false);
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
			maxDurationMs: msMacDinh,
			maxOutputSize: 100_000,
		},
	};
}

export const BashTool = taoBashTool();

const TRAN_OUTPUT = 100_000;

/**
 * Gộp output thành một chuỗi model đọc được.
 *
 * Mã thoát đứng ĐẦU và chỉ hiện khi ≠ 0: model phải biết lệnh hỏng ngay dòng
 * đầu, chứ không phải đoán từ nội dung. Cắt phần GIỮA thay vì phần cuối vì lỗi
 * biên dịch và tóm tắt test thường nằm ở cuối.
 */
function format(stdout: string, stderr: string, ma: number, bienGioi: boolean): string {
	const dau = bienGioi
		? `${DAU_BI_GIET} vì quá hạn giờ — mã thoát ${ma}]\n`
		: ma !== 0
			? `${DAU_MA_THOAT}${ma}]\n`
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
