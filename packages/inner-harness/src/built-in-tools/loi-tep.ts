/**
 * Dịch lỗi hệ thống tệp sang câu model xử lý được.
 *
 * VÌ SAO CẦN
 *
 * `writeFile` ném thẳng lỗi của hệ điều hành lên, và `ToolExecutor` trả nguyên
 * văn cho model. Model 30B đọc câu như
 *
 *     EBUSY: resource busy or locked, open '/du-an/Helpdesk.Api.dll'
 *     The process cannot access the file because it is being used by another process
 *
 * rồi phải tự đoán: sai đường dẫn? thiếu quyền? hay chỉ là tạm thời? Đoán sai
 * theo hướng nào cũng tốn lượt — nó hoặc thử lại y hệt mãi, hoặc bỏ cuộc và
 * báo "đã sửa xong" trong khi tệp chưa hề đổi.
 *
 * Mỗi mã lỗi có một hành động ĐÚNG khác nhau, và chỉ chỗ này biết đủ để nói ra:
 *   · bị khoá  → tạm thời, phải DỪNG tiến trình đang giữ rồi thử lại
 *   · hết quyền → không tự khắc phục được, phải báo người dùng
 *   · hết đĩa   → thử lại vô ích
 *
 * Câu nào cũng kết bằng "KHÔNG được báo là đã sửa xong": đây là kiểu hỏng đắt
 * nhất — người dùng tin là xong, và chỉ phát hiện ở lần build sau.
 */

const KHONG_BAO_XONG =
	"The file was NOT changed. Do not report this edit as done.";

/**
 * @returns câu đã dịch, hoặc `null` nếu không nhận ra mã lỗi (nơi gọi giữ
 *   nguyên lỗi gốc — thà thô còn hơn dịch sai thành một chẩn đoán khác)
 */
export function dienGiaiLoiTep(err: unknown, duong: string): string | null {
	const e = err as NodeJS.ErrnoException;
	const ma = e?.code;
	const chu = String(e?.message ?? "");

	// Khoá tệp. `EBUSY`/`ETXTBSY` là mã chuẩn; Windows và ổ mạng đôi khi trả
	// `EPERM` kèm đúng câu "being used by another process", nên bắt cả chữ.
	if (ma === "EBUSY" || ma === "ETXTBSY" || /being used by another process/i.test(chu)) {
		return (
			`${duong} is LOCKED by another process — this is temporary, not a permission problem. ` +
			`Something is holding the file open: a running build or watcher ` +
			`(\`dotnet watch\`, \`dotnet build\`, \`npm run dev\`, \`tsc --watch\`), a debugger, ` +
			`or an editor. Stop that process first (check with Bash), then retry the SAME edit once. ` +
			`Do NOT retry it repeatedly and do NOT switch to a different file. ${KHONG_BAO_XONG}`
		);
	}

	if (ma === "EACCES" || ma === "EPERM") {
		return (
			`No permission to write ${duong}. You cannot fix this yourself — do not retry, ` +
			`do not try sudo. Tell the user which file needs write permission. ${KHONG_BAO_XONG}`
		);
	}

	if (ma === "EROFS") {
		return `${duong} is on a read-only filesystem. Retrying will not help. ${KHONG_BAO_XONG}`;
	}

	if (ma === "ENOSPC") {
		return `Disk is full — cannot write ${duong}. Retrying will not help; tell the user. ${KHONG_BAO_XONG}`;
	}

	if (ma === "EISDIR") {
		return `${duong} is a directory, not a file. Check the path with Glob. ${KHONG_BAO_XONG}`;
	}

	if (ma === "ENOENT") {
		return (
			`${duong} does not exist. Find the real path with Glob or Grep before editing — ` +
			`do not guess it. ${KHONG_BAO_XONG}`
		);
	}

	if (ma === "EMFILE" || ma === "ENFILE") {
		return `Too many open files on this machine — wait a moment and retry once. ${KHONG_BAO_XONG}`;
	}

	return null;
}

/** Bọc một thao tác tệp: lỗi nhận ra được thì ném lại bản đã dịch. */
export async function boiLoiTep<T>(duong: string, viec: () => Promise<T>): Promise<T> {
	try {
		return await viec();
	} catch (err) {
		const chu = dienGiaiLoiTep(err, duong);
		throw chu ? new Error(chu) : err;
	}
}
