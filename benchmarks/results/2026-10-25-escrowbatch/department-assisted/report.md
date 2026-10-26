# EscrowBatch — Department chạy tiếp có can thiệp

Code Department đã tạo và đạt **65/65** mục chấm ngoài, so với Single **64/65**. Đây là nhánh chạy tiếp có can thiệp, không thay thế kết quả benchmark tự động ban đầu.

| Tiêu chí | Department có can thiệp | Single ban đầu |
|---|---|---|
| Điểm hành vi | 65/65 | 64/65 |
| Check nội bộ | 11 đạt, 16 lỗi | 15 đạt |
| Quy trình cuối | blocked | awaiting_acceptance |
| Model attempts | 6 | 2 |
| Thời gian tự động cộng dồn | 326.7s | 119.2s |
| Input token quan sát | 1016057 | 375883 |
| Output token | 35096 | 9928 |
| Ước tính ứng dụng | $1.163 | $0.338 |

## Can thiệp

- Sửa 7 lỗi metadata/oracle/steps của kế hoạch theo SPEC, giữ 24 ca.
- Author xóa tests/scaffold.test.js được bảo vệ: hệ thống hoàn nguyên đúng. Theo yêu cầu tiếp tục, thêm hướng dẫn giữ nguyên file đó và cấp một lượt Author mới qua resume.
- Author lần sau tạo manifest hợp lệ, khóa test rồi Developer viết source. Không sửa source/assertion thay model, không truyền grader hoặc code Single cho Department.

## Điểm chặn hiện tại

Test helper code(promise, value) được truyền ledger.apply(...) trực tiếp. Implementation đồng bộ ném Error trước khi helper bắt lỗi; expect(...).rejects có cùng vấn đề. SPEC cho phép sync hoặc async. Report thật có 16 ca lỗi, không phải 16 lỗi nghiệp vụ đã được chứng minh.

Author chẩn đoán trả JSON không có khối fenced như giao thức hiện tại yêu cầu; parser từ chối. Nội dung chẩn đoán còn quy lỗi implementation khi bằng chứng chưa đủ. Không tự xóa marker chẩn đoán hoặc nới test để cho qua; run chưa tới mutation/Verifier và chưa được nghiệm thu.

## Đánh giá code

Department dùng nextBalances cho kiểm tra funds trong batch, nên qua ca provisional-credit mà Single trượt. Map/Set bảo toàn ID đặc biệt, history/replay/expiry và snapshot đều qua bộ chấm hiện có. Không suy 65/65 thành không còn lỗi: chưa có mutation hoặc Verifier, chưa đánh giá tải lớn; clone khi restore cần soát thêm về aliasing nested snapshot.

Kết luận: code Department có kết quả hành vi tốt hơn trên bộ chấm này sau hỗ trợ; độ tự vận hành vẫn kém Single và chưa hoàn tất Verify. Chưa có cơ sở nói Department tốt hơn nói chung hoặc nhanh hơn.

Hồ sơ: plan-repair.json, approval.json, result.json (lượt scope bị chặn), scope-retry/detail.json, scope-retry/grade.json, internal-test-report.json, diagnosis-raw.json và candidate/. Benchmark gốc ../report.md và ../runs.json giữ nguyên.
