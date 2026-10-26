# Báo cáo nghiệm thu: EscrowBatch / department / GPT-6 Luna medium

**Trạng thái:** Có thể nghiệm thu sau khi đọc cảnh báo
**Chế độ:** verify · **Checkpoint:** `e90c9c3102` · **Tạo lúc:** 2026-10-25T03:23:14.310Z

## Yêu cầu gốc

# EscrowBatch — transactional in-memory ledger

Implement src/ledger.js (ES modules), exporting createLedger(initialBalances, {now=0}={}) and restoreLedger(snapshot). No database, UI or dependencies. Write tests and short README. API calls may be sync or async; consumers await them. Inputs are plain JSON; IDs/account names are nonempty strings, including names like "__proto__". Arithmetic in benchmark stays within safe integers. No authorization, network, crash durability or wall-clock timer is required.

1. initialBalances maps existing accounts to nonnegative integer balances. Accounts are never created/deleted later. A ledger has monotonic integer time and revision initially 0. inspect() returns a detached {now,revision,accounts,holds}; accounts is an array of {id,balance,available} sorted by ID using JS string comparison; holds is an array of active {id,account,amount,expiresAt}, also sorted by ID. available = balance minus that account's active holds. Total balance is conserved.
2. apply({id,expectedRevision,ops}) atomically performs the nonempty ordered batch below and returns {revision}. A successful fresh batch increments revision exactly once, even if its net effect is zero. A failure throws an Error with .code and leaves all state, revision, hold-ID history and request-ID history unchanged; subsequent ops observe earlier provisional ops within the same batch. expectedRevision must equal the current revision or throw REVISION_CONFLICT.
3. reserve: {type:'reserve',hold,account,amount,ttl}. amount and ttl must be positive safe integers (INVALID_AMOUNT / INVALID_TTL). Require existing account (UNKNOWN_ACCOUNT), globally unused hold ID (HOLD_EXISTS) and available >= amount (INSUFFICIENT_FUNDS). Add hold expiring at now+ttl without changing balance. Hold IDs remain used forever after a successful batch, including expired/closed holds, but a rolled-back reservation does not consume its ID.
4. transfer: {type:'transfer',from,to,amount}. Validate positive integer amount, existing accounts and from.available >= amount; debit from and credit to. from===to is allowed, but still requires sufficient available before the operation. It changes neither holds nor total balance.
5. settle: {type:'settle',hold,to,amount}. Require a live hold, existing destination and positive integer amount <= hold.amount (AMOUNT_EXCEEDED otherwise). Debit the held account and credit to; close the entire hold and release unused reserved amount. Destination may equal owner. release: {type:'release',hold} closes a live hold without changing balances. Both use HOLD_NOT_FOUND for never-seen IDs, HOLD_EXPIRED for expired IDs and HOLD_CLOSED for settled/released IDs. Failed operations do not close a hold.
6. advance(t) accepts a nonnegative integer t >= now (INVALID_TIME otherwise), updates now and expires every active hold with expiresAt <= t. One call increments revision once iff at least one hold expired, irrespective of their count. Merely changing time does not change revision. apply does not implicitly advance time. Expired funds are available immediately.
7. Successful request IDs are idempotent forever: replaying the same id and same ordered ops returns a detached original {revision} without effects, even with a stale expectedRevision or after expiry/restore. Equality ignores object-key order recursively but preserves array order. expectedRevision is excluded from replay equality. Reusing an ID with different ops throws IDEMPOTENCY_CONFLICT. This replay/conflict decision precedes revision checking. Failed request IDs are not consumed. Do not specify error precedence for other multiply-invalid inputs.
8. snapshot() returns detached JSON-serializable state with schemaVersion:1; restoreLedger(JSON.parse(JSON.stringify(snapshot))) must preserve balances, time, revision, active and terminal hold history and successful request replay history. Snapshot internal fields are otherwise private; only snapshots produced by this implementation are required inputs to restoreLedger. Mutating an inspect result, snapshot, successful apply result or caller-owned request after apply must never alter live/restored state or replay comparison. Restored and original ledgers evolve independently.

Example: start {a:100,b:0}, reserve h=60 for ttl=5 at time0 => revision1, a.available40. Settle h to b for25 => revision2, balances a75/b25, a.available75. Replaying reservation request returns revision1 and never recreates h. A batch that transfers10 then fails reserving1000 changes nothing.


## Cảnh báo

- Lưu ý: Test C-4, C-5, C-6, C-7, C-8, C-9, C-11, C-12, C-13, C-14, C-16, C-18, C-19, C-20, C-21, C-23 đã được sửa setup theo diff người dùng duyệt (770cc726 → 32f37a29): SPEC permits sync and async API. Normalize test invocation into promise before rejection assertions; no expected values or test identities changed.
- Lưu ý: Test C-14 đã được sửa setup theo diff người dùng duyệt (32f37a29 → e90c9c31): C-14 setup revision must be 4: three successful batches plus one expiry. Correct only request expectedRevision from 3 to 4; error assertions remain unchanged.
- **Cần đọc:** Mutation còn 30 sống sót và 3 không được test phủ; cần xem chất lượng assertion.
- **Cần đọc:** Giới hạn Verifier: Không tự chạy test; dựa trên bằng chứng runner hiện hành do yêu cầu cung cấp.
- **Cần đọc:** Giới hạn Verifier: Không có diff Git trong workspace; đối chiếu diff được dán với các file hiện có.
- Lưu ý: Công cụ phân tích mã (knip, jscpd, dependency-cruiser) chưa chạy: chưa có đánh giá về mã chết, trùng lặp hay vi phạm ranh giới module.

## Yêu cầu và bằng chứng

| Mã | Yêu cầu | Hành vi | Trạng thái | Test chứng minh |
|---|---|---|---|---|
| R-1 | createLedger(initialBalances, {now=0}={}) khởi tạo ledger với các account đã cho, thời gian now và revision 0; inspect(… | Mong muốn | verified | @json:["tests/ledger.test.js",["EscrowBatch acceptance","[R-1][R-2][C…<br>@json:["tests/ledger.test.js",["EscrowBatch acceptance","[R-1][R-2][C…<br>@json:["tests/ledger.test.js",["EscrowBatch acceptance","[R-1][R-2][R… |
| R-2 | inspect() sắp accounts và holds theo ID bằng thứ tự so sánh chuỗi của JavaScript; accounts có dạng {id,balance,availabl… | Mong muốn | verified | @json:["tests/ledger.test.js",["EscrowBatch acceptance","[R-1][R-2][C…<br>@json:["tests/ledger.test.js",["EscrowBatch acceptance","[R-1][R-2][C…<br>@json:["tests/ledger.test.js",["EscrowBatch acceptance","[R-2][R-6][C…<br>@json:["tests/ledger.test.js",["EscrowBatch acceptance","[R-8][R-2][C…<br>… +1 |
| R-3 | apply({id,expectedRevision,ops}) chỉ nhận batch không rỗng; batch thành công trả {revision} và tăng revision đúng một l… | Mong muốn | verified | @json:["tests/ledger.test.js",["EscrowBatch acceptance","[R-3][R-5][C…<br>@json:["tests/ledger.test.js",["EscrowBatch acceptance","[R-3][R-4][C…<br>@json:["tests/ledger.test.js",["EscrowBatch acceptance","[R-3][R-8][C… |
| R-4 | expectedRevision phải bằng revision hiện tại nếu request không được replay; nếu lệch, apply ném Error có code REVISION_… | Mong muốn | verified | @json:["tests/ledger.test.js",["EscrowBatch acceptance","[R-3][R-4][C… |
| R-5 | Nếu bất kỳ op nào trong apply thất bại, toàn bộ trạng thái, revision, lịch sử hold ID và lịch sử request ID giữ nguyên;… | Mong muốn | verified | @json:["tests/ledger.test.js",["EscrowBatch acceptance","[R-3][R-5][C…<br>@json:["tests/ledger.test.js",["EscrowBatch acceptance","[R-5][R-6][R…<br>@json:["tests/ledger.test.js",["EscrowBatch acceptance","[R-5][R-12][… |
| R-6 | reserve yêu cầu amount và ttl là số nguyên dương an toàn; lỗi tương ứng có code INVALID_AMOUNT hoặc INVALID_TTL. Accoun… | Mong muốn | verified | @json:["tests/ledger.test.js",["EscrowBatch acceptance","[R-2][R-6][C…<br>@json:["tests/ledger.test.js",["EscrowBatch acceptance","[R-5][R-6][R…<br>@json:["tests/ledger.test.js",["EscrowBatch acceptance","[R-6][R-7][C…<br>@json:["tests/ledger.test.js",["EscrowBatch acceptance","[R-6][R-11][…<br>… +1 |
| R-7 | Hold ID đã được dùng trong batch thành công tiếp tục bị xem là đã dùng sau khi hold hết hạn, settle hoặc release; reser… | Mong muốn | verified | @json:["tests/ledger.test.js",["EscrowBatch acceptance","[R-5][R-6][R…<br>@json:["tests/ledger.test.js",["EscrowBatch acceptance","[R-6][R-7][C…<br>@json:["tests/ledger.test.js",["EscrowBatch acceptance","[R-7][R-10][… |
| R-8 | transfer yêu cầu amount là số nguyên dương an toàn, hai account tồn tại và available của from đủ; lỗi dùng INVALID_AMOU… | Mong muốn | verified | @json:["tests/ledger.test.js",["EscrowBatch acceptance","[R-3][R-8][C…<br>@json:["tests/ledger.test.js",["EscrowBatch acceptance","[R-8][C-9] v…<br>@json:["tests/ledger.test.js",["EscrowBatch acceptance","[R-8][R-2][C… |
| R-9 | settle yêu cầu hold còn hoạt động, account đích tồn tại, amount là số nguyên dương an toàn và không vượt quá hold.amoun… | Mong muốn | verified | @json:["tests/ledger.test.js",["EscrowBatch acceptance","[R-9][R-10][…<br>@json:["tests/ledger.test.js",["EscrowBatch acceptance","[R-9][R-10][…<br>@json:["tests/ledger.test.js",["EscrowBatch acceptance","[R-9][C-13] … |
| R-10 | release đóng hold đang hoạt động mà không đổi balance. Với settle và release, hold chưa từng biết ném HOLD_NOT_FOUND, h… | Mong muốn | verified | @json:["tests/ledger.test.js",["EscrowBatch acceptance","[R-9][R-10][…<br>@json:["tests/ledger.test.js",["EscrowBatch acceptance","[R-9][R-10][…<br>@json:["tests/ledger.test.js",["EscrowBatch acceptance","[R-10][C-14]…<br>@json:["tests/ledger.test.js",["EscrowBatch acceptance","[R-7][R-10][… |
| R-11 | advance(t) chỉ chấp nhận số nguyên không âm t>=now, nếu không ném INVALID_TIME. Nó cập nhật now và làm hết hạn mọi hold… | Mong muốn | verified | @json:["tests/ledger.test.js",["EscrowBatch acceptance","[R-6][R-11][…<br>@json:["tests/ledger.test.js",["EscrowBatch acceptance","[R-11][C-16]…<br>@json:["tests/ledger.test.js",["EscrowBatch acceptance","[R-11][C-17]… |
| R-12 | Request ID thành công được idempotent vĩnh viễn: cùng ID và cùng ops theo thứ tự trả bản sao kết quả revision ban đầu m… | Mong muốn | verified | @json:["tests/ledger-extra.test.js",["EscrowBatch additional public A…<br>@json:["tests/ledger.test.js",["EscrowBatch acceptance","[R-12][C-19]…<br>@json:["tests/ledger.test.js",["EscrowBatch acceptance","[R-12][R-14]…<br>@json:["tests/ledger.test.js",["EscrowBatch acceptance","[R-5][R-12][… |
| R-13 | snapshot() trả state JSON-serializable có schemaVersion:1. Khôi phục từ JSON.parse(JSON.stringify(snapshot)) giữ balanc… | Mong muốn | verified | @json:["tests/ledger-extra.test.js",["EscrowBatch additional public A…<br>@json:["tests/ledger.test.js",["EscrowBatch acceptance","[R-13][R-14]…<br>@json:["tests/ledger.test.js",["EscrowBatch acceptance","[R-13][C-24]… |
| R-14 | Sửa inspect result, snapshot, apply result, hoặc request do caller sở hữu sau apply không được làm đổi state live/resto… | Mong muốn | verified | @json:["tests/ledger-extra.test.js",["EscrowBatch additional public A…<br>@json:["tests/ledger.test.js",["EscrowBatch acceptance","[R-12][R-14]…<br>@json:["tests/ledger.test.js",["EscrowBatch acceptance","[R-1][R-2][R…<br>@json:["tests/ledger.test.js",["EscrowBatch acceptance","[R-13][R-14]… |

## Các ca đã khai báo và rủi ro còn lại

| Ca | Bắt buộc | Kết quả | Test chứng minh |
|---|---|---|---|
| C-1 | Có | passed | test: @json:["tests/ledger.test.js",["EscrowBatch acceptance","[R-1][R-2][C-1] initializes balances and sorted detached inspection"]] |
| C-2 | Có | passed | test: @json:["tests/ledger.test.js",["EscrowBatch acceptance","[R-1][R-2][C-2] preserves special account identifiers"]] |
| C-3 | Có | passed | test: @json:["tests/ledger.test.js",["EscrowBatch acceptance","[R-2][R-6][C-3] sorts active holds and subtracts their amounts from available"]] |
| C-4 | Có | passed | test: @json:["tests/ledger.test.js",["EscrowBatch acceptance","[R-3][R-5][C-4] rejects empty and failed batches without partial effects"]] |
| C-5 | Có | passed | test: @json:["tests/ledger.test.js",["EscrowBatch acceptance","[R-3][R-4][C-5] increments once for zero-net batches and checks revisions"]] |
| C-6 | Có | passed | test: @json:["tests/ledger.test.js",["EscrowBatch acceptance","[R-3][R-8][C-6] observes provisional transfers and checks self-transfer funds"]] |
| C-7 | Có | passed | test: @json:["tests/ledger.test.js",["EscrowBatch acceptance","[R-5][R-6][R-7][C-7] rolls back request and hold identifiers after a failed batch"]] |
| C-8 | Có | passed | test: @json:["tests/ledger.test.js",["EscrowBatch acceptance","[R-6][R-7][C-8] validates reserve amount ttl account hold history and availability"]] |
| C-9 | Có | passed | test: @json:["tests/ledger.test.js",["EscrowBatch acceptance","[R-8][C-9] validates transfer amount accounts and held availability"]] |
| C-10 | Có | passed | test: @json:["tests/ledger.test.js",["EscrowBatch acceptance","[R-8][R-2][C-10] transfers balances while preserving holds and total balance"]] |
| C-11 | Có | passed | test: @json:["tests/ledger.test.js",["EscrowBatch acceptance","[R-9][R-10][C-11] settles partially and closes the entire hold"]] |
| C-12 | Có | passed | test: @json:["tests/ledger.test.js",["EscrowBatch acceptance","[R-9][R-10][C-12] rejects excessive settlement without closing its hold"]] |
| C-13 | Có | passed | test: @json:["tests/ledger.test.js",["EscrowBatch acceptance","[R-9][C-13] validates settlement destination and amount while allowing owner destination"]] |
| C-14 | Có | passed | test: @json:["tests/ledger.test.js",["EscrowBatch acceptance","[R-10][C-14] distinguishes unknown expired and closed holds on release"]] |
| C-15 | Có | passed | test: @json:["tests/ledger.test.js",["EscrowBatch acceptance","[R-6][R-11][C-15] expires at the boundary and releases funds once"]] |
| C-16 | Có | passed | test: @json:["tests/ledger.test.js",["EscrowBatch acceptance","[R-11][C-16] validates monotonic integer time and leaves revision unchanged without expiry"]] |
| C-17 | Có | passed | test: @json:["tests/ledger.test.js",["EscrowBatch acceptance","[R-11][C-17] expires multiple holds with one revision increment"]] |
| C-18 | Có | passed | test: @json:["tests/ledger.test.js",["EscrowBatch acceptance","[R-7][R-10][R-6][C-18] permanently consumes released and expired hold identifiers"]] |
| C-19 | Có | passed | test: @json:["tests/ledger.test.js",["EscrowBatch acceptance","[R-12][C-19] replays original result and conflicts before checking revision"]] |
| C-20 | Có | passed | test: @json:["tests/ledger.test.js",["EscrowBatch acceptance","[R-12][R-14][C-20] snapshots request input and compares keys recursively but preserves array order"]] |
| C-21 | Có | passed | test: @json:["tests/ledger.test.js",["EscrowBatch acceptance","[R-5][R-12][C-21] permits retrying a failed request identifier with valid operations"]] |
| C-22 | Có | passed | test: @json:["tests/ledger.test.js",["EscrowBatch acceptance","[R-1][R-2][R-14][C-22] detaches inspection snapshot and apply results"]] |
| C-23 | Có | passed | test: @json:["tests/ledger.test.js",["EscrowBatch acceptance","[R-13][R-14][C-23] restores terminal and replay history with independent evolution"]] |
| C-24 | Có | passed | test: @json:["tests/ledger.test.js",["EscrowBatch acceptance","[R-13][C-24] round-trips schema time revision balances and active holds"]] |

Manifest: 77436b089deec1348fcd165e700826088a703a8d60e010ac63dbc0d9ed52bdfb; thời gian check: 2s.

Mutation: available — Đã nhận diện JS/TS + Vitest và bộ Stryker tương thích.
Trạng thái: completed; baseline: passed; 1 phút.
Killed: 241; survived: 30; no coverage: 3; timeout: 0; lỗi: 0; chưa chạy: 0.
Đã kiểm tra các mutation trong phạm vi source đã chọn.
- src/ledger.js:78 — StringLiteral: NoCoverage
- src/ledger.js:114 — StringLiteral: NoCoverage
- src/ledger.js:116 — StringLiteral: NoCoverage
- src/ledger.js:21 — ConditionalExpression: Survived
- src/ledger.js:21 — EqualityOperator: Survived
- src/ledger.js:21 — ConditionalExpression: Survived
- src/ledger.js:21 — ConditionalExpression: Survived
- src/ledger.js:21 — EqualityOperator: Survived
- src/ledger.js:21 — EqualityOperator: Survived
- src/ledger.js:34 — StringLiteral: Survived
- src/ledger.js:56 — MethodExpression: Survived
- src/ledger.js:56 — ConditionalExpression: Survived
- src/ledger.js:56 — LogicalOperator: Survived
- src/ledger.js:56 — ConditionalExpression: Survived
- src/ledger.js:56 — ConditionalExpression: Survived
- src/ledger.js:57 — EqualityOperator: Survived
- src/ledger.js:64 — MethodExpression: Survived
- src/ledger.js:64 — ConditionalExpression: Survived
- src/ledger.js:64 — LogicalOperator: Survived
- src/ledger.js:64 — ConditionalExpression: Survived
- src/ledger.js:64 — ConditionalExpression: Survived
- src/ledger.js:75 — StringLiteral: Survived
- src/ledger.js:76 — ConditionalExpression: Survived
- src/ledger.js:77 — StringLiteral: Survived
- src/ledger.js:94 — EqualityOperator: Survived
- src/ledger.js:94 — ConditionalExpression: Survived
- src/ledger.js:94 — EqualityOperator: Survived
- src/ledger.js:114 — ConditionalExpression: Survived
- src/ledger.js:114 — LogicalOperator: Survived
- src/ledger.js:114 — ConditionalExpression: Survived
- src/ledger.js:116 — ConditionalExpression: Survived
- src/ledger.js:116 — LogicalOperator: Survived
- src/ledger.js:116 — ConditionalExpression: Survived
Căn cứ C-1: R-1: khởi tạo ledger với các account đã cho, thời gian now và revision 0; inspect() trả về dữ liệu tách biệt gồm now, revision, accounts và holds.; R-2: inspect() sắp accounts và holds theo ID bằng thứ tự so sánh chuỗi của JavaScript. Khởi tạo và inspect được đối chiếu trực tiếp với cấu trúc cùng giá trị quy định. Thứ tự mong đợi dùng so sánh chuỗi JavaScript.
Căn cứ C-2: R-1: inspect() trả về dữ liệu tách biệt gồm now, revision, accounts và holds.; R-2: accounts có dạng {id,balance,available}. Giả định cho phép tên đặc biệt như __proto__. Kết quả inspect phải thể hiện các account đã khởi tạo đúng dạng.
Căn cứ C-3: R-2: available bằng balance trừ tổng hold đang hoạt động của account.; R-6: Hold hết hạn tại now+ttl; reserve không đổi balance.. Hai hold hoạt động cùng account cho phép kiểm tra tổng reserved amount, thứ tự ID, expiry và việc reserve không ghi nợ balance.
Căn cứ C-4: R-3: apply({id,expectedRevision,ops}) chỉ nhận batch không rỗng; R-5: Nếu bất kỳ op nào trong apply thất bại, toàn bộ trạng thái, revision, lịch sử hold ID và lịch sử request ID giữ nguyên. Bước đầu kiểm tra batch rỗng. Bước sau tạo thay đổi tạm thời trước op lỗi; inspect xác nhận rollback toàn batch. Invariants là các điều hợp đồng quy định.
Căn cứ C-5: R-3: batch thành công trả {revision} và tăng revision đúng một lần, kể cả khi hiệu ứng ròng bằng không.; R-4: expectedRevision phải bằng revision hiện tại nếu request không được replay; nếu lệch, apply ném Error có code REVISION_CONFLICT.. Hai transfer đảo ngược tạo hiệu ứng ròng bằng không nhưng vẫn là batch thành công; request tiếp theo xác nhận revision đã tăng.
Căn cứ C-6: R-3: Các op sau trong batch quan sát thay đổi tạm thời từ op trước.; R-8: from===to được phép nhưng vẫn phải đủ available trước op. Bước đầu kiểm tra chuỗi thao tác trong batch và revision một lần. Bước sau kiểm tra self-transfer không miễn điều kiện funds. Tổng balance được bảo toàn theo hợp đồng.
Căn cứ C-7: R-5: request thất bại không tiêu thụ ID.; R-6: reserve yêu cầu amount và ttl là số nguyên dương an toàn; lỗi tương ứng có code INVALID_AMOUNT hoặc INVALID_TTL. Account phải tồn tại (UNKNOWN_ACCOUNT), hold ID chưa từng được dùng thành công (HOLD_EXISTS), và available phải đủ (INSUFFICIENT_FUNDS). Hold hết hạn tại now+ttl; reserve không đổi balance.; R-7: reservation trong batch thất bại không tiêu thụ hold ID.. Bước một tạo hold provisional rồi gây lỗi. Bước hai tái sử dụng cả request ID lẫn hold ID; thành công chứng minh rollback lịch sử ID.
Căn cứ C-8: R-6: amount và ttl là số nguyên dương an toàn; R-6: Account phải tồn tại (UNKNOWN_ACCOUNT), hold ID chưa từng được dùng thành công (HOLD_EXISTS), và available phải đủ (INSUFFICIENT_FUNDS).. Mỗi trường hợp vi phạm riêng một điều kiện để xác nhận mã lỗi không phụ thuộc thứ tự ưu tiên khi nhiều điều kiện cùng sai. Hold ID đã dùng được tạo trước đó bằng một batch thành công.
Căn cứ C-9: R-8: transfer yêu cầu amount là số nguyên dương an toàn, hai account tồn tại và available của from đủ; lỗi dùng INVALID_AMOUNT, UNKNOWN_ACCOUNT hoặc INSUFFICIENT_FUNDS.. Các input tách biệt kiểm tra ba điều kiện và xác nhận funds bị hold không thể bị transfer.
Căn cứ C-10: R-8: chuyển tiền không thay đổi holds hay tổng balance.; R-2: available bằng balance trừ tổng hold đang hoạt động của account.. Bước đầu lập trạng thái có hold. Bước sau kiểm tra debit/credit, giữ nguyên hold và tính available sau transfer. Tổng balance được bảo toàn.
Căn cứ C-11: R-9: Thành công ghi nợ owner, ghi có destination, đóng toàn bộ hold và giải phóng phần chưa settle; R-10: hold đã settle/release ném HOLD_CLOSED. Bước settle dùng amount nhỏ hơn hold để kiểm tra phần dư được giải phóng và hold đóng toàn bộ. Bước tiếp theo xác nhận trạng thái terminal.
Căn cứ C-12: R-9: amount vượt mức ném AMOUNT_EXCEEDED.; R-10: op lỗi không đóng hold.. Request vượt mức được thực hiện riêng để xác nhận lỗi và hold còn hoạt động; settle đúng amount sau đó xác nhận hold chưa bị đóng.
Căn cứ C-13: R-9: settle yêu cầu hold còn hoạt động, account đích tồn tại, amount là số nguyên dương an toàn; R-9: destination có thể là owner.. Các điều kiện lỗi được thử riêng; settle tới owner kiểm tra đích trùng owner vẫn hợp lệ và hold được đóng.
Căn cứ C-14: R-10: hold chưa từng biết ném HOLD_NOT_FOUND, hold hết hạn ném HOLD_EXPIRED, hold đã settle/release ném HOLD_CLOSED; R-10: release đóng hold đang hoạt động mà không đổi balance.. Ba hold đại diện ba trạng thái lịch sử riêng biệt. Kiểm tra balances trước và sau release hoạt động để xác nhận không ghi nợ/ghi có.
Căn cứ C-15: R-11: làm hết hạn mọi hold có expiresAt<=t.; R-11: Revision tăng đúng một lần nếu có ít nhất một hold hết hạn. Hai bước nằm hai phía của expiresAt để kiểm tra điều kiện bao gồm biên. Inspect cho thấy hold và funds ngay sau mỗi bước.
Căn cứ C-16: R-11: chỉ chấp nhận số nguyên không âm t>=now, nếu không ném INVALID_TIME.; R-11: nếu không có hold hết hạn, chỉ đổi thời gian không tăng revision.. Các giá trị thử riêng rẽ vi phạm từng điều kiện thời gian. Advance hợp lệ khi không có expiry xác nhận revision không đổi.
Căn cứ C-17: R-11: Revision tăng đúng một lần nếu có ít nhất một hold hết hạn, không phụ thuộc số lượng; R-11: Funds hết hạn lập tức khả dụng.. Tạo nhiều hold cùng expiry để phân biệt số lượng expiry với số lần tăng revision. Inspect sau mỗi bước kiểm tra trạng thái.
Căn cứ C-18: R-7: Hold ID đã được dùng trong batch thành công tiếp tục bị xem là đã dùng sau khi hold hết hạn, settle hoặc release; R-6: reserve yêu cầu amount và ttl là số nguyên dương an toàn; lỗi tương ứng có code INVALID_AMOUNT hoặc INVALID_TTL. Account phải tồn tại (UNKNOWN_ACCOUNT), hold ID chưa từng được dùng thành công (HOLD_EXISTS), và available phải đủ (INSUFFICIENT_FUNDS). Hold hết hạn tại now+ttl; reserve không đổi balance.. Hai bước kiểm tra hai loại trạng thái terminal khác nhau. Reserve lại mỗi ID phải bị từ chối theo lịch sử sử dụng thành công.
Căn cứ C-19: R-12: cùng ID và cùng ops theo thứ tự trả bản sao kết quả revision ban đầu mà không có hiệu ứng; R-12: Quyết định replay/conflict xảy ra trước kiểm tra revision.. Bước đầu replay sau thay đổi trạng thái với revision stale để xác nhận kết quả gốc và không có hiệu ứng. Bước sau dùng ID với ops khác và revision sai để phân biệt thứ tự kiểm tra.
Căn cứ C-20: R-12: So sánh ops bỏ qua thứ tự key object đệ quy nhưng giữ thứ tự array; R-14: Sửa inspect result, snapshot, apply result, hoặc request do caller sở hữu sau apply không được làm đổi state live/restored hay cách so sánh replay.. Mutation sau apply kiểm tra request được sao chép cho lịch sử replay. Replay với key order khác phải tương đương; array order khác phải được phân biệt.
Căn cứ C-21: R-5: request thất bại không tiêu thụ ID.. Retry cùng ID với ops hợp lệ phân biệt lịch sử request chỉ ghi nhận thành công. Inspect xác nhận lần đầu không có hiệu ứng.
Căn cứ C-22: R-14: Sửa inspect result, snapshot, apply result, hoặc request do caller sở hữu sau apply không được làm đổi state live/restored hay cách so sánh replay.; R-2: available bằng balance trừ tổng hold đang hoạt động của account.. Bước mutation thử các kết quả detached; inspect mới đối chiếu state và invariant available.
Căn cứ C-23: R-13: Khôi phục từ JSON.parse(JSON.stringify(snapshot)) giữ balances, time, revision, lịch sử hold đang hoạt động và terminal, cùng lịch sử replay request thành công; R-13: ledger gốc và ledger khôi phục tiến triển độc lập.; R-14: không được làm đổi state live/restored hay cách so sánh replay.. Round-trip JSON kiểm tra snapshot serializable. Replay và tái sử dụng hold kiểm tra lịch sử được phục hồi; advance kiểm tra hai ledger không dùng chung state.
Căn cứ C-24: R-13: snapshot() trả state JSON-serializable có schemaVersion:1.; R-13: Khôi phục từ JSON.parse(JSON.stringify(snapshot)) giữ balances, time, revision, lịch sử hold đang hoạt động và terminal. Round-trip và inspect so sánh các thành phần state được yêu cầu bảo tồn, không áp đặt cấu trúc nội bộ snapshot.

Các ca đã khai báo đạt không chứng minh mọi tình huống nghiệp vụ đều được kiểm tra.

## Thay đổi so với bản gốc

4 file, +404 −3

- `README.md` (modified) +16 −1
- `src/ledger.js` (modified) +131 −2
- `tests/ledger-extra.test.js` (added) +21 −0
- `tests/ledger.test.js` (added) +236 −0

## Kết quả chạy test

- `node node_modules/vitest/vitest.mjs run --reporter=json --outputFile=.aidept-report.json` → **passed** · 27 pass, 0 fail, 0 bỏ qua · 2s

## Verifier độc lập

Đã review: SPEC.md: hợp đồng R-1–R-14 và các giả định; src/ledger.js: khởi tạo, inspect, apply, advance, snapshot và restore; tests/ledger.test.js; tests/ledger-extra.test.js; README.md; tests/scaffold.test.js: xác nhận nội dung được giữ nguyên.
Bằng chứng runner: chk_3f3baad5.
- Giới hạn: Không tự chạy test; dựa trên bằng chứng runner hiện hành do yêu cầu cung cấp.
- Giới hạn: Không có diff Git trong workspace; đối chiếu diff được dán với các file hiện có.
- "C:\\Users\\ADMIN\\.cache\\codex-runtimes\\codex-primary-runtime\\dependencies\\native\\powershell\\pwsh.exe" -Command 'git status --short; git diff --stat; git diff -- src/ledger.js README.md tests/ledger.test.js tests/ledger-extra.test.js': passed — 
- "C:\\Users\\ADMIN\\.cache\\codex-runtimes\\codex-primary-runtime\\dependencies\\native\\powershell\\pwsh.exe" -Command 'Get-Content package.json; if (Test-Path AGENTS.md) { Get-Content AGENTS.md }; if (Test-Path tests/scaffold.test.js) { Get-Content tests/scaffold.test.js }': passed — {
  "name": "escrowbatch-benchmark",
  "private": true,
  "type": "module",
  "scripts": {
    "test": "vitest run"
  },
  "devDependencies": {
    "vitest": "3.2.4",
    "@stryker-mutator/core": "9.6.1",
    "@stryker-mutator/vitest-runner": "9.6.1"
  }
}
import {it,expect} from 'vitest';
import {createLedger,restoreLedger} from '../src/ledger.js';
it('public exports exist',()=>{expect(typeof createLedger).toBe('function');expect(typeof restoreLedger).toBe('function');});

- "C:\\Users\\ADMIN\\.cache\\codex-runtimes\\codex-primary-runtime\\dependencies\\native\\powershell\\pwsh.exe" -Command '$n=0; Get-Content tests/ledger.test.js | ForEach-Object { $n++; '"'{0,4}: {1}' -f "'$n, $_ }; $n=0; Get-Content tests/ledger-extra.test.js | ForEach-Object { $n++; '"'{0,4}: {1}' -f "'$n, $_ }': passed — estoreLedger(JSON.parse(JSON.stringify(snapshot)));
 234:     expect(restored.inspect()).toEqual({ now: 7, revision: 1, accounts: [{ id: 'a', balance: 40, available: 30 }, { id: 'b', balance: 2, available: 2 }], holds: [{ id: 'h', account: 'a', amount: 10, expiresAt: 12 }] });
 235:   });
 236: });
   1: import { describe, it, expect } from 'vitest';
   2: import { createLedger, restoreLedger } from '../src/ledger.js';
   3: 
   4: describe('EscrowBatch additional public API checks', () => {
   5:   it('[R-12][R-13] restores replay history after expiry', async () => {
   6:     const ledger = createLedger({ a: 20 });
   7:     const request = { id: 'reserve', expectedRevision: 0, ops: [{ type: 'reserve', hold: 'h', account: 'a', amount: 5, ttl: 2 }] };
   8:     expect(await ledger.apply(request)).toEqual({ revision: 1 });
   9:     await ledger.advance(2);
  10:     const restored = restoreLedger(JSON.parse(JSON.stringify(ledger.snapshot())));
  11:     expect(await restored.apply({ ...request, expectedRevision: 0 })).toEqual({ revision: 1 });
  12:     expect(restored.inspect()).toEqual(ledger.inspect());
  13:   });
  14: 
  15:   it('[R-14] keeps restored state detached from snapshot mutations', () => {
  16:     const snapshot = createLedger({ a: 3 }).snapshot();
  17:     const restored = restoreLedger(snapshot);
  18:     snapshot.accounts[0].balance = 100;
  19:     expect(restored.inspect().accounts[0].balance).toBe(3);
  20:   });
  21: });

Kết luận: **pass**

Checklist theo hợp đồng trước khi xét diff:

1. Khởi tạo, `inspect()` detached và sắp xếp account/hold theo thứ tự chuỗi JS.
2. Batch không rỗng, tăng revision đúng một lần, kiểm tra revision; rollback toàn bộ state và lịch sử ID khi lỗi.
3. Reserve/transfer/settle/release: validation, funds khả dụng, trạng thái hold và mã lỗi.
4. `advance`: thời gian đơn điệu, expiry đúng biên, revision chỉ tăng khi có expiry.
5. Idempotency: replay/conflict trước revision, so sánh sâu bỏ qua thứ tự key nhưng giữ thứ tự mảng.
6. Snapshot/restore JSON round-trip giữ lịch sử và trả dữ liệu tách biệt; hai ledger phát triển độc lập.
7. README/tests và các giới hạn thiết kế: chỉ nêu finding có vị trí cùng bằng chứng cụ thể; phân loại theo nhóm D1–D5 khi là finding thiết kế.

Giờ tôi sẽ đối chiếu checklist với hướng dẫn/`SPEC.md` trong repository và diff, rồi chỉ báo các phản ví dụ có thể xác nhận bằng đường dẫn code hoặc runner.
Checklist đã được đối chiếu với `SPEC.md`. Runner hiện hành được cung cấp báo 27/27 pass; tôi chưa chạy lại test. `git diff` trong workspace hiện trống, nên tôi đang kiểm tra trực tiếp các file hiện có để xác nhận nội dung và vị trí code tương ứng với diff bạn đưa.
Không tìm thấy phản ví dụ có thể xác nhận trong các file đã xem. `scaffold.test.js` được giữ nguyên. Runner được cung cấp báo 27/27 pass; tôi không tự chạy lại test. Workspace hiện không có diff Git, nên phần đối chiếu dựa trên diff trong yêu cầu và nội dung file hiện tại.

## Công sức

- Chi phí: ~$1.33 (ước tính) · 1,173,852 token · 7 lượt agent · 6 phút thời gian AI · 0 vòng sửa
- Công của bạn: 0s

## Nhận kết quả

Trạng thái giao: **unconfirmed** (chưa xác nhận giao thành công)
Branch: `aidept/run_8cb7d7c4-A` trong `C:\Users\ADMIN\OneDrive\Desktop\ai-department\.data\escrowbatch-20261025\department`.

```bash
git -C "C:\Users\ADMIN\OneDrive\Desktop\ai-department\.data\escrowbatch-20261025\department" log --oneline HEAD..aidept/run_8cb7d7c4-A
git -C "C:\Users\ADMIN\OneDrive\Desktop\ai-department\.data\escrowbatch-20261025\department" diff HEAD..aidept/run_8cb7d7c4-A
git -C "C:\Users\ADMIN\OneDrive\Desktop\ai-department\.data\escrowbatch-20261025\department" merge aidept/run_8cb7d7c4-A
```


## Thời gian thực thi

Tự động: 7 phút; chờ: 23 phút; chờ slot agent: 0s.

| Bước | Trạng thái | Bắt đầu | Kết thúc |
|---|---|---|---|
| queued | completed | 2026-10-25T02:52:39.751Z | 2026-10-25T02:52:39.757Z |
| Điều phối run | completed | 2026-10-25T02:52:39.754Z | 2026-10-25T02:54:06.577Z |
| Chuẩn bị bản sao/cài dependency | completed | 2026-10-25T02:52:39.768Z | 2026-10-25T02:52:40.309Z |
| Kiểm tra môi trường (tối đa 60 giây) | completed | 2026-10-25T02:52:40.322Z | 2026-10-25T02:52:42.006Z |
| planner chờ slot | completed | 2026-10-25T02:52:42.025Z | 2026-10-25T02:52:42.027Z |
| planner (A) | completed | 2026-10-25T02:52:42.030Z | 2026-10-25T02:52:59.738Z |
| author chờ slot | completed | 2026-10-25T02:52:59.921Z | 2026-10-25T02:52:59.923Z |
| author (A) | completed | 2026-10-25T02:52:59.926Z | 2026-10-25T02:54:06.399Z |
| awaiting_approval | completed | 2026-10-25T02:54:06.571Z | 2026-10-25T03:02:00.180Z |
| queued | completed | 2026-10-25T03:02:00.180Z | 2026-10-25T03:02:00.186Z |
| Điều phối run | failed | 2026-10-25T03:02:00.183Z | 2026-10-25T03:03:19.541Z |
| Kiểm tra môi trường (tối đa 60 giây) | completed | 2026-10-25T03:02:00.195Z | 2026-10-25T03:02:01.902Z |
| author chờ slot | completed | 2026-10-25T03:02:01.927Z | 2026-10-25T03:02:01.929Z |
| author (A) | completed | 2026-10-25T03:02:01.932Z | 2026-10-25T03:03:19.252Z |
| blocked | completed | 2026-10-25T03:03:19.535Z | 2026-10-25T03:07:12.395Z |
| queued | completed | 2026-10-25T03:07:12.396Z | 2026-10-25T03:07:12.403Z |
| Điều phối run | failed | 2026-10-25T03:07:12.400Z | 2026-10-25T03:09:52.966Z |
| Kiểm tra môi trường (tối đa 60 giây) | completed | 2026-10-25T03:07:12.417Z | 2026-10-25T03:07:13.859Z |
| author chờ slot | completed | 2026-10-25T03:07:13.886Z | 2026-10-25T03:07:13.888Z |
| author (A) | completed | 2026-10-25T03:07:13.891Z | 2026-10-25T03:08:29.140Z |
| developer chờ slot | completed | 2026-10-25T03:08:29.530Z | 2026-10-25T03:08:29.533Z |
| developer (A) | completed | 2026-10-25T03:08:29.536Z | 2026-10-25T03:09:33.277Z |
| Check "test" (candidate) | completed | 2026-10-25T03:09:33.680Z | 2026-10-25T03:09:35.380Z |
| Chạy lại check test một lần để kiểm tra flaky; chưa quy lỗi cho source hay test. | completed | 2026-10-25T03:09:35.385Z | 2026-10-25T03:09:35.388Z |
| Check "test" (candidate) | completed | 2026-10-25T03:09:35.397Z | 2026-10-25T03:09:37.585Z |
| author chờ slot | completed | 2026-10-25T03:09:37.628Z | 2026-10-25T03:09:37.632Z |
| author (A) | completed | 2026-10-25T03:09:37.636Z | 2026-10-25T03:09:52.817Z |
| blocked | completed | 2026-10-25T03:09:52.959Z | 2026-10-25T03:19:06.055Z |
| queued | completed | 2026-10-25T03:19:06.055Z | 2026-10-25T03:19:06.061Z |
| Điều phối run | failed | 2026-10-25T03:19:06.058Z | 2026-10-25T03:19:12.021Z |
| Check "test" (candidate) | completed | 2026-10-25T03:19:07.029Z | 2026-10-25T03:19:09.492Z |
| Chạy lại check test một lần để kiểm tra flaky; chưa quy lỗi cho source hay test. | completed | 2026-10-25T03:19:09.498Z | 2026-10-25T03:19:09.501Z |
| Check "test" (candidate) | completed | 2026-10-25T03:19:09.510Z | 2026-10-25T03:19:11.987Z |
| failed | completed | 2026-10-25T03:19:12.011Z | 2026-10-25T03:19:31.192Z |
| queued | completed | 2026-10-25T03:19:31.192Z | 2026-10-25T03:19:31.197Z |
| Điều phối run | completed | 2026-10-25T03:19:31.195Z | 2026-10-25T03:21:18.100Z |
| Check "test" (candidate) | completed | 2026-10-25T03:19:32.336Z | 2026-10-25T03:19:34.389Z |
| Kiểm tra khả năng bắt lỗi của test (tối đa 5 phút) | completed | 2026-10-25T03:19:34.439Z | 2026-10-25T03:20:48.209Z |
| verifier chờ slot | completed | 2026-10-25T03:20:48.386Z | 2026-10-25T03:20:48.390Z |
| verifier (A) | completed | 2026-10-25T03:20:48.392Z | 2026-10-25T03:21:17.907Z |
| awaiting_acceptance | running | 2026-10-25T03:21:18.089Z | đang chạy |
Lượt theo vai: {"planner":1,"author":4,"developer":1,"verifier":1}.
Nguyên nhân chạy lại: [{"reason":"check_failure","count":2}].

Môi trường: passed; runtime local.
Kiểm tra trên runtime chạy checks; không xác nhận quyền thực thi trong sandbox riêng của agent. Không phải bằng chứng nghiệm thu.
- test: passed — Runner tải cấu hình và discovery thành công; chưa chứng minh test nghiệp vụ đạt.