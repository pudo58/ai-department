# EscrowBatch — benchmark chạy lại

## Tóm tắt

Chạy lại trên snapshot AI Department hiện tại, giữ nguyên bài toán, base commit, grader 65 mục, GPT‑6 Luna medium, trần hiệu lực $10.8 và chạy tuần tự. Kết quả được lưu ở cohort riêng; benchmark cũ và run Department assisted không bị sửa.

| Chỉ số | AI Department / Verify | Single |
|---|---:|---:|
| Run | `run_b8f61a83` | `run_5d63cb30` |
| Kết quả | Dừng ở duyệt kế hoạch | Bị chặn nghiệm thu do thiếu bằng chứng test |
| Candidate | Chưa tạo | Có |
| Grader ngoài | Không chấm, không có code | **65/65 (100%)** |
| Checks nội bộ | Chưa chạy | 3/3 test đạt |
| Thời gian tự động | 77.4 giây | 162.3 giây |
| Lượt model | 2: Planner 1, Author 1 | 4: Planner 1, Developer 3 |
| Token vào (trong đó cache) | 38.9K (23.6K) | 1.76M (1.68M) |
| Token ra | 10.2K | 25.4K |
| Chi phí ước tính của ứng dụng | $0.206 | $1.134 |
| Can thiệp benchmark | 0 | 1 lần xác nhận cảnh báo hợp đồng |

## Vì sao bị dừng

**Department:** Author tạo 20 ca nhưng hợp đồng không qua kiểm tra: căn cứ R‑10 gắn nhầm vào C‑6; R‑3 và R‑16 gắn nhầm vào C‑20; R‑17 thiếu ca tự động bắt buộc; còn hai câu hỏi chưa được giải quyết. Không sửa kế hoạch hoặc gọi lại Author trong benchmark, nên chưa có candidate để chấm.

**Single:** code vượt cả 65 ca grader độc lập, nhưng chỉ có hai test nghiệp vụ được tạo (3 test tổng cộng tính cả smoke test). Chúng chỉ gắn bằng chứng cho R‑4, R‑5, R‑8, R‑14, R‑15, R‑17, R‑18. Server chặn nghiệm thu vì thiếu test evidence cho các yêu cầu còn lại. Vì vậy 65/65 là điểm hành vi của candidate, không đồng nghĩa run được nghiệm thu theo chính sách của AI Department.

## So với cohort trước

- **Department:** lần chạy mù trước cũng chưa tạo code. Lần này số ca sai cấu trúc/căn cứ giảm so với 24 ca có 7 lỗi được ghi ở lần đầu, nhưng vẫn còn blocker nên chưa cho thấy quy trình Verify đã chạy trọn vẹn. Bản assisted trước đó đạt 65/65 chỉ sau sửa kế hoạch và hai sửa setup có receipt người soát; không thể tính là tự động.
- **Single:** điểm grader tăng từ 64/65 lên 65/65 ở một candidate, nhưng run mới tốn thời gian và token nhiều hơn, đồng thời bị chặn vì bằng chứng test thiếu. Đây là hai mẫu quan sát, không đủ kết luận xu hướng chất lượng hay tốc độ.
- **Kết luận:** benchmark xác nhận code Single lần này đúng với 65 ca đã khóa. Nó chưa chứng minh AI Department cải thiện độ tự chạy; thất bại Author ở bước soát kế hoạch vẫn là điểm nghẽn chính. Cơ chế chặn nghiệm thu vì thiếu evidence hoạt động đúng theo policy hiện tại, nhưng tạo khoảng cách giữa candidate đúng theo grader ngoài và bằng chứng test do run tự tạo.

## Giới hạn và hồ sơ

Grader tự kiểm 65/65; biến thể CAS sai bị bắt ở 19 mục, biến thể expiry sai ở 15 mục. Bộ chấm không chứng minh mọi hành vi đều đúng. Một task, một lần cho mỗi mode; không suy rộng kết quả. Single không có Verifier độc lập. Số tiền là ước tính nội bộ, không phải hóa đơn API. Không dùng kết quả grader để hướng dẫn agent.

Lượt khởi động đầu tiên lỗi trước khi tạo arm vì chưa có base checkout; không gọi model. Sự cố được ghi ở `preflight-failure.json`; sau đó base được clone đúng frozen commit và benchmark chạy một lượt mỗi mode, không retry model.

Protocol và source snapshot: `protocol.json`, `source-manifest.json`. Dữ liệu từng run: `department-detail.json`, `single-detail.json`, `runs.json`. Candidate/chấm: `candidate-single/`, `single-grade.json`. So sánh máy đọc: `comparison.json`. Output report tự sinh ban đầu được giữ riêng tại `report-generator-output.md`; tài liệu này là kết luận đã hiệu chỉnh theo kết quả rerun.
