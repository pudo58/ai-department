# Department sau khi sửa các nguyên nhân bị chặn của pilot-1

Cùng 8 task, cùng manifest đã đăng ký (assignment và hash gói task không đổi). Chỉ nhánh `harness-team` (Department) được chạy lại bằng code đã sửa; hai nhánh còn lại giữ nguyên kết quả đã đăng ký trong `../2026-10-26-eval-pilot-1`. Kết quả chạy lại để trong các thư mục `dept-*`, không ghi đè kết quả đã đăng ký.

## Code đã đổi (theo thứ tự)

1. Chẩn đoán "test sai" được chuẩn hoá từ diff và report của runner thay vì bị loại vì trường dư thừa; trích dẫn không khớp điều khoản được gắn lại vào điều khoản (mọi loại quyết định); sửa của chẩn đoán "code sai"/"chưa chắc" không còn là lý do loại.
2. Tối đa 3 bản sửa test hợp lệ được tự áp dụng mỗi run (trước là 1); sau khi sửa mà check vẫn fail thì vòng sửa thông thường tiếp tục (tối đa 2 lần); liên kết assertion bị lệch thì gắn lại theo tên test (manifest `derived`, chỉ cảnh báo); lượt sửa manifest được thêm nguyên một test mới; Author quên sửa file được nhắc một lần.
3. Finding của Verifier không có phản ví dụ chạy được: Developer sửa một vòng rồi thành cảnh báo, không chặn nữa.
4. Bộ chạy: không từ chối bản sửa test mà hệ thống đã tự duyệt; lần dừng do nhà cung cấp model quá tải (capacity) tính là hạ tầng và chạy lại.

## Kết quả cuối (`dept-final`, cả 16 ô, grader PulseGraph đã điều chỉnh như báo cáo trước)

| Nhánh | Được nghiệm thu | Đạt grader | `falseReady` | Chạy suy giảm | Chi phí TB | Thời gian TB |
|---|---|---|---|---|---|---|
| native-full (đã đăng ký) | 0,88 | 14/16 | n/a | n/a | $0,19 | 69 s |
| harness-single (đã đăng ký) | 0,88 | 15/16 | 1 | 0 | $0,76 | 196 s |
| harness-team **lúc đăng ký** | 0,62 | 15/16 | 0 | 6 | $1,01 | 289 s |
| harness-team **sau khi sửa** | **0,75** | 14/16 | 0 | 7 | $1,14 | 296 s |

Chênh lệch tỉ lệ nghiệm thu của Department so với Single: −12,5 điểm (95% CI −25 → 0); so với native: −12,5 (CI −38 → +19). Mẫu còn rất nhỏ.

Điểm "đạt grader" của hai dòng harness-team ở trên là điểm với grader PulseGraph đã điều chỉnh (15/16 lúc đăng ký, 14/16 sau khi sửa; chưa điều chỉnh là 13/16 cho cả hai).

Các ô Department chưa được nghiệm thu sau khi sửa (4/16), theo lý do dừng ghi trong dữ liệu:
- `bookings` lần 2: dừng vì check `test` thất bại ở test `[R-3][R-5][C-3]` do Author viết; mã đạt 23/23. Đây là nguyên nhân "test Author sai" còn lại.
- `pulsegraph` lần 1: dừng vì "Developer không thay đổi file nào"; mã đạt 44/44 với grader đã điều chỉnh. Tôi chưa chứng minh được nguyên nhân gốc (test sai hay Developer bỏ lượt), nên không gán nhãn.
- `pulsegraph` lần 2 (38/44) và `runner` lần 2 (27/28): mã sai thật và bị chặn bởi finding của Verifier, tức là chặn đúng.

## Điều phải nêu

- **Thiên lệch chọn lọc ở các lần chạy giữa chừng.** Các thư mục `dept-v2` … `dept-v5` chỉ gồm vài ô đã bị chặn, được chạy lại sau mỗi lần sửa; chúng cho thấy từng lỗi hệ thống được sửa nhưng không dùng để tính tỉ lệ. Chỉ `dept-final` (cả 16 ô, code cuối) được dùng cho số liệu ở trên.
- **Code đổi dựa trên chính các ô này.** Các sửa đổi được thiết kế sau khi đọc nguyên nhân từng ô bị chặn của pilot-1; con số 0,75 vì vậy là một ước lượng lạc quan, chưa được kiểm trên task chưa từng thấy.
- **Đánh đổi của việc không chặn:** finding không có phản ví dụ chạy được nay chỉ là cảnh báo, và `falseReady` vẫn bằng 0 trong lần chạy cuối, nhưng ở `dept-v2` ô `runner` lần 2 từng lọt thành "sẵn sàng" dù mã sai (27/28). Ở `dept-final` ô này lại bị chặn (đường khác), nên không thể nói chắc chắn rủi ro đã biến mất.
- **Một ô bị nhà cung cấp model từ chối** (`charges` lần 2, "model quá tải") và được chạy lại; lần đầu bị loại khỏi kết quả như một lỗi hạ tầng (đã nêu trong `infrastructureErrors`).
- Các hạn chế của pilot-1 vẫn đúng: gói task nguồn gốc `synthetic`, một lần chạy mỗi ô, hợp đồng tự duyệt.

## Kết luận ngắn

Sửa đổi nâng tỉ lệ nghiệm thu của Department từ 0,62 lên 0,75 và loại được các điểm chết cụ thể, nhưng vẫn thấp hơn Single và native (0,88), tốn gấp khoảng 1,5 lần Single và 6 lần native, và chậm hơn. Không có bằng chứng Department tốt hơn một AI agent về chất lượng.
