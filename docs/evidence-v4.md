# Giữ chặt ý nghĩa của bằng chứng và biến lỗi tìm được thành regression — chính sách v4

Run Verify mới dùng `qualityPolicyVersion: 4`. Run cũ giữ chính sách đã lưu (v1–v3); đọc, resume hoặc chạy lại check không tự nâng phiên bản và không đổi hash hợp đồng. Chính sách v4 được chép vào run lúc tạo (`run.evidencePolicy`) nên biến môi trường như `AIDEPT_AUTO_TEST_REPAIR` không đổi được quyền của một run v4 đang tồn tại. Mọi điều kiện theo phiên bản nằm ở một chỗ: [src/core/policy.ts](../src/core/policy.ts).

Nguyên tắc: hệ thống không biến **thiếu** bằng chứng thành **đã** kiểm chứng. Lỗi định dạng thì tự xử lý; mọi thay đổi về assertion, kỳ vọng hay nghiệp vụ chưa rõ phải có người đọc và duyệt.

## 1. Kế hoạch ca, Author và manifest

| Việc | v3 (cũ) | v4 |
|---|---|---|
| Spelling/enum alias, đường dẫn, khoảng trắng và dấu câu của trích dẫn | chuẩn hóa | chuẩn hóa (không đổi nghĩa) |
| Trích dẫn sai | thay bằng toàn văn điều khoản | **giữ nguyên, báo lỗi chặn duyệt** |
| Ca `high` mà `required=false`; dòng "không áp dụng" mâu thuẫn với nhóm đã có ca | sửa giúp | **giữ nguyên, validator nêu mâu thuẫn** |
| Câu hỏi chưa trả lời | thành giả định | **vẫn là câu hỏi, chặn duyệt** |
| Author không trả kế hoạch đọc được / lượt lập kế hoạch bị gián đoạn | hệ thống lập kế hoạch tối thiểu | chỉ dựng **bản nháp có nhãn `[NHÁP]`**; nhãn làm kế hoạch không hợp lệ cho tới khi người dùng viết lại căn cứ, bước và kết quả |
| Căn cứ (oracle) hợp lệ; mỗi bước có trạng thái trước/sau và ít nhất một điều khoản tồn tại | một phần là lưu ý | **chặn duyệt** |
| Điều khoản của bước nằm ngoài căn cứ của chính ca; ca state/concurrency/consistency bắt buộc chỉ có một bước hoặc thiếu bất biến; nhóm vừa có ca vừa khai không áp dụng | lưu ý | lưu ý (hiện lúc duyệt và trong báo cáo, không chặn) |
| Mỗi nhóm rủi ro có ca hoặc lý do không áp dụng | lưu ý | **chặn duyệt** |
| Manifest suy từ tên test khi Author hỏng | được chấp nhận kèm cảnh báo | **không bao giờ là bằng chứng đầy đủ** (chặn) |
| Bước bắt buộc không có assertion gắn vào | cảnh báo | **chặn** |

Draft không hợp lệ vẫn được lưu để sửa và kiểm tra lại: output thô, `Test plan validation error`, `Author output draft` và patch đều nằm trong run. Giới hạn sửa định dạng (một lượt Author cho kế hoạch, một lượt cho manifest) và marker lưu trước lượt AI giữ nguyên: restart hay resume không cấp thêm lượt.

## 2. Chẩn đoán và sửa test

- `normalizeDiagnosis` chỉ đưa **tên test** về định danh của report runner. Nó không đổi `target`, kết luận test đúng/sai, `caseIds`, vị trí hay trích dẫn.
- Chẩn đoán mâu thuẫn (sau một lượt sửa), không đủ căn cứ (`ambiguous`), bị gián đoạn hoặc đề xuất bị loại → **run dừng** với lý do và bước người dùng làm tiếp (sửa hợp đồng/kế hoạch ca để Author làm lại, hoặc chuyển chế độ). Developer **không** được gọi để đoán nguyên nhân.
- **Không tự duyệt** bản sửa test. Dùng lại `Test repair proposal`, hash và màn hình đọc diff.
- Sửa **setup** (`test_setup`) phải giữ nguyên mọi assertion, tên và số lượng test (so bằng cú pháp). Sửa **assertion** phải khai báo `before → after` và trích điều khoản; tập assertion sau sửa phải bằng đúng tập cũ trừ các `before` cộng các `after`; setup, thao tác, tên test không đổi. Bất kỳ thay đổi ngoài đề xuất đều bị loại (xem `setupRepairProblems`, `assertionCorrectionProblems` trong [src/core/authoring.ts](../src/core/authoring.ts)).
- Sau khi duyệt: áp dụng đúng patch, tạo checkpoint, khóa lại test và manifest rồi chạy lại bằng chứng. Nếu assertion không còn khớp bước đã duyệt thì dừng; **không** quay về liên kết theo tên.

## 3. Nghiệm thu

Báo cáo và trang Nghiệm thu phân biệt bốn mức:

1. **Test chạy đạt** (check xanh).
2. **Bước có assertion** (manifest + đối chiếu AST).
3. **Sai khác được tái hiện** (runner chạy cùng kịch bản trên bản sao đúng checkpoint).
4. **Finding đã được chứng minh sửa xong**: cùng kịch bản (và test regression, nếu stack hỗ trợ) thất bại trước khi sửa và đạt sau khi sửa, đúng phiên bản.

Chặn nghiệm thu (tick cảnh báo không vượt được): thiếu bằng chứng bắt buộc; thiếu verdict Verifier hợp lệ cho **đúng checkpoint hiện tại** (thiếu, bị bỏ qua, không đọc được, `abstain`); finding blocker/major chưa xử lý — kể cả finding không có phản ví dụ chạy được, **không** còn được hạ xuống cảnh báo sau một vòng sửa; finding đã đóng nhưng phản ví dụ vẫn tái hiện; test regression đã bị sửa. Vẫn là cảnh báo: mutation chưa hỗ trợ, ca bổ sung chưa chạy, giới hạn ngoài phạm vi bắt buộc. Điều kiện giao kết quả thành công và bảo vệ workspace giữ nguyên.

## 4. Phản ví dụ → regression

```
Verifier (một lượt review có sẵn)       trả kịch bản `reproduction` (public API Node ESM) hoặc `reproductionLimitation`
   ↓
Replay (node-api, bản sao đúng checkpoint) 3 probe / 60 s mỗi lượt, 30 s mỗi probe, không tự retry
   ↓ reproduced
Sinh test bằng code (không AI)           Vitest, `tests/aidept-regressions/<module>-<findingId>.test.js` (`.test.ts` có kiểu cho project TS)
   ↓
Thử một lần trên bản sao riêng           clone tạm của đúng checkpoint (không đụng candidate), xóa khi xong, hủy hoặc restart;
                                         phải THẤT BẠI đúng assertion của bước replay thấy khác (`AIDEPT-REG:<bước>`)
                                         và mọi check bắt buộc không có report đang đạt (typecheck, lint…) vẫn đạt khi có test
   ↓ failed_as_expected
Trang task: căn cứ + kết quả replay + diff test + kết quả thử   → người dùng đọc và xác nhận bằng hash
   ↓ biên nhận (finding, scenario, checkpoint, hợp đồng, cấu hình, hash test)
Sửa: áp dụng test, commit, KHÓA, ghi manifest regression → rồi mới gọi Developer
   ↓
Checks + ca Author + regression + mutation + Verifier   → replay lại cùng kịch bản
   ↓ before reproduced ∧ after not_reproduced ∧ regression failed→passed
resolved (`resolution.kind = verified_fix`)
```

- Test thử không đạt (`passed_unexpectedly`, `wrong_failure`, `discovery_error`, `breaks_checks`, `error`, `timeout`, `interrupted`) **không** được xác nhận bằng hash. Lỗi import/nhận file/timeout/công cụ không bị đếm là sai khác hành vi. `breaks_checks`: test thất bại đúng chỗ nhưng làm hỏng một check bắt buộc khác; không đề xuất, vì file sẽ bị khóa và không ai được sửa nó để chữa build.
- Bản sao thử: Git clone của checkpoint cộng patch test. Local: thư mục `node_modules` riêng, mỗi mục đã cài là một liên kết tới candidate (cache công cụ như `.vite` không được liên kết), nên file công cụ ghi thêm vào `node_modules` nằm trong bản sao; một test ghi vào bên trong một package đã cài vẫn chạm bản dùng chung. Docker: `node_modules` gắn chỉ đọc.
- Test TypeScript: helper có khai báo kiểu, chỉ sinh helper kịch bản dùng tới (để `noUnusedLocals` không báo), và import module bằng đuôi `.js` (tsc chấp nhận, Vite ánh xạ về `.ts`).
- Chỉ hỗ trợ project JS/TS có đúng một check Vitest có report JSON (`vitest run`). Nhiều check Vitest → chọn một ở **Check Vitest cho regression**. Thư mục khác mặc định → **Thư mục test regression**; Vitest của project phải nhận thư mục đó. Stack chưa hỗ trợ **không** được báo là đã tạo regression: finding đi theo review thủ công với giới hạn ghi rõ trong đề xuất và báo cáo.
- Biên nhận mất hiệu lực khi đổi checkpoint, hợp đồng, cấu hình project, scenario hoặc test (hash). Ngoại lệ duy nhất là chính giao dịch sửa: manifest regression ghi checkpoint lúc xác nhận (`appliedFrom`) và commit chỉ thêm đúng test đó (`appliedCheckpoint`); dừng giữa commit này và lượt Developer thì resume vẫn dùng được biên nhận, miễn là run đang ở đúng commit đó và file test còn nguyên. Commit nào khác sau đó vẫn làm biên nhận hết hiệu lực. **Chạy lại phản ví dụ** (`POST /api/runs/:id/findings/:fid/replay`) dùng hàng đợi và khóa của run, không gọi AI, tạo đề xuất mới nên cần xác nhận lại.
- Test regression tự chứa: chỉ cần Vitest của project, không phụ thuộc database hay đường dẫn máy của AI Department. File có dòng đầu `// aidept-regression {…}` kèm hash của phần còn lại.
- Chống tái phát: file nằm trong checkpoint bàn giao và danh sách test bị khóa (thiếu, skip, đổi tên, không có trong report → chặn). Run sau quét thư mục regression của project, khóa các file đó khỏi mọi agent và đưa ID của chúng vào danh sách phải chạy đạt. File bị sửa so với hash trong chính nó là blocker. File còn nguyên chưa đủ: mỗi regression (file trong project và mục trong manifest của run) phải có kết quả **đạt** trên đúng checkpoint và cấu hình hiện tại. Regression ghi cho một check đã đổi tên hoặc bị xóa được chạy bằng check Vitest regression hiện tại, và lý do chặn ghi rõ ánh xạ đó; không có check nào chạy được thì chặn kèm tên check cũ. Đổi hoặc xóa regression chưa có đường duyệt-diff tự động: sửa trực tiếp trong project rồi chạy lại. **Chạy lại check** chạy cả regression, không gọi AI.

## 5. API

| Thay đổi | Ghi chú |
|---|---|
| `POST /api/runs/:id/findings/:fid/confirm` `{proposalHash}` hoặc `{manualReason}` | v4: bắt buộc hash của đề xuất hiện tại; không có regression dùng được thì bắt buộc `manualReason` (≥ 10 ký tự). 400 payload sai, 409 hash/trạng thái cũ |
| `POST …/findings/:fid/resolve` `{reason}` | v4: bắt buộc lý do (≥ 10 ký tự); ghi `resolution.kind = manual_review`, không bao giờ hiện là "đã sửa" |
| `POST …/findings/:fid/replay` `{proposalHash?}` | chạy lại phản ví dụ, không AI |
| `POST …/repair` | 409 nếu xác nhận không còn khớp đề xuất hiện tại |
| `RunDetail.regressionProposals`, `.findingProofs`, `.regressionFiles` và cùng các trường trong báo cáo | |
| `PATCH /api/projects/:id` `regressionDir`, `regressionRecipe` | |

Run cũ (v1–v3) giữ nguyên hành vi một cú nhấp của `confirm`/`resolve`.

## 6. Xác nhận

```powershell
pnpm build
pnpm test:reliability
```

Nhóm test mới (agent là fixture; Git, Vitest và replay chạy thật; không dùng quota model): `policy-v4.test.ts` (chính sách, kế hoạch, chẩn đoán, verdict), `regression-loop.test.ts` (PulseGraph từ phản ví dụ đến bằng chứng sửa), `regression-edges.test.ts` (sửa không xong, xác nhận hết hiệu lực, review thủ công, bảo vệ qua các run), `regression-hardening.test.ts` (regression mất check vẫn chặn, resume sau khi khóa regression, thử trên bản sao riêng, JUnit có thuộc tính file, test TypeScript qua typecheck strict, bước tiếp theo sau khi xác nhận là sửa chứ không phải đóng tay), `regression-ui.test.ts`. Fixture trình duyệt: `pnpm exec tsx tests/fixtures/regression-ui.ts`. Các fixture v3 cũ được ghim phiên bản (`setupV3`, `pinV3`) để giữ kiểm tra tương thích.

Giới hạn còn lại: regression chỉ có cho project JS/TS + Vitest và API phù hợp adapter `node-api`; chưa có sinh chuỗi ngẫu nhiên, điều khiển concurrency, fault injection, vòng sửa theo mutation hay phân tích ảnh hưởng toàn repo. Một lượt benchmark ngắn trên model thật (xem `docs/evaluation-v4-benchmark.md`) chỉ là kiểm tra ban đầu, chưa đủ kết luận ưu thế tổng quát.
