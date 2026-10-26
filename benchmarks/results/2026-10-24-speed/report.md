# Đối chứng tăng tốc AI Department — ReplayGate

**Chưa chứng minh được tăng tốc hoặc chất lượng code tốt hơn.** Sáu run đã được ghi nhận đầy đủ nhưng chưa run nào tạo candidate mới.

Cùng GPT-6 Luna medium cho mọi vai, cùng SPEC/scaffold/grader và trần ngân sách hiệu lực $10,80/run. Mỗi nhóm ba run, chạy tuần tự trên snapshot và data directory riêng. Không retry run lỗi, không sửa source/test/schema thay model.

| Chỉ số | Baseline | Snapshot tối ưu |
|---|---:|---:|
| Tới chờ nghiệm thu | 0/3 | 0/3 |
| Candidate để chấm | 0/3 | 0/3 |
| Tổng lượt model (gồm thất bại) | 6 | 5 |
| Lượt model hoàn tất | 6 | 4 |
| Input token quan sát (gồm cache) | 230000 | 112444 |
| Output token quan sát | 29652 | 20695 |
| Trung vị thời gian đến hoàn tất | Chưa đo được | Chưa đo được |

Baseline: ba kế hoạch Author sai schema. Snapshot tối ưu: một kế hoạch sai priority enum; một kế hoạch parse được nhưng sai liên kết/trích dẫn oracle, thiếu ca và còn câu hỏi; một run dừng do quota trước khi Planner trả kết quả. Các cổng kiểm tra đã giữ lại output không hợp lệ. Các số thời gian tới khi dừng bên dưới không được dùng làm tỷ lệ tăng tốc.

## baseline

- Run 1: `run_8583f26b`; **blocked / invalid_plan**; 96.1 giây thời gian tự động quan sát; 2 lượt model; điểm code: không có candidate.
  Lý do: Không đọc được kế hoạch ca: Phản hồi sai định dạng: cases.0.steps: Too small: expected array to have >=2 items; cases.0.invariants: Too small: expected array to have >=1 items; cases.4.steps: Too small: expected array to have >=2 items; cases.4.invariants: Too small: expected array to have >=1 items; cases.5.steps: Too small: expected array to have >=2 items; cases.5.invariants: Too small: expected array to have >=1 items; cases.8.steps: Too small: expected array to have >=2 items; cases.8.invariants: Too small: expected array to have >=1 items; cases.9.steps: Too small: expected array to have >=2 items; cases.9.invariants: Too small: expected array to have >=1 items; cases.11.steps: Too small: expected array to have >=2 items; cases.11.invariants: Too small: expected array to have >=1 items; cases.18.steps: Too small: expected array to have >=2 items; cases.18.invariants: Too small: expected array to have >=1 items. Sửa Hợp đồng trước khi duyệt.
  Vấn đề hợp đồng: Chính sách v2 cần kế hoạch ca có căn cứ v2.; Verify cần kế hoạch ca kiểm thử trước khi duyệt.
  Can thiệp ghi nhận: 0. Mutation/Verifier: chưa tới bước này.
- Run 2: `run_ec19eae8`; **blocked / invalid_plan**; 100.1 giây thời gian tự động quan sát; 2 lượt model; điểm code: không có candidate.
  Lý do: Không đọc được kế hoạch ca: Phản hồi sai định dạng: cases.0.steps: Too small: expected array to have >=2 items; cases.0.invariants: Too small: expected array to have >=1 items; cases.1.steps: Too small: expected array to have >=2 items; cases.1.invariants: Too small: expected array to have >=1 items; cases.2.steps: Too small: expected array to have >=2 items; cases.2.invariants: Too small: expected array to have >=1 items; cases.10.steps: Too small: expected array to have >=2 items; cases.10.invariants: Too small: expected array to have >=1 items; cases.11.steps: Too small: expected array to have >=2 items; cases.11.invariants: Too small: expected array to have >=1 items; cases.18.steps: Too small: expected array to have >=2 items; cases.18.invariants: Too small: expected array to have >=1 items; cases.21.steps: Too small: expected array to have >=2 items; cases.21.invariants: Too small: expected array to have >=1 items; notApplicable.0.group: Invalid option: expected one of "happy"|"boundary"|"authorization"|"concurrency"|"dependency"|"state"|"consistency". Sửa Hợp đồng trước khi duyệt.
  Vấn đề hợp đồng: Chính sách v2 cần kế hoạch ca có căn cứ v2.; Verify cần kế hoạch ca kiểm thử trước khi duyệt.
  Can thiệp ghi nhận: 0. Mutation/Verifier: chưa tới bước này.
- Run 3: `run_329c94c3`; **blocked / invalid_plan**; 80.9 giây thời gian tự động quan sát; 2 lượt model; điểm code: không có candidate.
  Lý do: Không đọc được kế hoạch ca: Phản hồi sai định dạng: cases.0.steps: Too small: expected array to have >=2 items; cases.4.steps: Too small: expected array to have >=2 items; cases.6.steps: Too small: expected array to have >=2 items; cases.10.steps: Too small: expected array to have >=2 items; cases.11.steps: Too small: expected array to have >=2 items; cases.12.steps: Too small: expected array to have >=2 items. Sửa Hợp đồng trước khi duyệt.
  Vấn đề hợp đồng: Chính sách v2 cần kế hoạch ca có căn cứ v2.; Verify cần kế hoạch ca kiểm thử trước khi duyệt.
  Can thiệp ghi nhận: 0. Mutation/Verifier: chưa tới bước này.

## optimized

- Run 1: `run_9f925577`; **blocked / invalid_plan**; 82.0 giây thời gian tự động quan sát; 2 lượt model; điểm code: không có candidate.
  Lý do: Không đọc được kế hoạch ca: Phản hồi sai định dạng: cases.7.priority: Invalid option: expected one of "high"|"normal"|"low". Sửa Hợp đồng trước khi duyệt.
  Vấn đề hợp đồng: Chính sách v2 cần kế hoạch ca có căn cứ v2.; Verify cần kế hoạch ca kiểm thử trước khi duyệt.
  Can thiệp ghi nhận: 0. Mutation/Verifier: chưa tới bước này.
- Run 2: `run_9fbc7e31`; **awaiting_approval / contract_needs_correction**; 94.1 giây thời gian tự động quan sát; 2 lượt model; điểm code: không có candidate.
  Vấn đề hợp đồng: C-1: Căn cứ R-2 không thuộc ca.; C-1: Căn cứ R-6 không thuộc ca.; C-6: Trích dẫn R-4 không có trong điều khoản hiện tại.; C-7: Căn cứ R-6 không thuộc ca.; C-11: Căn cứ R-13 không thuộc ca.; C-13: Căn cứ R-7 không thuộc ca.; C-17: Trích dẫn R-11 không có trong điều khoản hiện tại.; C-19: Trích dẫn R-13 không có trong điều khoản hiện tại.; R-16: thiếu ca tự động bắt buộc.; Kế hoạch còn câu hỏi chưa giải quyết; hãy trả lời vào hợp đồng hoặc ghi giả định đã xác nhận rồi xóa câu hỏi.
  Can thiệp ghi nhận: 0. Mutation/Verifier: chưa tới bước này.
- Run 3: `run_81eb8314`; **blocked / provider_blocked**; 5.1 giây thời gian tự động quan sát; 1 lượt model; điểm code: không có candidate.
  Lý do: Có thể đã chạm quota: You’ve hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), visit https://chatgpt.com/settings/usage to purchase more credits or try again at Oct 25th, 2026 3:01 AM.. Chờ rồi resume; không tự đổi provider.
  Vấn đề hợp đồng: Chính sách v2 cần kế hoạch ca có căn cứ v2.; Verify cần kế hoạch ca kiểm thử trước khi duyệt.
  Can thiệp ghi nhận: 0. Mutation/Verifier: chưa tới bước này.

## Bản bàn giao sau kiểm tra

Bản tối ưu được đo là snapshot khóa trước ba run. Bản code bàn giao có thêm sửa lỗi phát hiện bằng regression sau đó; chưa gọi model thật để đo lại các sửa này.

- Real Git/Vitest regression exposed initial draft recovery at null run.checkpoint; patch now binds to its saved base checkpoint.
- Preflight resolves installed tools without npx downloads, preserves config arguments and invalidates a prior receipt after environment failure.
- One repair routing helper rejects stale manifest/check evidence before Developer, including resumed runs.
- A standalone environment action preserves a pending contract approval gate; failed provider attempts retain prompt receipts.
- Priority enum and exact oracle references are explicit in the final prompt; no frozen run was retried to measure this update.

Build local đạt. Reliability: **28 file / 393 test; 0 fail, 0 bỏ qua**.
Vòng regression trước có 1/393 lỗi: fixture mutation monorepo hết deadline 27 giây khi chạy chung. Chạy riêng cùng assertion/deadline đã đạt. Nhóm reliability giảm worker ngoài từ 4 xuống 2 để hạn chế tranh tài nguyên với worker của Stryker; giữ nguyên toàn bộ ca và timeout. Kết quả lỗi ban đầu được giữ ở ../execution-speed/reliability-timeout-before-reproduction.json.
Regression gồm Git/Vitest thật cho draft đầu tiên, discovery baseline đỏ không chạy assertion, lỗi môi trường/config, stale hash/manifest, restart/resume, khóa test, delivery, báo cáo và API/UI. Fixture dùng agent giả, không dùng quota model thật.
UI trình duyệt đã xác nhận kiểm tra lại môi trường không gọi agent; phục hồi draft giữ số lượt Author; tiếp tục tới chờ nghiệm thu và hiển thị giới hạn Verifier. Screenshot và HTML ở `../execution-speed/`.
Hướng dẫn cấu hình/thao tác: `../../docs/execution-speed.md`. GitHub CI Windows/Linux chưa chạy trong lượt local này.

## Giới hạn

- Three attempts per arm on one task do not establish average reliability or production defect rates.
- The optimized quota failure is included as provider_blocked; it is not evidence of faster execution or a code defect.
- The awaiting_approval run has unresolved contract/oracle problems; its short runtime is not a successful completion.
- Historical 43/43 ReplayGate candidates do not stand in for candidates missing from this six-run comparison.
- No failed run was retried and no candidate source/test/schema was repaired by the benchmark controller.
- Runs were sequential in baseline-then-optimized order; provider variability and cache effects were not randomized.
- Token totals are observed CLI traffic, not billed cost; one failed attempt returned no usage.
- Final handoff code contains post-benchmark hardening verified with fixtures, not new live comparisons.

Hồ sơ: `protocol.json`, `<arm>-runs.json`, `<arm>-<n>-detail.json`, `optimized-source-receipt.json`, `final-source-receipt.json` và `comparison.json`. Grader gốc được giữ nguyên hash; không có file grade mới vì không có candidate.
