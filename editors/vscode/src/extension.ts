/**
 * Extension AgentWeave cho VS Code.
 *
 * Ba thứ editor làm tốt hơn hẳn terminal, và đó là lý do extension này tồn tại:
 *   ① duyệt quyền bằng NÚT BẤM kèm diff tô màu, thay vì gõ y/n giữa dòng chữ
 *   ② mở thẳng file mà agent vừa sửa, không phải tự tìm
 *   ③ thấy độ đầy ngữ cảnh ở thanh trạng thái — với model cục bộ 64K thì đây
 *      là con số cần liếc thường xuyên
 */

import * as vscode from "vscode";
import { AgentClient, type SuKienAgent } from "./agent-client";

let client: AgentClient | null = null;
let panel: vscode.WebviewPanel | null = null;
let output: vscode.OutputChannel;
let thanhTrangThai: vscode.StatusBarItem;

export function activate(ctx: vscode.ExtensionContext): void {
	output = vscode.window.createOutputChannel("AgentWeave");
	thanhTrangThai = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
	ctx.subscriptions.push(output, thanhTrangThai);

	ctx.subscriptions.push(
		vscode.commands.registerCommand("agentweave.chat", () => moKhungChat(ctx)),
		vscode.commands.registerCommand("agentweave.restart", () => {
			client?.dungLai();
			client = null;
			batDauClient();
			vscode.window.showInformationMessage("AgentWeave: đã khởi động lại agent");
		}),
		vscode.commands.registerCommand("agentweave.pipeline", async () => {
			// Pipeline là TRỤ CỘT 2: có cổng chất lượng và vòng thử lại, nhưng
			// KHÔNG có rule/skill/memory. Hỏi thẳng lệnh kiểm thay vì đoán, vì
			// không có lệnh kiểm thì `qualityGate` tắt và pipeline mất đúng phần
			// giá trị riêng của nó — lúc đó dùng khung chat còn hơn.
			const viec = await vscode.window.showInputBox({
				title: "AgentWeave: chạy pipeline SDLC",
				prompt: "Việc cần làm (khép kín, có tiêu chí đạt/hỏng rõ ràng)",
				placeHolder: "vd: thêm hàm cong(a,b) vào src/toan.js và viết test",
			});
			if (!viec?.trim()) return;

			// Đoán lệnh kiểm THEO DỰ ÁN. Điền sẵn `npm test` cho mọi thứ là bẫy:
			// trên một solution .NET nó chạy trong thư mục không có package.json,
			// hỏng ngay, cổng chất lượng đỏ, retryEngine quay đủ 3 vòng vô ích —
			// và người dùng tưởng agent làm sai. Đoán sai vẫn hơn bịa, nhưng đoán
			// theo thứ có thật trên đĩa thì hầu như không sai.
			// TRỎ ĐÚNG VÀO FILE DỰ ÁN, không phát một lệnh trần.
			//
			// Mất một vòng chạy mới thấy: `dotnet build` trần chạy ở gốc workspace,
			// nơi KHÔNG có project nào — nó in "0 Error(s)" và trả mã thoát 0 trong
			// 0,15 giây. Cổng chất lượng xanh, pipeline báo ĐẠT, trong khi build
			// thật trong HelpdeskSolution/ đang hỏng mã thoát 1. Một phép kiểm
			// không kiểm gì mà vẫn xanh là thứ nguy hiểm nhất trong cả pipeline.
			const doanLenhKiem = async (): Promise<string> => {
				const goc = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? "";
				const tim = async (mau: string): Promise<string | null> => {
					const r = await vscode.workspace.findFiles(mau, "**/node_modules/**", 1);
					if (r.length === 0) return null;
					const p = r[0]!.fsPath;
					return p.startsWith(goc) ? p.slice(goc.length + 1) : p;
				};
				const sln = await tim("**/*.sln");
				if (sln) return `dotnet build "${sln}"`;
				const csproj = await tim("**/*.csproj");
				if (csproj) return `dotnet build "${csproj}"`;
				const pkg = await tim("**/package.json");
				if (pkg) {
					const thuMuc = pkg.replace(/package\.json$/, "").replace(/\/$/, "");
					return thuMuc === "" ? "npm test" : `npm --prefix "${thuMuc}" test`;
				}
				const pom = await tim("**/pom.xml");
				if (pom) return `mvn -q -f "${pom}" test`;
				const cargo = await tim("**/Cargo.toml");
				if (cargo) return `cargo test --manifest-path "${cargo}"`;
				if (await tim("**/go.mod")) return "go test ./...";
				return "";
			};

			const lenhKiem = await vscode.window.showInputBox({
				title: "Lệnh kiểm chất lượng",
				prompt: "Ngăn cách bằng dấu phẩy. Bỏ trống = không có cổng chất lượng.",
				placeHolder: "vd: dotnet build, npm test",
				value: await doanLenhKiem(),
			});
			// `undefined` = người dùng bấm Esc ở bước này → huỷ cả lệnh.
			if (lenhKiem === undefined) return;

			const checks = lenhKiem
				.split(",")
				.map((c) => c.trim())
				.filter((c) => c !== "");

			moKhungChat(ctx);
			batDauClient();
			client?.chayPipeline(viec.trim(), checks);
			panel?.reveal();
		}),
		vscode.commands.registerCommand("agentweave.addFile", () => {
			const tep = vscode.window.activeTextEditor?.document;
			if (!tep) return;
			const goc = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? "";
			const tuongDoi = tep.uri.fsPath.startsWith(goc)
				? tep.uri.fsPath.slice(goc.length + 1)
				: tep.uri.fsPath;
			panel?.webview.postMessage({ type: "chenVaoO", text: `@${tuongDoi} ` });
			panel?.reveal();
		}),
	);
}

export function deactivate(): void {
	client?.dungLai();
}

function layTuyChon() {
	const c = vscode.workspace.getConfiguration("agentweave");
	return {
		cliPath: c.get<string>("cliPath", "agentweave"),
		model: c.get<string>("model", "qwen3-coder:30b"),
		permissionMode: c.get<string>("permissionMode", "default"),
		ollamaHost: c.get<string>("ollamaHost", "127.0.0.1:11434"),
		cwd: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd(),
	};
}

function batDauClient(): void {
	client = new AgentClient(layTuyChon());
	client.on("nhatKy", (s: string) => output.append(s));
	client.on("suKien", (e: SuKienAgent) => {
		xuLySuKien(e);
		panel?.webview.postMessage(e);
	});
	client.batDau();
}

function xuLySuKien(e: SuKienAgent): void {
	switch (e.type) {
		case "ready":
			// Server vừa sẵn sàng → xin danh sách model ngay, không đợi webview.
			// Bọc cặp với việc webview tự xin lúc tải: một trong hai luôn tới đích,
			// nên dropdown model không còn kẹt "disabled".
			client?.lietKeModel();
			break;
		case "context": {
			const pct = Math.round((e.used / e.max) * 100);
			thanhTrangThai.text = `$(database) ngữ cảnh ${pct}%`;
			thanhTrangThai.tooltip = `${e.used.toLocaleString()} / ${e.max.toLocaleString()} token`;
			// Đổi màu khi sắp phải nén — người dùng biết trước, không bị bất ngờ.
			thanhTrangThai.backgroundColor =
				pct >= 80 ? new vscode.ThemeColor("statusBarItem.warningBackground") : undefined;
			thanhTrangThai.show();
			break;
		}
		case "compacted":
			vscode.window.setStatusBarMessage(
				`AgentWeave: đã nén ngữ cảnh (~${e.freedTokens} token)`,
				4000,
			);
			break;
		case "tool_result":
			// Sửa file xong thì làm mới editor đang mở để người dùng thấy ngay.
			if (e.ok && /^Edited |^Written /.test(e.preview)) {
				void vscode.commands.executeCommand("workbench.action.files.revert");
			}
			break;
		case "error":
			output.appendLine(`[loi] ${e.message}`);
			break;
		default:
			break;
	}
}

function moKhungChat(ctx: vscode.ExtensionContext): void {
	if (panel) {
		panel.reveal();
		return;
	}

	panel = vscode.window.createWebviewPanel(
		"agentweaveChat",
		"AgentWeave",
		vscode.ViewColumn.Beside,
		{ enableScripts: true, retainContextWhenHidden: true },
	);

	panel.webview.html = dungHtml(panel.webview, ctx.extensionUri);

	panel.onDidDispose(() => {
		panel = null;
		client?.dungLai();
		client = null;
		thanhTrangThai.hide();
	});

	panel.webview.onDidReceiveMessage((m: Record<string, unknown>) => {
		switch (m.type) {
			case "hoi":
				client?.hoi(
					String(m.text),
					Array.isArray(m.images)
						? (m.images as Array<{ data: string; mimeType?: string }>)
						: undefined,
				);
				break;
			case "dinhAnh":
				// Mở hộp thoại chọn ảnh ở tiến trình host rồi đẩy base64 vào webview.
				void chonAnhTuFile().then((a) => {
					if (a) panel?.webview.postMessage({ type: "anhTuFile", ...a });
				});
				break;
			case "quyen":
				client?.traLoiQuyen(String(m.id), m.allow === true, m.alwaysAllow === true);
				break;
			case "huy":
				client?.huy();
				break;
			case "xoa":
				client?.xoaHoiThoai();
				break;
			case "listModels":
				client?.lietKeModel();
				break;
			case "doiModel":
				client?.doiModel(String(m.model));
				break;
			case "moFile": {
				const goc = vscode.workspace.workspaceFolders?.[0]?.uri;
				if (goc) void vscode.window.showTextDocument(vscode.Uri.joinPath(goc, String(m.path)));
				break;
			}
			case "listSessions":
				client?.lietKePhien();
				break;
			case "moPhien":
				client?.moPhien(m.id ? String(m.id) : undefined);
				break;
			case "hoanTac":
				client?.hoanTac();
				break;
			case "timKiemFile":
				// Gợi ý đường dẫn cho @ — hỏi thẳng workspace của VS Code, không
				// cần thêm giao thức phía agent. Loại thư mục nặng để danh sách gọn.
				void timFileGoiY(String(m.q ?? "")).then((ds) =>
					panel?.webview.postMessage({ type: "goiYFile", ds }),
				);
				break;
		}
	});

	if (!client?.dangSong()) batDauClient();
}

/**
 * Tìm tối đa 20 file khớp chuỗi gõ sau @.
 *
 * Dùng API workspace của VS Code nên tôn trọng sẵn .gitignore và files.exclude
 * của người dùng — không phải nhét thêm luật loại trừ vào agent. Khớp theo chuỗi
 * con trên đường dẫn tương đối, đủ dùng cho một danh sách gõ nhanh.
 */
async function chonAnhTuFile(): Promise<{ data: string; mimeType: string; ten: string } | null> {
	const chon = await vscode.window.showOpenDialog({
		canSelectMany: false,
		filters: { Ảnh: ["png", "jpg", "jpeg", "gif", "webp", "bmp"] },
		openLabel: "Đính ảnh vào chat",
	});
	if (!chon || !chon[0]) return null;
	const uri = chon[0];
	const bytes = await vscode.workspace.fs.readFile(uri);
	const duoi = (uri.path.split(".").pop() ?? "png").toLowerCase();
	const mimeType = duoi === "jpg" ? "image/jpeg" : `image/${duoi}`;
	const b64 = Buffer.from(bytes).toString("base64");
	return {
		data: `data:${mimeType};base64,${b64}`,
		mimeType,
		ten: uri.path.split("/").pop() ?? "anh",
	};
}

async function timFileGoiY(q: string): Promise<string[]> {
	const glob = "**/*";
	const loai = "**/{node_modules,.git,dist,.turbo,out,build}/**";
	const uris = await vscode.workspace.findFiles(glob, loai, 2000);
	const goc = vscode.workspace.workspaceFolders?.[0]?.uri;
	const rel = uris.map((u) => (goc ? vscode.workspace.asRelativePath(u, false) : u.fsPath));
	const kq = q.trim() ? rel.filter((r) => r.toLowerCase().includes(q.toLowerCase())) : rel;
	// Ngắn trước cho những đường dẫn nông nổi lên đầu — thường là thứ cần.
	return kq.sort((a, b) => a.length - b.length).slice(0, 20);
}

function dungHtml(webview: vscode.Webview, goc: vscode.Uri): string {
	const js = webview.asWebviewUri(vscode.Uri.joinPath(goc, "media", "chat.js"));
	const css = webview.asWebviewUri(vscode.Uri.joinPath(goc, "media", "chat.css"));
	const nonce = Math.random().toString(36).slice(2);
	// Cỡ chữ chỉnh được: khung chat là chỗ để ĐỌC, không phải giao diện dày đặc
	// như phần còn lại của editor, nên 13px mặc định là quá nhỏ.
	const coChu = vscode.workspace.getConfiguration("agentweave").get<number>("fontSize", 14);

	return `<!DOCTYPE html>
<html lang="vi">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy"
      content="default-src 'none'; style-src ${webview.cspSource}; img-src data:; script-src 'nonce-${nonce}';">
<link href="${css}" rel="stylesheet">
<style>:root { --aw-co-chu: ${Math.min(Math.max(coChu, 10), 24)}px; }</style>
</head>
<body>
  <div id="tin-nhan"></div>
  <div id="dang-cho-quyen"></div>
  <div id="dang-chay">
    <span class="cham-nhay"></span>
    <span class="viec" id="viec-hien-tai">đang nghĩ…</span>
    <span class="dong-ho" id="dong-ho">0.0s</span>
  </div>
  <div id="thanh-nhap">
    <div id="anh-cho" class="an"></div>
    <div id="o-nhap-boc">
      <textarea id="o-nhap" rows="3" placeholder="Hỏi gì đó… @đường-dẫn để chèn file · dán (Ctrl+V) hoặc nút Ảnh để gửi ảnh"></textarea>
      <div id="goi-y-file" class="an"></div>
    </div>
    <div id="nut">
      <select id="chon-model" disabled title="Model đang dùng"></select>
      <button id="gui">Gửi</button>
      <button id="huy" class="phu">Dừng</button>
      <button id="anh" class="phu" title="Đính ảnh (hoặc dán Ctrl+V vào ô nhập)">🖼 Ảnh</button>
      <button id="hoan-tac" class="phu" title="Hoàn tác thay đổi file gần nhất" disabled>↶ Hoàn tác</button>
      <button id="phien" class="phu" title="Phiên đã lưu">Phiên</button>
      <button id="xoa" class="phu">Xoá hội thoại</button>
    </div>
  </div>
  <div id="bang-phien" class="an"></div>
  <script nonce="${nonce}" src="${js}"></script>
</body>
</html>`;
}
