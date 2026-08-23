/**
 * Nạp tri thức cho một phiên: rule, skill, và các nguồn nhắc đi kèm.
 *
 * Gộp vào một chỗ vì ba bước này phải đi cùng nhau và rất dễ quên bước cuối:
 * quét được rule có điều kiện mà không đăng ký nguồn nhắc thì rule nằm im trên
 * đĩa mãi mãi — hệ thống báo xanh, chính sách không bao giờ có hiệu lực. Đúng
 * kiểu hỏng mà air-gap không tha thứ, nên không để nơi gọi tự ráp.
 *
 * Thứ tự cũng có chủ ý: rule vào system prompt TRƯỚC chỉ mục skill. Rule là
 * chỉ dẫn bắt buộc, skill là danh mục để model tự chọn — thứ bắt buộc đứng gần
 * phần thân prompt hơn.
 */

import {
	type MemoryScanReport,
	type RuleDiscoveryReport,
	type SkillDiscoveryReport,
	type LichHen,
	SoTayViec,
	createScheduleTool,
	createTodoTool,
	installMemory,
	installRules,
	installSkills,
	nguonBoNhoLienQuan,
	nguonHenGio,
	nguonNhacTodo,
	nguonRuleTheoDuongDan,
	nguonSkillTheoDuongDan,
	summarizeMemoryReport,
	summarizeRuleReport,
	summarizeSkillReport,
} from "@agentweave/inner-harness";
import type { CauHinhAgent } from "./agent-config";

/** Phần tối thiểu của harness mà hàm này cần — cũng là hợp đồng để test giả lập. */
export interface HarnessNhanTriThuc {
	registerTool(tool: never): void;
	setSystemPromptSection(name: string, content: string | null): void;
	themNguonNhac(nguon: never): void;
	unregisterTool?(name: string): void;
	getTools?(): ReadonlyArray<{ name: string }>;
}

export interface TuyChonNapTriThuc {
	goc: string;
	cauHinh: CauHinhAgent;
	/** Bỏ qua skill (model không hỗ trợ tool thì LoadSkill vô dụng và gây lỗi 400). */
	boQuaSkill?: boolean;
	/**
	 * Người dùng bảo bỏ qua bộ nhớ trong phiên này.
	 *
	 * Bỏ qua nghĩa là không đặt gì vào prompt — không phải đặt vào rồi dặn model
	 * đừng dùng. Cách sau đã đo là hỏng: model thừa nhận rồi vẫn nhắc tới.
	 */
	boQuaBoNho?: boolean;
	/**
	 * Lịch hẹn của phiên. Có thì đăng ký tool `ScheduleTask` cho model đặt hẹn,
	 * và nguồn nhắc bắn việc đến hạn NGAY TRONG một lượt dài.
	 *
	 * Đồng hồ chính vẫn nằm ở CLI (xem lib/dong-ho-hen.ts) — nguồn nhắc ở đây
	 * chỉ là đường phụ cho lượt chạy lâu. Hai đường dùng chung một `LichHen` nên
	 * `dangChay`/`xong()` đã chống bắn kép sẵn.
	 */
	lichHen?: LichHen;
	/**
	 * Sổ tay việc của phiên. Có thì đăng ký tool TodoWrite và nguồn nhắc tiến độ.
	 *
	 * Đây là thứ chống lại kiểu hỏng "kể lể rồi hỏi suông": model có chỗ ghi kế
	 * hoạch, và bị kéo về danh sách khi nó trôi quá lâu.
	 */
	soTayViec?: SoTayViec;
	/** Lượt hiện tại của phiên — sổ tay dùng để biết danh sách cũ bao lâu rồi. */
	layLuot?: () => number;
	quiet?: boolean;
}

export interface KetQuaNapTriThuc {
	rule?: RuleDiscoveryReport;
	skill?: SkillDiscoveryReport;
	boNho?: MemoryScanReport;
	/** Một dòng cho bộ tự kiểm tra và cho `--verbose`. */
	tomTat: string[];
}

export async function napTriThuc(
	// biome-ignore lint/suspicious/noExplicitAny: hợp đồng cấu trúc, xem HarnessNhanTriThuc
	inner: any,
	t: TuyChonNapTriThuc,
): Promise<KetQuaNapTriThuc> {
	const ra: KetQuaNapTriThuc = { tomTat: [] };

	// ── Rule ──
	// Hỏng ở đây KHÔNG được làm chết phiên: người dùng gõ `agentweave chat` để
	// làm việc, không phải để nhận stack trace vì một tệp AGENTS.md sai cú pháp.
	try {
		const { registry, report } = await installRules(inner, {
			projectDir: t.goc,
			orgRulesDir: t.cauHinh.orgRulesDir ?? null,
			quiet: t.quiet ?? true,
		});
		ra.rule = report;
		ra.tomTat.push(`rule: ${summarizeRuleReport(report)}`);
		if (report.soCoDieuKien > 0) {
			inner.themNguonNhac(nguonRuleTheoDuongDan(registry));
		}
	} catch (err) {
		ra.tomTat.push(`rule: KHONG NAP DUOC — ${(err as Error).message}`);
	}

	// ── Skill ──
	if (!t.boQuaSkill) {
		try {
			const { registry, report } = await installSkills(inner, {
				projectDir: t.goc,
				orgSkillsDir: t.cauHinh.orgSkillsDir,
				contextWindow: t.cauHinh.contextWindow,
				quiet: t.quiet ?? true,
			});
			ra.skill = report;
			ra.tomTat.push(`skill: ${summarizeSkillReport(report)}`);
			if (report.soCoDieuKien > 0) {
				inner.themNguonNhac(nguonSkillTheoDuongDan(registry));
			}
		} catch (err) {
			ra.tomTat.push(`skill: KHONG NAP DUOC — ${(err as Error).message}`);
		}
	}

	// ── Hẹn giờ ──
	if (t.lichHen) {
		try {
			const daCo = inner.getTools?.().some((x: { name: string }) => x.name === "ScheduleTask");
			if (daCo) inner.unregisterTool?.("ScheduleTask");
			inner.registerTool(createScheduleTool(t.lichHen));
			inner.themNguonNhac(nguonHenGio(t.lichHen));
			ra.tomTat.push(`hen gio: ${t.lichHen.soViec} viec dang cho`);
		} catch (err) {
			ra.tomTat.push(`hen gio: KHONG NAP DUOC — ${(err as Error).message}`);
		}
	}

	// ── Danh sách việc ──
	if (t.soTayViec && t.cauHinh.danhSachViec === true) {
		try {
			const so = t.soTayViec;
			const daCo = inner.getTools?.().some((x: { name: string }) => x.name === "TodoWrite");
			if (daCo) inner.unregisterTool?.("TodoWrite");
			inner.registerTool(createTodoTool(so, t.layLuot ?? (() => 0)));
			inner.themNguonNhac(nguonNhacTodo(so));
			ra.tomTat.push(`viec: ${so.danhSach().length} muc${so.tomTat() ? ` (${so.tomTat()})` : ""}`);
		} catch (err) {
			ra.tomTat.push(`viec: KHONG NAP DUOC — ${(err as Error).message}`);
		}
	}

	// ── Bộ nhớ liên phiên ──
	// Recall tất định, không gọi model: air-gap có một model trên Jetson, mỗi
	// lượt gọi phụ là một lần người dùng ngồi chờ thêm.
	try {
		const { report, daBat } = await installMemory(inner, {
			projectDir: t.goc,
			boQua: t.boQuaBoNho,
			quiet: t.quiet ?? true,
		});
		ra.boNho = report;
		ra.tomTat.push(`bo nho: ${summarizeMemoryReport(report)}${daBat ? "" : " (bi bo qua)"}`);
		if (daBat && report.tep.length > 0) {
			inner.themNguonNhac(nguonBoNhoLienQuan(report));
		}
	} catch (err) {
		ra.tomTat.push(`bo nho: KHONG NAP DUOC — ${(err as Error).message}`);
	}

	return ra;
}
