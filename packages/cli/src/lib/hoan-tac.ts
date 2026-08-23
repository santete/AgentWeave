/**
 * Hoàn tác thay đổi file của agent.
 *
 * Tách khỏi serve để test được mà không cần dựng cả một lượt LLM. Điểm tinh tế
 * duy nhất — và là chỗ dễ sai nhất:
 *
 *   `truocDo === null` nghĩa là file KHÔNG tồn tại trước khi agent ghi. Hoàn
 *   tác lúc đó phải XOÁ file, KHÔNG phải ghi chuỗi rỗng vào. Ghi rỗng để lại
 *   một file lạ mà trước đó không có — hoàn tác kiểu đó là sai, và trong khu cô
 *   lập thì cái file thừa đó không ai biết từ đâu ra.
 */

import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

export interface BuocHoanTac {
	/** Đường dẫn tương đối theo gốc dự án. */
	path: string;
	/** Nội dung trước khi agent ghi; null nếu file vốn chưa tồn tại. */
	truocDo: string | null;
}

export interface KetQuaHoanTac {
	path: string;
	/** true = đã xoá file (vì nó vốn không tồn tại), false = đã khôi phục nội dung. */
	daXoa: boolean;
}

/**
 * Áp dụng một bước hoàn tác lên đĩa.
 *
 * Ghi thẳng bằng fs, KHÔNG qua FileWrite: đây là thao tác hệ thống do người
 * dùng chủ động yêu cầu, không phải agent sửa file, nên không chịu ràng buộc
 * "phải đọc trước khi ghi".
 */
export async function apDungHoanTac(goc: string, buoc: BuocHoanTac): Promise<KetQuaHoanTac> {
	const abs = resolve(goc, buoc.path);
	if (buoc.truocDo === null) {
		await rm(abs, { force: true });
		return { path: buoc.path, daXoa: true };
	}
	await mkdir(dirname(abs), { recursive: true });
	await writeFile(abs, buoc.truocDo, "utf-8");
	return { path: buoc.path, daXoa: false };
}
