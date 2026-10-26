# ReplayGate benchmark — kết quả cuối

## Kết quả

Hai candidate được chấm lại bằng cùng grader đã audit, cùng 43 kiểm tra hành vi:

| Nhánh | Điểm | Test riêng | Thời gian / lượt model |
|---|---:|---:|---:|
| Agent đơn — GPT-6 Luna | **10/10 (43/43)** | 5/5 | 70 giây / 1 lượt |
| AI Department — GPT-6 Luna | **10/10 (43/43)** | 16/16 | 28,5 phút / 9 lượt |

**Độ đúng theo grader: hòa.** Benchmark này chưa chứng minh AI Department tạo code đúng hơn agent đơn. Điểm khác biệt là Department đi qua kế hoạch, test độc lập, check, mutation và Verifier; đổi lại cần nhiều thời gian, lượt model và can thiệp vận hành hơn.

## AI Department

- Candidate: `.data/workspaces/run_f7c3e2a3-A`, checkpoint `00985be12c2ddb525bc8c94262523a1628a0986f`.
- Grader độc lập: **43/43**. Test Author cuối cùng: **16 đạt, 0 lỗi, 0 bỏ qua**.
- Mutation: 316 bị test bắt, 82 sống sót, 9 không được phủ; không có timeout hoặc lỗi công cụ. Đây là tín hiệu chất lượng assertion, không phải điểm đúng/sai độc lập.
- Verifier trả `pass`, không có finding. Tuy nhiên, lệnh Vitest riêng của Verifier không chạy được do lỗi `Access is denied` khi tải config workspace. Check chính của run và grader bên ngoài đều chạy đạt; vì vậy không nên xem riêng verdict Verifier là một lần xác minh test độc lập thành công.
- Hai ca C-11 và C-14 ban đầu lỗi do test giả định API luôn trả Promise và dựa vào thứ tự enqueue mặc định giữa các thời điểm khác nhau. Người vận hành đã xem và duyệt diff chỉ sửa test setup; sau đó toàn bộ 16 ca chạy đạt.
- Run hiện ở trạng thái **chờ nghiệm thu** trong ứng dụng; chưa xác nhận giao kết quả.

## Agent đơn

- Grader độc lập chạy lại: **43/43**; test riêng: **5/5**.
- Một probe bổ sung sau khi khóa bộ điểm phát hiện hành vi cần xem lại tại ranh giới hết lease với lời gọi public không hợp lệ. Probe này không nằm trong 43 kiểm tra nên không làm đổi điểm 10/10; chưa dùng nó để kết luận Department hơn vì chưa có phép chạy đối chứng đã khóa trên cả hai nhánh.

## Chi phí vận hành và độ tin cậy

Run Department mất khoảng 28,5 phút và dùng 2.245.474 input token, 55.368 output token qua 9 lượt GPT-6 Luna. Cần năm đợt can thiệp vận hành: sửa cấu trúc kế hoạch, sửa mapping manifest, xử lý định dạng JSON và duyệt lại hợp đồng, khôi phục liên kết dependency, rồi duyệt diff sửa test. Đây là số lần can thiệp trong lần chạy này, không phải số đo trung bình.

Không quy đổi token thành chi phí thực tế vì cả hai nhánh chạy qua subscription CLI. Một task duy nhất cũng chưa đủ để suy ra độ tin cậy trung bình.

## Hồ sơ

- Điểm Department: `department-grade-audited.json`
- Điểm Agent đơn chạy lại: `single-grade-audited-rerun.json`
- So sánh máy đọc: `comparison-final.json`
- Grader audit: `grade-audited.mjs`
- CI GitHub chưa chạy trong benchmark local này.
