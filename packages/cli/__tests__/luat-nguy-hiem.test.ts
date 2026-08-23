import { describe, it, expect } from "vitest";
import { matchPattern } from "@agentweave/outer-harness";
import { LUAT_NGUY_HIEM } from "../src/lib/luat-nguy-hiem";

type Behavior = "allow" | "deny" | "ask";

/** Quyết định của tầng luật nguy hiểm với 1 lệnh Bash (allow = không luật nào bắt). */
function quyetBash(command: string): Behavior {
	const req = { toolName: "Bash", toolInput: { command } } as never;
	for (const r of LUAT_NGUY_HIEM) if (matchPattern(r.pattern, req)) return r.behavior;
	return "allow";
}

function quyetFile(toolName: string, path: string): Behavior {
	const req = { toolName, toolInput: { path } } as never;
	for (const r of LUAT_NGUY_HIEM) if (matchPattern(r.pattern, req)) return r.behavior;
	return "allow";
}

describe("LUAT_NGUY_HIEM — chặn lệnh không hồi được", () => {
	it("DENY: rm -rf kể cả trong lệnh ghép", () => {
		expect(quyetBash("rm -rf build")).toBe("deny");
		expect(quyetBash("cd repo && rm -rf .")).toBe("deny");
		expect(quyetBash("dotnet build && rm -rf bin")).toBe("deny");
	});

	it("DENY: sudo, kể cả sau &&", () => {
		expect(quyetBash("sudo apt install x")).toBe("deny");
		expect(quyetBash("echo x && sudo rm y")).toBe("deny");
	});

	it("DENY: ghi .env", () => {
		expect(quyetFile("FileWrite", ".env")).toBe("deny");
		expect(quyetFile("FileWrite", "config/app.env")).toBe("deny");
	});

	it("ASK: git vứt bỏ thay đổi (reset/clean/checkout/restore/branch/stash)", () => {
		expect(quyetBash("git reset --hard HEAD~1")).toBe("ask");
		expect(quyetBash("cd sub && git reset --hard")).toBe("ask");
		expect(quyetBash("git clean -fdx")).toBe("ask");
		expect(quyetBash("git checkout -- src/Foo.cs")).toBe("ask");
		expect(quyetBash("git checkout .")).toBe("ask");
		expect(quyetBash("git restore .")).toBe("ask");
		expect(quyetBash("git branch -D feature")).toBe("ask");
		expect(quyetBash("git stash clear")).toBe("ask");
		expect(quyetBash("git stash drop stash@{2}")).toBe("ask");
	});

	it("ASK: push --force / -f", () => {
		expect(quyetBash("git push --force origin main")).toBe("ask");
		expect(quyetBash("git push -f")).toBe("ask");
	});

	it("ASK: drop database + find -delete", () => {
		expect(quyetBash("dotnet ef database drop -f")).toBe("ask");
		expect(quyetBash("find . -name '*.tmp' -delete")).toBe("ask");
	});

	it("ALLOW: lệnh đọc/an toàn KHÔNG bị chặn (không over-ask)", () => {
		for (const c of [
			"git status",
			"git diff",
			"git log --oneline",
			"git add .",
			"git commit -m fix",
			"git checkout main", // đổi nhánh — KHÔNG phải vứt thay đổi
			"git switch -c feat",
			"git push origin main",
			"git push --follow-tags", // không được nhầm với -f
			"dotnet build Helpdesk.sln",
			"dotnet test",
			"find . -name '*.cs'", // find không -delete
			"ls -la",
			"cat README.md",
		]) {
			expect(quyetBash(c), c).toBe("allow");
		}
	});

	it("mọi luật đều ưu tiên 100 (thắng always-allow 45/75) và source policy", () => {
		for (const r of LUAT_NGUY_HIEM) {
			expect(r.priority).toBe(100);
			expect(r.source).toBe("policy");
			if (r.behavior === "ask") expect(r.message, r.pattern).toBeTruthy();
		}
	});
});
