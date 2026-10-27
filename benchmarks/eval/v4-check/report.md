# Kiểm tra ban đầu chính sách v4: Department và Single (12/12 lượt)

Khóa protocol: `acf1d974571b` lúc 2026-10-26T14:51:11.709Z. Model `gpt-6-luna` (medium) cho mọi vai; trần hiệu lực $10.8/lượt; tối đa 30 phút tự động mỗi lượt.
**Dữ liệu tổng hợp do AI viết** (task, reference, grader, mutant) và các quyết định duyệt do AI điều phối đưa ra theo SPEC đã khóa. Đây là kiểm tra ban đầu với 12 lượt: chưa đủ kết luận ưu thế tổng quát, và kết quả không được chọn theo việc Department thắng hay thua.

## Theo nhánh

| Nhánh | Lượt | Đạt grader | Hoàn tất đủ bằng chứng | Lỗi lọt khi báo sẵn sàng | Finding tái hiện | Regression tạo | Test Author sai | Lượt can thiệp | Phút TB | Chi phí TB | Điểm grader TB |
|---|---|---|---|---|---|---|---|---|---|---|---|
| department | 6 | 4/6 | 5/6 | 1 | 1 | 1 | 0 | 9 | 6.1 | $1.02 | 83% |
| single | 6 | 6/6 | 6/6 | 0 | 0 | 0 | 0 | 6 | 2.7 | $0.90 | 100% |

## Từng lượt

| Lượt | Nhánh | Trạng thái | Grader | Đủ bằng chứng | Báo sẵn sàng mà grader fail | Finding tái hiện | Regression | Test Author sai | Can thiệp | Phút | Chi phí |
|---|---|---|---|---|---|---|---|---|---|---|---|
| ticketflow:department:1 | department | awaiting_acceptance | 29/29 | có | không | 0 | 0 | 0 | 2 | 7.1 | $1.19 |
| ledgerhold:department:1 | department | awaiting_acceptance | 32/32 | có | không | 0 | 0 | 0 | 1 | 4.8 | $0.92 |
| ticketflow:single:1 | single | awaiting_acceptance | 29/29 | có | không | 0 | 0 | 0 | 1 | 3.2 | $0.78 |
| couponstack:single:1 | single | awaiting_acceptance | 33/33 | có | không | 0 | 0 | 0 | 1 | 3.2 | $1.47 |
| ledgerhold:single:2 | single | awaiting_acceptance | 32/32 | có | không | 0 | 0 | 0 | 1 | 2.0 | $0.49 |
| ledgerhold:department:2 | department | awaiting_acceptance | 32/32 | có | không | 0 | 0 | 0 | 2 | 5.5 | $0.86 |
| couponstack:department:2 | department | blocked | 0/33 | không | không | 0 | 0 | 0 | 1 | 3.3 | $0.55 |
| ledgerhold:single:1 | single | awaiting_acceptance | 32/32 | có | không | 0 | 0 | 0 | 1 | 2.8 | $0.76 |
| ticketflow:single:2 | single | awaiting_acceptance | 29/29 | có | không | 0 | 0 | 0 | 1 | 2.9 | $1.22 |
| couponstack:single:2 | single | awaiting_acceptance | 33/33 | có | không | 0 | 0 | 0 | 1 | 2.3 | $0.67 |
| couponstack:department:1 | department | awaiting_acceptance | 32/33 | có | **có** | 1 | 1 | 0 | 2 | 8.3 | $1.40 |
| ticketflow:department:2 | department | awaiting_acceptance | 29/29 | có | không | 0 | 0 | 0 | 1 | 7.6 | $1.16 |

## Test grader không đạt (điểm gốc giữ nguyên)

- couponstack:department:2: definitions rejects invalid definitions with INVALID_INPUT; definitions rejects invalid requests with INVALID_INPUT; definitions reports duplicate and unknown codes; pricing prices an order without codes; pricing applies one percent coupon and one fixed coupon; pricing rounds a percent discount down; pricing applies percent coupons before fixed ones whatever the order of the codes; pricing applies each percent coupon to what is left, in the order of the codes
- couponstack:department:1: redeeming treats an equal request written with other key order and the same codes as the same order

## Quyết định của người điều phối

- ticketflow:department:1 #1 contract: revise — Form-only revision against SPEC rule 5/6: R-14 (no wall clock/persistence/timers) cannot be tested through the public API, so it is marked manual as the planner prompt prescribes; the Author's question about merge priority is answered by SPEC rule 5 (base priority), so it is removed and recorded as an assumption; C-12 contained only the unanswered question instead of an expected result and is dropped (C-11 still covers merge). No expected result was added or changed.
- ticketflow:department:1 #2 contract: approve — After the form-only revision the plan states SPEC rules 1-7 without adding or dropping behavior; each step's expected result follows the cited rule.
- ledgerhold:department:1 #1 contract: approve — Plan is valid under v4 (no blocking problems); read against SPEC rules 1-10: cases cover validation, balances/holds, capture/release, transfer atomicity and idempotent keys; scenario numbers follow the cited rules. Two advisory notes about step clauses were left as written.
- ticketflow:single:1 #1 contract: approve — Contract restates SPEC rules 1-7 without adding or dropping behavior; two assumptions only record what the SPEC leaves unspecified.
- couponstack:single:1 #1 contract: approve — Contract restates SPEC rules 1-9; the two assumptions ask about behavior the SPEC does not decide (safe-integer overflow, invalid now()), which stays unspecified: approval does not add a rule for them.
- ledgerhold:single:2 #1 contract: approve — Contract restates SPEC rules 1-10 (R-1..R-16) without adding or dropping behavior; both assumptions only record what the SPEC leaves unspecified.
- ledgerhold:department:2 #1 contract: revise — Form-only revision: C-18, C-19 and C-20 are 'not applicable' statements written as non-required automated cases (preconditions/actions 'Không áp dụng', no steps, quotes that are not clauses). The same groups are already declared in notApplicable with reasons, so the cases are dropped; no test coverage or expected result is removed or added.
- ledgerhold:department:2 #2 contract: approve — After dropping the three not-applicable placeholder cases the plan has no blocking problems; remaining cases state SPEC rules 1-10 and were read in round 1.
- couponstack:department:2 #1 contract: approve — Plan is valid under v4 and states SPEC rules 1-9; the three assumptions ask about behavior the SPEC does not decide (overflow, error precedence, how often now() is read) and no rule is added for them.
- ledgerhold:single:1 #1 contract: approve — Contract restates SPEC rules 1-10 without adding or dropping behavior; assumptions only record unspecified behavior (invalid now(), overflow, argument equality).
- ticketflow:single:2 #1 contract: approve — Contract restates SPEC rules 1-7 (R-1..R-17) without adding or dropping behavior; assumptions only record unspecified behavior (empty assignee filter, now() failure).
- couponstack:single:2 #1 contract: approve — Contract restates SPEC rules 1-9 without adding or dropping behavior; assumptions only record unspecified behavior (non-JSON inputs, invalid now()).
- couponstack:department:1 #1 contract: approve — Plan is valid under v4 with no questions; it states SPEC rules 1-9 without adding or dropping behavior.
- couponstack:department:1 #2 findings: confirm — SPEC rule 1: a request needs a nonempty string customer and a nonempty lines array, and violations fail with INVALID_INPUT. A null request has no customer, so INVALID_INPUT follows; the runner reproduced a native TypeError instead, and the generated regression failed at exactly that step.
- ticketflow:department:2 #1 contract: approve — Contract restates SPEC rules 1-7 without adding behavior; assumptions only record the unspecified list-assignee error code and merge-source view. Orchestrator observation, not edited: R-2 does not restate the SPEC default priority = 'normal' for create; approved unchanged, so the contract's omission stays in the record. Plan has no blockers; step-basis notes are advisories only.

## Giới hạn

- 3 task × 2 nhánh × 2 lần: khoảng tin cậy rất rộng; không dùng để kết luận chung.
- Task, grader và quyết định duyệt đều do AI tạo ra; grader được audit theo SPEC và thử bằng lỗi cấy trước khi chạy nhưng chưa có người độc lập xác nhận.
- Single có Planner và một vai viết code/test/tự review; không có Author hay Verifier độc lập và không có finding/regression, nên các cột đó chỉ có nghĩa với Department.