# Pilot-1 (M0b): 8 task × 3 nhánh × 2 lần

Ngày 2026-10-26. `gpt-6-luna` medium cho mọi vai, cùng SPEC và scaffold, chạy tuần tự (48/48 assignment, không lỗi hạ tầng). Manifest `pilot-1.manifest.json` đã đăng ký trước khi chạy (hash 96c6c682…, khóa cả hash của từng gói task). Chấm bằng grader ẩn của gói task. Nhánh: `native-full` = Codex CLI chạy riêng với đủ tính năng; `harness-single` = chế độ Single của ứng dụng; `harness-team` = chế độ Verify (Department).

**Nguồn gốc `synthetic`.** Task, reference, grader và mutant do AI viết, chưa có người độc lập xác nhận; CLI đánh dấu kết quả chỉ để thử bộ đo, không phải bằng chứng về hiệu quả. Hợp đồng được tự duyệt nguyên trạng; đề xuất sửa test hợp lệ được tự áp dụng một lần mỗi run. Một lần chạy mỗi ô.

## Kết quả

Hai bảng: điểm theo grader đã đăng ký ("lúc chạy") và sau một điều chỉnh grader làm sau khi thấy kết quả (xem mục cuối).

| Nhánh | Chạy | Đạt grader (lúc chạy → sau chỉnh) | Được nghiệm thu* | `falseReady` | Chạy suy giảm | Chi phí TB | Thời gian TB |
|---|---|---|---|---|---|---|---|
| native-full | 16 | 13 → 14 | 13 → 14 | n/a | n/a | $0,19 | 69 s |
| harness-single | 16 | 15 → 15 | 14 → 14 | 1 | 0 | $0,76 | 196 s |
| harness-team (Department) | 16 | 13 → 15 | 10 → 10 | 0 | 6 | $1,01 | 289 s |

\* "Được nghiệm thu" = grader đạt toàn bộ **và** run đi hết đường bình thường (harness: tới chờ nghiệm thu; native: agent kết thúc). Chi phí là ước tính theo token của ứng dụng, không phải hóa đơn.

Tỉ lệ nghiệm thu sau chỉnh: native 0,88; Single 0,88; Department 0,62. Chênh lệch Department so với Single −25 điểm (95% CI −44 → −6); so với native −25 (CI −50 → +13); Single so với native 0 (CI −25 → +25). Với 8 task, mẫu thấp hơn nhiều so với 104 task cần để thấy chênh 15 điểm: khoảng bao gồm 0 nghĩa là chưa đủ bằng chứng, trừ chênh lệch Department–Single.

Ma trận từng ô (điểm sau chỉnh; OK = đạt hết): xem `matrix.md`.

## Đọc kết quả

1. **Mã đúng:** ba nhánh gần như ngang nhau trên grader (14/16, 15/16, 15/16). Không có bằng chứng Department viết mã đúng hơn.
2. **Department bị chặn nhiều nhất dù mã thường đúng:** 6/16 run không tới được nghiệm thu, và 5 trong 6 run đó có mã đạt grader.
   - 3 run do **test của Author sai** (`bookings` lần 1: test hold bắt đầu trong quá khứ; `pulsegraph` lần 2: test đọc `token` của kết quả null; `bookings` lần 2: lượt sửa test thứ hai bị bộ chạy từ chối). Developer không thể làm đạt một test sai.
   - 2 run do **Verifier nêu finding** trên mã đạt grader (`pulsegraph` lần 1: `blockedBy` không cập nhật khi dependency đứng trước bị block muộn; `runner` lần 1: giá trị thường vẫn tính là "đang chạy" tới microtask kế). Cả hai đọc SPEC theo nghĩa đen là đúng, và reference của mình cũng mắc cùng điều đó; grader không kiểm các ca này. Không finding nào có phản ví dụ chạy được.
   - 1 run (`runner` lần 2) bị chặn **đúng**: Verifier chỉ ra lỗi thật mà grader sau khi bổ sung cũng bắt (27/28).
3. **Điểm có lợi cho Department:** 0 `falseReady` (Single có 1: `pulsegraph` lần 1, snapshot làm mất lease nhưng vẫn báo "sẵn sàng"). Nhưng lợi ích đó nhỏ so với cái giá: 5 run mã đúng bị chặn.
4. **Chi phí và thời gian:** native chạy riêng rẻ hơn Single ~4 lần và hơn Department ~5 lần, nhanh hơn 3 và 4 lần, với tỉ lệ đúng tương đương.
5. **Native-full có hai mã sai thật** (`charges` lần 2: key không hết hạn; `versions` lần 1: không nhận tiền tố `v`), và không có cơ chế nào tự phát hiện chúng; đây là lý do duy nhất cho thấy phần "độc lập kiểm chứng" có thể có giá trị.

## Điều chỉnh grader sau khi thấy kết quả

Ba run (`pulsegraph` Department lần 1 và 2, native lần 2) bị 43/44 do hai assertion của grader đòi mã lỗi mà SPEC không quy định: tự phụ thuộc vào chính nó (vừa là tự tham chiếu vừa là chưa tồn tại: `INVALID_DEPENDENCIES` hay `UNKNOWN_DEPENDENCY`) và `complete` trên id không tồn tại (`UNKNOWN_JOB` hay `LEASE_LOST`). Bản sửa chấp nhận cả hai mã (`benchmarks/eval/amendments/pilot-1/pulsegraph.grade.test.js`, để ngoài gói task đã đăng ký). Đã kiểm lại: reference vẫn đạt, cả 16 mutant vẫn bị bắt. Chấm lại bằng `scripts/eval-regrade.mjs`. Điểm "lúc chạy" vẫn giữ nguyên trong `rows/`.

Tương tự, grader `runner` được bổ sung một ca trước pilot (sau pilot e1), nên cả pilot này dùng bản đã bổ sung.

## Hạn chế

- Task, reference, grader và mutant cùng một tác giả (AI); đã lộ hai lỗi grader và hai chỗ reference lệch SPEC theo nghĩa đen. Cần người ngoài soát trước khi dùng cho kết luận.
- Hợp đồng tự duyệt và sửa test tự áp dụng nên không đo công sức duyệt của người; các cổng của Department vì vậy đang bị phạt (không có người gỡ chặn).
- Chi phí là ước tính theo token; native không có "báo sẵn sàng" nên không có `falseReady`.
- Một lần chạy mỗi ô; 8 task.
