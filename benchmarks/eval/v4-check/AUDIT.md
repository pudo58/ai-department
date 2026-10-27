# Audit của grader theo SPEC — kiểm tra ban đầu chính sách v4

Mục đích: mỗi assertion của grader chỉ khẳng định điều SPEC đã quy định, và grader đủ nhạy để bắt các lỗi cấy trước khi chạy model. Audit do cùng AI đã viết SPEC, reference, grader và mutant thực hiện (dữ liệu **tổng hợp**, chưa có người độc lập xác nhận); vì vậy kết quả chấm của từng lượt được kiểm tra thêm, và mọi thẩm định lỗi grader sau khi chạy được ghi riêng (`adjudications.json`, mục trong `report.md`), không đổi điểm gốc.

## Cách audit

1. Đọc từng `it(...)` và từng `expect(...)` đối chiếu với điều khoản đánh số trong SPEC. Điều nào không có điều khoản đỡ thì sửa **SPEC** (khi hành vi hiển nhiên cần quy định) hoặc **bỏ assertion**.
2. Không kiểm tra đầu vào vi phạm nhiều quy tắc không liên quan cùng lúc (SPEC cũng nói vậy), nên không phụ thuộc thứ tự lỗi ngoài những chỗ SPEC nêu.
3. `node scripts/eval-v4.mjs check`: reference đạt 100% grader và mọi mutant bị bắt (`scripts/eval-task-check.mjs`).
4. Mỗi pack được hash (SPEC, scaffold, reference, grader, mutant) và hash đó được khóa trong `protocol.json` trước lần gọi model đầu tiên.

## Sửa đổi do audit

| Pack | Phát hiện | Xử lý |
|---|---|---|
| ledgerhold | SPEC chưa nói trạng thái của hold đã capture/release khi quá hạn TTL (`captured` hay `expired`) | Thêm vào điều 9: hold đã capture/release giữ trạng thái đó; chỉ hold còn mở mới thành `expired` |
| ticketflow | SPEC chưa nói giá trị trả về của `create/assign/wait/…/merge` mà grader dùng | Thêm vào điều 6: các lệnh đổi ticket trả view của ticket sau khi đổi, `merge` trả view của target |
| ticketflow | Mutant "gán tại đúng mốc escalation vẫn tránh được escalate" không đổi hành vi quan sát được (đánh giá thời gian chạy trước mọi thao tác) | Bỏ mutant tương đương, không giữ để làm đẹp con số |
| couponstack | Một dòng thừa trong test "áp dụng từng percent coupon…" | Bỏ dòng |

## ledgerhold — `src/ledger.js` (32 test, 17 mutant)

| Test | Điều khoản SPEC |
|---|---|
| rejects an invalid holdTtl… | 1 |
| opens an account with zero funds… | 2 |
| rejects bad names, keys and amounts… | 1 (mã lỗi), 10 (khóa không bị dùng hết bởi lệnh lỗi) |
| does not change anything when a deposit is refused | 1, 4 |
| adds deposits to total and available… | 3, 4 |
| reserves available funds… | 3, 5 |
| allows a hold of exactly the available funds… | 5 |
| numbers holds in creation order… | 5 (bộ đếm chỉ tăng khi hold được tạo) |
| lets a hold stop counting exactly at createdAt + holdTtl | 3 |
| frees the funds of an expired hold… | 3, 5 |
| only counts the active holds of the account itself | 3 |
| spends from the hold, closes it… | 6, 9 |
| allows capturing exactly the hold amount… | 6 |
| refuses to capture or release a hold that already expired | 6, 7 |
| refuses a second capture or a release of a closed hold | 6, 7 |
| releases without spending… | 7, 9 |
| keeps a captured hold captured after its time is up | 6, 9 (làm rõ sau audit) |
| reports an expired hold as expired… | 9 |
| moves available funds… / cannot move held funds… / can move funds again… / allows a transfer of exactly… | 3, 8 |
| refuses the same account and unknown accounts… | 1, 8 |
| applies a call once and replays… / replays the remembered result… / does not create a second hold… / replays a capture, a release and a transfer… | 10, 5 |
| rejects a key reused with other arguments or another method… | 10 |
| does not use up the key of a call that failed | 10 |
| returns copies… | 10 (bản sao sâu) |
| keeps the books balanced… / treats two accounts independently… | 3, 5–8 |

## ticketflow — `src/tickets.js` (29 test, 17 mutant)

| Test | Điều khoản SPEC |
|---|---|
| rejects invalid options… | tổng quát (tùy chọn), 1 |
| creates an open, unassigned ticket… / rejects bad input, taken ids… | 1, 2, 6 |
| follows open → assigned → pending… / lets assign replace the assignee… | 2, 6 |
| refuses every other transition with BAD_STATE… / does not allow anything on a closed ticket | 2 (chỉ các chuyển trạng thái đã liệt kê tồn tại), 1 (lỗi không đổi gì) |
| reopens a resolved ticket… / allows maxReopens reopenings… / refuses every reopening when maxReopens is 0 | 2 |
| keeps a resolved ticket resolved until resolvedAt + reopenWindow… / can still reopen at the last minute… / starts a new window each time… | 3 |
| closes by hand before the window is over | 2, 3 |
| escalates an unassigned ticket exactly when… / never escalates a ticket assigned before… / counts an assignment at the threshold as too late… / escalates a ticket that was never read… / caps the effective priority… | 4 |
| folds the source into the target… / gives the target the higher of the two priorities… | 5, 6 |
| carries an escalation over to the target and does not invent one | 4, 5 |
| refuses to merge a ticket into itself… / changes nothing when a merge fails / can merge a pending ticket… | 1, 2, 5 |
| sorts by effective priority, then by creation order / ranks an escalated ticket… | 4, 7 |
| filters by status and assignee together… / shows merged tickets… | 5, 6, 7 |

## couponstack — `src/coupons.js` (33 test, 20 mutant)

| Test | Điều khoản SPEC |
|---|---|
| rejects invalid definitions… | định nghĩa coupon |
| rejects invalid requests… / reports duplicate and unknown codes | 1, 9 |
| prices an order without codes / applies one percent coupon and one fixed coupon | 2, 4, 5 |
| rounds a percent discount down / applies percent coupons before fixed ones… / applies each percent coupon to what is left… / applies fixed coupons in the order… | 4, 5 |
| limits a coupon by its cap / never takes more than what is left… / takes a percent coupon of what the earlier coupons left, then caps it | 4 |
| leaves the engine untouched by a quote | 5 |
| honours validFrom and validTo… / measures minSubtotal on the subtotal before any discount… / limits total uses… / limits uses per customer… | 2 |
| reports the first ineligible coupon… / checks the rules of one coupon in the specified order | 2 |
| lets a non-stackable coupon stand alone… / lets any number of stackable coupons be combined | 3, 4 |
| prices like quote, counts one use… / counts nothing and remembers nothing when one coupon is not eligible | 6 |
| returns the first result for an equal request… / replays the first result even when… / treats an equal request written with other key order… / refuses the same order id with a different request… / returns copies… | 7 |
| gives every counted use back… / gives nothing back a second time / frees a place under maxUses and perCustomer / refuses unknown orders… / does not remember an order that failed… | 6, 8, 9 |

## Giới hạn

- Audit không thay thế một người độc lập đọc SPEC và grader. Điểm 100% hay thấp của model vẫn có thể phản ánh một chỗ SPEC mơ hồ mà người viết không thấy.
- Mutant do cùng người viết, nên chỉ cho biết grader bắt được loại lỗi đó, không cho biết grader bắt được mọi lỗi.
