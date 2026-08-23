// Giao diện chat trong webview.
// Không dùng framework: extension phải chạy được trong khu bảo mật, mỗi phụ
// thuộc thêm là một thứ nữa phải mang theo và phải tin.

const vscode = acquireVsCodeApi();
const oTinNhan = document.getElementById("tin-nhan");
const oQuyen = document.getElementById("dang-cho-quyen");
const oNhap = document.getElementById("o-nhap");

let khoiDangChay = null; // khối chữ model đang sinh
let chuDangChay = ""; // chữ thô, để dựng lại markdown khi đoạn kết thúc
// id các lời gọi tool bị ẩn — để ẩn nốt kết quả của chúng.
const idToolAn = new Set();
let dangBan = false;
let dongHo = null;
let lucBatDau = 0;
let daChayMs = 0; // thời gian AGENT chạy, không tính lúc chờ người dùng

const oDangChay = document.getElementById("dang-chay");
const oViec = document.getElementById("viec-hien-tai");
const oDongHo = document.getElementById("dong-ho");

/** Thanh "đang chạy" kèm đồng hồ — dấu hiệu agent còn sống chứ chưa dừng. */
function batDauChay(viec) {
  lucBatDau = Date.now();
  daChayMs = 0;
  oViec.textContent = viec;
  oDangChay.classList.add("hien");
  oDangChay.classList.remove("cho-nguoi");
  clearInterval(dongHo);
  dongHo = setInterval(() => {
    daChayMs = Date.now() - lucBatDau;
    oDongHo.textContent = `${(daChayMs / 1000).toFixed(1)}s`;
  }, 100);
}
function datViec(viec) {
  if (oDangChay.classList.contains("hien")) oViec.textContent = viec;
}

/**
 * Chờ người dùng quyết định thì DỪNG đồng hồ.
 *
 * Để nó chạy tiếp là đang bấm giờ người dùng — tạo cảm giác bị hối, mà con số
 * đó cũng không nói gì về agent. Đổi luôn sang tông chờ đợi: chấm ngừng nhấp
 * nháy, màu hổ phách, chữ nói rõ là đang chờ QUYẾT ĐỊNH chứ không phải đang bận.
 */
function tamDung(viec) {
  clearInterval(dongHo);
  dongHo = null;
  oDangChay.classList.add("cho-nguoi");
  oViec.textContent = viec;
  oDongHo.textContent = "";
}

/** Người dùng đã quyết xong — chạy tiếp, đồng hồ nối từ chỗ đã dừng. */
function chayTiep(viec) {
  oDangChay.classList.remove("cho-nguoi");
  oViec.textContent = viec;
  if (!dongHo) {
    // Cộng bù để đồng hồ không nhảy lùi, nhưng KHÔNG tính khoảng vừa chờ.
    lucBatDau = Date.now() - daChayMs;
    dongHo = setInterval(() => {
      daChayMs = Date.now() - lucBatDau;
      oDongHo.textContent = `${(daChayMs / 1000).toFixed(1)}s`;
    }, 100);
  }
}

function ngungChay() {
  clearInterval(dongHo);
  dongHo = null;
  oDangChay.classList.remove("hien", "cho-nguoi");
}

/**
 * Dựng markdown ở mức tối thiểu.
 *
 * Khối: ```mã```, "## tiêu đề", "- mục", "1. mục".
 * Trong dòng: `mã`, **đậm**.
 *
 * CỐ Ý không dùng innerHTML — chữ do model sinh ra, nhét thẳng vào HTML là mở
 * cửa cho chèn mã. Mọi thứ dựng bằng createElement + textContent.
 *
 * Vì sao cần hiểu tiêu đề và danh sách: `.khoi` có `white-space: pre-wrap` nên
 * xuống dòng vốn đã hiện đúng, nhưng "## Kết luận" và "- mục" thì hiện ra
 * nguyên dấu cú pháp. Người đọc thấy chữ thô lẫn dấu markdown — vừa xấu vừa
 * khó quét mắt, mà đó lại là thứ họ nhìn nhiều nhất.
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
    veDoanChu(khung, doan);
  });
}

/** Dựng phần chữ thường: tách theo DÒNG để nhận ra tiêu đề và danh sách. */
function veDoanChu(khung, doan) {
  const dong = doan.split("\n");
  let ds = null; // <ul>/<ol> đang mở, null = đang ở văn xuôi

  const dongDs = () => {
    ds = null;
  };

  for (let k = 0; k < dong.length; k++) {
    const d = dong[k];
    const tieuDe = /^(#{1,4})\s+(.*)$/.exec(d);
    const muc = /^\s*[-*]\s+(.*)$/.exec(d);
    const so = /^\s*(\d{1,3})[.)]\s+(.*)$/.exec(d);

    if (tieuDe) {
      dongDs();
      const h = document.createElement("div");
      h.className = `md-h md-h${tieuDe[1].length}`;
      veTrongDong(h, tieuDe[2]);
      khung.appendChild(h);
      continue;
    }

    if (muc || so) {
      const loai = muc ? "ul" : "ol";
      if (!ds || ds.tagName.toLowerCase() !== loai) {
        ds = document.createElement(loai);
        ds.className = "md-ds";
        khung.appendChild(ds);
      }
      const li = document.createElement("li");
      veTrongDong(li, muc ? muc[1] : so[2]);
      ds.appendChild(li);
      continue;
    }

    dongDs();
    // Dòng trống ngay sau một khối đã có thẻ riêng thì bỏ — nếu không sẽ thừa
    // một dòng trắng, vì thẻ khối đã tự có lề trên/dưới.
    if (d.trim() === "" && khung.lastChild && khung.lastChild.nodeType === 1) continue;
    veTrongDong(khung, d);
    if (k < dong.length - 1) khung.appendChild(document.createTextNode("\n"));
  }
}

/** Định dạng trong một dòng: `mã` và **đậm**. */
function veTrongDong(khung, chu) {
  for (const mau of chu.split(/(`[^`\n]+`|\*\*[^*\n]+\*\*)/)) {
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

    case "anhTuFile":
      themAnh(e.data, e.mimeType);
      oNhap.focus();
      break;

    case "notice":
      themKhoi(e.level === "warn" ? "canh-bao" : "he-thong-mo", e.message);
      break;

    // Lượt do server khởi phát (hẹn giờ). Webview chỉ tự vào trạng thái bận khi
    // NGƯỜI DÙNG bấm gửi, nên không có tin này thì ô nhập vẫn mở và câu gõ tiếp
    // theo bị từ chối bằng "dang chay mot luot khac".
    case "turn_start":
      khoiDangChay = null;
      chuDangChay = "";
      datBan(true);
      batDauChay("Đang chạy việc hẹn giờ");
      break;

    case "model_switched":
      // Tự đổi model cho lượt có ảnh (model chính không đọc được ảnh).
      themKhoi(
        "he-thong",
        `🖼 ${e.to} đọc ảnh` + (e.tam ? ` → ${e.from} dựng theo mô tả` : ""),
      );
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
      datViec("Đang soạn câu trả lời");
      oTinNhan.scrollTop = oTinNhan.scrollHeight;
      break;

    case "first_token":
      datViec("Đang soạn câu trả lời");
      break;

    case "tool": {
      if (khoiDangChay && chuDangChay) veChu(khoiDangChay, chuDangChay);
      khoiDangChay = null;
      chuDangChay = "";
      // TodoWrite chỉ sửa danh sách việc trong bộ nhớ — vẽ từng lời gọi ra chỉ
      // tạo một bức tường ⚡ che mất các tool làm việc thật. Bản gốc cũng ẩn
      // (`renderToolUseMessage() → null`). Tiến độ hiện ở thanh trạng thái.
      if (e.name === "TodoWrite") {
        idToolAn.add(e.id);
        datViec("Đang cập nhật danh sách việc");
        break;
      }
      datViec(`Đang chạy ${e.name}`);
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
      // Ẩn cả kết quả của TodoWrite — lời gọi đã ẩn thì kết quả treo lơ lửng.
      if (idToolAn.has(e.id)) {
        idToolAn.delete(e.id);
        break;
      }
      const d = themKhoi(e.ok ? "ket-qua" : "ket-qua-hong");
      // Kết quả ĐẠT: một dòng là đủ — người dùng chỉ cần biết nó chạy xong.
      // Kết quả HỎNG: giữ tới 4 dòng. Lỗi thường ngắn mà lại là thứ người dùng
      // cần đọc nhất; cắt còn một dòng thì họ thấy màu đỏ mà không biết vì sao.
      const tho = String(e.preview ?? "");
      const soDong = e.ok ? 1 : 4;
      const than = tho.split("\n").slice(0, soDong).join("\n").slice(0, e.ok ? 160 : 600);
      d.textContent = `${e.ok ? "✓" : "✗"} ${e.durationMs}ms · ${than}${tho.length > than.length ? " …" : ""}`;
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
      tamDung(`Chờ bạn duyệt ${e.tool}`);
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
        chayTiep(allow ? `Đang chạy ${e.tool}` : "Đang tiếp tục");
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
        bang.appendChild(oSo("⌛ agent", `${(p.totalMs / 1000).toFixed(1)}s`));
        if (p.waitUserMs > 1000) {
          // Tách hẳn ra: thời gian bạn ngồi quyết định không phải tốc độ của máy.
          bang.appendChild(oSo("👤 bạn duyệt", `${(p.waitUserMs / 1000).toFixed(0)}s`));
        }
        if (p.toolCalls) bang.appendChild(oSo("🔧", `${p.toolCalls} tool`));
        bang.appendChild(oSo("↕", `${e.usage.inputTokens.toLocaleString()}/${e.usage.outputTokens.toLocaleString()} tok`));
        if (e.context && e.context.maxTokens) {
          const pct = Math.round((e.context.usedTokens / e.context.maxTokens) * 100);
          bang.appendChild(oSo("▦ ngữ cảnh", `${pct}%`, pct >= 80 ? "cham" : ""));
        }
      }

      // Cảnh báo dựa trên QUAN SÁT, không dựa vào lời model tự nhận. Model 30B
      // hay tuyên bố "các test đều pass" mà chưa chạy lệnh nào.
      //
      // Ba trạng thái xấu khác nhau, đừng gộp làm một: "chưa chạy" là chưa có
      // ai hỏi; "bị giết" là đã hỏi mà không kịp trả lời; "báo hỏng" là đã có
      // câu trả lời và câu trả lời là không đạt. Gộp lại thì người dùng không
      // biết phải làm gì tiếp.
      const soSua = (e.edited || []).length;
      if (soSua > 0 && e.checkOutcome !== "dat") {
        const loi = {
          "khong-chay":
            `⚠ Đã sửa ${soSua} file nhưng CHƯA chạy kiểm tra nào: ${(e.edited || []).join(", ")}. ` +
            `Mọi khẳng định "chạy ổn" ở trên đều chưa được kiểm chứng.`,
          "bi-giet":
            `⚠ Lệnh kiểm tra bị giết vì quá hạn giờ — KHÔNG có kết luận nào cho ${soSua} file đã sửa. ` +
            `Nếu dự án build lâu, tăng bashTimeoutMs trong .agentweave/agent.json.`,
          hong:
            `⚠ Lệnh kiểm tra đã chạy và BÁO HỎNG — ${soSua} file đã sửa vẫn chưa đạt: ` +
            `${(e.edited || []).join(", ")}.`,
        }[e.checkOutcome || "khong-chay"];

        const c = themKhoi("chua-kiem-chung");
        c.textContent = loi;
        const b = document.createElement("button");
        b.textContent = e.checkOutcome === "hong" ? "Bảo agent sửa cho đạt" : "Bảo agent chạy kiểm tra";
        b.className = "phu";
        b.onclick = () => {
          const y =
            e.checkOutcome === "hong"
              ? "Lenh kiem tra dang bao hong. Doc ky output, sua cho den khi chay dat, roi bao ket qua that."
              : "Chay lenh kiem tra cua du an bang Bash roi bao ket qua that, ke ca khi that bai.";
          themKhoi("cau-hoi", y);
          datBan(true);
          vscode.postMessage({ type: "hoi", text: y });
        };
        c.appendChild(document.createElement("br"));
        c.appendChild(b);
      } else if (soSua > 0) {
        themKhoi("he-thong-mo", `✓ đã sửa ${soSua} file · lệnh kiểm tra chạy xong và đạt`);
      }

      // Có sửa file thì mở nút hoàn tác. Nút này áp lên NGĂN XẾP của agent —
      // bấm nhiều lần lùi dần từng thay đổi một.
      if (soSua > 0) document.getElementById("hoan-tac").disabled = false;
      break;
    }

    case "reset_ok":
      oTinNhan.innerHTML = "";
      themKhoi("he-thong", "Đã xoá hội thoại");
      break;

    case "sessions": {
      veBangPhien(e.sessions, e.current);
      break;
    }

    case "resumed": {
      // Dựng LẠI hội thoại cũ để đọc được, không chỉ nạp ngữ cảnh ngầm.
      oTinNhan.innerHTML = "";
      themKhoi("he-thong", `↻ Đã mở lại phiên ${e.id} · ${e.soLuot} lượt`);
      for (const m of e.transcript || []) {
        if (m.kind === "hoi") {
          const q = themKhoi("cau-hoi");
          if (m.coAnh) {
            const tag = document.createElement("span");
            tag.className = "anh-tag";
            tag.textContent = "🖼 ";
            q.appendChild(tag);
          }
          q.appendChild(document.createTextNode(m.text || "(ảnh)"));
        } else if (m.kind === "tra-loi") {
          veChu(themKhoi("tra-loi"), m.text);
        } else if (m.kind === "tool") {
          const d = themKhoi("tool");
          const nhan = document.createElement("span");
          nhan.className = "nhan";
          nhan.textContent = `⚡ ${m.text}`;
          d.appendChild(nhan);
        }
      }
      themKhoi("he-thong-mo", "— gõ tiếp để tiếp tục —");
      anBangPhien();
      break;
    }

    case "undone": {
      const chu = e.daXoa
        ? `↶ Đã hoàn tác: xoá ${e.path} (file này vốn do agent tạo mới)`
        : `↶ Đã hoàn tác: khôi phục ${e.path} về bản trước`;
      themKhoi("he-thong", `${chu}${e.conLai ? ` · còn ${e.conLai} bước có thể hoàn tác` : ""}`);
      if (!e.conLai) document.getElementById("hoan-tac").disabled = true;
      break;
    }

    case "goiYFile":
      veGoiYFile(e.ds || []);
      break;

    case "error": {
      khoiDangChay = null;
      chuDangChay = "";
      ngungChay();
      datBan(false);
      const oLoi = themKhoi("loi", `✗ ${e.message}`);
      // hint = các bước sửa cụ thể (vd Ollama chưa chạy). Hiện thành danh
      // sách đánh số, dễ làm theo hơn một dòng lỗi thô.
      if (Array.isArray(e.hint) && e.hint.length) {
        const ol = document.createElement("ol");
        ol.className = "buoc-sua";
        for (const b of e.hint) {
          const li = document.createElement("li");
          li.textContent = b;
          ol.appendChild(li);
        }
        oLoi.appendChild(ol);
      }
      break;
    }
  }
});

function gui() {
  const t = oNhap.value.trim();
  if ((!t && anhCho.length === 0) || dangBan) return;
  // Tin nhắn gửi hiện kèm THUMBNAIL ảnh, không phải "🖼×1" khô khan.
  const q = themKhoi("cau-hoi");
  if (t) q.appendChild(document.createTextNode(t));
  if (anhCho.length) {
    const strip = document.createElement("div");
    strip.className = "cau-hoi-anh";
    for (const a of anhCho) {
      const im = document.createElement("img");
      im.src = a.data;
      strip.appendChild(im);
    }
    q.appendChild(strip);
  }
  oNhap.value = "";
  khoiDangChay = null;
  chuDangChay = "";
  datBan(true);
  batDauChay("Đang đọc yêu cầu");
  vscode.postMessage({ type: "hoi", text: t, images: anhCho.map((a) => ({ data: a.data, mimeType: a.mimeType })) });
  xoaHetAnh();
}

// ── Ảnh đính kèm ──
// Dán (Ctrl+V) một ảnh chụp màn hình lỗi, hoặc bấm nút Ảnh. Giữ trong bộ nhớ tới
// khi gửi; mỗi ảnh hiện một thumbnail bấm ✕ để bỏ.
const anhCho = [];
const oAnhCho = document.getElementById("anh-cho");

function veAnhCho() {
  oAnhCho.textContent = "";
  if (!anhCho.length) {
    oAnhCho.classList.add("an");
    return;
  }
  anhCho.forEach((a, i) => {
    const o = document.createElement("div");
    o.className = "anh-thumb";
    const img = document.createElement("img");
    img.src = a.data;
    o.appendChild(img);
    const x = document.createElement("button");
    x.className = "bo-anh";
    x.textContent = "✕";
    x.title = "Bỏ ảnh";
    x.onclick = () => {
      anhCho.splice(i, 1);
      veAnhCho();
    };
    o.appendChild(x);
    oAnhCho.appendChild(o);
  });
  oAnhCho.classList.remove("an");
}
function themAnh(dataUrl, mimeType) {
  if (anhCho.length >= 6) return; // đủ dùng; nhiều quá thì ngữ cảnh nặng
  anhCho.push({ data: dataUrl, mimeType: mimeType || "image/png" });
  veAnhCho();
}
function xoaHetAnh() {
  anhCho.length = 0;
  veAnhCho();
}

// Dán ảnh từ clipboard.
oNhap.addEventListener("paste", (ev) => {
  const items = (ev.clipboardData || {}).items || [];
  for (const it of items) {
    if (it.type && it.type.startsWith("image/")) {
      const f = it.getAsFile();
      if (!f) continue;
      const r = new FileReader();
      r.onload = () => themAnh(String(r.result), f.type);
      r.readAsDataURL(f);
      ev.preventDefault(); // đừng dán data URL thô vào ô chữ
    }
  }
});

// ── Bảng phiên đã lưu ──
const oBangPhien = document.getElementById("bang-phien");

function veBangPhien(ds, current) {
  oBangPhien.textContent = "";
  const tieu = document.createElement("div");
  tieu.className = "tieu-de-phien";
  tieu.textContent = ds.length ? "Phiên đã lưu (mới nhất trước)" : "Chưa có phiên nào được lưu";
  oBangPhien.appendChild(tieu);
  for (const p of ds) {
    const hang = document.createElement("div");
    hang.className = "hang-phien" + (p.id === current ? " hien-tai" : "");
    const t = document.createElement("div");
    t.className = "phien-tom-tat";
    t.textContent = p.tomTat || "(không có tóm tắt)";
    const meta = document.createElement("div");
    meta.className = "phien-meta";
    const luc = (p.capNhat || "").slice(0, 16).replace("T", " ");
    meta.textContent = `${luc} · ${p.soLuot} lượt · ${p.model}` + (p.id === current ? " · đang mở" : "");
    hang.appendChild(t);
    hang.appendChild(meta);
    if (p.id !== current) {
      hang.onclick = () => vscode.postMessage({ type: "moPhien", id: p.id });
      hang.title = "Mở lại phiên này";
    }
    oBangPhien.appendChild(hang);
  }
  oBangPhien.classList.remove("an");
}
function anBangPhien() {
  oBangPhien.classList.add("an");
}

// ── Gợi ý @đường-dẫn ──
const oGoiY = document.getElementById("goi-y-file");
let goiYChon = -1; // dòng đang chọn trong dropdown
let goiYDs = [];

/** Lấy token @... ngay trước con trỏ; null nếu không đang gõ @. */
function tokenAt() {
  const v = oNhap.value;
  const caret = oNhap.selectionStart;
  const truoc = v.slice(0, caret);
  const m = truoc.match(/(^|\s)@([^\s@]*)$/);
  if (!m) return null;
  return { q: m[2], batDau: caret - m[2].length - 1, caret };
}

function xinGoiY() {
  const tk = tokenAt();
  if (!tk) {
    anGoiY();
    return;
  }
  vscode.postMessage({ type: "timKiemFile", q: tk.q });
}

function veGoiYFile(ds) {
  // Có thể tới sau khi người dùng đã gõ tiếp và không còn ở @token nữa.
  if (!tokenAt()) {
    anGoiY();
    return;
  }
  goiYDs = ds;
  goiYChon = ds.length ? 0 : -1;
  oGoiY.textContent = "";
  if (!ds.length) {
    anGoiY();
    return;
  }
  ds.forEach((d, i) => {
    const r = document.createElement("div");
    r.className = "goi-y-hang" + (i === goiYChon ? " chon" : "");
    r.textContent = d;
    r.onmousedown = (ev) => {
      ev.preventDefault(); // giữ focus ở textarea
      chonGoiY(i);
    };
    oGoiY.appendChild(r);
  });
  oGoiY.classList.remove("an");
}
function anGoiY() {
  oGoiY.classList.add("an");
  goiYChon = -1;
  goiYDs = [];
}
function chonGoiY(i) {
  const tk = tokenAt();
  if (!tk || !goiYDs[i]) return;
  const v = oNhap.value;
  const sau = v.slice(tk.caret);
  const chen = `@${goiYDs[i]} `;
  oNhap.value = v.slice(0, tk.batDau) + chen + sau;
  const vitri = tk.batDau + chen.length;
  oNhap.setSelectionRange(vitri, vitri);
  anGoiY();
  oNhap.focus();
}

oNhap.addEventListener("input", xinGoiY);
oNhap.addEventListener("blur", () => setTimeout(anGoiY, 120));

document.getElementById("gui").onclick = gui;
document.getElementById("huy").onclick = () => {
  vscode.postMessage({ type: "huy" });
  ngungChay();
  datBan(false);
};
document.getElementById("xoa").onclick = () => vscode.postMessage({ type: "xoa" });
document.getElementById("hoan-tac").onclick = () => vscode.postMessage({ type: "hoanTac" });
document.getElementById("anh").onclick = () => vscode.postMessage({ type: "dinhAnh" });
document.getElementById("phien").onclick = () => {
  // Bấm lần nữa để đóng nếu đang mở — nút bật/tắt.
  if (!oBangPhien.classList.contains("an")) anBangPhien();
  else vscode.postMessage({ type: "listSessions" });
};
document.getElementById("chon-model").onchange = (ev) =>
  vscode.postMessage({ type: "doiModel", model: ev.target.value });

// Enter gửi, Shift+Enter xuống dòng — quy ước quen thuộc.
// Nhưng khi dropdown gợi ý @ đang mở, các phím mũi tên / Enter / Esc lái dropdown
// trước, không đụng tới việc gửi.
oNhap.addEventListener("keydown", (ev) => {
  const moGoiY = !oGoiY.classList.contains("an") && goiYDs.length;
  if (moGoiY) {
    if (ev.key === "ArrowDown") {
      ev.preventDefault();
      dieuHuongGoiY(1);
      return;
    }
    if (ev.key === "ArrowUp") {
      ev.preventDefault();
      dieuHuongGoiY(-1);
      return;
    }
    if (ev.key === "Enter" || ev.key === "Tab") {
      ev.preventDefault();
      chonGoiY(goiYChon < 0 ? 0 : goiYChon);
      return;
    }
    if (ev.key === "Escape") {
      ev.preventDefault();
      anGoiY();
      return;
    }
  }
  if (ev.key === "Enter" && !ev.shiftKey) {
    ev.preventDefault();
    gui();
  }
});

function dieuHuongGoiY(buoc) {
  const hang = oGoiY.querySelectorAll(".goi-y-hang");
  if (!hang.length) return;
  goiYChon = (goiYChon + buoc + hang.length) % hang.length;
  hang.forEach((h, i) => h.classList.toggle("chon", i === goiYChon));
  hang[goiYChon].scrollIntoView({ block: "nearest" });
}

datBan(false);

// Xin danh sách model NGAY khi webview tải — kể cả khi tải lại (đổi tab rồi
// quay lại, VS Code dựng lại webview). Trước đây chỉ xin khi nhận 'ready', mà
// 'ready' server chỉ phát một lần lúc spawn → sau khi webview tải lại, dropdown
// kẹt 'disabled' vĩnh viễn, không đổi được model. Webview→extension luôn tin cậy.
vscode.postMessage({ type: "listModels" });
