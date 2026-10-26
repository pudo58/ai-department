# Cải tiến luồng Author và xác nhận CartStock

Đã bổ sung manifest do server tạo từ khai báo case/bước ngay trong test, cùng một lượt sửa draft có giới hạn. **Build đạt; 456/456 regression đạt trong 122 file.** Lượt thật mới [run_3973832e](http://127.0.0.1:14343/#/run/run_3973832e) đã **completed**, delivery **succeeded**. Các lượt thất bại trước được giữ nguyên.

## Thay đổi

- JS/TS + reporter JSON dùng source bindingProtocol=2: Author khai báo @aidept-case trước test, @aidept-step trước mỗi assertion, hoặc @aidept-bind cho assertion helper. Server đọc tên test/describe, biểu thức và dòng từ AST, lấy expected từ đúng bước/hợp đồng. Không đoán liên kết theo tag tên test, không coi comment là assertion.
- Giao thức bindingProtocol=1 vẫn cho phép tham chiếu expected bằng case/bước/hash hiện tại; expected sai được gửi tường minh vẫn bị từ chối. Dữ liệu cũ và manifest lưu trữ giữ schema/hash cũ.
- Draft sai được giữ raw output/patch trước hoàn nguyên. Có tối đa một lượt sửa trong ngân sách implement hiện tại; marker lưu trước gọi AI. Resume/restart/đổi cấu hình không cấp lại lượt cho cùng phiên bản hợp đồng.
- Lượt sửa chỉ chỉnh metadata và thêm assertion quan sát thiếu; giữ test identity/recipe/liên kết yêu cầu, phần setup/thao tác và assertion cũ. Mọi gate scope, manifest, ca/bước bắt buộc và AST chạy lại trước khóa.
- UI phân biệt sửa draft có AI với kiểm tra lại output đã lưu không gọi AI, khóa action khi busy và báo rõ khi đã hết lượt sửa.

## Xác nhận bằng fixture

9 test mới bao phủ legacy/hash, expected sai, tham chiếu sai phiên bản/bước, nguồn source binding tĩnh, tên chứa delimiter, helper dùng chung, thiếu annotation, đổi assertion/setup/skip, source binding đạt ngay hoặc sửa một lượt, output vẫn sai, provider gián đoạn và resume qua orchestrator mới. Git/Vitest chạy thật trên thư mục tạm; agent fixture không dùng quota model. Fixture thành công đi tới Verifier và chờ nghiệm thu. Test UI kiểm tra action thật và busy/used state.

Trong quá trình phát triển, regression đã bắt việc phục hồi draft áp patch hai lần. Mã đã sửa để áp đúng một lần; giữ kết quả thất bại tại reliability-before-recovery-fix.json và chạy lại suite sau sửa. Kết quả cuối: **456 passed, 0 failed, 0 skipped**. Các gate delivery, cleanup, checkpoint/verdict và evidence vẫn đạt.

Lệnh thực tế:

```powershell
node node_modules/typescript/bin/tsc --noEmit
node node_modules/vite/bin/vite.js build
node scripts/test-reliability.mjs
```

Wrapper pnpm đã cố chuẩn bị dependency rồi bị policy ignored-build của esbuild chặn; dùng công cụ đã cài trực tiếp như trên. package.json và pnpm-lock.yaml được đối chiếu hash với snapshot trước sửa và không đổi. Không điều chỉnh chính sách build để né lỗi.

## Lượt model thật

| Chỉ số | Kết quả |
|---|---|
| Model cho mọi vai | GPT-6 Luna medium |
| Thời gian tự động | 361.8 giây |
| Chờ soát/duyệt | 132.0 giây |
| Lượt vai | Planner 1; Author 3 (kế hoạch, sửa kế hoạch, viết test); Developer 1; Verifier 1 |
| Sửa manifest Author | 0 — đạt ngay lượt viết test đầu |
| Test đã khóa | 12 ca; 89 assertion được đối chiếu AST |
| Runner ứng viên | 13 passed, 0 failed, 0 skipped |
| Grader ngoài đã khóa trước model | 64/64, gồm 8 chuỗi 80 thao tác có seed |
| Mutation thật | baseline passed, completed trong 58.3 giây; 277 killed, 126 survived, 47 no coverage, 0 timeout, 0 error |
| Chi phí ước tính | $1.0269 / trần $10.8 |
| Giao kết quả | Branch aidept/run_3973832e-A, đúng checkpoint eacf41d2914b409fd76652087d02ff1967734e72 |

Mình đã soát/sửa hợp đồng một lần, duyệt hợp đồng và nghiệm thu qua API có receipt. Các sửa hợp đồng gồm liên kết oracle, phân loại nhóm không áp dụng, làm rõ input độc lập và giữ snapshot sạch trước bài thử mutate. **Không sửa source, test hoặc manifest ứng viên bằng tay, không đưa kết quả grader ngoài cho agent.** Đây là hoàn thành có bước duyệt của người vận hành, không phải tự chủ hoàn toàn.

Verifier pass với 0 finding, nhưng ghi rõ chưa tự chạy test thêm; chỉ review code và tham chiếu check hiện tại. Đã xác nhận cảnh báo đó và mutation còn yếu khi nghiệm thu bản benchmark. Check/evidence bắt buộc vẫn đạt; không tick vượt blocker.

## Giới hạn và bằng chứng

Không suy nhanh hơn hay ít lỗi hơn từ một lượt đạt. Mutation còn 126 sống sót và 47 không phủ; kết quả 64/64 không chứng minh mọi hành vi đúng. Chưa có finding mới để thử replay trong lượt này; fixture replay vẫn nằm trong regression. Chưa chạy GitHub CI trong đợt này.

- results.json: số đo, giới hạn và toàn bộ nhóm kết quả.
- reliability-results.json, reliability-junit.xml: regression cuối.
- ../2026-10-25-cartstock-source-bindings/: contract-review/receipt, raw detail, snapshot sản phẩm, candidate, grader và báo cáo nghiệm thu.
- ../2026-10-25-cartstock-v3/: lượt gốc bị chặn, không chỉnh kết quả cũ.
- ../2026-10-25-cartstock-v3-assisted/: một lần sửa draft bằng giao thức JSON trung gian vẫn bị từ chối vì model trả entries rỗng và thay test ngoài phạm vi; không reset marker. Lượt xác nhận source binding là run mới, không gán thành thành công của run cũ.

UI đang được phục vụ trên port 14343 với mã mới. Không commit/push; giữ các thay đổi chưa commit có sẵn.
