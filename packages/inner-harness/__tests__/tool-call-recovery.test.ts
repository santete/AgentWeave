/**
 * Test bộ cứu tool-call.
 *
 * Các chuỗi dưới đây là output THẬT của qwen3-coder:30b chạy qua Ollama trên
 * máy này, không phải ví dụ bịa. Cùng một phiên làm việc sinh ra cả hai khuôn.
 */

import { describe, it, expect } from "vitest";
import { cuuToolCall } from "../src/tool-call-recovery";

const TOOL = ["Bash", "FileRead", "FileWrite", "FileEdit", "Grep", "Glob"];

describe("cuuToolCall — khuôn Hermes XML", () => {
	// Nguyên văn lượt 4 của bài chạy thật trên repo giỏ hàng.
	const THAT = `Tôi sẽ giúp bạn chạy các test và sửa lỗi trong file \`src/gio-hang.js\`. Đầu tiên, hãy kiểm tra xem có test nào đang fail không bằng cách chạy lệnh \`node --test test/\`.
<function=Bash>
<parameter=command>
node --test test/
</parameter>
</function>
</tool_call>`;

	it("bóc được lời gọi từ output thật của model", () => {
		const kq = cuuToolCall(THAT, TOOL);

		expect(kq.khuon).toBe("hermes-xml");
		expect(kq.toolCalls).toHaveLength(1);
		expect(kq.toolCalls[0]!.toolName).toBe("Bash");
		expect(kq.toolCalls[0]!.toolInput).toEqual({ command: "node --test test/" });
	});

	it("giữ lại lời giải thích, bỏ khối tool-call và thẻ đóng mồ côi", () => {
		const kq = cuuToolCall(THAT, TOOL);

		expect(kq.conLai).toContain("Tôi sẽ giúp bạn chạy các test");
		expect(kq.conLai).not.toContain("<function=");
		expect(kq.conLai).not.toContain("</tool_call>");
	});

	it("bóc được nhiều lời gọi và nhiều tham số", () => {
		const kq = cuuToolCall(
			`<function=FileEdit><parameter=path>src/a.js</parameter>` +
				`<parameter=old_string>x</parameter><parameter=new_string>y</parameter></function>` +
				`<function=Bash><parameter=command>ls</parameter></function>`,
			TOOL,
		);

		expect(kq.toolCalls).toHaveLength(2);
		expect(kq.toolCalls[0]!.toolInput).toEqual({
			path: "src/a.js",
			old_string: "x",
			new_string: "y",
		});
		expect(kq.toolCalls[1]!.toolName).toBe("Bash");
	});

	it("tham số dạng object được parse, chuỗi thường giữ nguyên", () => {
		const kq = cuuToolCall(
			`<function=Bash><parameter=command>echo 123</parameter>` +
				`<parameter=env>{"A":1}</parameter></function>`,
			TOOL,
		);

		expect(kq.toolCalls[0]!.toolInput).toEqual({ command: "echo 123", env: { A: 1 } });
	});

	it("số dạng chuỗi KHÔNG bị đổi kiểu — command='123' phải còn là chuỗi", () => {
		const kq = cuuToolCall(`<function=Bash><parameter=command>123</parameter></function>`, TOOL);
		expect(kq.toolCalls[0]!.toolInput.command).toBe("123");
	});
});

describe("cuuToolCall — khuôn JSON", () => {
	// Nguyên văn lượt 2 và 3 của bài chạy thật.
	it("bóc được mảng content có tool_use", () => {
		const that = `[{"type":"text","text":"Let me try a different approach."},{"type":"tool_use","id":"call_1753286d","name":"Bash","input":{"command":"find . -name \\"*.js\\""}}]`;
		const kq = cuuToolCall(that, TOOL);

		expect(kq.khuon).toBe("json-block");
		expect(kq.toolCalls).toHaveLength(1);
		expect(kq.toolCalls[0]!.toolUseId).toBe("call_1753286d");
		expect(kq.toolCalls[0]!.toolInput).toEqual({ command: 'find . -name "*.js"' });
		expect(kq.conLai).toBe("Let me try a different approach.");
	});

	it("nhận dạng {name, arguments} trong thẻ tool_call", () => {
		const kq = cuuToolCall(
			`<tool_call>{"name":"Glob","arguments":{"pattern":"src/**/*.ts"}}</tool_call>`,
			TOOL,
		);

		expect(kq.khuon).toBe("tool_call-json");
		expect(kq.toolCalls[0]!.toolName).toBe("Glob");
		expect(kq.toolCalls[0]!.toolInput).toEqual({ pattern: "src/**/*.ts" });
	});

	it("arguments dạng chuỗi JSON cũng parse được", () => {
		const kq = cuuToolCall(`{"name":"Bash","arguments":"{\\"command\\":\\"ls\\"}"}`, TOOL);
		expect(kq.toolCalls[0]!.toolInput).toEqual({ command: "ls" });
	});

	it("bỏ được rào ```json", () => {
		const kq = cuuToolCall('```json\n{"name":"Bash","arguments":{"command":"ls"}}\n```', TOOL);
		expect(kq.toolCalls).toHaveLength(1);
	});
});

describe("cuuToolCall — chống nhận nhầm", () => {
	it("tên tool KHÔNG đăng ký thì không nhận", () => {
		const kq = cuuToolCall(`<function=XoaHetO Cung><parameter=x>1</parameter></function>`, TOOL);
		expect(kq.toolCalls).toHaveLength(0);
	});

	it("tool lạ trong khuôn hợp lệ vẫn bị từ chối", () => {
		const kq = cuuToolCall(`<function=SendEmail><parameter=to>ai@do.com</parameter></function>`, TOOL);
		expect(kq.toolCalls).toHaveLength(0);
		expect(kq.khuon).toBeNull();
	});

	it("văn xuôi nhắc tên tool không bị coi là lời gọi", () => {
		const chu = "Tôi sẽ dùng Bash để chạy test, rồi FileEdit để sửa file. Bạn thấy ổn không?";
		const kq = cuuToolCall(chu, TOOL);

		expect(kq.toolCalls).toHaveLength(0);
		expect(kq.conLai).toBe(chu);
	});

	it("khối mã minh hoạ cú pháp không bị nhận nhầm", () => {
		const kq = cuuToolCall("Ví dụ: `Bash({command: 'ls'})` là cách gọi.", TOOL);
		expect(kq.toolCalls).toHaveLength(0);
	});

	it("chuỗi rỗng và danh sách tool rỗng đều an toàn", () => {
		expect(cuuToolCall("", TOOL).toolCalls).toHaveLength(0);
		expect(cuuToolCall("<function=Bash><parameter=command>ls</parameter></function>", []).toolCalls)
			.toHaveLength(0);
	});

	it("JSON hỏng không làm ném lỗi", () => {
		expect(() => cuuToolCall('{"name":"Bash", KHONG PHAI JSON', TOOL)).not.toThrow();
		expect(cuuToolCall('{"name":"Bash", KHONG PHAI JSON', TOOL).toolCalls).toHaveLength(0);
	});
});
