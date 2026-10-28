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

Kết nối của plugin dùng `localhost` vì Figma không nhận địa chỉ IP trong `devAllowedDomains`. Đây vẫn là server trên máy này, dù trang AI Department mở bằng `127.0.0.1`. Không sửa riêng manifest: quyền mạng và URL trong UI phải khớp nhau; hãy tạo lại cả bộ Exporter.

## Cập nhật

Import lại `manifest.json` từ thư mục mới; Figma dùng bản vừa import.

Từ v1.1, Section có ảnh tổng quan và ảnh riêng cho các màn hình cấp đầu bên trong Section/Group. Frame con bên trong một màn hình không được tính thành màn hình khác. Ảnh màn hình giữ tối đa chiều ngang 2048px, cạnh dài 8192px và 16 triệu pixel; màn hình dài có vùng chi tiết được tạo trên server từ PNG đã xuất. Gallery ghi tên, node ID và kích thước; ảnh bị giới hạn hoặc không xuất được sẽ được báo. Tối đa 100 ảnh nguồn mỗi lượt, hãy chia phạm vi nếu vượt giới hạn.

Snapshot cũ được giữ nguyên: cập nhật plugin, ghép đôi rồi export lại Section để có ảnh từng màn hình. Ảnh tham chiếu đi cùng dữ liệu node/style/asset, không thay thế kiểm chứng giao diện sau triển khai.

Từ v1.1.1, vector có node hoặc layer cha được đọc là `visible=false` không gọi xuất SVG; chúng được ghi rõ là thiếu SVG do đang ẩn, vẫn cần xác nhận giới hạn. Lỗi SVG chưa xác định nguyên nhân được giữ riêng. Trong tab Giới hạn của snapshot, mục Chi tiết cảnh báo hỗ trợ tìm tên/node ID, xem component gốc/layer đang ẩn và mở bản ghi của node. Phần tra cứu cũng dùng được với snapshot cũ mà không thay đổi hash hay các xác nhận đã lưu.

## Giới hạn của v1

Chỉ editor Figma Design. Không đọc FigJam, Slides, video, comment, lịch sử phiên bản, font hay thư viện ngoài. Loại node hoặc trường chưa hỗ trợ được ghi trong coverage, không biến thành dữ liệu rỗng.
