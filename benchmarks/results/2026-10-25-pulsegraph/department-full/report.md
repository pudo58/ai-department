# PulseGraph — kết quả chạy đủ luồng có người soát

**Department đã hoàn tất và giao branch thành công.** Bản cuối đạt bộ chấm 75/75 và sửa được một lỗi `blockedBy` mà cả Single lẫn reference trước đó đều mắc. Single vẫn đạt 75/75 trên bộ chấm cũ nhưng trượt phản ví dụ mới; đã từ chối nghiệm thu Single.

Lần này tiếp tục run Department cũ, tự soát và duyệt các bước; chấm lại candidate Single gốc mà không gọi thêm model cho nhánh Single. Toàn bộ thời gian, token, lượt lỗi trước đó vẫn được tính vào Department. Benchmark ban đầu và báo cáo gốc giữ nguyên.

| Tiêu chí | AI Department Verify, có người soát | Single gốc |
|---|---:|---:|
| Model ở mọi lượt | gpt-6-luna / medium | gpt-6-luna / medium |
| Trần ngân sách hiệu lực | $10.80 | $10.80 |
| Trạng thái sau review | completed, delivery succeeded | blocked, từ chối nghiệm thu do lỗi đã tái hiện |
| Bộ chấm theo SPEC đã audit | 75/75 | 75/75 |
| Phản ví dụ mới từ Verifier | Đạt sau sửa | Thất bại |
| Checks tại checkpoint cuối | 18 đạt / 0 lỗi / 0 skip | 15 đạt / 0 lỗi / 0 skip |
| Các ca bắt buộc đã khai báo | 16/16 đạt | Không có kế hoạch Author độc lập |
| Lượt agent, tính cả lịch sử | 11 ({"planner":1,"author":4,"developer":4,"verifier":2}) | 3 ({"planner":1,"developer":2}) |
| Thời gian tự động trong app | 7m 55s | 2m 51s |
| Chi phí quy đổi ước tính | $1.977 | $0.700 |
| Input / cache / output token | 2178364 / 1940864 / 45453 | 886472 / 828032 / 18394 |
| Mutation cuối | killed 225; survived 45; no coverage 12; timeout 0 | killed 256; survived 59; no coverage 16; timeout 1 |
| Thời gian mutation cuối | 72.6s, nằm trong app | 79.6s, đo thêm ngoài app |

## Lỗi sâu được Verifier tìm thấy

1. Tạo A, B và C với `C.dependsOn = [A, B]`.
2. Hủy B: C bị block bởi B.
3. Hủy A: A trở thành dependency thất bại đầu tiên theo thứ tự; `C.blockedBy` phải đổi thành A.

Trước sửa, Department, Single và reference đều giữ B. Verifier tự phát hiện phản ví dụ trong code Department; chưa từng nhận output của grader hoặc code Single. Tôi xác nhận bằng public API và dùng API sửa finding của app. Developer sửa source, bổ sung `tests/scheduler.blocked-by.test.js`, rồi checks → mutation → Verifier chạy lại. Sau sửa: Department trả A, Single vẫn trả B.

Đây là bằng chứng cụ thể rằng review độc lập đã tìm ra lỗi ngoài bộ test của task này. Nó cũng cho thấy điểm 75/75 không chứng minh hết lỗi: reference và generator trace trước đó đều bỏ sót trình tự này. Tôi giữ probe mới riêng, không đổi điểm 75 ca đã khóa.

## Những can thiệp đã thực hiện

- Sửa hợp đồng trước chạy: bỏ `authorization` khỏi nhóm không áp dụng vì C-6 đã dùng nhóm này; sửa C-16 để retry được claim ở thời điểm 5 và lease 1 hết hạn ở 6. Giữ cả 16 ca và yêu cầu gốc, duyệt hợp đồng v4.
- Author tạo một assertion sai ở C-5: mong claim thứ ba trả null khi B còn ready. Chẩn đoán nói test sai nhưng enum lại là implementation, dẫn tới hai lượt Developer không có patch. Tôi lập diff sửa đúng một ca, duyệt qua proposal/hash hiện có, khóa lại manifest/test và chạy lại checks. Không sửa source thủ công.
- Xác nhận finding `blockedBy` bằng tái hiện thực tế rồi cho Developer sửa qua luồng findings.
- Đọc cảnh báo, kiểm tra thủ công tiêu chí không thêm persistence/network/timer/worker, nghiệm thu và xác nhận giao branch Department. Single bị từ chối sau khi phản ví dụ mới thất bại.

Vì có sửa kế hoạch và một assertion bởi người soát, kết quả này phải được hiểu là **hoàn tất có hỗ trợ**, chưa phải một run tự động trọn vẹn.

## Mutation và giới hạn

Department chạy mutation hai lần: trước sửa finding 218 killed / 44 survived / 12 no coverage trong 46.0s; sau sửa là số liệu trong bảng. Baseline của hai lần đều pass. Single được đo thêm bằng cùng adapter Stryker/Vitest, cùng concurrency 2 và giới hạn 5 phút; không gọi AI, không sửa candidate và không ghi mutation vào bằng chứng Single gốc.

Hai source sinh số mutant khác nhau nên không dùng số killed tuyệt đối để kết luận bộ test nào mạnh hơn. Mutant sống sót hoặc không được phủ vẫn cần xem xét; timeout Single không được tính là đã bắt lỗi nghiệp vụ.

Chờ duyệt bao gồm khoảng gián đoạn giữa các lượt hội thoại và thời gian tôi đọc bằng chứng; không dùng nó làm số đo tốc độ model. Department mất nhiều thời gian tự động hơn vì có lập kế hoạch, sai test/chẩn đoán, hai lượt mutation và hai lượt Verifier.

## Giao kết quả

Branch Department: `aidept/run_dfd3d309-A` trong `.data/pulsegraph-20261025/department`. Đã kiểm tra branch trỏ đúng checkpoint:

```text
b54cfcc0c980063ba7d16c0423c529281fdd929d
```

Delivery receipt là `succeeded`; đây là branch trong repo benchmark. Single giữ nguyên candidate lỗi để đối chứng và không được giao.

## Hồ sơ

- [Kết quả máy đọc](./comparison.json), [trạng thái giao](./result.json)
- [Chi tiết Department](./department-detail.json), [Single](./single-detail.json)
- [Grader Department](./department-grade.json), [Single](./single-grade.json)
- [Probe trước sửa](./blockedby-before-repair.json), [sau sửa](./blockedby-after-repair.json)
- [Diff sửa test có duyệt](./operator-c5.patch), [proposal và căn cứ](./operator-c5-proposal.json)
- [Candidate Department](./candidate-department/), [candidate Single](./candidate-single/)
- [Mutation Single đo thêm](./single-mutation.json)
- [Đề gốc](../SPEC.md), [protocol gốc](../protocol.json), [báo cáo benchmark trước khi hỗ trợ](../report.md)

## Kết luận từ lượt này

Department tạo bản cuối tốt hơn Single ở phản ví dụ đã kiểm chứng và đã giao thành công. Đổi lại, nó dùng nhiều lượt/thời gian hơn và vẫn cần người soát sửa kế hoạch cùng một test. Điểm cần cải thiện tiếp là độ đúng của Author và tính nhất quán giữa nhãn chẩn đoán với chính lý do/bằng chứng mà agent viết.

- One synthetic task and one original run per mode.
- Department used operator assistance on the plan and one test assertion; completion does not demonstrate full autonomy.
- Single was not rerun with AI in this continuation and did not receive the Department finding as model feedback.
- The new counterexample is a post-run discovery; its result is separate from the locked 75-item suite, not a retroactively altered benchmark score.
- Mutation counts come from different implementations and test suites; raw killed counts are not a controlled ranking of test quality.
- Surviving/no-coverage mutants remain warnings; the one Single timeout is not a demonstrated behavioral kill.
- Dollar figures are application estimates, not independently measured API invoices.
- Verifier supplied static review and cited current runner reports; it did not independently execute the test suite.
