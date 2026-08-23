# Xuất tài liệu Word / Excel / PDF

Agent tự sinh file `.docx` `.xlsx` `.pdf` **không cần thư viện Python** — dùng
LibreOffice ở chế độ không giao diện, gọi qua `Bash`. Máy đích đã đóng gói sẵn
`soffice`; KHÔNG cài thêm gì.

## Quy trình đúng

1. Viết nội dung ra file nguồn bằng `FileWrite`: Markdown (`.md`) hoặc HTML (`.html`)
   cho tài liệu chữ; CSV (`.csv`) cho bảng tính.
2. Chuyển sang định dạng đích bằng một lệnh `soffice`.
3. Báo đường dẫn file đã tạo. KHÔNG nói "đã tạo" mà chưa chạy lệnh chuyển.

## Lệnh theo từng đích

**Markdown → Word** (đường thẳng nhất, ưu tiên dùng):
```bash
soffice --headless --convert-to docx bao-cao.md --outdir .
```

**HTML → Word** — KHÔNG dùng `--convert-to docx` (báo lỗi "no export filter");
phải khai đúng tên bộ lọc:
```bash
soffice --headless --convert-to 'docx:MS Word 2007 XML' bao-cao.html --outdir .
```

**CSV → Excel:**
```bash
soffice --headless --convert-to xlsx bang.csv --outdir .
```

**Bất kỳ nguồn nào → PDF:**
```bash
soffice --headless --convert-to pdf bao-cao.html --outdir .
```

## Bẫy và cách tránh

- **"no export filter ... found, aborting"**: nguồn HTML mở nhầm thành Writer/Web.
  Khai bộ lọc tường minh như lệnh HTML→Word ở trên, hoặc đi vòng qua Markdown.
- **Hồ sơ người dùng bị khoá / sandbox chặn ghi HOME**: buộc LibreOffice ghi hồ
  sơ vào thư mục làm việc bằng `-env:UserInstallation`:
  ```bash
  soffice --headless -env:UserInstallation=file://$PWD/.lo-profile \
    --convert-to docx bao-cao.md --outdir .
  ```
- **Cảnh báo `failed to launch javaldx`**: vô hại, chuyển vẫn thành công. Bỏ qua.
- **Kiểm chứng thật**: sau khi chuyển, chạy `file bao-cao.docx` — phải thấy
  "Microsoft Word 2007+". Đừng tin là xong khi chưa kiểm.

## Bảng định dạng nguồn → đích

| Muốn | Nguồn nên viết | Lệnh |
|---|---|---|
| Word | Markdown | `--convert-to docx` |
| Word từ HTML | HTML | `--convert-to 'docx:MS Word 2007 XML'` |
| Excel | CSV | `--convert-to xlsx` |
| PDF | HTML hoặc Markdown | `--convert-to pdf` |

Định dạng chữ thuần (`.md .txt .html .csv .json`) thì KHÔNG cần soffice —
`FileWrite` ghi thẳng là xong.
