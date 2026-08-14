/**
 * Demo hệ thống Skill — chạy được cả khi KHÔNG có Ollama.
 *
 * Hai chế độ:
 *   node examples/skill-demo.mjs              → chỉ quét + in chỉ mục (offline, không gọi model)
 *   node examples/skill-demo.mjs "câu hỏi"    → chạy AgentLoop thật, xem model có tự gọi LoadSkill không
 *
 * Chế độ thứ nhất chính là hạng mục 8 của bộ tự kiểm tra lúc bàn giao:
 * "chỉ mục có mặt, LoadSkill trả về nội dung".
 */
import { AgentLoop, installSkills, summarizeSkillReport } from "../packages/inner-harness/dist/index.js";
import { FileReadTool, GlobTool, GrepTool } from "../packages/inner-harness/dist/index.js";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const MODEL = process.env.OLLAMA_MODEL || "qwen3-coder:30b";
process.env.AGENTWEAVE_DEFAULT_PROVIDER ??= "ollama";

const loop = new AgentLoop({
	model: MODEL,
	maxTurns: 6,
	systemPrompt: "Bạn là trợ lý lập trình. Trả lời ngắn gọn bằng tiếng Việt.",
	tools: [FileReadTool, GlobTool, GrepTool],
});

// Phạm vi tổ chức trỏ vào examples/skills — đúng cách gói bàn giao sẽ làm.
const { registry, report } = await installSkills(loop, {
	orgSkillsDir: join(here, "skills"),
	userSkillsDir: null,
});

console.log("─".repeat(64));
console.log(summarizeSkillReport(report));
for (const s of report.skills) {
	console.log(`  ${s.manifest.name.padEnd(22)} ${s.scope.padEnd(8)} ${s.contentBytes} byte`);
}

console.log("─".repeat(64));
console.log("CHỈ MỤC nạp vào system prompt:");
console.log(registry.renderIndex() || "(rỗng)");

console.log("─".repeat(64));
const hasIndex = loop.getSystemPrompt().includes("[skills]");
const hasTool = loop.getTools().some((t) => t.name === "LoadSkill");
console.log(`chỉ mục trong system prompt: ${hasIndex ? "CÓ" : "KHÔNG"}`);
console.log(`tool LoadSkill đã đăng ký:   ${hasTool ? "CÓ" : "KHÔNG"}`);

const first = report.skills[0];
if (first) {
	const content = await registry.loadContent(first.manifest.name);
	console.log(`LoadSkill("${first.manifest.name}") trả về ${content.length} ký tự`);
}

// Mốc để tách lượt nạp chẩn đoán ở trên khỏi lượt do model tự gọi bên dưới.
const baseline = new Map(registry.loadStats());

if (!hasIndex || !hasTool || report.problems.some((p) => p.fatal)) {
	console.error("✗ hệ thống skill CHƯA sẵn sàng");
	process.exit(1);
}

const prompt = process.argv[2];
if (!prompt) {
	console.log("✓ hệ thống skill sẵn sàng (chưa gọi model — truyền câu hỏi để chạy thật)");
	process.exit(0);
}

console.log("─".repeat(64));
console.log(`model: ${MODEL} · prompt: ${prompt}`);

const t0 = Date.now();
const gen = loop.run(prompt, { maxTurns: 6 });
for (;;) {
	const { value, done } = await gen.next();
	if (done) {
		console.log("─".repeat(64));
		console.log(`kết thúc: ${value.reason} · ${((Date.now() - t0) / 1000).toFixed(1)}s`);
		console.log(`token:    in=${value.usage?.inputTokens ?? 0} out=${value.usage?.outputTokens ?? 0}`);
		// Chỉ đếm lượt do MODEL gọi — trừ đi lượt nạp chẩn đoán ở trên, nếu không
		// bảng thống kê sẽ báo xanh trong khi model chưa hề gọi LoadSkill.
		const doModelGoi = [...registry.loadStats()]
			.map(([n, c]) => [n, c - (baseline.get(n) ?? 0)])
			.filter(([, c]) => c > 0)
			.map(([n, c]) => `${n}×${c}`);
		console.log(`model đã gọi LoadSkill: ${doModelGoi.join(", ") || "(KHÔNG lần nào)"}`);
		break;
	}
	if (value.type === "tool:requested") {
		console.log(`[tool] ${value.toolName} ${JSON.stringify(value.toolInput)}`);
	}
	if (value.type === "message:assistant") {
		const t = value.content?.map((c) => c.text).join("") ?? "";
		if (t.trim()) console.log(`[trả lời] ${t.trim().slice(0, 400)}`);
	}
}
