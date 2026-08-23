/**
 * Khớp đường dẫn kiểu .gitignore — tự viết, không thêm phụ thuộc.
 *
 * Vì sao không dùng thư viện `ignore` như bản gốc: gói bàn giao air-gap phải
 * mang theo mọi thứ, mà ở đây chỉ cần một tập con nhỏ của cú pháp. Đổi lại
 * phải nói RÕ tập con đó là gì, để người viết rule không trông chờ thứ không có:
 *
 *   `*`        khớp trong MỘT đoạn, không vượt qua `/`
 *   `?`        đúng một ký tự, không phải `/`
 *   `**`       khớp qua nhiều đoạn (`src/**` khớp `src/a/b.ts`)
 *   `a/b`      có `/` → neo từ gốc phạm vi
 *   `*.sql`    không có `/` → khớp TÊN TỆP ở bất kỳ tầng nào
 *   `src/api`  khớp cả chính nó lẫn mọi thứ bên trong
 *   `a, b`     nhiều mẫu, ngăn bằng dấu phẩy — khớp MỘT mẫu là đủ
 *
 * KHÔNG hỗ trợ: phủ định `!`, lớp ký tự `[a-z]`. Cả hai đều hiếm trong rule
 * và mỗi thứ thêm vào là một chỗ hành vi lệch với gitignore thật.
 *
 * Cú pháp gitignore chứ không phải picomatch là chọn có chủ đích: người viết
 * rule đã quen `.gitignore` trong chính repo đó, dùng luật khác chỉ tổ gây
 * bất ngờ ở đúng chỗ không ai kiểm chứng.
 */

/**
 * Mẫu vô điều kiện — coi như không đặt `paths:`.
 *
 * `**` khớp mọi thứ, nên "rule có điều kiện khớp mọi file" chính là rule vô
 * điều kiện, chỉ khác ở chỗ nó bị bơm muộn và lặp lại. Quy về một mối.
 */
export function laVoDieuKien(mau: string): boolean {
	const cac = tachMau(mau);
	return cac.length === 0 || cac.some((m) => m === "**" || m === "**/*" || m === "*");
}

export function tachMau(mau: string): string[] {
	return mau
		.split(",")
		.map((s) => s.trim())
		.filter((s) => s !== "");
}

/**
 * Dựng bộ khớp cho chuỗi `paths:`.
 *
 * @returns hàm nhận đường dẫn TƯƠNG ĐỐI (dùng `/`), trả về true nếu khớp.
 *   Mẫu hỏng bị bỏ qua — trả về `null` khi không còn mẫu nào dùng được.
 */
export function taoBoKhop(mau: string): ((duongTuongDoi: string) => boolean) | null {
	const regex = tachMau(mau)
		.map(taoRegex)
		.filter((r): r is RegExp => r !== null);

	if (regex.length === 0) return null;

	return (duong: string) => {
		const chuan = chuanHoa(duong);
		// Đường dẫn ra ngoài gốc phạm vi thì không mẫu nào khớp được — chặn sớm
		// để không phải nghĩ về `../` trong regex.
		if (chuan === "" || chuan.startsWith("../") || chuan === "..") return false;
		return regex.some((r) => r.test(chuan));
	};
}

/** Đưa về dạng chuẩn: dấu `/`, bỏ `./` đầu và `/` cuối. */
export function chuanHoa(duong: string): string {
	return duong.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
}

function taoRegex(mauTho: string): RegExp | null {
	let mau = chuanHoa(mauTho);
	// Đuôi `/**` là thừa: bên dưới đã cho mẫu khớp cả chính nó lẫn phần trong.
	while (mau.endsWith("/**")) mau = mau.slice(0, -3);
	const neoTuGoc = mau.startsWith("/") || mau.includes("/");
	if (mau.startsWith("/")) mau = mau.slice(1);
	if (mau === "") return null;

	let than = "";
	for (let i = 0; i < mau.length; i++) {
		const c = mau[i]!;
		if (c === "*") {
			if (mau[i + 1] === "*") {
				i++;
				// `**/` nuốt luôn dấu gạch để `src/**/a.ts` khớp cả `src/a.ts`.
				if (mau[i + 1] === "/") {
					i++;
					than += "(?:[^/]*/)*";
				} else {
					than += ".*";
				}
			} else {
				than += "[^/]*";
			}
		} else if (c === "?") {
			than += "[^/]";
		} else {
			than += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
		}
	}

	// Không có `/` → khớp tên tệp ở bất kỳ tầng nào, đúng như gitignore.
	const dau = neoTuGoc ? "^" : "^(?:.*/)?";
	// `(?:/.*)?` — mẫu trỏ vào thư mục thì khớp luôn mọi thứ bên trong.
	try {
		return new RegExp(`${dau}${than}(?:/.*)?$`);
	} catch {
		return null;
	}
}
