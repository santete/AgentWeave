import { describe, it, expect } from "vitest";
import { chuanHoaDuongDan } from "../src/built-in-tools/duong-dan";

describe("chuanHoaDuongDan — bỏ @ do tag rớt vào path", () => {
	it("bỏ @ ở đầu (ca thật: model copy @file vào FileRead)", () => {
		expect(chuanHoaDuongDan("@ticket-implementation-plan.md")).toBe("ticket-implementation-plan.md");
		expect(chuanHoaDuongDan("@src/App.tsx")).toBe("src/App.tsx");
	});
	it("KHÔNG đụng path bình thường", () => {
		expect(chuanHoaDuongDan("ticket-implementation-plan.md")).toBe("ticket-implementation-plan.md");
		expect(chuanHoaDuongDan("src/a.cs")).toBe("src/a.cs");
		expect(chuanHoaDuongDan("./x")).toBe("./x");
		expect(chuanHoaDuongDan("/abs/path")).toBe("/abs/path");
	});
	it("chỉ bỏ @ ĐẦU, không đụng @ ở giữa (node_modules/@types)", () => {
		expect(chuanHoaDuongDan("node_modules/@types/node/index.d.ts")).toBe("node_modules/@types/node/index.d.ts");
	});
});
