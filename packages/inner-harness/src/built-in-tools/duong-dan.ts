/**
 * Chuẩn hoá đường dẫn model đưa vào tool file.
 *
 * Người dùng gõ `@ten-file` để ĐÍNH KÈM (cú pháp tag của extension: nội dung
 * file được nhồi thẳng vào ngữ cảnh). Nhưng model hay copy nguyên `@ten-file`
 * vào `path` của FileRead/FileWrite → resolve thành `cwd/@ten-file` rồi ENOENT.
 * Đo thật: tag @ thì content vào OK, mà model FileRead "@..." lại báo không thấy.
 *
 * Bỏ `@` ở ĐẦU đường dẫn. Path thật trong dự án không bắt đầu bằng `@` (gói scoped
 * của npm nằm dưới node_modules/@scope, không phải ở gốc cwd), nên an toàn.
 */
export function chuanHoaDuongDan(p: string): string {
	return typeof p === "string" ? p.replace(/^@/, "") : p;
}
