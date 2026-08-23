/**
 * Test cơ chế "không tin, mà kiểm".
 *
 * Đây là lớp bảo vệ mà cả sản phẩm dựa vào: model 30B hay tuyên bố "đã sửa xong,
 * test đều pass" mà chưa chạy gì. Nếu chính lớp này báo xanh nhầm thì nó còn hại
 * hơn không có, vì người dùng tin nó.
 */

import { describe, it, expect } from "vitest";
import {
	laLenhKiemTra,
	docKetCuc,
	canhBaoKiemTra,
	TheoDoiKiemTra,
} from "../src/lib/theo-doi-kiem-tra.js";

describe("laLenhKiemTra — nhận diện theo chương trình, không theo chữ", () => {
	it("nhận lệnh kiểm tra thật của 4 stack", () => {
		for (const c of [
			"npm test",
			"npm run build",
			"pnpm run test:unit",
			"yarn lint",
			"dotnet test",
			"dotnet build MySolution.sln",
			"mvn clean install",
			"./gradlew test",
			"./mvnw verify",
			"pytest -q",
			"python3 -m pytest tests/",
			"npx vitest run",
			"tsc --noEmit",
			"node --test test/*.js",
			"go test ./...",
			"cargo clippy",
			"make",
			"CI=1 npm test",
			"cd api && dotnet test",
		]) {
			expect(laLenhKiemTra(c), c).toBe(true);
		}
	});

	it("KHÔNG nhận lệnh chỉ tình cờ chứa chữ khoá", () => {
		// Mẫu regex cũ khớp hết mấy dòng này — agent chưa chạy gì đã được ghi
		// nhận là đã kiểm tra.
		for (const c of [
			"ls src/test/",
			"grep -rn test .",
			"cat build.gradle",
			"rm -rf build",
			"find . -name '*test*'",
			"git status",
			"echo test",
			"mkdir -p src/test",
		]) {
			expect(laLenhKiemTra(c), c).toBe(false);
		}
	});

	it("cài phụ thuộc KHÔNG phải là kiểm tra", () => {
		// Chúng không kết luận gì về tính đúng đắn của thay đổi.
		for (const c of [
			"npm install",
			"npm ci",
			"pnpm install",
			"dotnet restore",
			"pip install -r r.txt",
		]) {
			expect(laLenhKiemTra(c), c).toBe(false);
		}
	});

	it("chạy ứng dụng KHÔNG phải là kiểm tra", () => {
		for (const c of ["npm run dev", "dotnet run", "node server.js"]) {
			expect(laLenhKiemTra(c), c).toBe(false);
		}
	});
});

describe("docKetCuc — đọc mã thoát chứ không đoán", () => {
	it("không có tiền tố = lệnh chạy tốt", () => {
		expect(docKetCuc("Test Suites: 12 passed\n")).toBe("dat");
	});

	it("mã thoát khác 0 = hỏng", () => {
		expect(docKetCuc("[mã thoát 1]\n2 tests failed")).toBe("hong");
	});

	it("bị giết vì quá hạn giờ = KHÔNG có kết luận", () => {
		expect(docKetCuc("[lệnh bị giết vì quá hạn giờ — mã thoát null]\n")).toBe("bi-giet");
	});
});

describe("TheoDoiKiemTra — ghép lệnh gửi đi với kết quả trả về", () => {
	const chay = (t: TheoDoiKiemTra, id: string, lenh: string, ketQua: string) => {
		t.yeuCau("Bash", { command: lenh }, id);
		t.hoanTat(id, ketQua);
	};

	it("chưa chạy gì thì là khong-chay", () => {
		expect(new TheoDoiKiemTra().ketCuc).toBe("khong-chay");
	});

	it("chạy xong và đạt thì mới tính là đã kiểm chứng", () => {
		const t = new TheoDoiKiemTra();
		chay(t, "1", "npm test", "all passed");
		expect(t.ketCuc).toBe("dat");
		expect(t.daKiemChung).toBe(true);
	});

	it("LỖI CŨ: lệnh bị giết giữa chừng KHÔNG được tính là đã kiểm tra", () => {
		const t = new TheoDoiKiemTra();
		chay(t, "1", "mvn clean install", "[lệnh bị giết vì quá hạn giờ — mã thoát null]\n");
		expect(t.ketCuc).toBe("bi-giet");
		expect(t.daKiemChung).toBe(false);
	});

	it("LỖI CŨ: build hỏng KHÔNG được tính là đã kiểm tra", () => {
		const t = new TheoDoiKiemTra();
		chay(t, "1", "dotnet test", "[mã thoát 1]\nFailed: 3");
		expect(t.ketCuc).toBe("hong");
		expect(t.daKiemChung).toBe(false);
	});

	it("lệnh gửi đi nhưng chưa có kết quả thì chưa kết luận gì", () => {
		// Người dùng từ chối quyền, hoặc lượt bị ngắt giữa chừng.
		const t = new TheoDoiKiemTra();
		t.yeuCau("Bash", { command: "npm test" }, "1");
		expect(t.ketCuc).toBe("khong-chay");
	});

	it("lấy kết luận CUỐI, không phải xấu nhất", () => {
		// Agent chạy hỏng, sửa, chạy lại đạt — trạng thái hiện tại là đạt.
		const t = new TheoDoiKiemTra();
		chay(t, "1", "npm test", "[mã thoát 1]\nfail");
		chay(t, "2", "npm test", "ok");
		expect(t.ketCuc).toBe("dat");
	});

	it("đạt rồi hỏng sau đó thì kết luận là hỏng", () => {
		const t = new TheoDoiKiemTra();
		chay(t, "1", "npm test", "ok");
		chay(t, "2", "npm run lint", "[mã thoát 2]\n5 problems");
		expect(t.ketCuc).toBe("hong");
	});

	it("bỏ qua tool không phải Bash và lệnh không phải kiểm tra", () => {
		const t = new TheoDoiKiemTra();
		t.yeuCau("FileWrite", { path: "a.ts" }, "1");
		t.hoanTat("1", "Written 10 bytes");
		chay(t, "2", "ls src/test/", "a.ts b.ts");
		expect(t.ketCuc).toBe("khong-chay");
	});
});

describe("canhBaoKiemTra — nói đúng chuyện đã xảy ra", () => {
	it("không sửa file thì không cảnh báo gì", () => {
		expect(canhBaoKiemTra("khong-chay", 0)).toBeNull();
	});

	it("sửa mà không kiểm tra", () => {
		expect(canhBaoKiemTra("khong-chay", 3)).toMatch(/CHƯA chạy kiểm tra nào/);
	});

	it("bị giết thì nói là không có kết luận, không nói là chưa chạy", () => {
		expect(canhBaoKiemTra("bi-giet", 2)).toMatch(/KHÔNG có kết luận/);
	});

	it("hỏng thì nói thẳng là hỏng", () => {
		expect(canhBaoKiemTra("hong", 2)).toMatch(/BÁO HỎNG/);
	});

	it("đạt thì im lặng", () => {
		expect(canhBaoKiemTra("dat", 5)).toBeNull();
	});
});
