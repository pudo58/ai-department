# EscrowBatch — AI Department và Single

**Kết luận:** Single đi được tới chờ nghiệm thu; Department chưa qua bước duyệt kế hoạch. Tuy nhiên code Single có lỗi nghiêm trọng trong batch và chưa đạt SPEC, dù toàn bộ 15 test nội bộ đều xanh. Chưa thể so chất lượng hai bản code vì Department chưa tạo candidate.

Ngày 2026-10-25T02:58:38.155Z. Cả hai dùng **gpt-6-luna, medium**, cùng scaffold, SPEC, công cụ và trần hiệu lực **$10.8**. Một lượt mỗi bên, tuần tự. Không retry hoặc sửa hộ output.

Bài toán: sổ cái giữ chỗ/chuyển tiền với atomic batch, rollback, CAS revision, expiry, idempotency ưu tiên trước CAS và snapshot tách biệt. Bộ chấm ngoài workspace: **53 ca cụ thể + 12 chuỗi 100 bước**; 65 mục chấm độc lập. Bộ chấm được khóa hash trước lượt model đầu tiên.

| Tiêu chí | AI Department / Verify | Single |
|---|---|---|
| Trạng thái cuối | awaiting_approval | awaiting_acceptance |
| Candidate code | Chưa có | Có |
| Điểm hành vi | Không chấm: chưa có code | 64/65 (98.5%) |
| Thời gian tự động | 86.8s | 119.2s |
| Thời gian chờ tại mốc kết thúc | 0.2s | 13.3s |
| Lượt model | 2 ({"planner":1,"author":1}) | 2 ({"planner":1,"developer":1}) |
| Input token quan sát, gồm cache | 37521 | 375883 |
| Cached token (nằm trong input) | 23552 | 347520 |
| Output token | 10725 | 9928 |
| Chi phí quy đổi ước tính của ứng dụng | $0.210 | $0.338 |
| Checks nội bộ | Chưa chạy | 15 đạt / 0 lỗi |
| Can thiệp người soát benchmark | 0 | 1 |
| Ca kế hoạch Author | 24 | Không có Author độc lập |

## Quy trình và điểm nghẽn

### department
Run: `run_8cb7d7c4`. Các model thực ghi nhận: gpt-6-luna.
Không có blocker runtime được ghi nhận.
- C-7: Trích dẫn R-6 không có trong điều khoản hiện tại.
- C-10: Căn cứ R-2 không thuộc ca.
- C-18: Căn cứ R-6 không thuộc ca.
- C-20: ca Nhất quán dữ liệu bắt buộc phải mô tả chuỗi ít nhất hai bước.
- C-20: ca Nhất quán dữ liệu bắt buộc phải nêu bất biến cần giữ sau từng bước.
- C-21: Trích dẫn R-12 không có trong điều khoản hiện tại.
- Chưa xét nhóm Lặp và đồng thời hoặc nêu lý do không áp dụng.
Can thiệp: []
Mutation: chưa có kết quả ở mốc kết thúc.

### single
Run: `run_c814fa27`. Các model thực ghi nhận: gpt-6-luna.
Không có blocker runtime được ghi nhận.
Can thiệp: [{"type":"contract_review","approve":true,"contractHash":"104db969f7a8ca215d2d92d9619bd379a160687bab02fced2973b455c647a3dc","acknowledgedWarnings":["assumptions_present"],"reason":"Reviewed against frozen SPEC: atomicity, availability, terminal hold history, expiry boundary, replay precedence, snapshot and aliasing preserved. Assumptions restate SPEC. Export API and forbidden-scope requirements marked manual; frozen external grader still independently tests exports. No contract edits or business clarification supplied.","at":"2026-10-25T02:54:37.340Z"}]
Mutation: chưa có kết quả ở mốc kết thúc.

Department sinh được kế hoạch có nhiều ca rollback, expiry, idempotency và snapshot, nhưng kế hoạch không qua kiểm tra căn cứ/cấu trúc nên chưa tới Developer. Không được dùng thời gian dừng sớm này để kết luận Department nhanh hơn.

## Hành vi theo nhóm

| Nhóm | Department | Single |
|---|---|---|
| public-api | Chưa có code | 2/2 |
| time | Chưa có code | 6/6 |
| money | Chưa có code | 3/3 |
| holds | Chưa có code | 5/5 |
| boundary | Chưa có code | 1/1 |
| history | Chưa có code | 6/6 |
| errors | Chưa có code | 1/1 |
| atomicity | Chưa có code | 4/5 |
| validation | Chưa có code | 10/10 |
| revision | Chưa có code | 2/2 |
| idempotency | Chưa có code | 5/5 |
| aliasing | Chưa có code | 4/4 |
| snapshot | Chưa có code | 3/3 |
| stateful | Chưa có code | 12/12 |

### Ca lỗi single
- D21-ordered-provisional-effects: Error: INSUFFICIENT_FUNDS
    at fail (file:///C:/Users/ADMIN/OneDrive/Desktop/ai-department/.data/escrowbatch-20261025/workspaces/run_c814fa27-A/src/ledger.js:2:40)
    at Object.apply (file:///C:/Users/ADMIN/OneDrive/Desktop/ai-department/.data/escrowbatch-20261025/workspaces/run_c814fa27-A/src/ledger.js:59:53)
    at apply (file:///C:/Users/ADMIN/OneDrive/Desktop/ai-department/test-results/2026-10-25-escrowbatch/grade.mjs:16:45)
    at file:///C:/Users/ADMIN/OneDrive/Desktop/ai-department/test-results/2026-10-25-escrowbatch/grade.mjs:41:96
    at async test (file:///C:/Users/ADMIN/OneDrive/Desktop/ai-department/test-results/2026-10-25-escrowbatch/grade.mjs:20:67)
    at async file:///C:/Users/ADMIN/OneDrive/Desktop/ai-department/test-results/2026-10-25-escrowbatch/grade.mjs:41:1

## Review code

Code Single gọn, tên nghiệp vụ rõ và nhiều cơ chế đúng, nhưng sai nguồn dữ liệu khi tính available trong transaction. Đây là lỗi correctness mức cao, không phải vấn đề phong cách. Department chưa có code nên không chấm điểm code cho nhánh đó.

- Điểm tốt: Dùng Map/Set, xử lý được account và ID đặc biệt như __proto__; không thêm dependency.
- Điểm tốt: Tách state tạm trước commit giúp các lỗi thông thường rollback; lịch sử terminal hold và replay được giữ qua snapshot.
- Điểm tốt: Canonical hóa object key order và trả kết quả mới cho replay; các ca expiry, snapshot, aliasing và idempotency trong bộ chấm đã đạt.
- Điểm tốt: Có 14 test do agent viết cộng 1 smoke test scaffold; phủ cả lỗi đầu vào và trạng thái, không chỉ ca thuận.
- **HIGH — Batch tính available từ số dư đã commit:** getAvailable truyền nextHolds nhưng available vẫn đọc accounts thay vì nextAccounts. Hậu quả: không dùng được tiền vừa nhận và có thể chi hai lần trong cùng batch. D21 trượt; probe P02 tạo số dư a=-60 từ a=100. (candidate-single/src/ledger.js:24-27,48-51,67-69; single-grade.json D21; single-failure-diagnosis.json P01/P02)
- **MEDIUM — Bộ test tự viết thiếu chuỗi thao tác hợp lệ trong cùng batch:** Ca rollback có transfer rồi reserve không đủ tiền, nhưng không có ca nhận tiền rồi reserve/transfer tiếp và hai debit liên tiếp cùng nguồn. Một test cho mỗi R-x chưa kiểm tra được các tương tác giữa thao tác. (candidate-single/tests/ledger.test.js:30; single-detail.json checks=15 passed; D21/P02 fail)
- **LOW — Một số assertion không khớp đầy đủ tên test:** R-2 sửa accounts[0] nhưng lại xác nhận account a, trong khi phần tử đầu là __proto__; R-7 nêu rollback ID nhưng chỉ kiểm tra tái sử dụng ID sau release; R-10 nêu closed nhưng chỉ kiểm tra missing/expired. Tên test và tag không đủ làm bằng chứng cho mọi nhánh. (candidate-single/tests/ledger.test.js:12-20,56-62,77-83)
- **INFO — Hiệu năng và mức độ đầy đủ chưa được chứng minh:** Mỗi lần kiểm tra available quét holds, mỗi apply copy toàn bộ accounts/holds/history liên quan. Không benchmark tải lớn, không coverage/mutation cho candidate này. Không suy luận khả năng production từ 65 mục chấm. (candidate-single/src/ledger.js:24-27,48-50; protocol.json)

Quyết định review: **Không nghiệm thu code Single theo SPEC hiện tại. Department: quy trình chưa qua duyệt kế hoạch, chưa có candidate để quyết định code.**.

## Môi trường và lượt chạy trong agent

Host preflight và check cuối đạt. Trong sandbox agent, npm test và Vitest mặc định lỗi tải config/esbuild; agent dùng --configLoader native để chạy test, tự sửa một assertion sai account do thứ tự sort rồi chạy đạt. Không thay config hoặc recipe; mọi lệnh được lưu ở single-command-evidence.json.

Single không có Author/Verifier độc lập và không tự chạy mutation trong chế độ hiện tại. Verify dừng trước Developer nên chưa tới checks/mutation/Verifier. Không có kết quả mutation để so ở lần này.

## Chẩn đoán bổ sung sau chấm

Các probe sau chỉ dùng xác nhận nguyên nhân; **không cộng vào hay thay đổi điểm 64/65 đã khóa**.

- P01-provisional-credit: expected {"result":{"revision":1},"state":{"now":0,"revision":1,"accounts":[{"id":"a","balance":50,"available":50},{"id":"b","balance":50,"available":50}],"holds":[]}}; actual {"error":"INSUFFICIENT_FUNDS","state":{"now":0,"revision":0,"accounts":[{"id":"a","balance":100,"available":100},{"id":"b","balance":0,"available":0}],"holds":[]}}.
- P02-double-spend-in-one-batch: expected {"error":"INSUFFICIENT_FUNDS","state":{"now":0,"revision":0,"accounts":[{"id":"a","balance":100,"available":100},{"id":"b","balance":0,"available":0}],"holds":[]}}; actual {"result":{"revision":1},"state":{"now":0,"revision":1,"accounts":[{"id":"a","balance":-60,"available":-60},{"id":"b","balance":160,"available":160}],"holds":[]}}.

Tình huống chi vượt: a có 100; batch chuyển 80 rồi chuyển thêm 80 đáng ra phải rollback. Code Single lại commit a=-60, b=160. Nguồn lỗi: available() đọc Map accounts đã commit, còn batch cập nhật nextAccounts.

12 trace cố định không bắt lỗi này vì các batch hợp lệ trong generator chủ yếu có một op; ca D21 và probe nhiều op bổ sung mới chạm tới. Vì vậy 1.200 bước không thay thế thiết kế chuỗi thay đổi trạng thái trong cùng transaction.

## Kiểm tra bộ chấm

Oracle qua 65/65; scaffold chưa triển khai qua 0/65. Biến thể cố ý sai CAS bị bắt 19 mục; sai expiry bị bắt 15 mục. Đây là kiểm tra sức bắt lỗi của grader, không chứng minh oracle không có bug.

## Giới hạn

- One attempt per mode on one synthetic task; no population-level reliability or speed conclusion.
- Single means application Single mode, with Planner and self review; not one raw CLI call.
- Both modes share model family/provider and local host; independent role sessions do not prove independent model errors.
- Dollar figures are application estimates for subscription usage, not measured API bills.
- 53 directed cases plus 12 fixed-seed stateful traces do not establish exhaustive correctness.
- A missing candidate has no code score, not a fabricated 0/65.
- No failed run was retried, no contract/test/source was repaired by benchmark operator, and external grader output was never fed to agents.
- Local runtime uses CLI sandbox and scope enforcement; external grader remains outside workspace but is not hidden behind a container security boundary.

## Cải tiến rút ra

- Ưu tiên tạo oracle reference/link/quote từ dữ liệu đã chọn thay vì để Author viết lại tự do; vẫn giữ kiểm tra exact quote, không nới cổng.
- Sinh khung đầy đủ nhóm rủi ro và trường steps/invariants cho từng ca ngay từ schema; không dựa vào prompt để nhớ tất cả.
- Bổ sung kế hoạch chuỗi có nhiều op thành công trong cùng transaction, kiểm tra available không âm sau từng op và kết quả rollback.
- Không lấy phần trăm test đạt làm quyết định cuối khi còn lỗi invariant mức cao.

## Hồ sơ

`protocol.json`, `source-manifest.json`, `SPEC.md`, `runs.json`, `<arm>-detail.json`, `<arm>-grade.json` (nếu có candidate), `candidate-<arm>/`, `grader-audit.json`, `comparison.json`. Các benchmark cũ giữ nguyên. Không nghiệm thu hoặc giao branch tự động.

Chấm lại bản code đã lưu (không gọi model):

```powershell
node test-results/2026-10-25-escrowbatch/grade.mjs test-results/2026-10-25-escrowbatch/candidate-single test-results/2026-10-25-escrowbatch/recheck.json
```
