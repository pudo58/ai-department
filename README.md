# AI Department v4.3

Harness làm nền, **Single là mặc định**, Team (Clarify / Verify / Compare) dùng có chọn lọc. Chạy local, server chỉ bind loopback.

```bash
npm run build && npm start     # http://127.0.0.1:4310
npm run dev                    # server + Vite (127.0.0.1:5173)
npm test                       # vitest
pnpm test:reliability           # regression có fixture, không gọi model thật
npm run eval -- <lệnh>         # bộ đo M0 (xem bên dưới)
```

Verify mới dùng chính sách v4: không biến thiếu bằng chứng thành "đã kiểm chứng", và finding được xác nhận đi hết vòng phản ví dụ → regression → sửa → bằng chứng trước/sau. Xem [chính sách v4](docs/evidence-v4.md); nền tảng v3 (căn cứ từng bước, liên kết assertion, chẩn đoán có cấu trúc, phản ví dụ) ở [docs/quality-v3.md](docs/quality-v3.md). Run cũ giữ nguyên phiên bản đã lưu.

## Đóng gói và phát hành lên npm

Chạy từ thư mục gốc của repository:

```bash
npm run package
npm publish ./release/ai-department --dry-run
npm login
npm publish ./release/ai-department
```

Giữ tiền tố `./`: `npm publish release/ai-department` được npm hiểu là repository GitHub `release/ai-department`, có thể gây lỗi SSH `Permission denied (publickey)`. Thư mục gốc là package private dùng phát triển; package để phát hành nằm trong `release/ai-department`. `--dry-run` chỉ kiểm tra gói, chưa đăng lên registry.

## Cấu trúc mã

- `src/core/`: luật thuần (hợp đồng, ngân sách, check, phát hiện stack, báo cáo), không đụng đĩa hay mạng.
- `src/runtime/`: chạy agent và check (Local, Docker, Fake), workspace git, cài công cụ build (`toolchain.ts`, `pythonenv.ts`).
- `src/server/orchestrator.ts`: mặt công khai của một run (tạo, chạy, dừng, duyệt, nghiệm thu) và vòng điều khiển qua các giai đoạn. Việc của từng giai đoạn nằm ở `src/server/run/`: `services.ts` (store, runtime, đồng hồ, một lượt agent), `planning.ts`, `candidates.ts` (vòng Developer, test do Author viết), `checks.ts`, `verification.ts`, `scope.ts` (được sửa gì), `outcome.ts` (trạng thái và read model), `acceptance.ts`, `timers.ts`.
- `src/server/app.ts`: bảo vệ loopback (Host, Origin, CSRF) và nối các nhóm route trong `src/server/routes/` (`providers`, `projects`, `memory`, `runs`, `previews`, `system`, `monitor`); `routes/schemas.ts` giữ các schema body.
- `src/client/`: giao diện React; mỗi trang lớn tách phần thân (`RunPage`, `MonitorHub`, `Monitor`) khỏi các panel của nó (`RunPanels`, `MonitorPanels`, `MonitorCharts`).

## Trạng thái triển khai

| Phần | Trạng thái |
|---|---|
| Snapshot, scope 3 tầng, retry/flaky/quarantine, ma trận yêu cầu–bằng chứng, hợp đồng có phiên bản | Xong, có test |
| Ngân sách 20/40/10/30, trần Team 3×, escalation có điều kiện | Xong, có test |
| Single, Clarify, Verify (Author khóa test + Verifier), Compare (hai candidate, chọn theo chỉ số khách quan) | Xong, test với FakeRuntime có kịch bản |
| Red/green cho bugfix và refactor | Xong, có test |
| Finding gate D1–D5, bác bỏ/xác nhận, vòng sửa 30% | Xong, có test |
| Thời gian người dùng (bộ đếm + nhập tay), metrics theo chế độ khởi đầu | Xong |
| Bảo vệ API: Host/Origin/CSRF, header an toàn | Xong, có test |
| Bộ đo M0a/M0b: đăng ký manifest, ITT, bootstrap theo strata, cỡ mẫu paired | Xong, có test |
| LocalRuntime (Codex chạy thẳng trên máy bạn, bản sao làm việc trong .data/workspaces) | **Đã chạy với Codex 0.163.0 thật**: task bugfix pass end-to-end, branch được giao về repo gốc. Không có cô lập container |
| DockerRuntime (agent + check trong container) | Chạy được với agent giả; **Codex thật không chạy lệnh được trong container khóa** (bwrap bị chặn), xem mục Docker |
| Hướng dẫn theo project (`guidance`) đưa vào prompt Planner/Developer/Repair/Author/Verifier | Xong, có test (cần Codex thật để thấy tác dụng lên chất lượng code) |
| Phát hiện stack chỉ-đọc, gợi ý guidance và check khi tạo/sửa project | Xong, có test; Node/JS/TS, Java/Kotlin (Maven, Gradle), Python (pytest), Go, Rust |
| Nhiều check mỗi project (UI thêm/sửa/xóa), check không có report (typecheck, lint, build) | Xong, có test, đã chạy với tiến trình thật qua LocalRuntime |
| Ngữ cảnh project: bản đồ repo, bộ nhớ đã duyệt, ngân sách token theo vai, xem trước | Xong, có test; **tắt mặc định**, chưa đo được lợi ích với Codex thật. Agent chưa tự đề xuất bộ nhớ (bước 3, chờ số đo) |
| Công cụ phân tích knip/jscpd/dependency-cruiser | Chưa nối: báo "chưa phân tích" |
| Feature mới (phase base+stub) | Chưa tự động; chỉ bugfix/refactor có red/green |
| Khóa theo test id (`missingTestIds`) | Đã nối manifest và report; thiếu/skip/đổi tên test đã khóa không đạt |
| Chạy Reviewer thật cho M0a | `runM0a` nhận `Reviewer` bất kỳ; chưa có adapter CLI |

Run **mô phỏng** (FakeProvider) chỉ kiểm tra workflow. Mọi check của nó là `incomplete` nên không bao giờ nghiệm thu được.

## Theo dõi khi có nhiều task

Tab **Trực tiếp** ưu tiên danh sách: có việc chạy thì mở **Đang chạy**, nhàn rỗi thì mở **Chờ bạn**. Việc chờ được chia thành nghiệm thu, duyệt hợp đồng/project và cần xử lý; mỗi nhóm hiện 5 việc, bấm **Xem thêm** để mở tiếp. Tìm kiếm và lọc project áp dụng cả số đếm lẫn danh sách. Bộ lọc và task đang chọn được giữ khi chuyển trang.

Chọn một task để xem lượt gọi AI hoặc log riêng ở khung bên cạnh. Lịch sử **Gần đây** gom 80 lượt gọi toàn hệ thống theo task; khi chọn, hệ thống tải riêng 40 lượt gần nhất của task đó, kể cả task không còn trong 80 lượt chung. **Sơ đồ hoạt động** luôn hiện phía trên danh sách, chỉ vẽ task có trạng thái đang chạy; task xếp hàng, chờ bạn, lỗi và đã xong không xuất hiện trên sơ đồ. Khi nhàn rỗi vẫn hiện hub/dịch vụ, không có node task. Trên màn hình hẹp, chi tiết nằm dưới danh sách.

## Báo cáo nghiệm thu và test đang chạy

Khi task tới bước nghiệm thu, trang task mở tab **Nghiệm thu** với một báo cáo đầy đủ để bạn đọc rồi mới quyết định: yêu cầu gốc, từng yêu cầu và các test chứng minh nó, file đã đổi so với bản gốc (+/−, diff đầy đủ), kết quả chạy test (pass/fail/bỏ qua, tên các test bị bỏ qua), kết luận và lời của Verifier độc lập, chi phí và công sức, và lệnh git để xem/merge branch. Báo cáo có thể tải về dạng Markdown (\`GET /api/runs/:id/report.md\`).

Mọi điều hệ thống **không chứng minh được** hiện thành cảnh báo: test bị bỏ qua, Verifier từ chối kết luận hoặc chưa chạy, tiêu chí thủ công, check flaky/quarantine. Nếu có cảnh báo, nút Nghiệm thu chỉ mở sau khi bạn tick xác nhận đã đọc (server cũng chặn nếu thiếu \`acknowledgeWarnings\`). Báo cáo bạn đã xem được lưu cùng task (artifact "Báo cáo nghiệm thu"). Số test pass/fail/bỏ qua chỉ có với check chạy sau khi tính năng này có; check cũ hiện "—" cho tới khi **Chạy lại check**.

Task chỉ chuyển sang **Hoàn thành** sau khi giao kết quả thành công. Run lưu bản ghi `delivery` gồm trạng thái, checkpoint, phiên bản hợp đồng, slot, thời gian, kết quả và lỗi đã che thông tin nhạy cảm. Nếu giao lỗi, task vẫn chờ nghiệm thu, hiện **Chưa giao được kết quả** và nút **Thử giao lại**. Nút này dùng lại `POST /api/runs/:id/accept`; khi bằng chứng còn hợp lệ, hệ thống chỉ thử giao lại, không gọi agent hoặc chạy lại check. Lỗi trả HTTP 409; giao diện tải lại trạng thái đã lưu. Thời điểm nghiệm thu và cửa sổ theo dõi bảy ngày bắt đầu sau lần giao thành công.

Trong lúc giao, hệ thống chặn nghiệm thu đồng thời, sửa task, chạy lại và xóa. Khi server khởi động lại, lượt giao dở chuyển thành `unknown`; workspace được giữ để thử lại. Task cũ đã nghiệm thu nhưng thiếu bằng chứng giao vẫn giữ lịch sử và hiện **Chưa xác nhận giao**. Cleanup từ chối xóa workspace nếu giao thất bại, gián đoạn, chưa rõ hoặc bằng chứng giao không khớp bản hiện tại, kể cả đã quá bảy ngày.

Kết luận Verifier chỉ áp dụng khi artifact còn hiệu lực và khớp cả checkpoint lẫn phiên bản hợp đồng. Khôi phục từ log thô cũng phải khớp attempt Verifier đã hoàn tất và cùng phiên bản. Nếu thiếu kết luận phù hợp, báo cáo hiện **Bản code này chưa có kết luận Verifier**; bạn vẫn có thể xác nhận cảnh báo để nghiệm thu khi các điều kiện tự động khác đạt.

Trong lúc check chạy, đầu trang task hiện khung **Chương trình test đang chạy**: lệnh đang chạy, thời gian, bộ đếm pass/fail/bỏ qua cập nhật theo từng test và console của chính test đó. Bộ đếm đọc output dạng spec/TAP của \`node --test\` và dấu tick của Jest/Vitest; nó chỉ là chỉ báo trực tiếp, kết quả chính thức là report đọc khi test chạy xong.

## Kiểm thử sâu cho Verify

Run Verify mới bật `qualityPolicyVersion: 1`. Luồng chạy là Planner → Author lập kế hoạch ca chỉ đọc → người dùng duyệt → Author viết và khóa test → Developer → checks → mutation → Verifier → nghiệm thu. Lượt Author bổ sung tính vào ngân sách prepare hiện có; hệ thống không tự tăng trần.

Trong tab **Hợp đồng**, đọc các ca `C-x` gắn với yêu cầu `R-x`: rủi ro, điều kiện ban đầu, thao tác, kết quả quan sát được, bắt buộc/bổ sung và tự động/thủ công. Với kế hoạch mới, ca bắt buộc về trạng thái, đồng thời hoặc nhất quán phải ghi ít nhất hai bước có thứ tự, kết quả sau từng bước và bất biến phải giữ sau mỗi bước. Điều này giúp lộ lỗi chỉ xuất hiện sau retry, reopen, thao tác đồng thời hoặc trạng thái trung gian; test phải kiểm tra từng bước, không chỉ kết quả cuối. Author phải xét ca thuận, dữ liệu sai/biên, quyền, lặp/đồng thời, lỗi phụ thuộc, chuyển trạng thái và nhất quán dữ liệu; nhóm không áp dụng phải có lý do. Máy chủ tự chuẩn hoá lỗi chính tả của output Author trước khi kiểm tra (`priority: "critical"` → `high`, tên nhóm gần đúng, câu hỏi dạng object, trích dẫn lệch khoảng trắng/dấu so với điều khoản, dòng "không áp dụng" mâu thuẫn với nhóm đã có ca); mọi thay đổi được ghi ở **Soát kế hoạch ca** và không đụng tới kết quả mong đợi, bước hay liên kết yêu cầu. Lỗi chặn duyệt chỉ còn là lỗi thật: câu hỏi chưa giải quyết, yêu cầu bắt buộc không có ca tự động, liên kết tới thứ không tồn tại, ca trạng thái thiếu chuỗi bước, mã ca/bước trùng. Lỗi hình thức (thiếu trạng thái trước/sau, nhóm chưa nhắc tới, thiếu bất biến, trích dẫn không nằm trong điều khoản) thành cảnh báo trong hợp đồng: bạn phải tick xác nhận đã đọc mới duyệt được, và chúng hiện lại ở báo cáo nghiệm thu. Bước đã duyệt mà test chưa có assertion gắn vào, hoặc assertion thừa chưa gắn bước, cũng là cảnh báo sau lượt sửa manifest duy nhất, không còn làm run dừng; `expected` chép trong manifest luôn được thay bằng văn bản của bước đã duyệt. Verify không dừng giữa chừng vì lỗi mà người dùng không tự sửa được: kế hoạch ca thiếu hoặc hỏng được hoàn thiện từ chính hợp đồng (mỗi yêu cầu bắt buộc một ca, id bước/ca trùng được đánh lại, căn cứ thiếu lấy nguyên văn điều khoản), câu hỏi chưa trả lời thành giả định để bạn xác nhận, manifest Author vẫn sai sau một lượt sửa thì suy ra ca của từng test từ tên test, chẩn đoán test không dùng được thì giữ nguyên bộ test đã khóa và Developer tiếp tục sửa code. Mọi bước tự xử lý như vậy hiện trong báo cáo nghiệm thu ("Tự xử lý ở bước …"). Finding của Verifier mà không có phản ví dụ chạy được được Developer sửa một vòng rồi thành cảnh báo ("Verifier còn nghi ngờ…") thay vì chặn; chẩn đoán "test sai" được chuẩn hoá từ diff và report của runner thay vì bị loại vì trường dư thừa; tối đa 3 bản sửa test hợp lệ được tự áp dụng mỗi run. Chỉ còn dừng khi hết ngân sách, môi trường không chạy được, hoặc test vẫn không đạt sau các vòng sửa. Sửa ca làm đổi hash, tăng phiên bản và đặt lại xác nhận. Kế hoạch đã duyệt trước khi có cấu trúc chuỗi giữ nguyên hiệu lực. Nếu Author trả output sai hoặc không tạo được test bắt buộc, task dừng; dùng **Sửa hợp đồng** để chỉnh kế hoạch trước khi thử lượt mới. Resume không tự lặp gọi Author cho cùng lỗi manifest.

Author trả manifest trước Developer, ví dụ:

```json
{"entries":[{"caseId":"C-1","requirementIds":["R-1"],"recipeId":"test","path":"tests/order.test.ts","identity":{"kind":"json","file":"tests/order.test.ts","titles":["Đơn hàng","[R-1][C-1] tạo một đơn"]}}]}
```

Verify mới dùng `qualityPolicyVersion: 2`, kế hoạch và manifest `schemaVersion: 2`. Mỗi ca có `oracle: { references: [{ requirementId, quote }], explanation }`: trích nguyên văn điều khoản thuộc ca, giải thích căn cứ của expected, các bước và bất biến. UI cho xem/sửa căn cứ; sửa làm đổi hash và mất hiệu lực duyệt. Trích dẫn tồn tại không chứng minh assertion đúng về ngữ nghĩa; thiếu quy định phải giải quyết câu hỏi trong hợp đồng trước khi duyệt.

Server tính `testId` từ danh tính có cấu trúc. JSON giữ đường dẫn tương đối và từng phần `ancestorTitles`/`title` trong `titles`; JUnit dùng `identity: { kind: "junit", className: "Orders", name: "test_R_1_C_1" }`. Không tự ghép tên bằng dấu `>` hoặc dấu cách. Tên test gắn `R-x`, `C-x`; Java/Python/Go có thể dùng `R_1`, `C_1`. Test tham số hóa kê khai từng tên cụ thể, ổn định. Mỗi recipe có namespace riêng. Manifest cũ chỉ khớp qua tên suy ra từ report và ánh xạ duy nhất. Manifest và file test bị khóa; test khác cùng `R-x` không thay được ca thiếu.

Ca tự động bắt buộc thiếu, skip, fail, flaky, quarantine, report lỗi hoặc bằng chứng sai checkpoint/slot/phiên bản/cấu hình đều chặn nghiệm thu. Ca bổ sung chưa đạt, ca thủ công và giới hạn mutation hiện thành cảnh báo. Tick cảnh báo không vượt qua blocker. Bằng chứng chỉ lấy kết quả mới nhất mỗi recipe. Báo cáo **Các ca đã khai báo đạt** không khẳng định đã kiểm tra mọi tình huống nghiệp vụ.

Run cũ giữ nguyên hợp đồng, hash và chính sách; không tự thêm kế hoạch hay gọi thêm AI khi đọc/resume. Single/Clarify/Compare chưa có bước lập ca độc lập; hệ thống vẫn khóa định danh test đã quan sát tại checkpoint và phát hiện test mất khỏi lần chạy sau.

### Phục hồi khi test hoặc bằng chứng chưa đạt

Test chạy và fail được phân biệt với test bị skip hoặc không xuất hiện trong report. Lỗi assertion đi vào vòng sửa Developer có giới hạn; test thiếu/skip vẫn chặn nghiệm thu. Khi checks đã xanh nhưng thiếu bằng chứng cho yêu cầu bắt buộc, hệ thống cho một lượt bổ sung test có assertion và liên kết yêu cầu, sau đó chạy lại. Những test đã quan sát vẫn giữ định danh để phát hiện việc bỏ test.

Với Verify có kế hoạch ca, Author được tối đa một lượt chẩn đoán cho mỗi cặp phiên bản hợp đồng và manifest. Chỉ assertion thực sự chạy và thất bại mới vào luồng này; `CheckResult.issues` phân biệt lỗi assertion, report, collection, môi trường, checkpoint và định danh thiếu/skip/trùng. Lỗi bằng chứng không tự gọi Developer sửa source.

Nếu có căn cứ setup hoặc assertion trái hợp đồng, Author chỉ tạo đề xuất: mọi thay đổi được hoàn nguyên, diff và lý do hiện trên trang task để người dùng đọc và duyệt. Bản sửa assertion phải ghi kỳ vọng trước/sau và trích điều khoản hợp đồng. Hợp đồng mơ hồ thì dừng để làm rõ. Developer không có quyền mở khóa test. Bản duyệt gắn với checkpoint, hợp đồng, cấu hình và hash manifest; bản cũ bị từ chối. Sau duyệt, hệ thống áp dụng đúng diff, khóa lại manifest có lịch sử phiên bản và chạy lại checks, mutation khả dụng, Verifier trước khi cho nghiệm thu. Giữ tên ca không thay thế việc đọc assertion; không duyệt bản sửa làm yếu hành vi cần kiểm chứng. Mặc định, để run chạy một mạch, đề xuất đã qua mọi kiểm tra (có trích điều khoản, `before` khớp assertion đã khóa, đúng file test của Author) được hệ thống tự áp dụng đúng một lần mỗi run; biên nhận ghi `auto_approved`, run bị đánh dấu chạy suy giảm và báo cáo nghiệm thu có cảnh báo kèm assertion trước/sau. Đặt `AIDEPT_AUTO_TEST_REPAIR=0` để quay lại cổng duyệt tay. Run v4 bỏ qua biến này: sửa test luôn chờ người đọc diff (xem [docs/evidence-v4.md](docs/evidence-v4.md)).

Chạy `pnpm build` và `pnpm test:reliability` để xác nhận, không gọi model thật. Regression giới hạn 4 worker để các fixture Vitest/Stryker con không tranh chấp tài nguyên; không tự retry test. Để xem luồng duyệt trong trình duyệt, chạy `pnpm exec tsx tests/fixtures/assertion-ui.ts` và mở URL được in ra; đây là fixture với agent/check giả, khác với fixture Vitest thật trong `tests/assertion-local.test.ts`.

Số lượt tự động được lưu để gián đoạn/resume không tự tăng trần. Bấm thử lại một run đã `failed`, hoặc duyệt phạm vi sửa file rồi chạy tiếp, là một yêu cầu chạy mới có giới hạn và vẫn dùng ngân sách hiện có. Đề xuất sửa test đang chờ duyệt không tự lặp gọi Author. Không thay đổi điều kiện chỉ `completed` sau khi giao thành công.

### Mutation tự nhận diện stack

Bộ nhận diện chỉ đọc manifest, tên cấu hình và metadata package đã cài. Adapter đầu tiên hỗ trợ **JS/TS + Vitest >=2, Stryker core và vitest-runner 9.6.1**. Trạng thái là `available`, `unsupported`, `missing_tool` hoặc `ambiguous`. Không tự chạy script để nhận diện hoặc cài dependency trong project của người dùng.

Nếu dùng pnpm và project chưa có công cụ:

```bash
pnpm add -D --save-exact @stryker-mutator/core@9.6.1 @stryker-mutator/vitest-runner@9.6.1
```

Dùng package manager/lockfile của project, commit manifest và lockfile rồi tạo run mới. Hướng dẫn trong giao diện chọn npm/pnpm/yarn/bun theo lockfile. Với monorepo, **Sửa project → Nâng cao → Thư mục mutation** chọn đường dẫn tương đối như `packages/api`; để trống tự nhận diện, `.` là gốc repo. Detector xét package ở gốc và tối đa hai tầng thư mục con. Dependency đã cài có thể nằm ở package, gốc repo hoặc thư mục cha trung gian như `packages/node_modules`; bản sao mutation giữ các vị trí này để runner tìm đúng công cụ. Nhiều cấu hình Vitest chính trong một package cần được hợp nhất trước khi adapter chạy.

Mutation chạy sau khi checks và ca bắt buộc đạt, trên clone riêng của đúng checkpoint; chỉ chọn source JS/TS thay đổi, loại file test, cấu hình, lockfile, file sinh tự động và dependency. Baseline phải đạt. `related` tắt để tránh bỏ sót test tích hợp gọi qua API. Mặc định 5 phút tổng, concurrency 2, một lượt mỗi checkpoint/cấu hình; không tự retry hay gọi AI sửa mutation sống sót.

JSON/Markdown và giao diện lưu riêng killed, survived, no coverage, timeout, lỗi biên dịch/công cụ và phần chưa chạy. Khi không xác định được số mutation chưa chạy, báo rõ chưa xác định. Timeout/lỗi công cụ không được tính là test bắt lỗi; không có ngưỡng mutation score chung. Mutation sống sót là cảnh báo cần xem xét; finding đã xác nhận vẫn theo chính sách hiện có.

**Chạy lại check** chỉ chạy checks và mutation phù hợp trên checkpoint đang có, không gọi Developer/Author/Verifier. Thay recipe/cấu hình làm bằng chứng cũ mất hiệu lực. Hủy hoặc restart đánh dấu lượt mutation dở là chưa hoàn tất; watchdog dừng cây tiến trình local, Docker được dừng theo tên container lúc phục hồi. Patch mutation không được giao về project.

### Regression bằng fixture

```bash
pnpm install --frozen-lockfile --ignore-scripts
pnpm build
pnpm test:reliability
```

Nhóm reliability dùng danh sách file tường minh trong `scripts/test-reliability.mjs`, gồm hợp đồng/API/orchestrator/delivery/verdict/runtime/project không Git/báo cáo/cleanup/preview và kiểm thử sâu. Fixture Stryker/Vitest chạy thật, so sánh test yếu với assertion ở giá trị biên và kiểm tra candidate/project không đổi; giới hạn test này 60 giây. Test giao diện component dùng DOM ảo và API Fastify thật, không thay thế kiểm tra hình ảnh trên trình duyệt. Live model và Docker E2E không nằm trong nhóm này.

CI `.github/workflows/reliability.yml` chạy Windows/Ubuntu, Node 24.12.0 và pnpm 11.25.0; mỗi job 15 phút, không hủy job còn lại khi một OS lỗi. JSON/JUnit và bằng chứng mutation ở `test-results/reliability/`, upload cả khi test lỗi và giữ 14 ngày. CI GitHub chỉ được xác nhận sau lần push/PR thực tế.

Để kiểm tra giao diện trực tiếp bằng fixture riêng:

```bash
pnpm build
pnpm exec tsx tests/fixtures/quality-ui.ts
```

Mở URL fixture in ra. Lần duyệt đầu cố ý trả hash cũ để kiểm tra tải lại; sau khi duyệt bản mới, fixture thiếu ca lỗi `C-2` nên bị chặn. Bấm **Chạy lại check** sẽ cung cấp đủ ca; đọc và xác nhận cảnh báo mutation trước khi nghiệm thu. Toàn bộ agent/check của fixture UI là mô phỏng, không gọi model hoặc ghi vào project thật. Dùng fixture mutation riêng trong test để có bằng chứng công cụ thật.

## Giám sát (log trực tiếp)

**Monitor** (`#/monitor`) có 3 tab. Link cũ (`#/monitor/console`, `/requests`, `/insights`) tự chuyển sang tab mới tương ứng. Chi phí luôn là **ước tính** khi provider không báo giá.

**Trực tiếp** (`#/monitor`):
- **Cảnh báo:** đĩa sắp đầy, task bị chặn vì provider quá tải hoặc hết quota.
- **Sơ đồ "AI Department đang gọi tới đâu":**
  - task nằm bên trái quỹ đạo, Codex / Claude / Check / Git bên phải, hub ở giữa;
  - đường đang chạy phát sáng, có hạt chạy dọc đường và nhãn "vai · thời gian"; hub có sóng radar;
  - đường dùng trong 10 phút qua hiện mờ;
  - dòng trạng thái ghi đang gọi gì cho mấy task, hoặc lần gọi gần nhất.
- **Lượt gọi gần đây** đặt cạnh sơ đồ.
- **Đang chạy:** giai đoạn, vai, đồng hồ, % ngân sách và dòng log mới nhất của từng task.
- **Chờ bạn:** chờ nghiệm thu, chờ duyệt hợp đồng, policy chưa duyệt, bị chặn, thất bại; mỗi việc có nút đi thẳng tới chỗ xử lý.
- **Console trực tiếp** ở cuối, thu gọn được và nhớ trạng thái.

**Chi phí** (`#/monitor/cost`, chọn kỳ Hôm nay/24h/7D/30D/60D):
- **6 thẻ số gọn:** lượt gọi, token, tỉ lệ cache, chi phí, chi phí mỗi task nghiệm thu, lãng phí ước tính. Mỗi thẻ có ↑/↓ so với cùng khoảng của kỳ trước.
- **Biểu đồ:** chuyển giữa chi phí (xếp chồng theo vai), token và lượt gọi.
- **Tiền đi đâu:** theo task, vai hoặc project.
- **Lãng phí:** Verifier chạy lại trên cùng checkpoint mà code và hợp đồng không đổi, lượt lỗi (tách lỗi provider), task chờ bạn hơn 24 giờ (`src/core/waste.ts`).
- **Phần thu gọn:** chi tiết lượt gọi (lọc theo task, vai, trạng thái, model, tìm chữ) và hiệu quả theo chế độ / có-không ngữ cảnh.

- **Hệ thống** (`#/monitor/system`):
  - chỗ trống ổ đĩa và phiên bản Codex;
  - dung lượng bản sao làm việc theo từng task (đo ở nền), kèm nút **Dọn** cho task hoàn thành đã giao thành công đúng bản hiện tại, task bị chặn hoặc thất bại hơn 7 ngày, hoặc bản sao không còn task (`POST /api/system/cleanup`). Mọi trường hợp vẫn phải qua quy tắc bảo vệ bằng chứng giao ở trên. Nút này chỉ xóa `.data/workspaces/<run>-*`, không đụng project gốc;
  - các phiên Chạy thử đang mở.

Tên model thật (ví dụ `gpt-6.1-sol`) được đọc từ nhật ký phiên của Codex (`~/.codex/sessions`) khi vai để trống model. Lượt cũ được bổ sung tên khi server khởi động.

**Console Log** (menu riêng) và tab **Log trực tiếp** trong từng task hiện console realtime: output cài đặt (`npm ci`), việc Codex đang làm (lệnh đã chạy, file đã sửa, kết quả), output của check, kèm heartbeat "vẫn đang chạy (120s)" cho các bước dài. Lọc theo mức/nguồn/từ khóa, tải log về, xem log thô của từng lượt agent. Log được lưu trong SQLite, che khóa API và tự cắt bớt khi vượt 200.000 dòng. API: `GET /api/logs`, `GET /api/logs/stream` (SSE), `GET /api/monitor`.

## Duyệt đường dẫn ngoài phạm vi

Nếu agent sửa file ngoài `modules` của project, patch bị từ chối và hoàn nguyên. Trang task hiện danh sách các thư mục/file đó; bạn chọn mục nào cho phép **trong task này** rồi hệ thống chạy lại. Không có mục nào được chọn sẵn. File được bảo vệ (lockfile, config check, test đã khóa, đường dẫn tuyệt đối hoặc có `..`) không bao giờ được duyệt, kể cả qua thư mục cha. Bấm **Chạy tiếp** sau một lần thất bại sẽ thử lại thật sự (candidate thất bại chỉ được giữ khi chuyển chế độ).

## Stack, quy ước và check của project

Để agent theo đúng stack của repo thay vì tự đoán, mỗi project có:

- **Hướng dẫn (`guidance`, tối đa 4000 ký tự)**: stack, quy ước, lệnh chạy, điều cần tránh. Được đưa vào prompt của Planner, Developer (kể cả vòng sửa và phương án B), Author và Verifier trong khối `<project_guidance>`, kèm lời nhắc đây là thông tin tham khảo của chủ project, **không phải lệnh thực thi** và không được lấn át hợp đồng. Hệ thống không chạy, không diễn giải nó; văn bản được cắt theo giới hạn, bỏ ký tự điều khiển, và không thể đóng khối hay mở code fence giả kết quả agent. Agent diễn giải độc lập (Clarify) cố ý không nhận nó. Sửa guidance làm tăng phiên bản policy và cần duyệt lại như mọi thay đổi khác. Task đã tạo giữ bản guidance lúc tạo cho tới khi **Chạy lại check** (lấy cấu hình mới nhất).
- **Phát hiện stack** (nút trong form tạo/sửa, `POST /api/projects/detect` với `{repository}` hoặc `{projectId}`): chỉ đọc `package.json`, lockfile, `tsconfig.json`, tên các file cấu hình framework/test/lint ở thư mục gốc và đếm file `*.test.*`; không chạy lệnh nào, không đánh giá file cấu hình JS, từ chối đường dẫn ra ngoài repo/symlink trỏ ra ngoài/file trên 256 KB. Trả về hướng dẫn gợi ý, check gợi ý (test, `npx tsc --noEmit` nếu có tsconfig, lint, build nếu có script) và lệnh cài đặt. Chỉ là gợi ý: guidance chỉ tự điền khi ô đang trống, check và lệnh cài đặt chỉ thêm khi bạn bấm.
- **Nhiều check**: form sửa/tạo cho thêm, sửa, xóa từng check (id, lệnh JSON argv, bắt buộc, report, timeout) và thêm từ mẫu (Vitest, Jest, node --test, tsc, ESLint, build). Check chạy theo thứ tự; id phải khác nhau.
- **Check không có report** (typecheck, lint, build): mã thoát 0 là pass, khác 0 là fail (có một lần chạy lại để phân biệt flaky), output hiện trong Console và trong lời nhắc sửa lỗi. Chúng không có test id nên **không bao giờ tính là bằng chứng cho yêu cầu**; chỉ check có report mới xác minh yêu cầu. Check bắt buộc đang fail vẫn chặn nghiệm thu dù test xanh. Không có red/green cho check này.

**Java, Kotlin, Python, Go, Rust.** Gặp `pom.xml` hoặc `build.gradle(.kts)`, detector gợi ý hai check: `build` (biên dịch code và test, `-q`) rồi `test`. Build chạy trước và nếu fail thì check test bị bỏ qua, lỗi biên dịch được đưa cho Developer sửa như một lỗi bình thường thay vì "thiếu report". Báo cáo test của Maven (`target/surefire-reports`) và Gradle (`build/test-results/test`) là mỗi class một file XML; `reportPath` có thể là **một thư mục** (gộp mọi `.xml` trong đó) hoặc mẫu `**/target/surefire-reports` cho dự án nhiều module. Lệnh dùng `mvnw`/`gradlew` nếu repo có (Windows: `mvnw.cmd` qua `cmd.exe`, chỉ khi đối số không chứa ký tự đặc biệt của cmd), không thì `mvn`/`gradle` trên máy; Gradle chạy `--no-daemon` để không để tiến trình ngầm giữ file. Python dùng `python -m pytest --junitxml`; Go và Rust chỉ có build và test theo exit code (không có report, nên yêu cầu phải xác minh thủ công). Tên test gắn yêu cầu bằng `[R-1]` hoặc `R_1` (Java, Python, Go, Rust không có dấu `[` trong tên hàm). Repo có manifest ở thư mục con (ví dụ `backend/pom.xml`) thì detector chỉ ra thư mục đó để chọn làm thư mục project.

**Môi trường tự chuẩn bị (chế độ Local).** Khi bắt đầu task, hệ thống đọc các lệnh của project (lệnh cài đặt và các check) để biết cần công cụ gì, rồi tự lo phần còn thiếu, không đổi gì trong hệ thống:
- **JDK, Maven, Gradle:** nếu lệnh dùng `mvn`/`gradle`/wrapper mà máy chưa có JDK, hoặc JDK cũ hơn phiên bản project yêu cầu (đọc từ `pom.xml`/`build.gradle`), hệ thống tải Eclipse Temurin (LTS thấp nhất đủ dùng) vào `<data>/tools/jdk-<n>`; `mvn`/`gradle` trần mà không có trên PATH thì tải Maven 3.9.9 / Gradle 8.10.2. Có `mvnw`/`gradlew` thì dùng wrapper, không tải Maven/Gradle. Mỗi file tải chỉ qua HTTPS từ nhà phát hành (api.adoptium.net, archive.apache.org, services.gradle.org), được đối chiếu với checksum họ công bố (sai thì xóa và dừng), tối đa 700 MB, chỉ tải một lần và dùng chung cho mọi task. Đã cài sẵn công cụ đủ dùng trên máy thì không tải gì. Công cụ cài được đặt lên đầu `PATH` (và `JAVA_HOME`) của lệnh setup, check và agent.
- **Python:** tạo `.venv` riêng trong bản sao làm việc, `pip install -r requirements.txt`, `pip install -e .` nếu là package (lỗi thì chỉ cảnh báo) và cài pytest nếu thiếu. `.venv` đặt lên đầu `PATH` nên `python -m pytest` trong check chạy trong venv. Python thì không tự cài được (trình cài trên Windows cần người bấm): thiếu thì task dừng ở trạng thái "Bị chặn" kèm hướng dẫn.
- `.venv/`, `target/` (Maven), `build/` và `.gradle/` (Gradle), `__pycache__/` không bao giờ vào diff của agent.
- Tiến trình tải và cài hiện trong Console (nguồn `setup`). Task chỉ bị chặn khi không cài được (mất mạng, checksum sai, thiếu Python).
- Chưa làm: tự cài Go và Rust (nặng, cần toolchain đầy đủ), Node theo phiên bản của project, và chế độ Docker (image runner chưa có JDK).

Giới hạn: phần tải và cài JDK/Maven/Gradle đã test với máy chủ giả (tải, checksum, giải nén, chia sẻ một lần tải) và phần Maven/Gradle chưa chạy với bản thật; venv và PATH đã chạy với Python thật, nhưng `pip install` từ PyPI chưa được chạy thử. Với pnpm/yarn, lệnh cài đặt gợi ý đi qua `npx` vì Windows không chạy trực tiếp `.cmd`; Bun chưa được hỗ trợ chạy trực tiếp.

## Skill

Trang **Skill** (`#/skills`) là thư viện skill theo chuẩn Agent Skills (thư mục có `SKILL.md` với frontmatter `name`, `description`, có thể kèm `scripts/`, `references/`, `assets/`), dùng chung cho Codex và Claude Code.

- **Cài:** từ skill có sẵn trên máy (`~/.codex/skills`, `~/.claude/skills`, hoặc một thư mục bất kỳ), từ file `.zip` (kéo thả; zip có nhiều skill thì chọn từng cái; `.rar` không hỗ trợ) hoặc từ một thư mục trên GitHub (repo công khai, link `…/tree/<nhánh>/<thư mục>`). Hệ thống kiểm tra tên (chữ thường, số, gạch ngang), mô tả, tối đa 300 file, 10 MB, mỗi file 2 MB, không symlink, không đường dẫn thoát ra ngoài, và đánh dấu file script. Bản sao được lưu ở `<data>/skills/<tên>`.
- **Duyệt:** skill mới cài ở trạng thái *Chờ duyệt*; agent chỉ nhận skill sau khi bạn đọc `SKILL.md`, danh sách file và bấm Duyệt. Cài lại với nội dung khác, hoặc file trên đĩa bị sửa sau khi duyệt, thì skill không được nạp cho tới khi duyệt lại.
- **Gán theo vai:** Sửa dự án → Ai làm việc → Tuỳ chỉnh từng vai, mỗi vai chọn skill riêng. Đổi gán là đổi policy, cần duyệt lại. Agent diễn giải độc lập (Clarify) không bao giờ nhận skill.
- **Nạp cho agent:** Claude Code qua `--plugin-dir` (thư mục plugin tạm ngoài bản sao làm việc, xoá sau lượt; nếu skill có script thì cho phép thêm `python`, `bash`, `sh`); Codex qua `.agents/skills/<tên>` trong bản sao làm việc (bị git bỏ qua, xoá sau lượt, không ghi đè skill trùng tên của repo); Antigravity và chế độ Docker nhận nội dung `SKILL.md` trong prompt (không kèm file phụ, tối đa ~6000 token). Đã thử thật: Claude Code 2.x và Codex 0.163 đều thấy và dùng skill nạp theo cách này.
- **Ghi nhận:** mỗi lượt agent ghi skill đã nạp trong ngữ cảnh của lượt (tab Chi phí & công); báo cáo nghiệm thu có mục "Skill đã dùng" và lưu ý khi skill có script.
- **Lưu ý:** Codex vẫn tự đọc skill và plugin cá nhân trong `~/.codex` dù chạy `--ignore-user-config` (cờ `skip_host_skill_discovery` chưa có tác dụng ở 0.163), nên agent Codex có thể thấy thêm skill cá nhân của bạn ngoài skill được gán.

## Ngữ cảnh project (bộ nhớ, bản đồ repo)

Nút **Ngữ cảnh** trên thẻ project mở 3 tab:

- **Bộ nhớ:** các sự kiện ngắn, kiểm chứng được về repo, ví dụ "code crawler nằm ở `worker/`" hay "test chạy bằng `node --test tests/*.test.cjs`, không có script `test`".
  - Mục bạn tự thêm có hiệu lực ngay. Mục do agent hoặc hệ thống đề xuất (chưa bật) phải được duyệt.
  - Có thể ghim, lưu trữ, xóa. Mỗi mục giữ lịch sử sửa.
  - Giới hạn: tối đa 50 mục đang dùng, 200 mục mỗi project, mỗi mục tối đa 500 ký tự (bí mật được che).
- **Bản đồ repo:** thư mục kèm số file, script, điểm vào, mẫu file test, tài liệu cho agent.
  - Chỉ đọc tên file, không đọc nội dung. Bỏ qua `node_modules`, `.git`, thư mục ẩn và symlink.
  - Không chép `AGENTS.md`, vì Codex tự đọc.
- **Xem trước và ngân sách:** chọn vai để thấy chính xác phần nào được gửi, ước tính token và phần nào bị bỏ (kèm lý do). Bật/tắt và chỉnh ngân sách ở đây; đây là thay đổi policy nên cần duyệt lại.

**Gửi cho ai** (ngân sách mặc định, đơn vị token ước tính):

| Vai | Ngân sách | Nhận |
|---|---|---|
| Developer (gồm repair, phương án B) | 3.000 | mọi loại bộ nhớ + bản đồ repo |
| Author | 1.000 | quy ước, lệnh, lỗi đã gặp liên quan test + script và test layout |
| Planner | 1.500 | chỉ bản đồ repo |
| Verifier | 0 (tắt) | chỉ quy ước, khi bạn bật |
| Interpreter | không bao giờ | |

Guidance vẫn gửi như cũ và không tính vào ngân sách.

**Các rào chắn:**
- **Tắt mặc định.** Khi tắt, prompt giữ y như trước.
- **Đóng băng theo run.** Ngữ cảnh được chụp một lần lúc run bắt đầu. Sửa bộ nhớ sau đó không đổi run đang chạy. Bấm Chạy tiếp một run chưa có checkpoint thì chụp lại.
- **Tự loại mục không còn đúng.** Lúc chụp, mục neo vào đường dẫn không còn tồn tại, mục `command` gọi `npm run` một script không có, hoặc mục quá 90 ngày chưa xác nhận lại sẽ chuyển **Cần xác nhận lại** và không được gửi.
- **Là thông tin tham khảo.** Khối `<project_context>` đặt sau hợp đồng, ghi rõ hợp đồng và phạm vi luôn thắng. Nó không thể đóng thẻ hay mở code fence.
- **Ghi lại cái đã gửi.** Mỗi lượt agent ghi artifact `context`. Trang run có cột **Ngữ cảnh** cho thấy chính xác cái đã gửi.

**Đo lợi ích:** `GET /api/metrics/context` so sánh run có và không có ngữ cảnh (tỉ lệ nghiệm thu, số vòng sửa, chi phí). Đây là số đo hỗ trợ quyết định, không phải thí nghiệm có đối chứng.

**API:**
- `GET|POST /api/projects/:id/memory`
- `PATCH|DELETE /api/projects/:id/memory/:mid`
- `GET /api/projects/:id/repomap`
- `GET /api/projects/:id/context?role=developer&budget=…`

**Tiết kiệm context window.** Verifier đọc toàn bộ thay đổi từ bản gốc (test của Author và mọi vòng sửa), không chỉ vòng cuối; diff quá 60.000 ký tự được cắt theo từng file ở ranh giới dòng, code trước test, lockfile/file sinh tự động chỉ nêu tên, và phần bị bỏ được liệt kê. Vòng sửa nối tiếp phiên Developer (Codex, Claude) chỉ gửi danh sách lỗi; phiên mới (hoặc Antigravity, vốn không nối phiên) nhận prompt đầy đủ với phần cố định đặt trước và danh sách lỗi ở cuối để cache của provider dùng lại được phần đầu. Ước lượng token tính chữ có dấu tiếng Việt nặng hơn chữ ASCII (khoảng 3 ký tự/token cho văn xuôi tiếng Việt thay vì 3,5).

## Project mới: cho agent dựng stack

Mặc định agent không được đụng `package.json`, lockfile, `tsconfig*.json` hay cấu hình Vite/Vitest/Jest/Playwright, để không làm yếu check. Với một thư mục mới, điều này buộc agent viết JS thuần không dependency.

Bật **"Cho phép agent tạo file thiết lập chưa có"** trong form tạo/sửa project (`allowScaffold`) thì agent được **tạo mới** các file đó và thêm dependency, nhưng chỉ khi file **chưa có trong bản gốc** của task. Khi đã tạo trong task thì agent sửa tiếp được.
- File đã có từ trước vẫn bị khóa.
- `.npmrc`, `.github/**`, `Dockerfile` và test đã khóa không bao giờ mở.
- Prompt của Developer và Author được báo rõ quyền này.
- Không có danh sách file của bản gốc thì không mở gì (an toàn mặc định).

## Chạy thử kết quả trước khi nghiệm thu

Trang task có nút **Chạy thử** khi run đã có checkpoint và không đang chạy.
- **Nó làm gì:** bật app từ đúng bản code của run (bản sao làm việc) trên một cổng localhost trống, truyền qua `PORT`, với `HOST=127.0.0.1`. Xong thì mở link trong tab mới.
- **Lệnh chạy:** lấy `previewCommand` của project (ô **Lệnh chạy thử app** trong Sửa project). Nếu trống thì tự đoán theo thứ tự: `npm run dev`, `npm start`, `node server.mjs`/`server.js`/`index.mjs`, hoặc server tĩnh có sẵn (`tools/preview/static-server.mjs`) cho thư mục chỉ có `index.html`. Server tĩnh không phục vụ file ẩn như `.env`. App nhận cổng qua biến `PORT`; Vite không đọc `PORT` nên script `dev`/`start` chạy `vite` được truyền sẵn `--port <cổng> --host 127.0.0.1 --strictPort`. Với công cụ khác cần cổng dạng tham số, ghi `{PORT}` vào lệnh, ví dụ `npm run dev -- --port {PORT} --host 127.0.0.1`.
- **Khi nào tự tắt:** sau 30 phút, khi bạn bấm Chạy tiếp, Chạy lại check, Sửa finding, Duyệt hợp đồng hay Nghiệm thu, hoặc khi server AI Department dừng.
- **Lưu ý:** app chạy code của repo trên máy bạn, giống như check.
- **API:** `GET /api/runs/:id/preview`, `POST /api/runs/:id/preview/start`, `POST /api/runs/:id/preview/stop`.

## Test giao diện cần bật app (Playwright)

Check chạy không qua shell nên không tự bật web trước khi test được. `tools/checks/web-e2e.mjs` làm việc đó. Nó chạy trong bản sao làm việc và lần lượt:
1. bật app bằng lệnh `--server` trên một cổng trống (truyền qua biến `PORT`);
2. chờ app trả lời;
3. chạy `playwright test` kèm report JUnit vào `.aidept-report.xml`, đặt URL của app vào biến môi trường mà test đọc (`--url-env`);
4. tắt app và trả về mã thoát của Playwright.

Output của Playwright (ảnh chụp, profile trình duyệt) ghi ra thư mục tạm, không lọt vào checkpoint. Nó không tự cài gì, nên lệnh cài đặt của project phải có Playwright. Ví dụ check:

```json
["node", "C:/…/ai_department/tools/checks/web-e2e.mjs", "--server", "node", "server.mjs", "--url-env", "EXPENSE_APP_URL", "--", "e2e", "--workers=2"]
```

Report path là `.aidept-report.xml`. Repo không có `package.json` thì lệnh cài đặt có thể là `["npm","install","--no-save","--no-package-lock","@playwright/test@<phiên bản>"]`. Trình duyệt Playwright được lưu ở cache của người dùng (`%LOCALAPPDATA%\ms-playwright`). Tên test phải gắn thẻ `[R-x]` để thành bằng chứng.

## Project không có git hoặc chưa có commit

Project chỉ cần là một thư mục tồn tại (không nhận ổ đĩa gốc hay thư mục home). Có hai trường hợp:

- **Git có ít nhất một commit**: agent làm trên bản clone, kết quả giao bằng branch `aidept/<run>-A` hoặc `-B` theo slot được chọn. Branch đã trỏ đúng checkpoint được coi là đã giao; branch trỏ nơi khác gây xung đột và được giữ nguyên.
- **Git chưa có commit, hoặc không phải git**: hệ thống chụp một bản sao thư mục (trừ `.git`, `node_modules`, `.data`, symlink; tối đa 20.000 file / 300 MB) thành repo git riêng của run trong `.data/workspaces/<run>-base`, tôn trọng `.gitignore` của project nên file bị ignore (như `.env`) không tới tay agent. Bản chụp chỉ tạo một lần mỗi run nên sửa thư mục project giữa chừng không làm lệch base. Khi **nghiệm thu**, các file task đã đổi được ghi thẳng vào thư mục project. Hệ thống kiểm tra xung đột toàn bộ trước khi ghi; nếu thao tác ghi bị gián đoạn, lần thử lại nhận ra các file đã có đúng nội dung cuối và tiếp tục phần còn lại. File bạn sửa khác với bản gốc và các phiên bản task đã tạo sẽ gây xung đột. Nội dung được đọc từ đúng checkpoint, gồm cả file nhị phân, và kiểm tra lại trước khi xác nhận giao thành công. Báo cáo JSON/Markdown và giao diện ghi rõ **Ghi file trực tiếp**, không hiển thị lệnh merge branch cho trường hợp này.

## Kết nối AI (Codex / Claude / Antigravity)

Trang **Kết nối AI** (`#/connect`, hoặc bấm ô trạng thái ở góc trên) có một thẻ cho mỗi CLI, mỗi thẻ đi qua 3 bước:

1. **Cài đặt.**
   - Codex: có nút "Cài Codex giúp tôi", cài vào `.tools/codex`, không cài toàn cục.
   - Claude Code: tự cài bằng `winget install Anthropic.ClaudeCode` hoặc `npm install -g @anthropic-ai/claude-code`.
2. **Đăng nhập.** Nút "Mở trang đăng nhập" chạy lệnh đăng nhập của chính CLI (`codex login`, `claude auth login --claudeai`) và mở trang của OpenAI hoặc Anthropic. Token do CLI lưu; AI Department không thấy mật khẩu hay token. Thẻ ghi rõ bạn đang dùng **gói thuê bao** (ChatGPT Plus/Pro, Claude Pro/Max) hay **API trả theo token**.
3. **Kiểm tra.** "Gửi thử 1 lượt" gọi đúng cách một run sẽ gọi. Nó tốn 1 lượt và báo model đã trả lời.

Khối **Chia việc giữa hai bên** áp dụng cách chia gợi ý cho một project:
- Codex lập kế hoạch và viết code;
- Claude viết test nghiệm thu, soát và điều tra.

Người soát dùng một họ model khác người viết code. Từng vai (provider, model, mức suy nghĩ) chỉnh trong **Sửa project → Ai làm việc gì**. Đổi vai là đổi policy, cần **Duyệt policy** lại.

**Claude chạy local:**
- `claude -p --output-format stream-json`, không có `--bare`, để dùng được đăng nhập Claude Pro/Max.
- `--setting-sources project,local --strict-mcp-config`: không nạp cấu hình hay MCP toàn cục của bạn.
- `--permission-mode acceptEdits` cùng danh sách công cụ hẹp: đọc và sửa file, `npm`/`npx`/`node`, `git` chỉ đọc. Agent con bị tắt.
- Đường Docker vẫn dùng `--bare` với `ANTHROPIC_API_KEY`.
- `AIDEPT_CLAUDE_ENTRY` trỏ tới CLI khác nếu `claude` không có trong PATH.

**Antigravity (Google, CLI `agy`):**
- Planner, Verifier, Investigator: chỉ đọc. Developer và Author: **thử nghiệm**. Ở các vai này agy chỉ sửa được file trong bản sao làm việc và không chạy được lệnh nào; AI Department tự chạy check sau lượt của nó. Antigravity chỉ chạy local, và vai thử nghiệm chỉ chạy trên Windows (nơi đã kiểm chứng).
- Cài bằng installer chính thức `irm https://antigravity.google/cli/install.ps1 | iex`. Installer đặt file vào `%LOCALAPPDATA%\agy\bin\agy.exe`; AI Department tìm ở đó trước, rồi mới tới PATH. `AIDEPT_AGY_ENTRY` trỏ tới bản khác.
- Đăng nhập: chạy `agy` trong PowerShell một lần, đăng nhập Google, rồi gõ `/exit`. Không có lệnh `auth status`, nên `agy models` trả về danh sách model được coi là đã đăng nhập.
- Lệnh chạy: `agy --input-format stream-json --output-format stream-json --mode plan|accept-edits --disable-slash-commands --add-dir=<bản sao> [--model …|--effort …] --print=`, với `plan` cho vai chỉ đọc và `accept-edits` cho Developer/Author. Prompt đi qua stdin dưới dạng `{"event":"user","message":{…}}`. Đầu prompt luôn có lời dặn: chỉ đọc, hoặc chỉ sửa trong bản sao và không chạy lệnh.
- agy in cảnh báo `--mode plan has no effect while slash command expansion is disabled`, nhưng log của nó cho thấy plan mode vẫn được bật. Dù vậy, plan mode không phải lớp bảo vệ (xem dưới).
- **An toàn.** Kiểm chứng ngày 2026-10-22 với agy 1.4.5 trên Windows 10.
  - Lỗ hổng: ở cả `plan` lẫn `accept-edits`, công cụ `write_file` của agy ghi được vào **mọi đường dẫn tuyệt đối** ngoài `--add-dir`: dự án khác, profile PowerShell, `~/.gemini/config/config.json` (nơi agy có thể tự cấp quyền chạy lệnh). Plan mode không chặn, dấu vân tay `git status` + `git diff` không thấy. `allowNonWorkspaceAccess: false` cũng không chặn. `--sandbox` không có tác dụng trên Windows 10 và chỉ áp dụng cho lệnh terminal.
  - Cách chặn: agy chỉ đọc luật quyền từ `~/.gemini/antigravity-cli/settings.json`. Vì vậy mỗi lượt chạy agy với `USERPROFILE`/`HOME` riêng, `<data>/agy/home-*`, chứa `settings.json` của riêng lượt đó; thư mục bị xoá sau lượt. agy không nạp file `~/.gemini` của bạn, kể cả `globalPermissionGrants`, và AI Department không sửa chúng. Đăng nhập vẫn chạy vì token nằm trong keyring của hệ thống.
  - Luật cho vai chỉ đọc: `deny` `write_file(*)` và mọi gốc ổ đĩa (`write_file(C:/)`…). Mọi lệnh ghi bị từ chối, kể cả trong bản sao.
  - Luật cho Developer/Author: `allow` bản sao làm việc (và thư mục `brain` của home riêng), `deny` `<bản sao>/.git`, `ask` `write_file(*)` và mọi gốc ổ đĩa.
  - Đo được: một luật phủ cả thư mục con, deny thắng allow, allow thắng ask, và chế độ không giao diện từ chối mọi ask. Thử thật: ghi ra ngoài bị từ chối ở cả hai chế độ, ghi vào `.git/hooks` bị từ chối, sửa file trong bản sao (Developer) vẫn chạy.
  - Không dùng `--dangerously-skip-permissions`: mọi lệnh shell bị từ chối, vì home riêng không cấp quyền lệnh nào.
  - Tripwire: trước và sau mỗi lượt, AI Department so `.git/hooks`, `.git/config` của bản sao và hai file của bạn (`~/.gemini/config/config.json`, `~/.gemini/antigravity-cli/settings.json`). Nếu khác, hooks và config được khôi phục, lượt bị huỷ và thay đổi chưa commit bị hoàn tác. Vai chỉ đọc còn phải giữ bản sao nguyên từng byte (`git status` + `git diff`).
- Khi agy dừng mà không trả lời vì bị từ chối:
  - vai chỉ đọc, hoặc Developer/Author định ghi ra ngoài bản sao: lượt thất bại với thông báo rõ ràng; với Developer/Author, các file nó đã sửa được hoàn tác;
  - Developer/Author định chạy lệnh (thường là chạy test sau khi sửa): lượt kết thúc bình thường, AI Department chạy check trên những gì nó đã sửa.
- Giới hạn còn lại: đây là luật của chính agy, không phải sandbox của hệ điều hành, và agy tự cập nhật nên bản khác 1.4.5 có thể xử lý luật khác. Check của project vẫn chạy code do agent viết với quyền của bạn, như khi Codex hay Claude chạy local.
- agy không báo giá. Với tài khoản Google, `costUsd = 0`; với `GEMINI_API_KEY`, chi phí được ước tính theo token.

**Chi phí khi dùng gói thuê bao:** số tiền Claude báo chỉ là quy đổi theo giá API. Nó được lưu thành `notionalUsd`, còn `costUsd = 0`, nên không trừ vào ngân sách task. Hạn mức của gói vẫn áp dụng. Khi chạm giới hạn, task chuyển sang bị chặn; chờ hạn mức hồi rồi bấm Chạy tiếp.

## Chạy local (khuyến nghị cho Codex)

Project có `executionMode: "local"` (mặc định khi tạo từ UI). Agent và check chạy trực tiếp trên máy, **không có cô lập**: agent làm được những gì tài khoản Windows của bạn làm được, bị giới hạn bởi sandbox của chính Codex; check chạy lệnh của repo và có mạng. Repo gốc không bị đụng cho tới khi bạn nghiệm thu, khi đó chỉ thêm một branch mới `aidept/<run>-A` (không ghi đè branch có sẵn, không đổi working tree hay branch hiện tại).

```bash
npm install --prefix .tools/codex @openai/codex   # CLI cục bộ, không đụng cài đặt toàn cục
node .tools/codex/node_modules/@openai/codex/bin/codex.js login   # nếu chưa đăng nhập
AIDEPT_LIVE_E2E=1 npx vitest run tests/live.e2e.test.ts          # chạy thật, tốn quota
```

Lệnh check/setup chạy không qua shell: trên Windows dùng `["npm", ...]`, `["npx", ...]` hoặc `["node", ...]` (không dùng file .cmd/pnpm trực tiếp). Cần `[windows] sandbox = "elevated"` đã được thiết lập bởi Codex trên máy; runtime truyền lại cấu hình này vì `--ignore-user-config` sẽ bỏ nó và Codex rơi về read-only.

**Những gì vẫn được giữ lại dù không có cô lập (chế độ Local):**
- **Khóa API không lọt vào code của repo.** Check, preview, kiểm tra môi trường và mutation chạy với biến môi trường đã bỏ mọi biến trông như credential (`*_API_KEY`, `*_TOKEN`, `*_SECRET`, `*_PASSWORD`, `*_CREDENTIALS`, `SSH_AUTH_SOCK`…, khớp theo từ nguyên vẹn nên `TOKENIZERS_PARALLELISM` không bị ảnh hưởng) cùng biến của các nhà cung cấp AI (`OPENAI_*`, `ANTHROPIC_*`, `GEMINI_*`…). Lệnh setup chỉ bỏ biến của nhà cung cấp AI, vì có thể cần `NPM_TOKEN` cho registry riêng. Một test do agent viết vì vậy không đọc được khóa của agent hay token của bạn. Project nào thật sự cần một biến, đặt `AIDEPT_PASS_ENV="TEN1,TEN2"` khi khởi động AI Department. Agent CLI vẫn nhận credential của chính nó.
- **Không agent nào được để lại hook hay khóa cấu hình git.** Sau mỗi lượt của Codex, Claude Code hay Antigravity, `.git/config` và `.git/hooks` được so với trước lượt; nếu khác (một hook hay `diff.external`/`filter.*` sẽ chạy code ở lệnh git kế tiếp) thì khôi phục, hoàn tác thay đổi chưa commit và hủy lượt đó.
- **Preview luôn được dừng trước khi bản sao làm việc bị dùng.** Orchestrator báo cho nơi phục vụ preview ngay trước mỗi lượt agent, check hay giao kết quả, thay vì đoán theo URL của request.
- **Yêu cầu "sửa finding" hoặc "chạy lại check" được lưu cùng run** (`pendingAction`): server khởi động lại giữa chừng thì Chạy tiếp vẫn làm đúng việc đó, và nó bị xóa khi bước kết thúc hay khi bạn bấm Dừng.

## Chạy thật trong Docker (cần attestation)

Chạy với Codex/Claude bị chặn cho đến khi operator tạo `.data/attestations/<projectId>.json`.
Đây là xác nhận của người vận hành, hệ thống không tự kiểm chứng các mục `*Verified`.

```json
{
  "version": 1, "projectId": "prj_xxxxxxxx",
  "imageId": "sha256:...", "imageReference": "node:24-bookworm-slim",
  "approvedAt": "2026-10-19T00:00:00Z", "expiresAt": "2026-11-19T00:00:00Z",
  "network": "aidept-agent",
  "providerEgressVerified": true, "nativeToolSurfaceVerified": true, "singleAgentEnforcementVerified": true,
  "providers": { "codex": { "version": "x.y.z", "authVolume": "aidept-codex-auth" } }
}
```

`imageId` phải trùng `docker image inspect --format '{{.Id}}' <image>`. Nếu `singleAgentEnforcementVerified` là false, run Single bị chặn thay vì tự nhận là single-agent.

## Docker

```bash
docker network create aidept-agent
docker build -t aidept-runner -f docker/runner/Dockerfile docker/runner            # CLI thật
docker build -t aidept-runner-stub -f docker/runner/Dockerfile.stub docker/runner  # chỉ để test
AIDEPT_DOCKER_E2E=1 npx vitest run tests/docker.e2e.test.ts
```

E2E kiểm chứng trên Docker thật: `npm ci` trong container, planner/developer chạy trong container, check chạy offline, red/green cho bugfix, checkout gốc không bị đổi, container check offline + root read-only + không thấy path host/Docker socket, attestation sai image/hết hạn/chưa verify bị chặn, check timeout là `incomplete` và container bị dọn. Agent trong E2E là `docker/runner/stub/codex.mjs` (kịch bản cố định): nó chứng minh đường ống, không nói gì về chất lượng agent. `singleAgentEnforcementVerified` và `providerEgressVerified` vẫn là xác nhận của operator, E2E không chứng minh chúng cho CLI thật.

## Repo chưa có test runner

Không cần cài gì: dùng mẫu **node --test** trong form project (Node 24 chạy trực tiếp file .ts). Check ghi report JUnit `.aidept-report.xml` và đồng thời in kết quả dạng spec ra console. Report JSON (Vitest/Jest) và JUnit đều được đọc; report thiếu hoặc không phải một trong hai thì check là `incomplete`, không bao giờ là "pass". Thẻ yêu cầu trong tiêu đề test có thể là `[R-1]`, `[R-1][R-2]` hoặc `[R-1, R-4]`.

Sửa lệnh check/modules/setup của project bằng nút **Sửa** (làm tăng phiên bản policy, cần duyệt lại). Task đang bị chặn vì check sai thì dùng **Chạy lại check (không tốn token)**: chạy lại test trên bản đã làm xong với cấu hình mới, không gọi agent. **Chạy tiếp** thì chạy lại cả giai đoạn implement.

## Quy ước test để có bằng chứng theo yêu cầu

Check cần `reportPath` trỏ tới JSON report kiểu Vitest/Jest, và tiêu đề test gắn mã yêu cầu: `it('[R-1] từ chối đơn trùng', …)`. Test không có thẻ hoặc check thiếu report không tạo bằng chứng cho yêu cầu nào.

## Bộ đo M0

```bash
npm run eval -- validate m0a.json
npm run eval -- register m0a.json          # khóa giao thức bằng hash; sửa sau đó bị từ chối
npm run eval -- assign m0b.json            # sinh 48 assignment từ seed đã đăng ký
npm run eval -- report-m0a m0a.json records.json
npm run eval -- report-m0b m0b.json records.json
npm run eval -- sample-size --delta 0.15 --discordant 0.4 --reps 2 --rho 0.5
```

Báo cáo giữ abstain/lỗi trong mẫu, tính task chưa xong và bản ghi thiếu là "chưa hoàn thành" (ITT), và nói rõ "chưa đủ bằng chứng" khi khoảng tin cậy bao gồm 0. Pilot đạt ngưỡng vẫn không cấp quyền chặn tự động.
