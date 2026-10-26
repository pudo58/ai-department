# Thí nghiệm "Department tốt hơn Single?"

Mục tiêu: có số liệu đủ sức trả lời, không phải một vài lần chạy đơn lẻ. Khung thống kê nằm ở `src/evaluation` (đăng ký trước, ITT, bootstrap theo task, cỡ mẫu McNemar). Phần ở đây là **task thật có grader ẩn** và **bộ chạy một lần một nhánh**.

## Gói task

`benchmarks/tasks/<id>/`

| Thành phần | Vai trò |
|---|---|
| `task.json` | id, tầng (`easy`/`hard`), tín hiệu, file code chính, tên file grader, ngân sách Department, đường dẫn được bảo vệ |
| `SPEC.md` | đề bài đưa cho cả hai nhánh |
| `scaffold/` | repo khởi đầu (stub + test scaffold + cấu hình) |
| `reference/` | lời giải chuẩn; phải qua 100% grader |
| `grader/` | test ẩn, chỉ chạy sau khi run kết thúc, ngoài workspace của agent |
| `mutants/*.json` | lỗi cấy vào reference (`find` → `replace`); mỗi mutant phải làm grader fail ít nhất một test |

## Các task hiện có (8, đủ 4 dễ và 4 khó cho M0b)

| Task | Tầng | Trọng tâm | Test grader | Mutant |
|---|---|---|---|---|
| `slugify` | dễ | chuẩn hóa Unicode, dấu phân cách, cắt độ dài | 17 | 13 |
| `versions` | dễ | semver: so sánh, tiền phát hành, sắp xếp ổn định | 21 | 12 |
| `lru` | dễ | thứ tự gần đây, `onEvict`, getter chỉ đọc | 23 | 15 |
| `ranges` | dễ | khoảng đóng, kề nhau, bất biến đầu vào | 24 | 15 |
| `pulsegraph` | khó | phụ thuộc, lease, backoff, snapshot | 44 | 16 |
| `charges` | khó | idempotency, ttl, chạy đồng thời | 27 | 14 |
| `bookings` | khó | khoảng nửa mở, hết hạn/hủy đúng mốc | 23 | 16 |
| `runner` | khó | giới hạn đồng thời, FIFO theo key, hủy | 28 | 15 |

Tầng là dự đoán trước khi chạy, không phải kết quả đo. Bốn task dễ chưa được đối chiếu với lời giải do model viết; phải chấm thử một vài lời giải như vậy (và xem lại mọi test fail) trước khi khóa hash.

Quy tắc viết grader: chỉ khẳng định điều SPEC quy định. Không khẳng định giá trị bắt đầu của bộ đếm, giá trị trả về không được nêu, thời điểm retry khi lease hết hạn hoặc thứ tự lỗi khi nhiều lỗi cùng lúc. Các grader trước đây từng áp đặt những chi tiết như vậy và làm sai điểm.

Kiểm tra một task trước khi dùng:

```bash
node scripts/eval-task-check.mjs pulsegraph
```

In ra hash của toàn bộ gói task (ghi vào kết quả mỗi lần chạy, để biết điểm thuộc bản grader nào), số test reference đạt và các mutant có bị bắt không. Thoát khác 0 nếu có vấn đề.

Chấm riêng một workspace đã có (không gọi model):

```bash
node scripts/eval-grade.mjs pulsegraph .data/<thư mục>/workspaces/<run>-A
```

## Chạy một nhánh

```bash
node node_modules/tsx/dist/cli.mjs scripts/eval-run.mjs pulsegraph single --tag r1
node node_modules/tsx/dist/cli.mjs scripts/eval-run.mjs pulsegraph department --tag r1
```

Kết quả: `test-results/eval/<task>-<arm>-<tag>.json`. Hợp đồng được duyệt nguyên trạng (ghi lại), đề xuất sửa test do hệ thống tự áp dụng nếu hợp lệ, và workspace cuối luôn được chấm kể cả khi run bị dừng. Trường quan trọng:

- `graderPass`: grader ẩn đạt toàn bộ.
- `falseReady`: hệ thống báo "sẵn sàng" nhưng grader ẩn không đạt. Đây là con số chính của thí nghiệm.
- `degraded`: run đi tiếp nhờ các bước tự xử lý làm yếu bằng chứng; báo cáo luôn tách "sẵn sàng" và "sẵn sàng, không suy giảm".
- `reachedDeveloper`, `costUsd`, `automaticMs`, `retries`.

## Giới hạn cần nêu khi báo cáo

- Hợp đồng tự duyệt nguyên trạng, nên không đo công sức duyệt của người.
- Reference, grader và mutant do cùng một người viết; kiểm chứng chéo bằng cách chấm các lời giải do model viết (nếu một lời giải hợp lệ bị fail, xem lại test đó) rồi mới khóa hash.
- Một lần chạy một task chỉ là chỉ báo. Kết luận cần cỡ mẫu theo `npm run eval -- sample-size` và khoảng tin cậy từ `report-m0b`.
