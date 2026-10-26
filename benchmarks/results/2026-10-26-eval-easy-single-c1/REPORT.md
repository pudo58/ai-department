# Đối chiếu grader của 4 task dễ với code do model viết — nhánh Single, mỗi task một lần

Ngày 2026-10-26. `gpt-6-luna` medium, `scripts/eval-run.mjs <task> single --tag c1`. Mục đích: xem grader có áp đặt điều SPEC không nói không (không phải so sánh hai nhánh).

| Task | Grader ẩn | Báo cáo của hệ thống | Chi phí ước tính | Thời gian |
|---|---|---|---|---|
| slugify | **15/17** | sẵn sàng + cảnh báo → **falseReady** | $0,51 | 134 s |
| versions | 21/21 | sẵn sàng | $0,46 | 112 s |
| lru | 23/23 | sẵn sàng | $0,54 | 127 s |
| ranges | 24/24 | sẵn sàng | $0,52 | 114 s |

## Hai test fail của slugify: lỗi của code, không phải của grader

Cả hai (`maxLength removes a separator left at the end by the cut`, `maxLength uses 80 as the default maxLength`) là cùng một lỗi. SPEC điều 5: sau khi cắt còn dư dấu phân cách ở cuối thì **bỏ** dấu đó. Code của model thì **thay** dấu phân cách bằng ký tự kế tiếp (`result.slice(0, -1) + slug[maxLength]`): `slugify('hello world', { maxLength: 6 })` trả `hellow` thay vì `hello`. Test tự viết của Single không phủ ca này nên hệ thống báo "sẵn sàng".

## Kết luận

- Ba task còn lại: grader nhất quán với một lời giải độc lập do model viết (không test nào đòi điều ngoài SPEC).
- slugify: grader đúng và bắt được lỗi thật mà nhánh Single tự báo sẵn sàng (một `falseReady`).
- Một lần chạy mỗi task; chưa phải bằng chứng về hiệu quả của nhánh nào.
