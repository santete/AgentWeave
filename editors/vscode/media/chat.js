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
      vscode.postMessage({ type: "listModels" });
      break;

    case "chenVaoO":
      oNhap.value += e.text;
      oNhap.focus();
      break;

    case "text_corrected":
      // Chữ vừa hiện hoá ra là tool-call viết dạng văn bản. Thay hẳn khối đó —
      // để nguyên thì người dùng thấy một đống JSON thô giữa câu trả lời.
      if (khoiDangChay) {
        if (e.text.trim()) khoiDangChay.textContent = e.text;
        else khoiDangChay.remove();
        khoiDangChay = null;
      }
      break;

    case "models": {
      const sel = document.getElementById("chon-model");
      sel.innerHTML = "";
      for (const m of e.models) {
        const o = document.createElement("option");
        o.value = m.name;
        o.textContent = `${m.name} (${(m.size / 1e9).toFixed(1)} GB)`;
        if (m.name === e.current) o.selected = true;
        sel.appendChild(o);
      }
      sel.disabled = false;
      break;
    }

    case "model_changed":
      themKhoi("he-thong", `Đã đổi model sang ${e.model}`);
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
        tt.textContent = `${e.diff.path} · +${e.diff.added} −${e.diff.removed}${e.diff.isNew ? " (tạo mới)" : ""}`;
        the.appendChild(tt);

        // Có nội dung đầy đủ thì mời mở bằng trình diff của chính editor —
        // dễ đọc hơn hẳn khi thay đổi lớn. Diff nhỏ dưới đây vẫn giữ để liếc.
        if (e.diff.after !== null && e.diff.after !== undefined) {
          const b = document.createElement("button");
          b.textContent = "Mở trong trình diff";
          b.className = "phu";
          b.onclick = () =>
            vscode.postMessage({
              type: "xemDiff",
              path: e.diff.path,
              after: e.diff.after,
              isNew: e.diff.isNew,
            });
          the.appendChild(b);
        }
        the.appendChild(veDiff(e.diff.text));
      } else {
        const c = document.createElement("code");
        c.textContent = JSON.stringify(e.input).slice(0, 400);
        the.appendChild(c);
      }

      const nut = document.createElement("div");
      nut.className = "nut-quyen";
      const traLoi = (allow, alwaysAllow) => {
        // Gửi kèm tên tool: phía agent cần nó để nhớ "luôn cho phép" qua các lượt.
        vscode.postMessage({ type: "quyen", id: e.id, allow, alwaysAllow, tool: e.tool });
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
      themNut(`Luôn cho phép ${e.tool}`, "phu", () => traLoi(true, true));
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

    case "always_allowed":
      themKhoi("he-thong-mo", `✓ từ giờ tự cho phép ${e.tool} (vẫn chặn rm -rf, sudo, ghi .env)`);
      break;

    case "turn_end": {
      khoiDangChay = null;
      datBan(false);

      // Cảnh báo dựa trên QUAN SÁT, không dựa vào lời model tự nhận. Model 30B
      // hay tuyên bố "các test đều pass" mà chưa chạy lệnh nào.
      if (e.edited && e.edited.length > 0 && !e.ranCheck) {
        const c = themKhoi("chua-kiem-chung");
        c.textContent =
          `⚠ Đã sửa ${e.edited.length} file nhưng CHƯA chạy kiểm tra nào: ${e.edited.join(", ")}. ` +
          `Mọi khẳng định "chạy ổn" ở trên đều chưa được kiểm chứng.`;
        const b = document.createElement("button");
        b.textContent = "Bảo agent chạy kiểm tra";
        b.className = "phu";
        b.onclick = () => {
          themKhoi("cau-hoi", "Chạy lệnh kiểm tra của dự án rồi báo kết quả thật.");
          datBan(true);
          vscode.postMessage({
            type: "hoi",
            text: "Chay lenh kiem tra cua du an bang Bash roi bao ket qua that, ke ca khi that bai.",
          });
        };
        c.appendChild(document.createElement("br"));
        c.appendChild(b);
      } else if (e.edited && e.edited.length > 0 && e.ranCheck) {
        themKhoi("he-thong-mo", `✓ đã sửa ${e.edited.length} file và có chạy kiểm tra`);
      }

      themKhoi(
        "he-thong-mo",
        `${e.usage.inputTokens.toLocaleString()} vào / ${e.usage.outputTokens.toLocaleString()} ra`,
      );
      break;
    }

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
document.getElementById("chon-model").onchange = (ev) =>
  vscode.postMessage({ type: "doiModel", model: ev.target.value });

// Enter gửi, Shift+Enter xuống dòng — quy ước quen thuộc.
oNhap.addEventListener("keydown", (ev) => {
  if (ev.key === "Enter" && !ev.shiftKey) {
    ev.preventDefault();
    gui();
  }
});

datBan(false);
