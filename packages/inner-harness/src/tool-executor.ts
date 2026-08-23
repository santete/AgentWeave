/**
 * REFERENCE IMPLEMENTATION — not production path (post-pivot 2026-04-22).
 *
 * In production, tool execution happens inside the target agent (Claude Code,
 * Cursor, etc.) — AgentWeave governs via hooks and adapters. See
 * product-spec/POSITIONING.md. This executor is kept for the reference
 * agent-loop and outer-harness test infrastructure.
 *
 * ---
 *
 * ToolExecutor — Executes tool calls with partition strategy.
 * Read-only tools run concurrently; write tools run serially.
 */

import { resolve, normalize } from "node:path";
import type { ToolContext, ToolResult, SandboxConfig } from "@agentweave/types";
import { ToolRegistry } from "./tool-registry";
import { catKetQua, chuanHoaThamSo, dienGiaiLoiZod, loiToolKhongCo } from "./tool-contract";
import {
	TRAN_MOI_TOOL,
	apTranTongLuot,
	ghiKetQuaRaDia,
	thongBaoDaGhi,
} from "./tool-result-store";

export interface ToolCall {
	toolUseId: string;
	toolName: string;
	toolInput: Record<string, unknown>;
}

export interface ToolCallResult {
	toolUseId: string;
	toolName: string;
	result: unknown;
	isError: boolean;
	durationMs: number;
}

interface Batch {
	concurrent: boolean;
	calls: ToolCall[];
}

/** Partition tool calls into batches: concurrent for read-only, serial for writes. */
export function partitionToolCalls(
	calls: ToolCall[],
	registry: ToolRegistry,
): Batch[] {
	const batches: Batch[] = [];

	for (const call of calls) {
		const tool = registry.get(call.toolName);
		const isSafe = tool?.metadata.isConcurrencySafe ?? false;

		const lastBatch = batches.at(-1);
		if (lastBatch && lastBatch.concurrent === isSafe) {
			lastBatch.calls.push(call);
		} else {
			batches.push({ concurrent: isSafe, calls: [call] });
		}
	}

	return batches;
}

export class ToolExecutor {
	constructor(
		private registry: ToolRegistry,
		private context: ToolContext,
	) {}

	async execute(calls: ToolCall[]): Promise<ToolCallResult[]> {
		const batches = partitionToolCalls(calls, this.registry);
		const results: ToolCallResult[] = [];

		for (const batch of batches) {
			if (batch.concurrent) {
				const batchResults = await Promise.all(
					batch.calls.map((call) => this.executeSingle(call)),
				);
				results.push(...batchResults);
			} else {
				for (const call of batch.calls) {
					const result = await this.executeSingle(call);
					results.push(result);
				}
			}
		}

		// Trần TỔNG cả lượt. Trần mỗi tool không đủ: mười tool song song, mỗi cái
		// 15 KB đều dưới trần, cộng lại vẫn 150 KB vào cửa sổ 64K.
		await this.apTranTong(results);
		return results;
	}

	/** Ghi ra đĩa từ kết quả to nhất xuống, cho tới khi tổng cả lượt vừa trần. */
	private async apTranTong(results: ToolCallResult[]): Promise<void> {
		const chu = results
			.filter((r) => typeof r.result === "string")
			.map((r) => ({ toolUseId: r.toolUseId, noiDung: r.result as string }));
		if (chu.length === 0) return;

		const thay = await apTranTongLuot(chu, this.context.cwd, this.context.sessionId);
		if (thay.size === 0) return;

		for (const r of results) {
			const moi = thay.get(r.toolUseId);
			if (moi !== undefined) r.result = moi;
		}
	}

	/**
	 * Kết quả vượt trần thì ghi ra đĩa và trả về bản xem trước.
	 *
	 * Ghi hỏng (đĩa đầy, chỉ đọc) thì lùi về cắt như cũ — mất phần đuôi vẫn hơn
	 * là để nguyên khối 300 KB tràn cửa sổ, và bản cắt vẫn nói rõ là đã cắt.
	 */
	private async thuGon(noi: string, toolUseId: string, tranTool?: number): Promise<string> {
		// Trần hệ thống LUÔN thắng: một tool khai 200.000 vẫn không được phép đẩy
		// từng đó vào cửa sổ 64K. Khai báo của tool chỉ dùng để siết CHẶT hơn.
		const tran = Math.min(tranTool ?? TRAN_MOI_TOOL, TRAN_MOI_TOOL);
		if (noi.length <= tran) return noi;

		const ghi = await ghiKetQuaRaDia(noi, toolUseId, this.context.cwd, this.context.sessionId);
		return ghi ? thongBaoDaGhi(ghi) : catKetQua(noi, tran);
	}

	private async executeSingle(call: ToolCall): Promise<ToolCallResult> {
		const tool = this.registry.get(call.toolName);
		const start = performance.now();

		if (!tool) {
			// Nêu tên gần nhất + danh sách tool có thật. Bản trước chỉ nói "not
			// found", nên model cục bộ gõ sai một chữ sẽ thử lại đúng cái tên sai
			// đó ở lượt sau — không có gì trong câu trả lời gợi cho nó tên đúng.
			return {
				toolUseId: call.toolUseId,
				toolName: call.toolName,
				result: loiToolKhongCo(call.toolName, this.registry.names()),
				isError: true,
				durationMs: performance.now() - start,
			};
		}

		try {
			// Sandbox: check file paths in tool input against allowed/denied
			if (this.context.sandbox) {
				const violation = checkSandbox(call.toolInput, this.context.sandbox, this.context.cwd);
				if (violation) {
					return {
						toolUseId: call.toolUseId,
						toolName: call.toolName,
						result: `Sandbox violation: ${violation}`,
						isError: true,
						durationMs: performance.now() - start,
					};
				}
			}

			// Sửa các kiểu lệch vô hại TRƯỚC khi kiểm tra: model cục bộ hay gửi
			// "10" thay vì 10, hoặc bọc thêm một lớp {"input": {...}}. Từ chối vì
			// những thứ đó là bắt cả hai bên trả giá cho một lỗi ai cũng thấy.
			const { thamSo, daSua } = chuanHoaThamSo(call.toolInput, tool.parameters);

			const kiemTra = tool.parameters.safeParse(thamSo);
			if (!kiemTra.success) {
				return {
					toolUseId: call.toolUseId,
					toolName: call.toolName,
					// `err.message` của zod là một mảng JSON — model 30B không suy ra
					// được "thiếu tham số path" từ đó, nó thử lại y hệt rồi bỏ cuộc.
					result: dienGiaiLoiZod(call.toolName, kiemTra.error),
					isError: true,
					durationMs: performance.now() - start,
				};
			}

			const result = await tool.execute(kiemTra.data, this.context);
			const tho =
				typeof result === "object" && result !== null && "data" in result
					? (result as ToolResult).data
					: result;

			// Kết quả quá lớn thì GHI RA ĐĨA, không cắt: cắt là mất hẳn phần đuôi,
			// còn ghi đĩa chỉ dời chỗ — model lấy lại bằng FileRead/Grep. Trần lấy
			// theo `maxOutputSize` của tool nhưng không bao giờ vượt trần hệ thống.
			const dulieu =
				typeof tho === "string"
					? await this.thuGon(tho, call.toolUseId, tool.metadata.maxOutputSize)
					: tho;

			// Có sửa thì NÓI RA. Sửa ngầm thì model không bao giờ học được khuôn
			// đúng và lượt sau lại sai y nguyên — trả tiền sửa mãi thay vì một lần.
			return {
				toolUseId: call.toolUseId,
				toolName: call.toolName,
				result: daSua.length > 0 ? themGhiChuSua(dulieu, daSua) : dulieu,
				isError: false,
				durationMs: performance.now() - start,
			};
		} catch (err) {
			return {
				toolUseId: call.toolUseId,
				toolName: call.toolName,
				// Lỗi thì CẮT chứ không ghi đĩa: phần cần nhất của một lỗi nằm ở hai
				// đầu (lệnh đã chạy, và dòng lỗi cuối), mà `catKetQua` giữ đúng cả
				// hai. Ghi ra tệp mỗi lần lỗi chỉ tổ rác đĩa cho thứ hiếm khi đọc lại.
				result: catKetQua(
					err instanceof Error ? err.message : "Unknown tool error",
					Math.min(tool.metadata.maxOutputSize ?? TRAN_MOI_TOOL, TRAN_MOI_TOOL),
				),
				isError: true,
				durationMs: performance.now() - start,
			};
		}
	}
}

// ─── Sandbox Path Checking ──────────────────────────────────────

const DEFAULT_DENIED = ["/etc", "/var", "/root", "/sys", "/proc"];
const SENSITIVE_GLOBS = [".env", ".ssh", ".aws", ".gnupg", "credentials"];

/**
 * Check tool input for sandbox violations.
 * LIMITATION: Only inspects known field names (path, file_path, filePath, file,
 * directory, command). Tools with custom path field names (e.g. target, destination)
 * bypass this check. Post-MVP: let tools declare path fields in metadata.
 */
function checkSandbox(
	input: Record<string, unknown>,
	sandbox: SandboxConfig,
	cwd: string,
): string | null {
	const paths: string[] = [];
	for (const key of ["path", "file_path", "filePath", "file", "directory", "command"]) {
		const val = input[key];
		if (typeof val === "string") {
			// For commands, extract paths heuristically
			if (key === "command") {
				// Extract file-like args from shell commands
				const tokens = val.split(/\s+/);
				for (const t of tokens) {
					if (t.startsWith("/") || t.startsWith("./") || t.startsWith("../") || t.includes(".env")) {
						paths.push(t);
					}
				}
			} else {
				paths.push(val);
			}
		}
	}

	if (paths.length === 0) return null;

	for (const p of paths) {
		const abs = resolve(cwd, normalize(p));

		// Check denied paths (explicit + defaults)
		const denied = [...DEFAULT_DENIED, ...(sandbox.deniedPaths ?? [])];
		for (const d of denied) {
			if (abs.startsWith(resolve(d)) || abs.startsWith(resolve(cwd, d))) {
				return `Access denied to "${p}" (matches denied path "${d}")`;
			}
		}

		// Check sensitive file patterns
		for (const s of SENSITIVE_GLOBS) {
			if (abs.includes(s)) {
				return `Access denied to "${p}" (sensitive pattern "${s}")`;
			}
		}

		// Check allowed paths (if specified, only these are permitted)
		if (sandbox.allowedPaths && sandbox.allowedPaths.length > 0) {
			const allowed = sandbox.allowedPaths.some((a) =>
				abs.startsWith(resolve(cwd, a)) || abs.startsWith(resolve(a)),
			);
			if (!allowed) {
				return `Access denied to "${p}" (not in allowed paths)`;
			}
		}
	}

	return null;
}

/**
 * Gắn ghi chú "đã tự sửa gì" lên đầu kết quả.
 *
 * Đặt TRƯỚC nội dung chứ không phải sau: kết quả tool có thể dài và bị nén ở
 * lượt sau, phần đuôi mất trước. Lời dạy khuôn đúng phải nằm ở chỗ sống lâu nhất.
 */
function themGhiChuSua(dulieu: unknown, daSua: ReadonlyArray<string>): unknown {
	const ghi =
		`[arguments auto-corrected — send them correctly next time]\n` +
		daSua.map((d) => `- ${d}`).join("\n");
	return typeof dulieu === "string" ? `${ghi}\n\n${dulieu}` : `${ghi}\n\n${JSON.stringify(dulieu)}`;
}
