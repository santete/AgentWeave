// Giao diện chat trong webview.
// Không dùng framework: extension phải chạy được trong khu bảo mật, mỗi phụ
// thuộc thêm là một thứ nữa phải mang theo và phải tin.

const vscode = acquireVsCodeApi();
const oTinNhan = document.getElementById("tin-nhan");
const oQuyen = document.getElementById("dang-cho-quyen");
const oNhap = document.getElementById("o-nhap");

let khoiDangChay = null; // khối chữ model đang sinh
let dangBan = false;

function themKhoi(lop, noiDung) {
  const d = document.createElement("div");
  d.className = `khoi ${lop}`;
  if (noiDung !== undefined) d.textContent = noiDung;
  oTinNhan.appendChild(d);
  oTinNhan.scrollTop = oTinNhan.scrollHeight;
  return d;
}

function datBan(ban) {
  dangBan = ban;
  document.getElementById("gui").disabled = ban;
  document.getElementById("huy").disabled = !ban;
}

/** Diff đã có mã màu ANSI từ CLI — đổi sang class CSS để webview tô được. */
function veDiff(text) {
  const box = document.createElement("pre");
  box.className = "diff";
  for (const dong of text.replace(/\x1b\[[0-9;]*m/g, "").split("\n")) {
    const d = document.createElement("div");
    d.textContent = dong;
    if (dong.startsWith("+ ")) d.className = "them";
    else if (dong.startsWith("- ")) d.className = "bot";
    else d.className = "giu";
    box.appendChild(d);
  }
  return box;
}

window.addEventListener("message", (ev) => {
  const e = ev.data;

  switch (e.type) {
    case "ready":
      themKhoi("he-thong", `Sẵn sàng · ${e.model} · quyền: ${e.permissionMode}`);
      if (e.configSource) themKhoi("he-thong-mo", `cấu hình: ${e.configSource}`);
      break;

    case "chenVaoO":
      oNhap.value += e.text;
      oNhap.focus();
      break;

    case "delta":
      // Chữ chảy tới đâu hiện tới đó — đây là khác biệt lớn nhất so với việc
      // ngồi nhìn màn hình trống chờ model nghĩ xong.
      if (!khoiDangChay) khoiDangChay = themKhoi("tra-loi", "");
      khoiDangChay.textContent += e.text;
      oTinNhan.scrollTop = oTinNhan.scrollHeight;
      break;

    case "tool": {
      khoiDangChay = null;
      const d = themKhoi("tool");
      d.innerHTML = `<span class="nhan">⚡ ${e.name}</span>`;
      const chiTiet = document.createElement("code");
      chiTiet.textContent = JSON.stringify(e.input).slice(0, 200);
      d.appendChild(chiTiet);
      break;
    }

    case "tool_result": {
      const d = themKhoi(e.ok ? "ket-qua" : "ket-qua-hong");
      d.textContent = `${e.ok ? "✓" : "✗"} ${e.durationMs}ms · ${String(e.preview).split("\n")[0].slice(0, 160)}`;
      break;
    }

    case "attached":
      themKhoi("dinh-kem", `📎 ${e.path} (${e.bytes} byte${e.truncated ? ", đã cắt" : ""})`);
      break;

    case "attach_error":
      themKhoi("canh-bao", `⚠ @${e.path}: ${e.reason}`);
      break;

    case "permission_request": {
      khoiDangChay = null;
      oQuyen.innerHTML = "";
      const the = document.createElement("div");
      the.className = "the-quyen";

      const tieuDe = document.createElement("div");
      tieuDe.className = "tieu-de";
      tieuDe.textContent = `Cho phép ${e.tool}?`;
      the.appendChild(tieuDe);

      if (e.diff) {
        const tt = document.createElement("div");
        tt.className = "tom-tat";
        tt.textContent = `+${e.diff.added} −${e.diff.removed}${e.diff.isNew ? " (tạo mới)" : ""}`;
        the.appendChild(tt);
        the.appendChild(veDiff(e.diff.text));
      } else {
        const c = document.createElement("code");
        c.textContent = JSON.stringify(e.input).slice(0, 400);
        the.appendChild(c);
      }

      const nut = document.createElement("div");
      nut.className = "nut-quyen";
      const traLoi = (allow, alwaysAllow) => {
        vscode.postMessage({ type: "quyen", id: e.id, allow, alwaysAllow });
        oQuyen.innerHTML = "";
      };
      const themNut = (nhan, lop, fn) => {
        const b = document.createElement("button");
        b.textContent = nhan;
        b.className = lop;
        b.onclick = fn;
        nut.appendChild(b);
      };
      themNut("Cho phép", "dong-y", () => traLoi(true, false));
      themNut("Luôn cho phép", "phu", () => traLoi(true, true));
      themNut("Từ chối", "tu-choi", () => traLoi(false, false));
      the.appendChild(nut);

      oQuyen.appendChild(the);
      break;
    }

    case "denied":
      themKhoi("canh-bao", `✗ từ chối ${e.tool} — ${e.reason}`);
      break;

    case "compacted":
      themKhoi("he-thong-mo", `✂ đã nén ngữ cảnh (~${e.freedTokens} token)`);
      break;

    case "recovered":
      themKhoi("he-thong-mo", `↻ ${e.reason}`);
      break;

    case "turn_end":
      khoiDangChay = null;
      datBan(false);
      themKhoi(
        "he-thong-mo",
        `${e.usage.inputTokens.toLocaleString()} vào / ${e.usage.outputTokens.toLocaleString()} ra`,
      );
      break;

    case "reset_ok":
      oTinNhan.innerHTML = "";
      themKhoi("he-thong", "Đã xoá hội thoại");
      break;

    case "error":
      khoiDangChay = null;
      datBan(false);
      themKhoi("loi", `✗ ${e.message}`);
      break;
  }
});

function gui() {
  const t = oNhap.value.trim();
  if (!t || dangBan) return;
  themKhoi("cau-hoi", t);
  oNhap.value = "";
  khoiDangChay = null;
  datBan(true);
  vscode.postMessage({ type: "hoi", text: t });
}

document.getElementById("gui").onclick = gui;
document.getElementById("huy").onclick = () => {
  vscode.postMessage({ type: "huy" });
  datBan(false);
};
document.getElementById("xoa").onclick = () => vscode.postMessage({ type: "xoa" });

// Enter gửi, Shift+Enter xuống dòng — quy ước quen thuộc.
oNhap.addEventListener("keydown", (ev) => {
  if (ev.key === "Enter" && !ev.shiftKey) {
    ev.preventDefault();
    gui();
  }
});

datBan(false);
