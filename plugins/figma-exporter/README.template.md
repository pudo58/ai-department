# AI Department Exporter

Plugin Figma đọc thiết kế trong file đang mở và gửi cho AI Department (trên máy này) để tạo snapshot KB.

## Cài vào Figma Desktop (một lần)

1. Mở Figma Desktop và đăng nhập (trên Figma hoặc trình duyệt chính thức; AI Department không nhận mật khẩu).
2. Mở một file thiết kế bất kỳ.
3. Import plugin từ file `manifest.json` trong thư mục này. Tên menu đổi theo bản Figma, nên có ba đường, dùng đường nào thấy trước:
   - Nhấn `Ctrl + /` (Quick actions), gõ `import plugin from manifest` rồi chọn lệnh khớp. Cách này không phụ thuộc vị trí menu.
   - Menu **Plugins → Import plugin from manifest…** (bản cũ hơn: **Plugins → Development → Import plugin from manifest…**).
   - Bản có panel **Tools**: **Create → Plugin**, nếu hộp thoại có tùy chọn import từ manifest. Đừng tạo plugin mới từ mẫu.
4. Chạy plugin **AI Department Exporter**: gõ tên vào Quick actions (`Ctrl + /`), hoặc tìm trong panel **Tools**, hoặc **Plugins → Development → AI Department Exporter** ở bản cũ.
5. Trong AI Department, mở tab **MCP**, bấm **Ghép đôi** để lấy mã 8 chữ số rồi nhập vào plugin.

Plugin này chỉ nói chuyện với `__ORIGIN__`. Nếu AI Department đổi cổng, bấm lại **Cài Figma Desktop & Exporter** để tạo bản mới rồi import lại manifest.

## Cập nhật

Import lại `manifest.json` từ thư mục mới; Figma dùng bản vừa import.

## Giới hạn của v1

Chỉ editor Figma Design. Không đọc FigJam, Slides, video, comment, lịch sử phiên bản, font hay thư viện ngoài. Loại node hoặc trường chưa hỗ trợ được ghi trong coverage, không biến thành dữ liệu rỗng.
