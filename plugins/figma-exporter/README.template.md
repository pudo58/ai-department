# AI Department Exporter

Plugin Figma đọc thiết kế trong file đang mở và gửi cho AI Department (trên máy này) để tạo snapshot KB.

## Cài vào Figma Desktop (một lần)

1. Mở Figma Desktop và đăng nhập (trên Figma hoặc trình duyệt chính thức; AI Department không nhận mật khẩu).
2. Mở một file thiết kế bất kỳ.
3. Menu **Plugins → Development → Import plugin from manifest…** và chọn file `manifest.json` trong thư mục này.
4. Chạy **Plugins → Development → AI Department Exporter**.
5. Trong AI Department, mở tab **MCP**, bấm **Ghép đôi** để lấy mã 8 chữ số rồi nhập vào plugin.

Plugin này chỉ nói chuyện với `__ORIGIN__`. Nếu AI Department đổi cổng, bấm lại **Cài Figma Desktop & Exporter** để tạo bản mới rồi import lại manifest.

## Cập nhật

Import lại `manifest.json` từ thư mục mới; Figma dùng bản vừa import.

## Giới hạn của v1

Chỉ editor Figma Design. Không đọc FigJam, Slides, video, comment, lịch sử phiên bản, font hay thư viện ngoài. Loại node hoặc trường chưa hỗ trợ được ghi trong coverage, không biến thành dữ liệu rỗng.
