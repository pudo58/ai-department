# Kiểm tra ban đầu chính sách v4 — 12 lượt trên model thật

Mục đích: xem chính sách v4 (Department/Verify) và Single hoạt động ra sao trên ba task mới tập trung vào **chuỗi trạng thái, rollback/idempotency và tương tác nhiều quy tắc**. Đây là kiểm tra ban đầu: 3 task × 2 nhánh × 2 lần = 12 lượt, **chưa đủ để kết luận ưu thế tổng quát**, và không có điều kiện "Department phải thắng" để chọn kết quả. Task, reference, grader, mutant và các quyết định duyệt đều do AI tạo (nhãn `synthetic`).

## Gói task (`benchmarks/tasks/`)

| Task | Trọng tâm | Test grader | Mutant |
|---|---|---|---|
| `ledgerhold` | khóa idempotency, hold/capture/release, hết hạn, chuyển tiền nguyên tử | 32 | 17 |
| `ticketflow` | trạng thái ticket, reopen + tự đóng theo mốc thời gian, leo thang, gộp ticket | 29 | 17 |
| `couponstack` | thứ tự áp dụng, giới hạn dùng, redeem idempotent, hoàn lại khi hủy | 33 | 20 |

Cả ba dùng JS/TS + Vitest, hợp với adapter replay `node-api` và regression Vitest. Audit từng assertion theo SPEC nằm ở [`benchmarks/eval/v4-check/AUDIT.md`](../benchmarks/eval/v4-check/AUDIT.md). Kiểm tra pack: `node node_modules/tsx/dist/cli.mjs scripts/eval-v4.mjs check` (reference đạt 100% và mọi mutant bị bắt).

## Giao thức đã khóa

`lock` ghi `benchmarks/eval/v4-check/protocol.json` trước lần gọi model đầu tiên và bộ chạy từ chối chạy nếu bất kỳ thứ nào sau đây đổi:

- hash của từng gói task (SPEC, scaffold, reference, grader, mutant) và của `AUDIT.md`;
- **snapshot sản phẩm**: hash toàn bộ `src/**`, `package.json`, `pnpm-lock.yaml` và các script của bộ chạy;
- model `gpt-6-luna`, mức `medium` cho **mọi vai**; phiên bản Codex CLI;
- trần hiệu lực **$10,80/lượt** (Single `budgetUsd` 10,8; Department base 6 × 1,8) và tối đa **30 phút tự động** mỗi lượt (thời gian chờ quyết định không tính);
- thứ tự 12 lượt, xáo bằng seed cố định `20261027`.

Single = Planner cộng một agent viết code, test và tự review; không có Author hay Verifier độc lập, không subagent. Department = Verify với `qualityPolicyVersion: 4`. Cùng scaffold, SPEC, công cụ và hướng dẫn project.

## Thăm dò trước khi khóa (không thuộc 12 lượt)

Trước khi khóa, chạy thăm dò **chỉ phần lập kế hoạch** (Planner và Author lập kế hoạch ca) trên ba pack bằng model thật, khoảng 8 lượt gọi, tổng chi phí ước tính dưới 2 USD. Nó cho thấy hai điều đã đưa vào sản phẩm trước khi khóa:

1. Kế hoạch thật của model đặt điều khoản cho bước thiết lập ngoài căn cứ riêng của ca. Coi đó là blocker làm kế hoạch không bao giờ qua được, nên v4 chỉ chặn các lỗi chính sách nêu (căn cứ không hợp lệ, bước thiếu trước/sau hoặc điều khoản tồn tại, nhóm rủi ro không có ca hay lý do); điều khoản nằm ngoài căn cứ của ca là lưu ý.
2. Author đôi khi bỏ `method`/`required` ở vài ca và cả kế hoạch bị loại vì sai định dạng. Prompt kế hoạch v4 được thêm bước rà từng ca; hệ thống vẫn không điền thay.

Cũng thấy: Author đôi khi hỏi lại điều SPEC không quy định (couponstack: tràn số của subtotal) hoặc khẳng định sai là thiếu điều khoản; kế hoạch bị bỏ hoặc còn câu hỏi thì run dừng ở bước duyệt hợp đồng và được ghi như vậy, không chạy lại.

## Người điều phối

Những gì sản phẩm hỏi người (duyệt hợp đồng, duyệt đề xuất sửa test, xác nhận finding) được trả lời bởi **AI điều phối**, theo SPEC đã khóa và không theo grader, reference hay candidate khác:

- duyệt hợp đồng/kế hoạch khi nó nêu đúng SPEC; chỉ sửa **hình thức** khi cần (nhãn, lý do không áp dụng, liên kết bước), không thêm hay đổi kết quả mong đợi; mọi lần sửa được ghi;
- duyệt đề xuất sửa test chỉ khi điều khoản SPEC được trích làm assertion cũ sai và assertion mới đúng;
- xác nhận finding (bằng hash đề xuất regression, hoặc review thủ công có lý do khi không sinh được regression) chỉ khi oracle trích điều khoản SPEC và các giá trị mong đợi suy ra từ đó; finding về hành vi SPEC không quy định thì bác bỏ;
- **không** viết/sửa code hay test thay model, không thêm nghiệp vụ, không chạy lại lượt thất bại hay bị chặn; tối đa hai vòng sửa mỗi lượt.

Mỗi quyết định nằm trong `rows/*.json` (`interventions`) và trong báo cáo.

## Chạy

```bash
node node_modules/tsx/dist/cli.mjs scripts/eval-v4.mjs check
node node_modules/tsx/dist/cli.mjs scripts/eval-v4.mjs lock      # một lần, trước mọi lần gọi model
node node_modules/tsx/dist/cli.mjs scripts/eval-v4.mjs run       # chạy tiếp được; chờ file quyết định cho mỗi câu hỏi
node node_modules/tsx/dist/cli.mjs scripts/eval-v4.mjs report
```

Mỗi câu hỏi được ghi vào `benchmarks/eval/v4-check/decisions/<lượt>.<vòng>.request.json`; bộ chạy chờ `<lượt>.<vòng>.decision.json` cùng thư mục: `{"action":"approve"|"revise"|"stop"|"reject","note":"…"}`, hoặc với finding `{"findings":[{"action":"confirm"|"dispute"|"resolve"|"replay","id":"…","proposalHash":"…","reason":"…"}]}`.

## Chấm điểm và báo cáo

Mọi candidate có workspace đều được chấm bằng grader ẩn, kể cả lượt bị chặn; điểm gốc không đổi. Mọi thẩm định lỗi grader riêng được ghi trong `adjudications.json` và hiện ở báo cáo. Báo cáo (`report.md`, `report.json`) tách:

| Cột | Nghĩa |
|---|---|
| Đạt grader | grader ẩn đạt toàn bộ |
| Hoàn tất đủ bằng chứng | tới `awaiting_acceptance`, `completion.ready`, không suy giảm |
| Lỗi lọt khi báo sẵn sàng | hệ thống báo sẵn sàng nhưng grader fail |
| Finding tái hiện | số finding mà runner tái hiện được |
| Regression tạo | số test regression được áp dụng và khóa |
| Test Author sai | số chẩn đoán kết luận test sai (đề xuất sửa test) |
| Lượt can thiệp | số quyết định người điều phối |
| Thời gian, chi phí | tự động (không tính chờ quyết định) và USD theo số liệu run |

Giới hạn: n = 12; grader và quyết định do AI viết; Single không có finding/regression nên các cột đó chỉ có nghĩa với Department; chi phí có thể là ước tính.

## Kết quả lần chạy ban đầu (2026-10-26)

Đã chạy đủ 12/12 lượt theo protocol đã khóa (`acf1d974571b`), không chạy lại lượt nào. Số liệu đầy đủ: `benchmarks/eval/v4-check/report.md`, `report.json`, từng lượt trong `rows/`, quyết định trong `decisions/`.

| Nhánh | Đạt grader | Đủ bằng chứng | Lỗi lọt khi báo sẵn sàng | Finding tái hiện | Regression tạo | Test Author sai | Phút TB | Chi phí TB |
|---|---|---|---|---|---|---|---|---|
| Department v4 | 4/6 | 5/6 | 1 | 1 | 1 | 0 | 6.1 | $1.02 |
| Single | 6/6 | 6/6 | 0 | 0 | 0 | 0 | 2.7 | $0.90 |

Đọc kết quả (không dùng để kết luận Department hơn hay kém):

- `couponstack:department:2` bị chặn: Author trả manifest không đọc được và v4 không còn đường suy manifest từ tiêu đề, nên run dừng trước Developer (không thử lại). Đây là hành vi v4 đúng thiết kế, nhưng cũng là 1/6 lượt Department không tạo ra mã để chấm (0/33).
- `couponstack:department:1` là lượt duy nhất báo sẵn sàng mà grader fail (32/33: thiếu xử lý "cùng request, khác thứ tự khóa" ở idempotency). Verifier lại tìm được và chứng minh một lỗi thật khác (request `null` ném `TypeError` thay vì `INVALID_INPUT`): replay tái hiện, regression sinh tự động fail đúng bước, được xác nhận, áp dụng rồi pass sau khi sửa → finding đóng với `verified_fix`. Ca key-order không được phát hiện; một nghi ngờ không liên quan (làm tròn phần trăm) còn mở ở dạng cảnh báo chưa xác nhận.
- Single không có Verifier/finding/regression nên đạt grader cao hơn ở mẫu nhỏ này với thời gian và chi phí thấp hơn; với n = 12 khác biệt này không đủ kết luận.
- Task, grader, mutant và mọi quyết định duyệt do AI điều phối tạo ra theo SPEC đã khóa (ghi nhận là hỗ trợ của AI điều phối); chưa có người độc lập kiểm tra. Không có `adjudications.json`: không có lỗi grader nào bị tranh chấp.
- Một lần quan sát của điều phối (không sửa hợp đồng): ở `ticketflow:department:2`, R-2 không nhắc mặc định `priority = 'normal'` của SPEC; lượt vẫn đạt 29/29.
