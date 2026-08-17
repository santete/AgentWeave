/**
 * Test cho các zod schema trong guard.ts.
 *
 * Đây là logic THỜI GIAN CHẠY — trình biên dịch TypeScript không bảo vệ được.
 * Schema sai nghĩa là chính sách bảo mật được nạp sai mà không ai biết.
 */
import { describe, expect, it } from "vitest";
import { GuardConfigSchema, GuardDecisionSchema, HookInputSchema } from "../src/guard";

describe("GuardDecisionSchema", () => {
	it("chấp nhận quyết định hợp lệ", () => {
		expect(GuardDecisionSchema.parse({ decision: "approve" }).decision).toBe("approve");
		expect(GuardDecisionSchema.parse({ decision: "block", reason: "nguy hiểm" }).reason).toBe(
			"nguy hiểm",
		);
	});

	it("từ chối quyết định ngoài danh sách", () => {
		expect(() => GuardDecisionSchema.parse({ decision: "maybe" })).toThrow();
		expect(() => GuardDecisionSchema.parse({ decision: "allow" })).toThrow(); // dễ nhầm với permission
	});

	it("bắt buộc có trường decision", () => {
		expect(() => GuardDecisionSchema.parse({ reason: "thiếu decision" })).toThrow();
	});
});

describe("HookInputSchema", () => {
	it("chỉ bắt buộc tool_name", () => {
		const r = HookInputSchema.parse({ tool_name: "bash" });
		expect(r.tool_name).toBe("bash");
		expect(r.tool_input).toEqual({}); // mặc định object rỗng
	});

	it("từ chối khi thiếu tool_name", () => {
		expect(() => HookInputSchema.parse({ cwd: "/tmp" })).toThrow();
	});

	it("giới hạn hook_event_name trong danh sách cho phép", () => {
		expect(HookInputSchema.parse({ tool_name: "x", hook_event_name: "PreToolUse" })).toBeTruthy();
		expect(() =>
			HookInputSchema.parse({ tool_name: "x", hook_event_name: "OnToolCrash" }),
		).toThrow();
	});

	it("passthrough: giữ lại trường lạ thay vì vứt bỏ", () => {
		const r = HookInputSchema.parse({ tool_name: "bash", truong_moi: 42 }) as Record<
			string,
			unknown
		>;
		expect(r.truong_moi).toBe(42);
	});
});

describe("GuardConfigSchema — giá trị mặc định", () => {
	it("config rỗng vẫn nạp được, mode mặc định là default", () => {
		const c = GuardConfigSchema.parse({});
		expect(c.mode).toBe("default");
		expect(c.permissions).toEqual([]);
	});

	it("audit BẬT sẵn — không im lặng bỏ ghi log", () => {
		const c = GuardConfigSchema.parse({});
		expect(c.audit.enabled).toBe(true);
		expect(c.audit.path).toBe(".agentweave/audit.log");
	});

	it("🔒 envAllowlist mặc định RỖNG (fail-closed) — không lộ biến môi trường", () => {
		const c = GuardConfigSchema.parse({});
		expect(c.envAllowlist).toEqual([]);
	});

	it("chỉ 4 chế độ được chấp nhận", () => {
		for (const m of ["default", "strict", "permissive", "plan"]) {
			expect(GuardConfigSchema.parse({ mode: m }).mode).toBe(m);
		}
		expect(() => GuardConfigSchema.parse({ mode: "yolo" })).toThrow();
	});
});

describe("GuardConfigSchema — luật quyền", () => {
	it("priority mặc định 100", () => {
		const c = GuardConfigSchema.parse({
			permissions: [{ pattern: "bash:*", behavior: "deny" }],
		});
		expect(c.permissions[0].priority).toBe(100);
	});

	it("chỉ chấp nhận allow/deny/ask", () => {
		for (const b of ["allow", "deny", "ask"]) {
			expect(
				GuardConfigSchema.parse({ permissions: [{ pattern: "p", behavior: b }] })
					.permissions[0].behavior,
			).toBe(b);
		}
		expect(() =>
			GuardConfigSchema.parse({ permissions: [{ pattern: "p", behavior: "block" }] }),
		).toThrow(); // "block" là của GuardDecision, không phải permission
	});

	it("bắt buộc có pattern", () => {
		expect(() => GuardConfigSchema.parse({ permissions: [{ behavior: "deny" }] })).toThrow();
	});
});

describe("GuardConfigSchema — ngân sách", () => {
	it("warningThreshold mặc định 0.8 và phải nằm trong [0,1]", () => {
		expect(GuardConfigSchema.parse({ budget: {} }).budget?.warningThreshold).toBe(0.8);
		expect(() => GuardConfigSchema.parse({ budget: { warningThreshold: 1.5 } })).toThrow();
		expect(() => GuardConfigSchema.parse({ budget: { warningThreshold: -0.1 } })).toThrow();
	});

	it("hạn mức phải là số dương", () => {
		expect(() => GuardConfigSchema.parse({ budget: { maxPerSession: 0 } })).toThrow();
		expect(() => GuardConfigSchema.parse({ budget: { maxPerDay: -5 } })).toThrow();
		expect(GuardConfigSchema.parse({ budget: { maxPerSession: 10 } }).budget?.maxPerSession).toBe(
			10,
		);
	});

	it("costPerToolCall mặc định 0 và không được âm", () => {
		expect(GuardConfigSchema.parse({ budget: {} }).budget?.costPerToolCall).toBe(0);
		expect(() => GuardConfigSchema.parse({ budget: { costPerToolCall: -1 } })).toThrow();
	});
});
