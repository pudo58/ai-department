# Thực thi, môi trường và phục hồi Author

## Giảm điểm dừng Author (2026-10-25)

Prompt kế hoạch có bảng requirementId/quote nguyên văn và đủ bảy nhóm rủi ro do server sinh. Manifest tiếp tục lấy mã ca/liên kết từ kế hoạch đã duyệt; server không tự chọn oracle hoặc sửa expected. Author được nhắc giữ file bảo vệ và dùng helper nhận thunk để bắt cả exception đồng bộ và Promise rejection.

Parser nhận fenced JSON, JSON thuần hoặc một giá trị JSON hoàn chỉnh đứng ở cuối phản hồi sau phần giải thích. Không sửa JSON hỏng, không bỏ schema validator, không cứu khối fenced bị hỏng bằng một kết quả khác. Resume có thể đọc lại raw diagnosis của attempt đã hoàn tất đúng checkpoint/hợp đồng/slot/cấu hình và hash; không cấp lượt AI mới. Chỉ kết luận implementation hợp lệ mới được dùng lại tự động; sửa test vẫn cần proposal/diff được duyệt.

Trước khóa, project JS/TS có yêu cầu sync/async được kiểm tra tĩnh mẫu `expect(call()).rejects`. Author có tối đa một lượt sửa chung với lỗi file không phải test; patch trước được lưu vào artifact bị từ chối và hoàn nguyên. Nếu chỉ sửa nhầm file test được bảo vệ, cùng một lượt sửa này yêu cầu giữ nguyên file đó; không nới scope và vi phạm lần hai vẫn chặn. File source/config bảo vệ hoặc ngoài scope chặn ngay. Kiểm tra này không phải chứng minh chất lượng test: chưa phân tích mọi helper tùy biến hoặc mọi ngôn ngữ, chưa thay thế discovery/checks/mutation. Ví dụ `expect(Promise.resolve().then(() => call())).rejects` bắt được cả hai kiểu lỗi.

EscrowBatch tiếp tục có hỗ trợ của người vận hành: diff setup đưa helper apply thành async và trì hoãn advance; diff kế tiếp sửa revision đầu vào C-14 từ 3 thành 4 theo điều khoản expiry. Duyệt bằng proposal hash qua cơ chế hiện có, không sửa source hoặc giá trị assertion để chiều implementation. Hồ sơ mới ở `test-results/2026-10-25-escrowbatch/department-assisted/`; benchmark gốc giữ nguyên.

Run mới lưu thời gian hàng đợi, setup, preflight, chờ slot agent, từng lượt agent, check, mutation và chờ duyệt. Thời gian tự động được tính bằng hợp các khoảng thực tế, không cộng chồng. Token từ CLI có thể gồm nhiều lượt công cụ trong một attempt; độ dài prompt được ghi riêng trong artifact `Agent input receipt`. Run cũ chưa có dữ liệu hiện “Chưa có số đo”.

## Môi trường

Sau setup và trước Planner, runtime kiểm tra runner ngay trong workspace. Adapter hiện có: Vitest và Jest với lệnh trực tiếp hoặc script package đơn giản chỉ gọi runner. Lệnh phức tạp hay stack khác trả `unsupported`, không được gọi là đã xác nhận nhưng vẫn tiếp tục checks thông thường.

Preflight kiểm tra phiên bản, tải cấu hình và discovery trong tổng giới hạn 60 giây, không chạy assertion để đòi baseline xanh. Lỗi dependency/executable/config xác định được sẽ chặn trước AI. Lỗi collection từ code chưa triển khai được hiển thị là chưa xác nhận đầy đủ, không tự kết luận hạ tầng hỏng. Config của project có thể thực thi trong discovery với quyền runtime hiện tại; host preflight không chứng minh quyền chạy lệnh trong sandbox riêng của agent.

Sau khi sửa môi trường, chọn **Kiểm tra lại môi trường**. Thao tác này không clone, không tự cài dependency và không gọi AI. Nó trả run về tạm dừng; chọn Chạy tiếp hoặc Chạy lại check tùy bước muốn tiếp tục.

Nếu task đang chờ duyệt hợp đồng hoặc chờ nghiệm thu, kiểm tra môi trường giữ lại bước chờ đó. Receipt được kiểm tra lại khi cấu hình thay đổi hoặc có lỗi môi trường mới hơn; không dùng một lần preflight đạt cũ để bỏ qua dependency đã bị xóa. Lệnh `npx vitest/jest` được probe qua CLI đã cài trong project; không để npx tự tải tool. Sau restart, probe không tự cài lại toolchain.

## Draft Author

Output manifest không hợp lệ được lưu cùng patch test, attempt, checkpoint xuất phát, hash hợp đồng và cấu hình trước khi hoàn nguyên. Draft không được tính là test nghiệm thu đã khóa.

**Kiểm tra lại output đã lưu** hữu ích sau khi parser được sửa. Hệ thống không sửa nội dung, tag hay assertion để cho qua. Nếu raw output vẫn sai, run tiếp tục bị chặn. Chỉ draft còn khớp toàn bộ phiên bản, chỉ sửa file test được phép và áp dụng được patch mới được tạo checkpoint và khóa manifest. Thao tác không gọi agent; bấm Chạy tiếp sau khi phục hồi để bắt đầu Developer.

## Chẩn đoán và Verifier

Resume sau check lỗi phân loại bằng chứng trước Developer. Report/môi trường/định danh/thiếu hoặc skip test cần xử lý bằng chứng; không gọi Developer để che lỗi. Assertion fail có danh tính đúng vào lượt Author chẩn đoán có giới hạn. Test sửa vẫn cần đọc diff và duyệt; kết luận cũ không cấp thêm lượt chẩn đoán sau restart hoặc thay checkpoint.

Verifier ghi phạm vi review, ID check hiện hành, giới hạn và lệnh kiểm tra thêm. Tham chiếu sai phiên bản bị từ chối. Khai báo lệnh đã pass nhưng không có bằng chứng thực thi được hiển thị chưa xác nhận. Lệnh lỗi quan sát được từ provider phải xuất hiện trong báo cáo. Một verdict pass không có nghĩa Verifier đã tự chạy test thành công. Cảnh báo vẫn cần xác nhận và không vượt qua blocker.

## API

- `POST /api/runs/:id/preflight`, body `{}`: kiểm tra lại môi trường bằng cấu hình project đã duyệt.
- `POST /api/runs/:id/revalidate-author-output`, body `{ "attemptId": "...", "draftHash": "..." }`: kiểm tra và phục hồi draft còn khớp.
- Cần CSRF token như các action hiện có. Payload sai trả 400; hash/trạng thái cũ hoặc đang giao kết quả trả 409. Action chạy qua hàng đợi; không chạy đồng thời với agent.
- Dữ liệu mới nằm trong `RunDetail.execution`, `environment`, `authorDraft` và báo cáo JSON/Markdown. Hợp đồng cũ không được tự nâng phiên bản khi đọc.

## Xác nhận

Chạy `pnpm build` và `pnpm test:reliability`. Regression mới nằm trong `tests/execution-speed.test.ts` và `tests/execution-speed-ui.test.ts`. Fixture trình duyệt không dùng model thật: `node --import tsx tests/fixtures/execution-speed-ui.ts` (cổng 14339).

`tests/author-draft-local.test.ts` dùng Git và Vitest thật để phục hồi draft trước checkpoint đầu tiên. Nhóm reliability dùng tối đa 2 worker ngoài vì Stryker tự sinh thêm worker; không thay deadline hay assertion của fixture mutation. `check_failure` là lý do chạy lại check trước khi biết lỗi thuộc implementation hay test, tránh ghi nhầm nguyên nhân.

Đối chứng ReplayGate lưu ở `test-results/2026-10-24-speed`: protocol khóa trước run đầu, snapshot baseline gồm thay đổi chưa commit, ba run mỗi nhóm, cùng GPT-6 Luna medium và cùng grader. Không sửa output thay model hoặc retry run lỗi để cải thiện kết quả. Báo cáo chỉ công bố mức tăng tốc đến hoàn tất nếu có đủ run hoàn tất ở cả hai nhóm; run dừng sớm không được coi là nhanh hơn.
