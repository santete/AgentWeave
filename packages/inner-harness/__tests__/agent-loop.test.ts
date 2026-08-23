import { describe, it, expect, vi } from "vitest";
import { z } from "zod";
import { createControlPlane } from "@agentweave/control-plane";
import type { ToolDefinition, InnerEvent } from "@agentweave/types";
import { AgentLoop } from "../src/agent-loop";
import { createMockLLMCaller, MockScenarios } from "../src/mock-llm";

function makeReadTool(name: string): ToolDefinition {
	return {
		name,
		description: `Read tool: ${name}`,
		parameters: z.object({}).passthrough(),
		execute: async () => `content of ${name}`,
		metadata: {
			isReadOnly: true,
			isDestructive: false,
			isConcurrencySafe: true,
			category: "file",
		},
	};
}

async function collectEvents(
	gen: AsyncGenerator<InnerEvent, unknown, void>,
): Promise<InnerEvent[]> {
	const events: InnerEvent[] = [];
	for await (const event of gen) {
		events.push(event);
	}
	return events;
}

describe("AgentLoop", () => {
	it("should complete with no tools when LLM returns text only", async () => {
		const cp = createControlPlane({ failMode: "open" });
		const loop = new AgentLoop({ controlPlane: cp, model: "mock" });
		loop.setLLMCaller(createMockLLMCaller(MockScenarios.simpleResponse));

		const events = await collectEvents(loop.run("Hello"));

		const terminal = events.find((e) => e.type === "terminal");
		expect(terminal).toBeDefined();
		expect(terminal!.type === "terminal" && terminal!.reason).toBe("completed");

		expect(loop.getState().status).toBe("completed");
	});

	it("gọi LLM hỏng phải kết thúc bằng reason 'error', KHÔNG phải 'completed'", async () => {
		// Bản trước nuốt lỗi và trả kết quả rỗng, nên endpoint sai vẫn báo
		// "completed" với 0 token — nhìn y hệt một câu trả lời rỗng hợp lệ.
		// Trong air-gap thì đây là kiểu lỗi tốn cả ngày mới truy ra.
		const loop = new AgentLoop({ model: "mock" });
		loop.setLLMCaller(async () => {
			throw new Error("Failed to parse URL from 127.0.0.1:11434/v1/chat/completions");
		});

		const events = await collectEvents(loop.run("Hello"));

		const terminal = events.find((e) => e.type === "terminal");
		expect(terminal!.type === "terminal" && terminal!.reason).toBe("error");

		const err = events.find((e) => e.type === "error");
		expect(err).toBeDefined();
		expect(err!.type === "error" && err!.error).toContain("Failed to parse URL");
	});

	it("should execute tool calls and loop back to LLM", async () => {
		const cp = createControlPlane({ failMode: "open" });
		const loop = new AgentLoop({
			controlPlane: cp,
			model: "mock",
			tools: [makeReadTool("FileRead")],
		});
		loop.setLLMCaller(createMockLLMCaller(MockScenarios.readThenRespond));

		const events = await collectEvents(loop.run("Read test.ts"));

		// Should have: turn:start, llm events, tool:requested, permission:allowed,
		// tool:completed, tool_result, turn:end, then second turn with terminal
		const toolCompleted = events.find((e) => e.type === "tool:completed");
		expect(toolCompleted).toBeDefined();

		const terminal = events.find((e) => e.type === "terminal");
		expect(terminal!.type === "terminal" && terminal!.reason).toBe("completed");

		// Should have 2 turns
		const turnStarts = events.filter((e) => e.type === "turn:start");
		expect(turnStarts).toHaveLength(2);
	});

	it("should deny tool via control plane interceptor", async () => {
		const cp = createControlPlane();
		// Register deny interceptor
		cp.registerInterceptor("tool_request", async (req) => ({
			behavior: "deny" as const,
			reason: "Blocked by test",
			source: "test",
		}));

		const loop = new AgentLoop({
			controlPlane: cp,
			model: "mock",
			tools: [makeReadTool("FileRead")],
		});
		loop.setLLMCaller(createMockLLMCaller(MockScenarios.readThenRespond));

		const events = await collectEvents(loop.run("Read test.ts"));

		const denied = events.find((e) => e.type === "permission:denied");
		expect(denied).toBeDefined();
		if (denied?.type === "permission:denied") {
			expect(denied.reason).toBe("Blocked by test");
		}
	});

	it("should track token usage across turns", async () => {
		const cp = createControlPlane({ failMode: "open" });
		const loop = new AgentLoop({
			controlPlane: cp,
			model: "mock",
			tools: [makeReadTool("FileRead")],
		});
		loop.setLLMCaller(createMockLLMCaller(MockScenarios.readThenRespond));

		await collectEvents(loop.run("Read file"));

		const usage = loop.getUsage();
		// Mock returns 100 input + 50 output per call, 2 calls
		expect(usage.inputTokens).toBe(200);
		expect(usage.outputTokens).toBe(100);
	});

	it("should stop at max turns", async () => {
		const cp = createControlPlane({ failMode: "open" });
		const loop = new AgentLoop({
			controlPlane: cp,
			model: "mock",
			maxTurns: 2,
			tools: [makeReadTool("FileRead")],
		});

		// LLM always requests tools — will never terminate naturally
		const infiniteResponses = Array.from({ length: 10 }, () => ({
			toolCalls: [{ toolName: "FileRead", toolInput: { path: "x.ts" } }],
		}));
		loop.setLLMCaller(createMockLLMCaller(infiniteResponses));

		const events = await collectEvents(loop.run("Loop forever"));

		const terminal = events.find((e) => e.type === "terminal");
		expect(terminal).toBeDefined();
		if (terminal?.type === "terminal") {
			expect(terminal.reason).toBe("max_turns");
		}
	});

	it("should abort when abort() is called", async () => {
		const cp = createControlPlane({ failMode: "open" });
		const loop = new AgentLoop({
			controlPlane: cp,
			model: "mock",
			tools: [makeReadTool("FileRead")],
		});

		// Slow LLM — gives time to abort
		loop.setLLMCaller(async () => {
			await new Promise((r) => setTimeout(r, 100));
			return {
				toolCalls: [{ toolUseId: "t1", toolName: "FileRead", toolInput: {} }],
				stopReason: "tool_use",
			};
		});

		// Abort after 50ms
		setTimeout(() => loop.abort("test abort"), 50);

		const events = await collectEvents(loop.run("Do something"));

		expect(loop.getState().status).toBe("aborted");
	});

	it("should handle pause/resume via commands", async () => {
		const cp = createControlPlane({ failMode: "open" });
		const loop = new AgentLoop({ controlPlane: cp, model: "mock" });
		loop.setLLMCaller(createMockLLMCaller(MockScenarios.simpleResponse));

		// Test command handler
		const pauseAck = await cp.sendCommand({ type: "pause" });
		expect(pauseAck.accepted).toBe(true);
		expect(loop.getState().status).toBe("paused");

		const resumeAck = await cp.sendCommand({ type: "resume" });
		expect(resumeAck.accepted).toBe(true);
		expect(loop.getState().status).toBe("running");
	});

	it("should reject input via input gate", async () => {
		const cp = createControlPlane();
		cp.registerInterceptor("input_received", async () => ({
			action: "reject" as const,
			reason: "Input rejected by test",
		}));

		const loop = new AgentLoop({ controlPlane: cp, model: "mock" });
		loop.setLLMCaller(createMockLLMCaller(MockScenarios.simpleResponse));

		const gen = loop.run("bad input");
		const events: InnerEvent[] = [];
		let result: unknown;
		while (true) {
			const { value, done } = await gen.next();
			if (done) {
				result = value;
				break;
			}
			events.push(value);
		}

		expect(result).toEqual({ reason: "input_rejected" });
	});

	it("should throw if run() is called twice", async () => {
		const cp = createControlPlane({ failMode: "open" });
		const loop = new AgentLoop({ controlPlane: cp, model: "mock" });
		loop.setLLMCaller(createMockLLMCaller(MockScenarios.simpleResponse));

		await collectEvents(loop.run("First run"));

		// Second run should throw with helpful message
		await expect(async () => {
			await collectEvents(loop.run("Second run"));
		}).rejects.toThrow("createHarness()");
	});

	it("should stop when budget is exceeded", async () => {
		const cp = createControlPlane({ failMode: "open" });
		const loop = new AgentLoop({
			controlPlane: cp,
			model: "mock",
			tools: [makeReadTool("FileRead")],
		});

		// Each call: 100 input + 50 output tokens
		// Sonnet default pricing: ~$3/M input + $15/M output
		// To trigger budget, use a very low budget
		const manyToolCalls = Array.from({ length: 10 }, () => ({
			toolCalls: [{ toolName: "FileRead", toolInput: { path: "x.ts" } }],
		}));
		loop.setLLMCaller(createMockLLMCaller(manyToolCalls));

		const events = await collectEvents(
			loop.run("Do lots of work", { maxBudgetUsd: 0.0001 }),
		);

		const terminal = events.find((e) => e.type === "terminal");
		expect(terminal).toBeDefined();
		if (terminal?.type === "terminal") {
			expect(terminal.reason).toBe("budget_exceeded");
		}
	});
});

describe("AgentLoop — phát hiện loop", () => {
	it("cắt LOOP khi model lặp cùng một lệnh liên tiếp (không đốt tới maxTurns)", async () => {
		const cp = createControlPlane({ failMode: "open" });
		const loop = new AgentLoop({ controlPlane: cp, model: "mock", tools: [makeReadTool("Grep")] });
		// Mô phỏng model quẩn tại chỗ: lượt nào cũng gọi Grep y hệt.
		loop.setLLMCaller(async () => ({
			text: "",
			toolCalls: [
				{ toolUseId: "t", toolName: "Grep", toolInput: { pattern: "Phase 1", path: "plan.md" } },
			],
			stopReason: "tool_use",
			usage: { inputTokens: 10, outputTokens: 5 },
		}));
		const events = await collectEvents(loop.run("rà soát"));
		const terminal = events.find((e) => e.type === "terminal");
		expect(terminal && terminal.type === "terminal" && terminal.reason).toBe("loop");
		// Cắt SỚM — dưới 6 lần thực thi, không tới maxTurns.
		const soThucThi = events.filter((e) => e.type === "tool:requested").length;
		expect(soThucThi).toBeLessThan(6);
		// Có nudge cảnh báo loop cho model.
		const nudge = events.find(
			(e) => e.type === "recovery:retry" && String((e as { reason?: string }).reason).includes("loop"),
		);
		expect(nudge).toBeTruthy();
	});
});

describe("AgentLoop — loop detection phủ cả Bash, tha khi có tiến triển", () => {
	function makeTool(name: string): ToolDefinition {
		return {
			name,
			description: name,
			parameters: z.object({}).passthrough(),
			execute: async () => `${name} ok`,
			metadata: { isReadOnly: false, isDestructive: false, isConcurrencySafe: true, category: "file" },
		};
	}

	it("Bash đọc-lặp (ls -la mãi) bị cắt reason loop — hết lỗ miễn trừ", async () => {
		const cp = createControlPlane({ failMode: "open" });
		const loop = new AgentLoop({ controlPlane: cp, model: "mock", tools: [makeTool("Bash")] });
		loop.setLLMCaller(async () => ({
			text: "",
			toolCalls: [{ toolUseId: "t", toolName: "Bash", toolInput: { command: "ls -la" } }],
			stopReason: "tool_use",
			usage: { inputTokens: 5, outputTokens: 2 },
		}));
		const events = await collectEvents(loop.run("xem thư mục"));
		const terminal = events.find((e) => e.type === "terminal");
		expect(terminal && terminal.type === "terminal" && terminal.reason).toBe("loop");
	});

	it("build/test lặp XEN KẼ FileWrite KHÔNG bị chặn (tiến triển xoá bộ đếm)", async () => {
		const cp = createControlPlane({ failMode: "open" });
		const loop = new AgentLoop({
			controlPlane: cp,
			model: "mock",
			tools: [makeTool("Bash"), makeTool("FileWrite")],
		});
		let lan = 0;
		loop.setLLMCaller(async () => {
			lan++;
			if (lan > 8) {
				return { text: "xong", stopReason: "end_turn", usage: { inputTokens: 5, outputTokens: 2 } };
			}
			return {
				text: "",
				toolCalls:
					lan % 2 === 1
						? [{ toolUseId: `w${lan}`, toolName: "FileWrite", toolInput: { path: "a.md", content: `v${lan}` } }]
						: [{ toolUseId: `b${lan}`, toolName: "Bash", toolInput: { command: "dotnet test" } }],
				stopReason: "tool_use",
				usage: { inputTokens: 5, outputTokens: 2 },
			};
		});
		const events = await collectEvents(loop.run("sửa rồi test"));
		const terminal = events.find((e) => e.type === "terminal");
		expect(terminal && terminal.type === "terminal" && terminal.reason).toBe("completed");
		// 4 lần "dotnet test" y hệt nhưng mỗi lần đều sau một FileWrite → không nudge nào.
		const nudge = events.find(
			(e) => e.type === "recovery:retry" && String((e as { reason?: string }).reason).includes("loop"),
		);
		expect(nudge).toBeFalsy();
	});
});

describe("AgentLoop — bắt 'tuyên bố rồi dừng'", () => {
	it("model hứa 'Tôi sẽ kiểm tra...' với 0 tool → bị nhắc và quay vòng, không kết thúc", async () => {
		const cp = createControlPlane({ failMode: "open" });
		const loop = new AgentLoop({ controlPlane: cp, model: "mock", tools: [makeReadTool("FileRead")] });
		let lan = 0;
		loop.setLLMCaller(async () => {
			lan++;
			if (lan === 1)
				return {
					text: "Tôi sẽ bắt đầu kiểm tra cấu trúc dự án để tạo các thành phần cần thiết.",
					stopReason: "end_turn",
					usage: { inputTokens: 5, outputTokens: 5 },
				};
			if (lan === 2)
				return {
					text: "",
					toolCalls: [{ toolUseId: "r1", toolName: "FileRead", toolInput: { path: "a.md" } }],
					stopReason: "tool_use",
					usage: { inputTokens: 5, outputTokens: 5 },
				};
			return { text: "Đã đọc xong, kết quả: ...", stopReason: "end_turn", usage: { inputTokens: 5, outputTokens: 5 } };
		});
		const events = await collectEvents(loop.run("làm đi"));
		const nudge = events.find(
			(e) => e.type === "recovery:retry" && String((e as { reason?: string }).reason).includes("hanh dong"),
		);
		expect(nudge).toBeTruthy(); // có nhắc
		const daChay = events.filter((e) => e.type === "tool:completed").length;
		expect(daChay).toBe(1); // sau nhắc nó thật sự gọi tool
		const terminal = events.find((e) => e.type === "terminal");
		expect(terminal && terminal.type === "terminal" && terminal.reason).toBe("completed");
	});

	it("câu trả lời thường (không hứa hẹn) KHÔNG bị nhắc oan", async () => {
		const cp = createControlPlane({ failMode: "open" });
		const loop = new AgentLoop({ controlPlane: cp, model: "mock" });
		loop.setLLMCaller(async () => ({
			text: "Thủ đô của Pháp là Paris.",
			stopReason: "end_turn",
			usage: { inputTokens: 5, outputTokens: 5 },
		}));
		const events = await collectEvents(loop.run("thủ đô Pháp?"));
		const nudge = events.find(
			(e) => e.type === "recovery:retry" && String((e as { reason?: string }).reason).includes("hanh dong"),
		);
		expect(nudge).toBeFalsy();
	});
});

describe("AgentLoop — tuyên bố SAU khi đã đọc vài tool vẫn bị nhắc", () => {
	it("2 FileRead rồi 'Bây giờ tôi sẽ...' → nhắc hành động (điều kiện theo file-đã-ghi)", async () => {
		const cp = createControlPlane({ failMode: "open" });
		const loop = new AgentLoop({ controlPlane: cp, model: "mock", tools: [makeReadTool("FileRead")] });
		let lan = 0;
		loop.setLLMCaller(async () => {
			lan++;
			if (lan <= 2)
				return {
					text: "",
					toolCalls: [{ toolUseId: `r${lan}`, toolName: "FileRead", toolInput: { path: `f${lan}.md` } }],
					stopReason: "tool_use",
					usage: { inputTokens: 5, outputTokens: 5 },
				};
			if (lan === 3)
				return {
					text: "Đã đọc xong kế hoạch. Bây giờ tôi sẽ thực hiện các công việc và ghi report.",
					stopReason: "end_turn",
					usage: { inputTokens: 5, outputTokens: 5 },
				};
			return { text: "Hoàn tất.", stopReason: "end_turn", usage: { inputTokens: 5, outputTokens: 5 } };
		});
		const events = await collectEvents(loop.run("làm và ghi report"));
		const nudge = events.filter(
			(e) => e.type === "recovery:retry" && String((e as { reason?: string }).reason).includes("hanh dong"),
		);
		expect(nudge.length).toBeGreaterThan(0); // trước đây: 0 vì đã có tool chạy
	});
});

describe("AgentLoop — model tự khai done=false thì không cho dừng", () => {
	it("respond chuaXong → ép làm tiếp, chỉ kết thúc khi done=true", async () => {
		const cp = createControlPlane({ failMode: "open" });
		const loop = new AgentLoop({ controlPlane: cp, model: "mock", tools: [makeReadTool("FileRead")] });
		let lan = 0;
		loop.setLLMCaller(async () => {
			lan++;
			if (lan === 1)
				return { text: "Xin vui lòng chờ tôi kiểm tra.", stopReason: "end_turn", chuaXong: true, usage: { inputTokens: 5, outputTokens: 5 } };
			if (lan === 2)
				return {
					text: "",
					toolCalls: [{ toolUseId: "r1", toolName: "FileRead", toolInput: { path: "a.md" } }],
					stopReason: "tool_use",
					usage: { inputTokens: 5, outputTokens: 5 },
				};
			return { text: "Đã rà xong: còn thiếu X, Y.", stopReason: "end_turn", usage: { inputTokens: 5, outputTokens: 5 } };
		});
		const events = await collectEvents(loop.run("rà soát phase 2"));
		const ep = events.find(
			(e) => e.type === "recovery:retry" && String((e as { reason?: string }).reason).includes("done=false"),
		);
		expect(ep).toBeTruthy(); // bị ép làm tiếp
		expect(events.filter((e) => e.type === "tool:completed").length).toBe(1); // sau ép có làm thật
		const terminal = events.find((e) => e.type === "terminal");
		expect(terminal && terminal.type === "terminal" && terminal.reason).toBe("completed");
	});
});

describe("AgentLoop — bắt bệnh vẹt (dán lại câu trả lời cũ)", () => {
	it("trả lời trùng nguyên văn câu assistant trước → nhắc và làm lại", async () => {
		const cauCu =
			"Đã hoàn thành việc triển khai các chức năng còn thiếu trong Phase 1: Core Infrastructure and Data Model của project Helpdesk.Api. Tất cả đã được kiểm tra.";
		const cp = createControlPlane({ failMode: "open" });
		const loop = new AgentLoop({ controlPlane: cp, model: "mock" });
		let lan = 0;
		loop.setLLMCaller(async () => {
			lan++;
			if (lan === 1)
				return { text: cauCu, stopReason: "end_turn", usage: { inputTokens: 5, outputTokens: 5 } };
			return {
				text: "Phase 2 gồm 3 việc còn thiếu: state machine, SLA, outbox. Bắt đầu từ state machine.",
				stopReason: "end_turn",
				usage: { inputTokens: 5, outputTokens: 5 },
			};
		});
		const events = await collectEvents(
			loop.run("tiếp tục phần còn thiếu của phase 2", {
				initialMessages: [
					{ role: "user", content: "triển khai phase 1" },
					{ role: "assistant", content: cauCu },
				],
			}),
		);
		const nudge = events.find(
			(e) => e.type === "recovery:retry" && String((e as { reason?: string }).reason).includes("vet"),
		);
		expect(nudge).toBeTruthy();
		const cuoi = events.filter((e) => e.type === "message:assistant").pop();
		expect(JSON.stringify(cuoi)).toContain("Phase 2"); // câu chốt là nội dung MỚI
	});
});

describe("AgentLoop — chặn gọi liên tiếp cùng một tool", () => {
	/**
	 * Kiểu hỏng quan sát thật hai lần trong một buổi, mà bộ đếm (tool+input)
	 * bỏ lọt hoàn toàn vì tham số nhích một chút mỗi lần:
	 *   · 6 lệnh Grep gần trùng nhau, trả về đúng một kết quả
	 *   · 33 lệnh TodoWrite liên tiếp không kèm việc nào
	 */
	function toolDoc(ten: string): ToolDefinition {
		return {
			name: ten,
			description: "d",
			parameters: z.object({}).passthrough(),
			execute: async () => "ket qua",
			metadata: { isReadOnly: true, isDestructive: false, isConcurrencySafe: true, category: "file" },
		} as ToolDefinition;
	}

	it("goi Grep 5 lan lien tiep voi tham so khac nhau → bi chan", async () => {
		const loop = new AgentLoop({ model: "mock", maxTurns: 12 });
		loop.registerTool(toolDoc("Grep"));
		let n = 0;
		loop.setLLMCaller(async () => {
			n++;
			if (n <= 6) {
				return {
					stopReason: "tool_use",
					toolCalls: [{ toolUseId: `t${n}`, toolName: "Grep", toolInput: { pattern: `mau-${n}` } }],
				};
			}
			return { text: "xong", stopReason: "end_turn" };
		});

		const ev = await collectEvents(loop.run("tim gi do"));
		const chan = ev.find(
			(e) => e.type === "recovery:retry" && /goi lien tiep/.test(String((e as { reason?: string }).reason)),
		);
		expect(chan).toBeTruthy();
	});

	it("xen ke tool khac thi KHONG bi chan — vong doc-sua-chay binh thuong", async () => {
		const loop = new AgentLoop({ model: "mock", maxTurns: 14 });
		loop.registerTool(toolDoc("Grep"));
		loop.registerTool(toolDoc("FileRead"));
		let n = 0;
		loop.setLLMCaller(async () => {
			n++;
			if (n <= 8) {
				const ten = n % 2 === 0 ? "Grep" : "FileRead";
				return {
					stopReason: "tool_use",
					toolCalls: [{ toolUseId: `t${n}`, toolName: ten, toolInput: { x: n } }],
				};
			}
			return { text: "xong", stopReason: "end_turn" };
		});

		const ev = await collectEvents(loop.run("lam viec"));
		expect(
			ev.find((e) => e.type === "recovery:retry" && /goi lien tiep/.test(String((e as { reason?: string }).reason))),
		).toBeUndefined();
	});
});

describe("AgentLoop — cổng 'sửa file mà chưa kiểm chứng'", () => {
	/**
	 * Ba bộ bắt bệnh cũ đều soi CHỮ model viết. Model kết bằng một câu bình
	 * thản — "Đã tạo file a.js. Cần tạo thêm test." — thì không mẫu nào khớp,
	 * và nó ra khỏi vòng lặp với việc còn dở.
	 *
	 * Cổng này soi VIỆC: đã sửa file mà chưa từng chạy lệnh kiểm chứng nào.
	 */
	function toolGhi(): ToolDefinition {
		return {
			name: "FileWrite",
			description: "d",
			parameters: z.object({ path: z.string(), content: z.string() }),
			execute: async () => "Written 100 bytes",
			metadata: { isReadOnly: false, isDestructive: false, isConcurrencySafe: false, category: "file" },
		} as ToolDefinition;
	}
	function toolBash(): ToolDefinition {
		return {
			name: "Bash",
			description: "d",
			parameters: z.object({ command: z.string() }),
			execute: async () => "ok",
			metadata: { isReadOnly: false, isDestructive: false, isConcurrencySafe: false, category: "execution" },
		} as ToolDefinition;
	}
	const laKiemTra = (c: string) => /--test|npm test/.test(c);

	it("sửa file rồi dừng mà chưa kiểm chứng → bị chặn, tối đa 2 lần", async () => {
		const loop = new AgentLoop({ model: "mock", maxTurns: 8, laLenhKiemTra: laKiemTra });
		loop.registerTool(toolGhi());
		let n = 0;
		loop.setLLMCaller(async () => {
			n++;
			if (n === 1) {
				return {
					stopReason: "tool_use",
					toolCalls: [{ toolUseId: "t1", toolName: "FileWrite", toolInput: { path: "a.js", content: "x" } }],
				};
			}
			// Câu bình thản, KHÔNG khớp mẫu hứa hẹn — bộ bắt bệnh cũ bó tay.
			return { text: "Da tao file a.js. Can tao them test.", stopReason: "end_turn" };
		});

		const ev = await collectEvents(loop.run("lam di"));
		const chan = ev.filter(
			(e) => e.type === "recovery:retry" && /chua kiem chung/.test(String((e as { reason?: string }).reason)),
		);
		expect(chan).toHaveLength(2);
	});

	it("đã chạy lệnh kiểm chứng rồi thì KHÔNG chặn — model đã có kết luận thật", async () => {
		const loop = new AgentLoop({ model: "mock", maxTurns: 8, laLenhKiemTra: laKiemTra });
		loop.registerTool(toolGhi());
		loop.registerTool(toolBash());
		let n = 0;
		loop.setLLMCaller(async () => {
			n++;
			if (n === 1) {
				return {
					stopReason: "tool_use",
					toolCalls: [{ toolUseId: "t1", toolName: "FileWrite", toolInput: { path: "a.js", content: "x" } }],
				};
			}
			if (n === 2) {
				return {
					stopReason: "tool_use",
					toolCalls: [{ toolUseId: "t2", toolName: "Bash", toolInput: { command: "node --test" } }],
				};
			}
			return { text: "Test da chay va dat.", stopReason: "end_turn" };
		});

		const ev = await collectEvents(loop.run("lam di"));
		expect(
			ev.filter((e) => e.type === "recovery:retry" && /chua kiem chung/.test(String((e as { reason?: string }).reason))),
		).toEqual([]);
	});

	it("không sửa file nào thì không chặn — câu hỏi thuần tuý vẫn trả lời được", async () => {
		const loop = new AgentLoop({ model: "mock", maxTurns: 4, laLenhKiemTra: laKiemTra });
		loop.setLLMCaller(async () => ({ text: "Cau tra loi.", stopReason: "end_turn" }));
		const ev = await collectEvents(loop.run("hoi thoi"));
		const terminal = ev.find((e) => e.type === "terminal");
		expect(terminal!.type === "terminal" && terminal!.reason).toBe("completed");
	});

	it("không truyền laLenhKiemTra thì cổng TẮT hẳn — không đổi hành vi bản cũ", async () => {
		const loop = new AgentLoop({ model: "mock", maxTurns: 6 });
		loop.registerTool(toolGhi());
		let n = 0;
		loop.setLLMCaller(async () => {
			n++;
			if (n === 1) {
				return {
					stopReason: "tool_use",
					toolCalls: [{ toolUseId: "t1", toolName: "FileWrite", toolInput: { path: "a.js", content: "x" } }],
				};
			}
			return { text: "Da xong.", stopReason: "end_turn" };
		});
		const ev = await collectEvents(loop.run("lam di"));
		expect(
			ev.filter((e) => e.type === "recovery:retry" && /chua kiem chung/.test(String((e as { reason?: string }).reason))),
		).toEqual([]);
	});
});
