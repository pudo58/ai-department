# PulseGraph — benchmark AI Department và Single

## Kết quả

Bài toán scheduler trong bộ nhớ kiểm tra DAG phụ thuộc, thứ tự ưu tiên ổn định, lease và fencing token, đồng hồ logic, retry lũy thừa, cancel/block propagation, cùng snapshot/restore độc lập.

| Tiêu chí | AI Department Verify | AI Department Single |
|---|---:|---:|
| Trạng thái cuối | Chờ duyệt hợp đồng | Chờ nghiệm thu |
| Candidate | Không tạo | Có |
| Điểm code theo grader đã audit theo SPEC | Không có code để chấm | **75/75 (100%)** |
| Thời gian tự động | 112 giây | 170 giây |
| Lượt agent | 3: Planner 1, Author 2 | 3: Planner 1, Developer 2 |
| Model thực tế | GPT-6 Luna ở cả lượt | GPT-6 Luna ở cả lượt |
| Can thiệp duyệt | 0 | 1 lần duyệt hợp đồng |
| Chi phí ước tính của app | $0.315 | $0.700 |

Cả hai chạy tuần tự với cùng SPEC, scaffold, Vitest, môi trường local, model GPT-6 Luna medium và ngân sách hiệu lực $10.80. Single là chế độ Single trong AI Department, không phải một CLI độc lập.

## Điểm cần đọc cùng kết quả

Lượt đầu của grader đóng băng chấm Single **58/75**. Khi rà từng thất bại với SPEC, tôi phát hiện grader đã áp đặt các chi tiết SPEC không quy định: giá trị bắt đầu của `sequence`/`nextSequence`, mã lỗi chính xác cho `now` khởi tạo sai, và coi chuỗi chỉ có dấu cách là rỗng. 12 trace trạng thái cũng bị ảnh hưởng bởi giả định offset sequence. Vì vậy điểm 58/75 không hợp lệ để đánh giá code.

Tôi giữ nguyên SPEC, grader gốc, protocol và kết quả 58/75. Sau đó tạo một lượt chấm bổ sung chỉ nới các assertion không có căn cứ trong SPEC; không sửa candidate và không gửi kết quả grader cho model. Grader bổ sung qua reference **75/75** và Single cũng qua **75/75**. Các sửa đổi và lý do được lưu trong `grader-spec-audit.json`, `spec-audit.mjs` và `single-grade-spec-audit.json`. Đây là kết quả chấm lại hậu kiểm, được đánh dấu riêng thay vì thay thế âm thầm điểm ban đầu.

Grader gốc vẫn bắt được hai lỗi cấy có chủ đích: sai ranh giới hết hạn lease và sai backoff lũy thừa. Scaffold chưa triển khai đạt 0/75. Điều đó kiểm tra sức phát hiện lỗi, nhưng không bảo đảm bộ chấm bao phủ mọi hành vi.

## Nhận xét

- **Single:** candidate ngắn, tổ chức các phép chuyển trạng thái trong helper rõ ràng và đạt toàn bộ 75 ca đã kiểm chứng theo SPEC. Kết quả tốt trên đúng đề này; một task không chứng minh chất lượng tổng quát.
- **Department:** chưa tạo code để so sánh. Planner/Author đưa ca lease worker/token vào nhóm `authorization` đồng thời ghi nhóm này là không áp dụng. Validator phát hiện mâu thuẫn trước Developer. Đây là chặn đúng theo cơ chế, nhưng kế hoạch vẫn chưa đạt để chạy tiếp.
- **Tốc độ:** Single chậm hơn khoảng 58 giây tự động trong lượt này và dùng chi phí ước tính cao hơn. Department dừng trước bước triển khai, nên thời gian không phải so sánh thời gian hoàn tất hai sản phẩm tương đương.
- **Chưa kết luận được:** benchmark này cho thấy Single tạo candidate đạt grader, còn Verify phát hiện một lỗi tự mâu thuẫn trong kế hoạch. Nó chưa chứng minh bên nào thường tốt hơn; cần thêm nhiều đề và run hoàn tất ở cả hai nhánh.

## Hồ sơ

- [SPEC đã khóa](./SPEC.md)
- [Protocol và hash](./protocol.json)
- [Grader gốc](./grade.mjs) và [kết quả chấm gốc](./single-grade.json)
- [Kết quả chấm hậu kiểm](./single-grade-spec-audit.json)
- [Audit giả lập lỗi grader](./grader-audit.json) và [audit căn cứ SPEC](./grader-spec-audit.json)
- [Chi tiết Department](./department-detail.json), [chi tiết Single](./single-detail.json)
- [Candidate Single](./candidate-single/)
- [Comparison JSON](./comparison.json)

Benchmark không nghiệm thu hoặc giao candidate tự động. Các run vẫn ở trạng thái chờ duyệt hợp đồng/chờ nghiệm thu trong app.
