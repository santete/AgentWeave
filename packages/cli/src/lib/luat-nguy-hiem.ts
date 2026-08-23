/**
 * Luật chặn lệnh nguy hiểm — một nguồn sự thật dùng chung cho `serve`, `chat`,
 * `run`. Trước đây mỗi lệnh tự khai một mảng luật khác nhau: `serve` chặn 3 thứ,
 * `run` chặn 3 thứ hơi khác, `chat` lại khác — nên cùng một agent mà bảo vệ mỗi
 * cửa một kiểu. Gom về đây để sửa một nơi, ăn cả ba.
 *
 * VÌ SAO cần tầng này (không phó mặc câu dẫn): câu dẫn hệ thống có luật #7 "dừng
 * trước cái không hồi được", nhưng prompt là tầng YẾU NHẤT — model 30B có thể
 * phớt. Máy trong khu cô lập KHÔNG có remote để `git pull` lại: một lệnh lỡ tay
 * là mất việc của khách vĩnh viễn. Nên chốt bằng cơ chế tất định ở đây.
 *
 * Hai mức:
 *   · DENY  — thảm hoạ, không bao giờ hợp lệ (xoá huỷ diệt, sudo, ghi .env).
 *   · ASK   — không hồi được NHƯNG đôi khi dev thật sự muốn (reset --hard, drop
 *             db…). Hỏi người: extension/REPL hiện nút duyệt; `run` không tương
 *             tác + failMode "closed" ⇒ ask hoá deny = an toàn mặc định.
 *
 * KHỚP PATTERN: engine biên `Bash(x)` thành regex neo `^x$`, `*`→`.*`. Nên muốn
 * bắt lệnh nằm GIỮA chuỗi (vd `cd foo && git reset --hard`) thì phải bọc `*…*`.
 * Luật cũ `Bash(rm -rf *)` chỉ neo đầu — đã thêm biến thể `* … *` cho lệnh ghép.
 *
 * ƯU TIÊN 100: cao hơn "người dùng luôn cho phép Bash" (45) và always-allow lưu
 * đĩa (runtime, 75) → lệnh không-hồi-được KHÔNG bị tắt tiếng, luôn hỏi lại.
 */

import type { PermissionRule } from "@agentweave/types";

const deny = (pattern: string, message: string): PermissionRule => ({
	pattern,
	behavior: "deny",
	source: "policy",
	priority: 100,
	message,
});

const ask = (pattern: string, message: string): PermissionRule => ({
	pattern,
	behavior: "ask",
	source: "policy",
	priority: 100,
	message,
});

export const LUAT_NGUY_HIEM: PermissionRule[] = [
	// ── DENY: thảm hoạ ────────────────────────────────────────────
	deny("Bash(rm -rf *)", "Chan xoa huy diet (rm -rf)"),
	deny("Bash(* rm -rf *)", "Chan xoa huy diet (rm -rf trong lenh ghep)"),
	deny("Bash(* rm -fr *)", "Chan xoa huy diet (rm -fr)"),
	deny("Bash(sudo *)", "Chan sudo"),
	deny("Bash(* sudo *)", "Chan sudo (trong lenh ghep)"),
	deny("FileWrite(*.env)", "Khong ghi .env"),

	// ── ASK: không hồi được, nhưng đôi khi hợp lệ ─────────────────
	ask("Bash(*git reset --hard*)", "git reset --hard sẽ VỨT BỎ vĩnh viễn mọi thay đổi chưa commit. Cho phép?"),
	ask("Bash(*git clean -*)", "git clean sẽ XOÁ các file chưa được theo dõi — không khôi phục được. Cho phép?"),
	ask("Bash(*git checkout -- *)", "git checkout -- <path> sẽ vứt bỏ thay đổi ở đường dẫn đó. Cho phép?"),
	ask("Bash(*git checkout .*)", "git checkout . sẽ vứt bỏ TOÀN BỘ thay đổi đang làm. Cho phép?"),
	ask("Bash(*git restore *)", "git restore sẽ vứt bỏ thay đổi trong working tree. Cho phép?"),
	ask("Bash(*git branch -D*)", "git branch -D xoá nhánh kể cả khi chưa merge (mất commit). Cho phép?"),
	ask("Bash(*git push --force*)", "git push --force ghi đè lịch sử trên remote. Cho phép?"),
	ask("Bash(*git push -f*)", "git push -f ghi đè lịch sử trên remote. Cho phép?"),
	ask("Bash(*git stash clear*)", "git stash clear xoá sạch mọi stash đã cất — không lấy lại được. Cho phép?"),
	ask("Bash(*git stash drop*)", "git stash drop xoá một stash đã cất — không lấy lại được. Cho phép?"),
	ask("Bash(*dotnet ef database drop*)", "Lệnh này XOÁ SẠCH database. Cho phép?"),
	ask("Bash(*find * -delete*)", "find … -delete xoá hàng loạt file khớp điều kiện. Cho phép?"),
];
