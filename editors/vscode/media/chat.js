// Giao diện chat trong webview.
// Không dùng framework: extension phải chạy được trong khu bảo mật, mỗi phụ
// thuộc thêm là một thứ nữa phải mang theo và phải tin.

const vscode = acquireVsCodeApi();
const oTinNhan = document.getElementById("tin-nhan");
const oQuyen = document.getElementById("dang-cho-quyen");
const oNhap = document.getElementById("o-nhap");

let khoiDangChay = null; // khối chữ model đang sinh
let chuDangChay = ""; // chữ thô, để dựng lại markdown khi đoạn kết thúc
let dangBan = false;
let dongHo = null;
let lucBatDau = 0;

const oDangChay = document.getElementById("dang-chay");
const oViec = document.getElementById("viec-hien-tai");
const oDongHo = document.getElementById("dong-ho");

/** Thanh "đang chạy" kèm đồng hồ — dấu hiệu agent còn sống chứ chưa dừng. */
function batDauChay(viec) {
  lucBatDau = Date.now();
  oViec.textContent = viec;
  oDangChay.classList.add("hien");
  clearInterval(dongHo);
  dongHo = setInterval(() => {
    oDongHo.textContent = `${((Date.now() - lucBatDau) / 1000).toFixed(1)}s`;
  }, 100);
}
function datViec(viec) {
  if (oDangChay.classList.contains("hien")) oViec.textContent = viec;
}
function ngungChay() {
  clearInterval(dongHo);
  dongHo = null;
  oDangChay.classList.remove("hien");
}

/**
 * Dựng markdown ở mức tối thiểu: khối ```mã```, `mã trong dòng`, **đậm**.
 * CỐ Ý không dùng innerHTML — chữ do model sinh ra, nhét thẳng vào HTML là mở
 * cửa cho chèn mã. Mọi thứ dựng bằng createElement + textContent.
 */
function veChu(khung, chu) {
  khung.textContent = "";
  chu.split(/```/).forEach((doan, i) => {
    if (i % 2 === 1) {
      const pre = document.createElement("pre");
      pre.className = "ma";
      const dong = doan.split("\n");
      if (dong.length > 1 && /^[a-zA-Z0-9+#-]{0,15}$/.test(dong[0].trim())) dong.shift();
      pre.textContent = dong.join("\n").replace(/^\n+|\n+$/g, "");
      khung.appendChild(pre);
      return;
    }
    for (const mau of doan.split(/(`[^`\n]+`|\*\*[^*\n]+\*\*)/)) {
      if (!mau) continue;
      if (mau.startsWith("`") && mau.endsWith("`") && mau.length > 2) {
        const c = document.createElement("code");
        c.className = "trong-dong";
        c.textContent = mau.slice(1, -1);
        khung.appendChild(c);
      } else if (mau.startsWith("**") && mau.endsWith("**") && mau.length > 4) {
        const b = document.createElement("strong");
        b.textContent = mau.slice(2, -2);
        khung.appendChild(b);
      } else {
        khung.appendChild(document.createTextNode(mau));
      }
    }
  });
}

/** Một ô số đo. `muc` = "nhanh" | "cham" | "" để tô màu. */
function oSo(nhan, giaTri, muc) {
  const d = document.createElement("span");
  d.className = `o ${muc || ""}`.trim();
  d.textContent = `${nhan} `;
  const b = document.createElement("b");
  b.textContent = giaTri;
  d.appendChild(b);
  return d;
}

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
      // Trong lúc chảy để nguyên văn cho nhanh; dựng markdown khi đoạn kết
      // thúc, vì dựng lại ở mỗi mẩu thì giật.
      if (!khoiDangChay) {
        khoiDangChay = themKhoi("tra-loi", "");
        chuDangChay = "";
      }
      chuDangChay += e.text;
      khoiDangChay.textContent = chuDangChay;
      datViec("đang trả lời");
      oTinNhan.scrollTop = oTinNhan.scrollHeight;
      break;

    case "first_token":
      datViec("đang trả lời");
      break;

    case "tool": {
      if (khoiDangChay && chuDangChay) veChu(khoiDangChay, chuDangChay);
      khoiDangChay = null;
      chuDangChay = "";
      datViec(`đang chạy ${e.name}`);
      const d = themKhoi("tool");
      // KHÔNG innerHTML: e.name tới từ model.
      const nhan = document.createElement("span");
      nhan.className = "nhan";
      nhan.textContent = `⚡ ${e.name}`;
      d.appendChild(nhan);
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
      if (khoiDangChay && chuDangChay) veChu(khoiDangChay, chuDangChay);
      khoiDangChay = null;
      chuDangChay = "";
      datViec(`đang chờ bạn duyệt ${e.tool}`);
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
      if (khoiDangChay && chuDangChay) veChu(khoiDangChay, chuDangChay);
      khoiDangChay = null;
      chuDangChay = "";
      ngungChay();
      datBan(false);

      // Số đo hiệu năng THẬT. Với model cục bộ đây không phải trang trí: tok/s
      // tụt theo độ dài ngữ cảnh, người dùng cần thấy để biết khi nào nên xoá
      // hội thoại hoặc đổi model.
      if (e.perf) {
        const p = e.perf;
        const bang = themKhoi("so-do");
        bang.textContent = "";
        if (p.tokPerSec != null) {
          bang.appendChild(oSo("⚡", `${p.tokPerSec.toFixed(1)} tok/s`, p.tokPerSec >= 30 ? "nhanh" : "cham"));
        }
        if (p.ttftMs != null) {
          bang.appendChild(oSo("⏱ chờ", `${(p.ttftMs / 1000).toFixed(1)}s`, p.ttftMs > 5000 ? "cham" : ""));
        }
        bang.appendChild(oSo("⌛ tổng", `${(p.totalMs / 1000).toFixed(1)}s`));
        if (p.toolCalls) bang.appendChild(oSo("🔧", `${p.toolCalls} tool`));
        bang.appendChild(oSo("↕", `${e.usage.inputTokens.toLocaleString()}/${e.usage.outputTokens.toLocaleString()} tok`));
        if (e.context && e.context.maxTokens) {
          const pct = Math.round((e.context.usedTokens / e.context.maxTokens) * 100);
          bang.appendChild(oSo("▦ ngữ cảnh", `${pct}%`, pct >= 80 ? "cham" : ""));
        }
      }

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

      break;
    }

    case "reset_ok":
      oTinNhan.innerHTML = "";
      themKhoi("he-thong", "Đã xoá hội thoại");
      break;

    case "error":
      khoiDangChay = null;
      chuDangChay = "";
      ngungChay();
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
  chuDangChay = "";
  datBan(true);
  batDauChay("đang nghĩ…");
  vscode.postMessage({ type: "hoi", text: t });
}

document.getElementById("gui").onclick = gui;
document.getElementById("huy").onclick = () => {
  vscode.postMessage({ type: "huy" });
  ngungChay();
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
