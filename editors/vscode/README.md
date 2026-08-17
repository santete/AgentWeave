# AgentWeave cho VS Code

Giao diện chat cho agent lập trình chạy **hoàn toàn cục bộ** — không gọi ra
mạng, có quản trị quyền và kiểm toán.

---

## 1. Vì sao có extension này

Terminal làm tốt phần lõi, nhưng ba việc thì editor hơn hẳn:

| | Terminal | VS Code |
|---|---|---|
| Duyệt quyền | gõ `y`/`n` lẫn giữa dòng chữ đang chảy | **nút bấm** kèm diff tô màu |
| Xem file agent vừa sửa | tự đi tìm | editor tự làm mới |
| Độ đầy ngữ cảnh | phải để ý dòng chữ | **thanh trạng thái**, đổi màu khi sắp phải nén |

Với model cục bộ cửa sổ 64K thì cái thứ ba quan trọng hơn nhiều so với model
đám mây 200K — đầy ngữ cảnh là chậm đi và bắt đầu mất thông tin.

---

## 2. Kiến trúc — extension KHÔNG nhúng agent

```
VS Code extension  ──stdin/stdout JSON dòng──▶  agentweave serve --stdio
   (chỉ là giao diện)                              (agent thật, đã cài sẵn)
```

Gói bàn giao air-gap đã mang sẵn một bản AgentWeave hoàn chỉnh. Nếu extension
nhúng lại SDK thì thành **hai bản, hai cấu hình, hai chỗ phải vá** — mà trong
khu bảo mật thì không vá được gì. Nên extension chỉ lái bản đã cài.

Hệ quả tốt: giao thức không phụ thuộc VS Code. Neovim, JetBrains hay một script
bash đều lái được, chỉ cần đọc/ghi JSON theo dòng. Đặc tả nằm ở đầu tệp
`packages/cli/src/commands/serve.ts`.

---

## 3. Cài đặt

Cần có trước: `agentweave` trong PATH (hoặc khai đường dẫn ở Settings), và
Ollama đang chạy.

```bash
cd editors/vscode
npm install
npm run build
```

Chạy thử: mở thư mục `editors/vscode` trong VS Code rồi bấm **F5** — một cửa sổ
Extension Development Host mở ra với extension đã nạp.

Đóng gói thành `.vsix` để cài trên máy khác:

```bash
npx vsce package --no-dependencies
```

---

## 4. Dùng

| Thao tác | Cách làm |
|---|---|
| Mở khung chat | `Ctrl+Alt+A`, hoặc lệnh **AgentWeave: Mở khung chat** |
| Chèn file vào ngữ cảnh | gõ `@src/foo.ts`, hoặc chuột phải trong editor → **Đưa file đang mở vào ngữ cảnh** |
| Gửi | `Enter` · xuống dòng: `Shift+Enter` |
| Dừng giữa chừng | nút **Dừng** |
| Khởi động lại agent | lệnh **AgentWeave: Khởi động lại agent** |

### Cấu hình

| Khoá | Mặc định | Ý nghĩa |
|---|---|---|
| `agentweave.cliPath` | `agentweave` | đường dẫn CLI |
| `agentweave.model` | `qwen3-coder:30b` | để trống thì lấy theo `.agentweave/agent.json` |
| `agentweave.permissionMode` | `default` | `default` hỏi trước khi ghi · `permissive` không hỏi |
| `agentweave.ollamaHost` | `127.0.0.1:11434` | dạng `host:port` đúng chuẩn Ollama |

Cấu hình theo dự án (`.agentweave/agent.json`) vẫn có hiệu lực và **thắng** giá
trị mặc định của extension.

---

## 5. Trạng thái kiểm chứng — nói rõ để khỏi hiểu nhầm

| Phần | Đã kiểm chứng? |
|---|---|
| Giao thức `serve --stdio` | ✅ chạy thật đầu-cuối: xin quyền → duyệt → sửa file → 4/4 test pass |
| Mã client (spawn, đọc JSON dòng) | ✅ typecheck strict + đóng gói được; cùng dạng với script đã chạy thật |
| Giao diện webview | ⚠️ **chưa chạy trên VS Code thật** — máy dựng không có GUI |

Phần webview cần bấm F5 chạy thử trước khi dùng cho việc thật.

---

## 6. Đưa vào gói bàn giao air-gap

`.vsix` chưa nằm trong Base Kit. Muốn có thì đóng gói rồi chép vào, cài bằng:

```bash
code --install-extension agentweave-vscode-0.1.0.vsix
```

Lưu ý cho khu bảo mật: `vsce package` cần mạng ở lần đầu để tải phụ thuộc, nên
phải làm **trong 3 ngày chuẩn bị**, không để tới lúc đã ngắt mạng.
