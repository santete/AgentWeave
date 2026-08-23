/**
 * Đọc frontmatter YAML tối giản.
 *
 * Chỉ cần `key: value` một dòng, giá trị là chuỗi — rule không có nhu cầu nào
 * khác. Kéo cả một bộ phân tích YAML về chỉ để đọc `paths:` là đổi một phụ
 * thuộc lấy hai dòng code, mà gói bàn giao air-gap phải mang theo mọi thứ.
 *
 * Frontmatter hỏng KHÔNG làm hỏng tệp: coi như không có frontmatter và giữ
 * nguyên toàn bộ nội dung. Sai theo hướng "nạp thừa" an toàn hơn hẳn sai theo
 * hướng "im lặng nuốt mất chỉ dẫn".
 */

export interface KetQuaFrontmatter {
	truong: Record<string, string>;
	/** Phần còn lại sau khi bỏ khối frontmatter. */
	than: string;
	coFrontmatter: boolean;
}

export function tachFrontmatter(raw: string): KetQuaFrontmatter {
	// BOM ở đầu tệp làm dòng `---` không còn khớp — gỡ trước.
	const s = raw.replace(/^﻿/, "");
	if (!/^---\r?\n/.test(s)) {
		return { truong: {}, than: raw, coFrontmatter: false };
	}

	const dong = s.split(/\r?\n/);
	let ketThuc = -1;
	for (let i = 1; i < dong.length; i++) {
		if (dong[i]!.trim() === "---") {
			ketThuc = i;
			break;
		}
	}
	// Mở mà không đóng: gần như chắc chắn là lỗi gõ. Giữ nguyên tệp thay vì
	// nuốt trọn nội dung vào một frontmatter khổng lồ.
	if (ketThuc === -1) return { truong: {}, than: raw, coFrontmatter: false };

	const truong: Record<string, string> = {};
	for (let i = 1; i < ketThuc; i++) {
		const d = dong[i]!;
		if (d.trim() === "" || d.trimStart().startsWith("#")) continue;
		const dauHai = d.indexOf(":");
		if (dauHai <= 0) continue;
		const khoa = d.slice(0, dauHai).trim();
		let giaTri = d.slice(dauHai + 1).trim();
		if (
			(giaTri.startsWith('"') && giaTri.endsWith('"') && giaTri.length >= 2) ||
			(giaTri.startsWith("'") && giaTri.endsWith("'") && giaTri.length >= 2)
		) {
			giaTri = giaTri.slice(1, -1);
		}
		if (khoa !== "") truong[khoa] = giaTri;
	}

	return { truong, than: dong.slice(ketThuc + 1).join("\n"), coFrontmatter: true };
}
