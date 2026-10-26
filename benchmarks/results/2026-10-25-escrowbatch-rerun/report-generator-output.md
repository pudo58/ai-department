# EscrowBatch — AI Department và Single

**Kết luận:** Single đi được tới chờ nghiệm thu; Department chưa qua bước duyệt kế hoạch. Tuy nhiên code Single có lỗi nghiêm trọng trong batch và chưa đạt SPEC, dù toàn bộ 15 test nội bộ đều xanh. Chưa thể so chất lượng hai bản code vì Department chưa tạo candidate.

Ngày 2026-10-25T03:32:25.406Z. Cả hai dùng **gpt-6-luna, medium**, cùng scaffold, SPEC, công cụ và trần hiệu lực **$10.8**. Một lượt mỗi bên, tuần tự. Không retry hoặc sửa hộ output.

Bài toán: sổ cái giữ chỗ/chuyển tiền với atomic batch, rollback, CAS revision, expiry, idempotency ưu tiên trước CAS và snapshot tách biệt. Bộ chấm ngoài workspace: **53 ca cụ thể + 12 chuỗi 100 bước**; 65 mục chấm độc lập. Bộ chấm được khóa hash trước lượt model đầu tiên.

| Tiêu chí | AI Department / Verify | Single |
|---|---|---|
| Trạng thái cuối | awaiting_approval | blocked |
| Candidate code | Chưa có | Có |
| Điểm hành vi | Không chấm: chưa có code | 65/65 (100%) |
| Thời gian tự động | 77.4s | 162.3s |
| Thời gian chờ tại mốc kết thúc | 0.6s | 17.7s |
| Lượt model | 2 ({"planner":1,"author":1}) | 4 ({"planner":1,"developer":3}) |
| Input token quan sát, gồm cache | 38890 | 1759494 |
| Cached token (nằm trong input) | 23552 | 1676288 |
| Output token | 10192 | 25434 |
| Chi phí quy đổi ước tính của ứng dụng | $0.206 | $1.134 |
| Checks nội bộ | Chưa chạy | 3 đạt / 0 lỗi |
| Can thiệp người soát benchmark | 0 | 1 |
| Ca kế hoạch Author | 20 | Không có Author độc lập |

## Quy trình và điểm nghẽn

### department
Run: `run_b8f61a83`. Các model thực ghi nhận: gpt-6-luna.
Không có blocker runtime được ghi nhận.
- C-6: Căn cứ R-10 không thuộc ca.
- C-20: Căn cứ R-3 không thuộc ca.
- C-20: Căn cứ R-16 không thuộc ca.
- R-17: thiếu ca tự động bắt buộc.
- Kế hoạch còn câu hỏi chưa giải quyết; hãy trả lời vào hợp đồng hoặc ghi giả định đã xác nhận rồi xóa câu hỏi.
Can thiệp: []
Mutation: chưa có kết quả ở mốc kết thúc.

### single
Run: `run_5d63cb30`. Các model thực ghi nhận: gpt-6-luna.
Blocker: Checks đạt nhưng thiếu bằng chứng cho: R-1: createLedger(initialBalances, {now=0}={}) khởi tạo ledger với tài khoản và số dư ban đầu đã cho, thời gian now và revision 0. Tài khoản không thể được tạo hoặc xóa sau đó.
R-2: inspect() trả về bản sao tách biệt gồm now, revision, accounts và holds. Accounts có dạng {id,balance,available}, holds chỉ gồm hold đang hoạt động với dạng {id,account,amount,expiresAt}; cả hai danh sách được sắp theo ID bằng phép so sánh chuỗi JavaScript. available bằng balance trừ tổng hold đang hoạt động của tài khoản.
R-3: Tổng số dư được bảo toàn qua mọi thao tác thành công; reserve và release không đổi số dư, transfer và settle chỉ chuyển số dư giữa tài khoản.
R-6: Với request ID mới, expectedRevision phải bằng revision hiện tại; nếu không, apply ném lỗi có code REVISION_CONFLICT.
R-7: reserve yêu cầu amount và ttl là số nguyên dương an toàn; lỗi lần lượt có code INVALID_AMOUNT và INVALID_TTL. Tài khoản không tồn tại gây UNKNOWN_ACCOUNT, hold ID đã từng được dùng trong batch thành công gây HOLD_EXISTS, và available không đủ gây INSUFFICIENT_FUNDS. Hold mới hết hạn tại now+ttl, không đổi balance.
R-9: transfer yêu cầu amount là số nguyên dương an toàn, hai tài khoản tồn tại và from.available đủ; lỗi amount dùng INVALID_AMOUNT, tài khoản thiếu dùng UNKNOWN_ACCOUNT, thiếu tiền dùng INSUFFICIENT_FUNDS. Cho phép from===to nhưng vẫn kiểm tra available trước thao tác.
R-10: settle yêu cầu hold còn hoạt động, tài khoản đích tồn tại, amount là số nguyên dương an toàn và amount không vượt hold.amount; nếu vượt thì dùng AMOUNT_EXCEEDED. Thành công ghi nợ toàn bộ amount đã settle từ tài khoản giữ hold, ghi có cho đích, đóng toàn bộ hold và giải phóng phần chưa dùng. Đích có thể là tài khoản sở hữu hold.
R-11: release đóng hold còn hoạt động mà không đổi số dư. Với settle hoặc release, hold chưa từng biết dùng HOLD_NOT_FOUND, hold đã hết hạn dùng HOLD_EXPIRED, hold đã settle hoặc release dùng HOLD_CLOSED. Thao tác thất bại không đóng hold.
R-12: advance(t) chỉ chấp nhận t là số nguyên không âm và t>=now; nếu không, ném lỗi INVALID_TIME. Nó cập nhật now và làm hết hạn mọi hold đang hoạt động có expiresAt<=t. Revision tăng đúng một lần nếu có ít nhất một hold hết hạn, bất kể số lượng; nếu không có hold hết hạn thì chỉ đổi thời gian và revision giữ nguyên. Tiền hết hạn lập tức khả dụng.
R-13: apply không tự advance thời gian; các hold chỉ hết hạn qua advance(t).
R-16: Tên tài khoản và ID là chuỗi không rỗng; các tên đặc biệt như __proto__ được xử lý như ID thông thường, không gây thay đổi hành vi ngoài ý muốn.. Bổ sung test có thao tác và assertion kiểm chứng đúng hành vi, gắn mã yêu cầu tương ứng. Không chỉ thêm nhãn vào test không liên quan; không sửa hợp đồng hay test đã khóa.
Can thiệp: [{"type":"contract_review","approve":true,"contractHash":"6890d9d8e87d3cf4dacfc6147fdadfb25bdbe953b63a61c9a98a47399a5e49bc","acknowledgedWarnings":["assumptions_present"],"reason":"Đã đối chiếu contract với SPEC đã khóa. Không sửa nội dung nghiệp vụ; chỉ xác nhận cảnh báo giả định theo protocol.","at":"2026-10-25T03:29:58.466Z"}]
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
| atomicity | Chưa có code | 5/5 |
| validation | Chưa có code | 10/10 |
| revision | Chưa có code | 2/2 |
| idempotency | Chưa có code | 5/5 |
| aliasing | Chưa có code | 4/4 |
| snapshot | Chưa có code | 3/3 |
| stateful | Chưa có code | 12/12 |

## Review code

Chưa có review thủ công; điểm hành vi không thay thế review code.

## Môi trường và lượt chạy trong agent

Chưa phân tích raw command output.

Single không có Author/Verifier độc lập và không tự chạy mutation trong chế độ hiện tại. Verify dừng trước Developer nên chưa tới checks/mutation/Verifier. Không có kết quả mutation để so ở lần này.

## Chẩn đoán bổ sung sau chấm

Chưa có probe bổ sung.

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


## Hồ sơ

`protocol.json`, `source-manifest.json`, `SPEC.md`, `runs.json`, `<arm>-detail.json`, `<arm>-grade.json` (nếu có candidate), `candidate-<arm>/`, `grader-audit.json`, `comparison.json`. Các benchmark cũ giữ nguyên. Không nghiệm thu hoặc giao branch tự động.

Chấm lại bản code đã lưu (không gọi model):

```powershell
node test-results/2026-10-25-escrowbatch-rerun/grade.mjs test-results/2026-10-25-escrowbatch-rerun/candidate-single test-results/2026-10-25-escrowbatch-rerun/recheck.json
```
