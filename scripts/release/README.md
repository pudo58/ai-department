# AI Department

Phòng làm việc của các AI viết code (Codex, Claude Code, Antigravity) chạy ngay trên máy bạn. Bạn giao việc, AI lập kế hoạch, viết code, viết test và soát lẫn nhau. Bạn duyệt và nghiệm thu trên giao diện web.

## Cần có

- **Node.js 18 trở lên để khởi động.** Lần chạy đầu app tự tải bộ Node 24 và npm tương ứng từ nodejs.org, kiểm tra SHA-256 rồi dùng riêng trong thư mục dữ liệu. Không dùng npm cũ của máy để tải runtime hoặc cài dependency cho task. Cần có mạng ở lần tải đầu; Node/npm của máy giữ nguyên.
- Ít nhất một AI đã cài và đăng nhập trên máy: Codex, Claude Code hoặc Antigravity. Có thể cài sau, ngay trong app.

## Cài từ npm

```bash
npm install -g ai-department
ai-department
```

Trình duyệt tự mở http://127.0.0.1:4310. Muốn tắt thì đóng cửa sổ dòng lệnh, hoặc bấm Ctrl+C.

Cập nhật bằng `npm install -g ai-department@latest`. Dữ liệu của bạn không bị đụng tới.

## Dùng bản zip (không cần npm)

1. Giải nén vào một thư mục bạn có quyền ghi, ví dụ `C:\AI Department`. Không nên đặt trong `Program Files`.
2. Chạy file khởi động:
   - Windows: bấm đúp `start.cmd`.
   - macOS hoặc Linux: chạy `./start.sh`.

Bản zip giữ dữ liệu ngay trong thư mục đó (`.data`). Khi muốn chuyển sang máy khác, mang cả thư mục đi.

## Lần đầu sử dụng

1. **Kết nối AI.** Mở trang Kết nối AI để cài và đăng nhập Codex, Claude Code hoặc Antigravity. Phiên đăng nhập do từng CLI tự lưu trên máy này; app không giữ mật khẩu hay token.
2. **Thêm dự án.** Bấm "Chọn thư mục" để chọn thư mục code. App tự nhận diện stack, rồi điền sẵn check và lệnh cài đặt.
3. **Duyệt policy, rồi Giao việc.**

## Dữ liệu nằm ở đâu

| Cách cài | Thư mục dữ liệu |
|---|---|
| npm | `~/.ai-department` (Windows: `C:\Users\<tên>\.ai-department`) |
| zip | thư mục đã giải nén |

Muốn đổi chỗ thì đặt biến môi trường `AIDEPT_HOME` trước khi chạy.

Bên trong thư mục dữ liệu:
- `.data/ai-department.sqlite`: dự án, việc, lịch sử.
- `.data/workspaces`: bản sao làm việc của từng việc. Thư mục này có thể lớn; dọn ở **Theo dõi → Hệ thống**.
- `runtime/tools/node-24.22.1`: bộ Node 24.22.1 + npm 11.19.1 riêng, được kiểm tra phiên bản khi mở app. Runtime cũ chỉ có Node sẽ được thay bằng bộ đầy đủ ở đường dẫn mới; dữ liệu task giữ nguyên.

Muốn sao lưu thì tắt app rồi copy thư mục `.data`.

## Tuỳ chọn

```bash
ai-department --port 4320    # chạy ở cổng khác
ai-department --no-open      # không tự mở trình duyệt
ai-department --help
```

App chỉ nghe ở `127.0.0.1`, nên máy khác trong mạng không truy cập được.

## Chế độ Docker (tuỳ chọn)

Dự án mặc định chạy trên máy. Muốn chạy AI trong container thì làm như sau:
1. Cài Docker.
2. Build image từ `docker/runner/Dockerfile` (nằm trong thư mục cài đặt).
3. Tạo attestation bằng `ai-department attest --project <id> ...`.

## Giấy phép

MIT, xem file `LICENSE`.
