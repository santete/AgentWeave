/**
 * Quan sát xem agent có THẬT SỰ kiểm chứng thay đổi của mình không.
 *
 * Bản trước bật cờ "đã kiểm tra" chỉ vì câu lệnh CHỨA chữ `test|build|mvn…`.
 * Hai kiểu sai, cả hai đều lặng lẽ:
 *
 *   ① Sai dương — `ls src/test/`, `grep -r test .`, `cat build.gradle` đều khớp
 *      mẫu. Agent chưa chạy gì đã được ghi nhận là đã kiểm tra.
 *   ② Nguy hơn — chỉ nhìn LỆNH GỬI ĐI, không nhìn KẾT QUẢ. `mvn test` chạy 3
 *      phút rồi bị giết vì quá hạn giờ vẫn tính là đã kiểm tra. Build hỏng cũng
 *      vậy. Đúng thứ mà cơ chế này sinh ra để chặn.
 *
 * Nên ở đây tách làm hai việc: nhận diện lệnh theo CHƯƠNG TRÌNH được gọi (không
 * phải chữ nằm đâu đó trong dòng lệnh), rồi đọc mã thoát để biết nó kết luận gì.
 */

import { DAU_BI_GIET, DAU_MA_THOAT } from "@agentweave/inner-harness";

export type KetCucKiemTra =
	/** Không có lệnh kiểm tra nào chạy. */
	| "khong-chay"
	/** Chạy xong, mã thoát 0. */
	| "dat"
	/** Chạy xong, mã thoát ≠ 0 — có kết luận, và kết luận là hỏng. */
	| "hong"
	/** Bị giết vì quá hạn giờ — KHÔNG có kết luận nào cả. */
	| "bi-giet";

/** Chương trình mà chỉ cần gọi tới là đã đang kiểm tra. */
const CHUONG_TRINH = new Set([
	"pytest",
	"tox",
	"jest",
	"vitest",
	"tsc",
	"mvn",
	"mvnw",
	"gradle",
	"gradlew",
	"ctest",
	"phpunit",
	"rspec",
	"eslint",
	"biome",
	"ruff",
	"mypy",
]);

/** Trình quản lý gói: phải nhìn thêm việc con mới biết có kiểm tra không. */
const QUAN_LY_GOI = new Set(["npm", "pnpm", "yarn", "bun"]);

/** Lệnh bọc — bỏ qua để lấy chương trình thật đứng sau. */
const LENH_BOC = new Set(["sudo", "time", "nice", "env", "npx", "bunx", "command", "exec"]);

/**
 * Việc con tính là kiểm tra.
 *
 * Cố ý KHÔNG có `install`, `ci`, `restore`, `run` (chạy ứng dụng) — chúng không
 * kết luận gì về tính đúng đắn của thay đổi.
 */
const VIEC_KIEM_TRA =
	/^(test|tests|build|lint|typecheck|type-check|check|verify|compile|clippy|vet|coverage)$/;

/**
 * Câu lệnh này có phải đang kiểm chứng mã nguồn không.
 *
 * Tách theo `&&`, `||`, `;`, `|` rồi xét từng đoạn: chỉ cần một đoạn là lệnh
 * kiểm tra thì cả dòng tính là có.
 */
export function laLenhKiemTra(command: string): boolean {
	return command.split(/&&|\|\||[;|\n]/).some((doan) => doanLaKiemTra(doan));
}

function doanLaKiemTra(doan: string): boolean {
	let tu = doan.trim().split(/\s+/).filter(Boolean);

	// Bỏ gán biến môi trường đứng đầu (`CI=1 npm test`) và các lệnh bọc.
	while (tu.length > 0 && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tu[0]!) || LENH_BOC.has(tu[0]!))) {
		tu = tu.slice(1);
	}
	if (tu.length === 0) return false;

	// Lấy tên chương trình, bỏ đường dẫn và đuôi: `./gradlew` → `gradlew`.
	const prog = (tu[0]!.split("/").pop() ?? "").replace(/\.(sh|cmd|bat|exe|ps1)$/, "");
	const thamSo = tu.slice(1).filter((a) => !a.startsWith("-"));

	if (CHUONG_TRINH.has(prog)) return true;

	if (QUAN_LY_GOI.has(prog)) {
		// `npm test`, `npm run build`, `pnpm run test:unit` — lấy tên script,
		// cắt phần sau dấu hai chấm.
		const viec = thamSo[0] === "run" || thamSo[0] === "run-script" ? thamSo[1] : thamSo[0];
		return viec !== undefined && VIEC_KIEM_TRA.test(viec.split(":")[0]!);
	}

	if (prog === "dotnet" || prog === "go" || prog === "cargo" || prog === "swift") {
		return thamSo.some((a) => VIEC_KIEM_TRA.test(a));
	}

	// `make` trần là build; `make test` cũng tính.
	if (prog === "make") return thamSo.length === 0 || thamSo.some((a) => VIEC_KIEM_TRA.test(a));

	if (prog === "python" || prog === "python3") return /\s-m\s+(pytest|unittest|tox)\b/.test(doan);
	if (prog === "node") return /\s--test\b/.test(doan);

	return false;
}

/** Đọc kết luận từ output của Bash. Dấu hiệu lấy từ chính tool, không chép tay. */
export function docKetCuc(ketQua: unknown): Exclude<KetCucKiemTra, "khong-chay"> {
	const s = typeof ketQua === "string" ? ketQua : String(ketQua ?? "");
	if (s.startsWith(DAU_BI_GIET)) return "bi-giet";
	if (s.startsWith(DAU_MA_THOAT)) return "hong";
	return "dat";
}

/**
 * Theo dõi một lượt: ghép lệnh gửi đi với kết quả trả về.
 *
 * Lấy kết luận CUỐI CÙNG chứ không phải xấu nhất: agent chạy test hỏng, sửa,
 * chạy lại đạt — trạng thái hiện tại của mã nguồn là đạt. Lấy xấu nhất thì lượt
 * nào có một lần hỏng cũng bị báo hỏng mãi.
 */
export class TheoDoiKiemTra {
	private dangCho = new Set<string>();
	private cuoiCung: KetCucKiemTra = "khong-chay";

	/** Gọi khi thấy sự kiện `tool:requested`. */
	yeuCau(toolName: string, toolInput: unknown, toolUseId: string): void {
		if (toolName !== "Bash") return;
		const vao = toolInput as Record<string, unknown>;
		if (typeof vao?.command === "string" && laLenhKiemTra(vao.command)) {
			this.dangCho.add(toolUseId);
		}
	}

	/** Gọi khi thấy `tool:completed`. */
	hoanTat(toolUseId: string, ketQua: unknown): void {
		if (!this.dangCho.delete(toolUseId)) return;
		this.cuoiCung = docKetCuc(ketQua);
	}

	/** Gọi khi thấy `tool:failed` — không spawn được thì cũng không có kết luận. */
	thatBai(toolUseId: string): void {
		if (!this.dangCho.delete(toolUseId)) return;
		this.cuoiCung = "bi-giet";
	}

	get ketCuc(): KetCucKiemTra {
		// Còn lệnh chưa có kết quả (bị từ chối quyền, hoặc lượt dừng giữa chừng)
		// thì không có kết luận — đừng suy ra là đã kiểm tra.
		return this.cuoiCung;
	}

	/** Chỉ true khi lệnh kiểm tra đã chạy XONG và báo đạt. */
	get daKiemChung(): boolean {
		return this.cuoiCung === "dat";
	}
}

/** Câu cảnh báo cho người dùng, hoặc null nếu không có gì phải nói. */
export function canhBaoKiemTra(ketCuc: KetCucKiemTra, soFileDaSua: number): string | null {
	if (soFileDaSua === 0) return null;
	switch (ketCuc) {
		case "khong-chay":
			return `đã sửa ${soFileDaSua} file nhưng CHƯA chạy kiểm tra nào — mọi khẳng định ở trên chưa được kiểm chứng`;
		case "bi-giet":
			return `lệnh kiểm tra bị giết vì quá hạn giờ — KHÔNG có kết luận nào cho ${soFileDaSua} file đã sửa`;
		case "hong":
			return `lệnh kiểm tra đã chạy và BÁO HỎNG — ${soFileDaSua} file đã sửa vẫn chưa đạt`;
		case "dat":
			return null;
	}
}
