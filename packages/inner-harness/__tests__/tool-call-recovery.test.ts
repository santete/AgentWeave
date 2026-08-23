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

describe("cuuToolCall — JSON tool_use NHÚNG giữa chữ (loop ngáo)", () => {
	const TEN = ["FileEdit", "FileRead", "Bash"];

	it("prose RỒI tới [{type:tool_use,...}] ở cuối — phải bóc và chạy", () => {
		const text =
			"Tôi thấy vẫn còn lỗi trong các file test. Tôi sẽ sửa lại:\n\n" +
			'[{"type":"tool_use","id":"call_5kx9m0jz","name":"FileRead","input":{"path":"Ticket.Domain/Entities/User.cs"}}]';
		const kq = cuuToolCall(text, TEN);
		expect(kq.toolCalls).toHaveLength(1);
		expect(kq.toolCalls[0].toolName).toBe("FileRead");
		expect(kq.toolCalls[0].toolInput).toEqual({ path: "Ticket.Domain/Entities/User.cs" });
		expect(kq.conLai).toContain("Tôi sẽ sửa lại");
		expect(kq.conLai).not.toContain("tool_use");
	});

	it("input lồng nhau + dấu } NẰM TRONG chuỗi — không làm lệch bộ đếm ngoặc", () => {
		const text =
			"Sửa file:\n" +
			'[{"type":"tool_use","name":"FileEdit","input":{"path":"a.cs","old_string":"if (x) { y }","new_string":"if (x) { z }"}}]';
		const kq = cuuToolCall(text, TEN);
		expect(kq.toolCalls).toHaveLength(1);
		expect(kq.toolCalls[0].toolInput).toMatchObject({ old_string: "if (x) { y }" });
	});

	it("nhiều tool_use trong một mảng nhúng", () => {
		const text =
			'Chạy các bước:\n[{"type":"tool_use","name":"Bash","input":{"command":"dotnet build"}},{"type":"tool_use","name":"FileRead","input":{"path":"x.cs"}}]';
		const kq = cuuToolCall(text, TEN);
		expect(kq.toolCalls).toHaveLength(2);
	});

	it("KHÔNG nuốt JSON dữ liệu bình thường (không phải tool)", () => {
		const text = 'Kết quả: [{"id":1,"name":"An"},{"id":2,"name":"Bình"}]';
		const kq = cuuToolCall(text, TEN);
		expect(kq.toolCalls).toHaveLength(0);
	});
});

// ─── boBocKhoiJson: gỡ vỏ JSON khi model nhả trọn câu cuối dạng content-block ──

import { boBocKhoiJson } from "../src/tool-call-recovery";

describe("boBocKhoiJson", () => {
	it("gỡ mảng text dùng key 'result' (đúng ca thật của qwen3-coder)", () => {
		const raw = '[{"type":"text","result":"Tôi đã build và test xong. 6 test đều pass."}]';
		expect(boBocKhoiJson(raw)).toBe("Tôi đã build và test xong. 6 test đều pass.");
	});

	it("gỡ mảng text dùng key 'text'", () => {
		expect(boBocKhoiJson('[{"type":"text","text":"xong"}]')).toBe("xong");
	});

	it("gỡ đối tượng đơn dùng key 'content'", () => {
		expect(boBocKhoiJson('{"type":"text","content":"ok"}')).toBe("ok");
	});

	it("gỡ được kể cả khi bọc trong ```json", () => {
		const raw = '```json\n[{"type":"text","result":"trong fence"}]\n```';
		expect(boBocKhoiJson(raw)).toBe("trong fence");
	});

	it("ghép nhiều block text bằng xuống dòng", () => {
		const raw = '[{"type":"text","text":"dòng 1"},{"type":"text","result":"dòng 2"}]';
		expect(boBocKhoiJson(raw)).toBe("dòng 1\ndòng 2");
	});

	it("KHÔNG đụng chữ thường", () => {
		const s = "Tôi đã build xong, 6 test pass.";
		expect(boBocKhoiJson(s)).toBe(s);
	});

	it("KHÔNG phá mảng dữ liệu thật (có 'name' → giữ nguyên)", () => {
		const s = '[{"id":1,"name":"Ticket"},{"id":2,"name":"User"}]';
		expect(boBocKhoiJson(s)).toBe(s);
	});

	it("KHÔNG đụng tool-call json (để recovery lo)", () => {
		const s = '[{"type":"tool_use","name":"Bash","input":{"command":"ls"}}]';
		expect(boBocKhoiJson(s)).toBe(s);
	});

	it("JSON hỏng → trả nguyên văn", () => {
		const s = '[{"type":"text","result":"thiếu ngoặc"';
		expect(boBocKhoiJson(s)).toBe(s);
	});
});

// ─── Parse nới lỏng: FileWrite markdown có xuống dòng THÔ (ca thật trong ảnh) ──

describe("cuuToolCall — tool_use JSON có control char thô trong content", () => {
	// content markdown nhiều dòng, xuống dòng THÔ (không \\n) → JSON.parse chết.
	const contentThua = `# Workthrough Phase 1
## Task 1: Database Schema
- [x] All tables created
- [x] Indexes added`;

	it("cứu được FileWrite dù content có newline thô", () => {
		const raw = `[{"type":"tool_use","id":"call_7053298","name":"FileWrite","input":{"path":"phase01.md","content":${JSON.stringify(
			contentThua,
		).replace(/\\n/g, "\n")}}}]`;
		// (thay \\n đã escape bằng newline THÔ để mô phỏng đúng lỗi model)
		const kq = cuuToolCall(raw, TOOL);
		expect(kq.toolCalls).toHaveLength(1);
		expect(kq.toolCalls[0]!.toolName).toBe("FileWrite");
		expect(kq.toolCalls[0]!.toolInput.path).toBe("phase01.md");
		expect(String(kq.toolCalls[0]!.toolInput.content)).toContain("Database Schema");
		// Nội dung nhiều dòng phải giữ nguyên xuống dòng.
		expect(String(kq.toolCalls[0]!.toolInput.content).split("\n").length).toBeGreaterThan(2);
	});

	it("cứu được cả khi có văn xuôi trước khối (bocJsonNhung)", () => {
		const raw = `Tôi sẽ tạo file với tên đúng là phase01.md:
[{"type":"tool_use","id":"call_1","name":"FileWrite","input":{"path":"phase01.md","content":"# Tiêu đề
dòng 2"}}]`;
		const kq = cuuToolCall(raw, TOOL);
		expect(kq.toolCalls).toHaveLength(1);
		expect(kq.toolCalls[0]!.toolName).toBe("FileWrite");
		expect(String(kq.toolCalls[0]!.toolInput.content)).toContain("dòng 2");
	});

	it("JSON đã đúng (content escape chuẩn) vẫn parse như thường", () => {
		const raw = `[{"type":"tool_use","id":"c","name":"FileWrite","input":{"path":"a.md","content":"x\\ny"}}]`;
		const kq = cuuToolCall(raw, TOOL);
		expect(kq.toolCalls).toHaveLength(1);
		expect(kq.toolCalls[0]!.toolInput.content).toBe("x\ny");
	});
});
