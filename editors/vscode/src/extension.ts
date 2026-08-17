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
				client?.hoi(String(m.text));
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
		}
	});

	if (!client?.dangSong()) batDauClient();
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
      content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
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
    <textarea id="o-nhap" rows="3" placeholder="Hỏi gì đó… dùng @đường-dẫn để chèn file"></textarea>
    <div id="nut">
      <select id="chon-model" disabled title="Model đang dùng"></select>
      <button id="gui">Gửi</button>
      <button id="huy" class="phu">Dừng</button>
      <button id="xoa" class="phu">Xoá hội thoại</button>
    </div>
  </div>
  <script nonce="${nonce}" src="${js}"></script>
</body>
</html>`;
}
