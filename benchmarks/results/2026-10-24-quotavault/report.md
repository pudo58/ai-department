# Benchmark AI Department vs một agent — QuotaVault

**Ngày chạy:** 24/10/2026 · **Model hai nhánh:** GPT‑5.6 Terra, medium · **Số lần chạy:** 1 mỗi nhánh.

## Kết quả chính

| Tiêu chí | AI Department (Verify) | Một agent (Single) |
|---|---:|---:|
| Bộ chấm hành vi đã audit | **50/50 — 10/10** | **50/50 — 10/10** |
| Bộ chấm đóng băng ban đầu | 47/50 — 9,4/10 | 48/50 — 9,6/10 |
| Trạng thái AI Department | `failed` | `awaiting_acceptance` (checks đạt, sẵn sàng nghiệm thu) |
| Checks nội bộ | Fail ở cả hai checkpoint | Pass ở cả hai checkpoint |
| Lượt gọi model | 5 (Planner, 2 Author, 2 Developer) | 3 (Planner, 2 Developer) |
| Thời gian chạy | khoảng 21,3 phút | khoảng 18,9 phút |
| Chi tiêu ước tính trong app | $1,224 / trần $6 | $1,330 / trần $6 |
| Can thiệp người dùng vào sản phẩm | 3 đợt | 1 đợt |

Hai nhánh dùng cùng repo gốc, đặc tả, phiên bản Node/Vitest, trần ngân sách, công cụ kiểm tra và model. Các candidate được chấm bằng 50 ca API độc lập sau khi cả hai lượt model đã dừng. Không nhánh nào thấy kết quả chấm của nhánh kia. “Chi tiêu” là ước lượng của ứng dụng, không phải hóa đơn tiền mặt; dùng model qua subscription không đồng nghĩa khoản tiền này bị tính trực tiếp.

## Vì sao giữ cả điểm thô và điểm audit

Bộ chấm đã đóng băng trước khi bắt đầu, nhưng sau khi hai lượt hoàn tất mới phát hiện ba giả định của evaluator không được đặc tả bảo đảm:

- `STORE01`: đặc tả cho phép phát hiện store hỏng lúc mở vault hoặc lần sử dụng đầu; grader ban đầu bắt buộc lỗi phải xảy ra ở thời điểm cụ thể hơn.
- `WIN04`: test đặt `windowMs=10`, bắt đầu ở thời điểm 10 rồi gọi thời điểm 29 nhưng lại coi vẫn cùng window; ranh giới kế tiếp là 20.
- `SWP01`: grader đòi `cancel` phải báo lỗi sau khi `sweep` đã hết hạn reservation, trong khi đặc tả không quy định kết quả cụ thể cho chuyển trạng thái đó.

Vì vậy, điểm 47/50 và 48/50 được giữ nguyên như bản ghi lịch sử, không bị ghi đè. Bản `grade-audited.mjs` bỏ/chỉnh đúng ba giả định không được hỗ trợ; cả hai candidate đạt **50/50**. Hash của grader gốc và grader audit nằm trong `benchmark-summary.json`. Điểm audit là phép so theo hợp đồng đã viết, không chứng minh phần mềm không còn lỗi.

## Chất lượng code và quy trình

### AI Department

- Điểm tốt: tạo kế hoạch kiểm thử sâu với 18 ca bắt buộc; triển khai xử lý CAS, window, idempotency, multi-tenant cùng bài test chi tiết. Candidate cuối cùng qua toàn bộ 50 ca hành vi độc lập.
- Điểm yếu đáng kể: checks nội bộ đánh dấu cả 18 test bị thiếu dù báo cáo Vitest chứa các test tương ứng; dấu hiệu là khác định dạng đường dẫn/ID test giữa manifest và report. Đây là lỗi chất lượng của chương trình điều phối cần regression riêng.
- Hai assertion do Author tạo không khớp chính hợp đồng: C‑13 đòi reserved vẫn bằng 2 sau khi reservation đã commit; C‑17 đòi cancel lặp phải lỗi dù đặc tả nói trả `duplicate`. Developer retry không sửa được điểm này, khiến run kết thúc `failed`.
- Kế hoạch Author ban đầu sai schema và cần điều chỉnh hợp đồng/duyệt lại. Việc duyệt dùng nội dung đặc tả rõ ràng, không bổ sung yêu cầu nghiệp vụ mới.
- Mutation không chạy vì checks fail. Do đó benchmark không có dữ liệu mutation để chứng minh lợi ích của pipeline Verify.

### Một agent

- Tự sửa sau khi checkpoint đầu có checks đạt nhưng chưa quan sát được các test nghiệm thu; thêm test có mã yêu cầu, chạy lại và đạt checks. Hành vi độc lập cũng đạt 50/50.
- Hoàn tất đến trạng thái chờ nghiệm thu; không có delivery/accept trong benchmark vì hai nhánh chỉ được so ở candidate code.
- Dùng ít lượt model và ít thời gian hơn trong lần chạy này; chi phí ước tính cao hơn nhẹ. Không suy rộng thành kết luận về mọi tác vụ hoặc mọi cách cấu hình.

## Kết luận

**Chất lượng hành vi của code hòa nhau theo 50 ca đã audit. Quy trình hoàn tất lần này tốt hơn ở Single:** nó tự đi đến trạng thái sẵn sàng nghiệm thu, còn AI Department không hoàn tất dù code cuối qua grader độc lập. Benchmark này chưa chứng minh một agent tốt hơn tổng quát; nó chỉ cho thấy lợi ích lập kế hoạch của Department chưa chuyển thành reliability đầu-cuối trong task này. Ưu tiên cải tiến AI Department là sửa đối chiếu ID/đường dẫn test và kiểm tra tính nhất quán giữa kế hoạch ca với assertion trước khi khóa test.

## Tính tái lập và file kết quả

- Đặc tả: [`SPEC.md`](./SPEC.md), SHA‑256 `3106237b1a5a6987327fbbe9b3b07d13cd9330ff45edc0cec0d3801af6e7f2a7`.
- Grader đóng băng: [`grade.mjs`](./grade.mjs), kết quả thô [`department-grade.json`](./department-grade.json), [`single-grade.json`](./single-grade.json).
- Grader audit: [`grade-audited.mjs`](./grade-audited.mjs), kết quả [`department-grade-audited.json`](./department-grade-audited.json), [`single-grade-audited.json`](./single-grade-audited.json).
- Tóm tắt có run ID, checkpoint, thời gian, lượt gọi và hash: [`benchmark-summary.json`](./benchmark-summary.json).
- Protocol ban đầu: [`protocol.json`](./protocol.json). Candidate nằm ở `C:\Users\ADMIN\OneDrive\Desktop\ai-department-quotavault-20261024\department` và `...\single`; SHA cuối lần lượt `728186d81a13d7a393b869be3959b74ce09a95af` và `32b783b41df7cc4d5e09220133835ff9a8d6a3c0`.

Chạy lại grader trong thư mục repo bằng:

```powershell
node test-results/2026-10-24-quotavault/grade.mjs --candidate <candidate-path> --out <output.json>
node test-results/2026-10-24-quotavault/grade-audited.mjs --candidate <candidate-path> --out <output.json>
```

Có một lỗi hạ tầng chung trước khi hai lượt bắt đầu: workspace clone thiếu `node_modules`; setup đã được sửa giống nhau cho cả hai nhánh trước khi model tiếp tục. Đây được ghi nhận là can thiệp chung, không tính là lỗi riêng của nhánh nào. Kết quả là benchmark local; không có CI GitHub chạy trong báo cáo này.
