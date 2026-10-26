# Pilot trước thí nghiệm Department vs Single — 4 task, mỗi nhánh một lần

Ngày 2026-10-26. Model `gpt-6-luna` medium cho mọi vai, cùng SPEC, scaffold, ngân sách hiệu lực $10,80, chạy tuần tự bằng `scripts/eval-run.mjs`. Hợp đồng được tự duyệt nguyên trạng; đề xuất sửa test hợp lệ được hệ thống tự áp dụng một lần. Chấm bằng grader ẩn trong `benchmarks/tasks/<id>/grader`, đã qua `eval-task-check` (reference đạt hết, mọi mutant bị bắt).

| Task | Nhánh | Grader ẩn | Trạng thái | Báo cáo | Chạy suy giảm | Chi phí ước tính | Thời gian |
|---|---|---|---|---|---|---|---|
| pulsegraph | Single | 44/44 | chờ nghiệm thu | sẵn sàng + cảnh báo | không | $0,92 | 199 s |
| pulsegraph | Department | 44/44 | chờ nghiệm thu | sẵn sàng + cảnh báo | không | $0,72 | 214 s |
| charges | Single | 27/27 | **failed** (test do chính nó viết fail) | không sẵn sàng | không | $1,41 | 236 s |
| charges | Department | 27/27 | chờ nghiệm thu | sẵn sàng + cảnh báo | có (sửa test Author) | $1,07 | 287 s |
| bookings | Single | 23/23 | chờ nghiệm thu | sẵn sàng + cảnh báo | không | $1,08 | 159 s |
| bookings | Department | 23/23 | chờ nghiệm thu | sẵn sàng + cảnh báo | không | $0,81 | 243 s |
| runner | Single | 28/28 | chờ nghiệm thu | sẵn sàng | không | $0,58 | 181 s |
| runner | Department | **27/28** | **blocked** (Verifier: 1 finding major) | không sẵn sàng | có (sửa test Author) | $0,98 | 617 s |

## Đọc kết quả

- **Về mã:** Single đúng cả 4/4 task, Department 3/4. Ở `runner`, bản code của Department thật sự sai: khi task đầu của một key vừa xong, nó chọn task của key khác trẻ hơn thay vì task kế của chính key đó (cái spec điều 5 đòi). Bản của Single và reference thì đúng.
- **Về việc hệ thống có biết mình đúng hay sai:** không lần nào báo "sẵn sàng" mà grader không đạt (`falseReady` = 0 ở cả hai nhánh). Department báo không sẵn sàng đúng lúc code sai (Verifier độc lập đưa phản ví dụ chính xác, đã kiểm lại bằng chạy thật). Single có một lần báo `failed` dù code đúng (`charges`: test tự viết fail).
- **Chi phí:** Department rẻ hơn ở 3/4 task (ước tính của ứng dụng), đắt hơn ở `runner`. Thời gian tự động Department dài hơn ở cả 4.

## Điều phải nêu

- Mỗi task chỉ một lần mỗi nhánh. Đây là chỉ báo, chưa phải bằng chứng; không kết luận nhánh nào tốt hơn.
- **Grader `runner` được bổ sung sau khi thấy kết quả:** bản đầu bỏ sót đúng ca mà Verifier của Department chỉ ra (27/27 cho cả hai). Sau khi thêm một test cho ca đó, reference vẫn 28/28 và mutant mới "key vừa xong vẫn bị giữ" bị bắt; hai bản code được chấm lại (Single 28/28, Department 27/28). Các file `runner-*` giữ cả điểm lúc chạy (`graderAtRunTime`) và điểm sau khi chấm lại. Đây là hiệu chỉnh grader có chủ đích nhưng sau sự việc, nên số `runner` phải được đọc với lưu ý này.
- Reference, grader và mutant do cùng một người viết, chưa có người ngoài soát.
- Hợp đồng tự duyệt nguyên trạng nên không đo công sức duyệt của người.
- Task `pulsegraph`, `bookings` không phân biệt được hai nhánh (cả hai đạt hết).
