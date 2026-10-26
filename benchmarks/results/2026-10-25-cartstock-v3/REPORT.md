# CartStock — lần chạy thật với Verify v3

Run [run_743c5eb3](http://127.0.0.1:14343/#/run/run_743c5eb3) dùng **GPT-6 Luna medium cho mọi vai**, trần $10.8. Kết quả: **blocked trước Developer**, chưa có candidate để chấm code. Không nghiệm thu hay giao kết quả.

## Bài toán

Module ES JavaScript quản lý giữ hàng cho giỏ mua sắm: giữ nhiều SKU, sửa giỏ nguyên tử, owner/version, xác nhận/hủy/hết hạn, idempotency theo request ban đầu và snapshot/restore. Yêu cầu gốc: [SPEC.md](SPEC.md).

## Số đo

| Chỉ số | Kết quả |
|---|---:|
| Thời gian tự động (hợp các span của sản phẩm) | 226.0 giây |
| Thời gian chờ tại lúc kết thúc benchmark | 401.3 giây |
| Planner | 1 lượt |
| Author | 3 lượt: lập kế hoạch, sửa kế hoạch giới hạn, viết test |
| Developer / Verifier | 0 / 0 |
| Input / output token do provider báo | 202261 / 33503 |
| Cached token (nằm trong input) | 139776 |
| Chi phí ước tính | $0.7319 |
| Ca / binding trong draft | 17 / 95 |

Thời gian chờ bao gồm soát hợp đồng và chẩn đoán ngoài, không phải model thực thi. Không thể suy tốc độ hoàn thành từ một run dừng sớm.

## Diễn biến và can thiệp

1. Preflight đạt trước lượt AI đầu. Planner đề xuất ví dụ sai: stock A:5/B:2, amend A:4/B:2 bị kỳ vọng thiếu hàng dù thực tế đủ.
2. Author lập 17 ca nhưng guard bắt 6 lỗi căn cứ. Lượt sửa tự động có giới hạn vẫn để 7 lỗi. Người vận hành soát và sửa hợp đồng qua API có phiên bản: thêm điều khoản hiện hữu vào oracle, sửa ví dụ/C-10 sang B:3, làm rõ stale version, căn cứ overflow và wrapper nhận lỗi sync/async. Không sửa source/test ứng viên. Xem [contract-review-diff.json](contract-review-diff.json), receipt-1 và receipt-2.
3. Author tạo test cùng manifest. Gate v3 từ chối: **48 binding expected khác nguyên văn bước**, **5 bước thiếu binding**, **16 binding expression không duy nhất** và **16 assertion chưa có liên kết được chấp nhận**. Đây là số thông báo phân nhóm, không phải 85 lỗi nghiệp vụ độc lập; một lỗi binding có thể kéo theo thông báo chưa liên kết.
4. Khi người dùng yêu cầu tiếp tục, kiểm tra lại đúng draft/hash bằng action hỗ trợ, không gọi AI. Output vẫn sai nên không được khóa. Không đổi hash bằng sửa hợp đồng giả, không xóa marker để cấp lượt mới.
5. Chạy bản sao test draft trên reference ở thư mục riêng: **17/17 đạt**. Đây là chẩn đoán test, không phải implementation Department. Candidate workspace vẫn sạch và chỉ chứa stub ban đầu.

## Bộ chấm ngoài và phạm vi kết luận

Bộ chấm được khóa trước model: **64/64 trên reference**, scaffold **0/64**, bắt cả 5 mutant cài cố ý (biên expiry, credit hold cũ, owner/version precedence, replay deadline và confirm accounting). Có 8 chuỗi 80 thao tác/seed kiểm tra bất biến ledger. Grader không import reference. Các mutant ở đây là audit bộ chấm, **không phải mutation do Department chạy**.

Nâng cấp chứng minh được qua run này: preflight chạy sớm, guard oracle bắt lỗi, guard assertion ngăn khóa output sai, draft được giữ/hoàn nguyên và kiểm tra lại không tốn model. Chưa đi tới diagnosis v3, checks ứng viên, mutation, Verifier replay hoặc delivery nên chưa xác nhận thực tế các phần đó.

**Kết luận:** cơ chế chặn làm đúng, nhưng khả năng hoàn thành tự động chưa đạt ở lần này. Nút thắt là giao thức Author phải sao chép expected và kê khai nhiều assertion bằng tay. Bước cải tiến phù hợp là server sinh sẵn binding theo case/step, Author điền expression/line, và có một lượt sửa draft có giới hạn, lưu marker/hash trước khi gọi; vẫn giữ nguyên mọi kiểm tra trước khóa. Chưa triển khai thay đổi đó trong benchmark đã khóa.

## Bằng chứng và chạy lại chẩn đoán

- [benchmark.json](benchmark.json): số đo và giới hạn.
- [final-detail.json](final-detail.json): raw output, artifact, trace, trạng thái.
- [draft-diagnostic.json](draft-diagnostic.json): phân loại lỗi và kết quả runner thật.
- [protocol.json](protocol.json), [source-manifest.json](source-manifest.json): cấu hình/hash trước model và snapshot mã nguồn có sẵn.

Từ repo root, không gọi model:

```powershell
node test-results/2026-10-25-cartstock-v3/grade.mjs test-results/2026-10-25-cartstock-v3/reference.mjs test-results/2026-10-25-cartstock-v3/reference-recheck.json
node test-results/2026-10-25-cartstock-v3/diagnose-draft.mjs
```

Đọc dữ liệu cũ không nâng policy/hash. Không thay đổi source sản phẩm, benchmark cũ hay candidate để cứu kết quả. UI được phục vụ tiếp tại port 14343, run vẫn blocked; server chính 4310 được giữ nguyên.
