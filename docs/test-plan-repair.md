# Sửa bản nháp kế hoạch ca trước khi duyệt

Verify tạo kế hoạch với Author trước Developer. Server kiểm tra cấu trúc, trích dẫn, liên kết yêu cầu, nhóm rủi ro và ca tự động bắt buộc. Kiểm tra này không chứng minh kết quả mong đợi đúng về nghiệp vụ.

Output Author v2 mới khai báo liên kết một lần trong `oracle.references`. Server lấy các `requirementId` đã được Author chọn để tạo `requirementIds` của ca trước khi kiểm tra. Server không chọn điều khoản thay Author. Nếu output vẫn khai báo cả hai trường, chúng phải khớp theo validator; server không tự ghép chúng để che lỗi.

Hợp đồng lưu trữ vẫn dùng schema v2 hiện có. Đọc hợp đồng, sửa thủ công trong form hoặc đọc benchmark cũ không tự thêm trường, đổi phiên bản hoặc đổi hash.

## Một lượt sửa trong ngân sách

Nếu bản nháp có lỗi định dạng hoặc lỗi validator, Author nhận bản nháp và toàn bộ lỗi để sửa một lần. Hai lượt đều chỉ đọc, nằm trong giai đoạn `prepare` và dùng ngân sách hiện có. Dấu nhận diện lượt sửa được lưu trước khi gọi model. Dừng, restart hoặc resume không cấp thêm lượt cho bản nháp đó.

Lượt sửa không được xóa/đổi mã ca duy nhất, bỏ liên kết tới yêu cầu có thật, giảm mức rủi ro cao, hạ ca bắt buộc hoặc chuyển ca tự động thành thủ công. Ca trùng mã có thể được cấp mã riêng khi từng kịch bản được đối chiếu đủ với nội dung ban đầu; không gộp mất ca. Mã yêu cầu không tồn tại có thể được sửa về mã thật. Kế hoạch bị sửa yếu đi được từ chối và bản đầu được giữ để người dùng chỉnh.

Câu hỏi chưa giải quyết phải được giữ nguyên, kể cả khi nằm trong JSON chưa hợp lệ theo schema. Nếu chỉ còn câu hỏi, hệ thống chuyển thẳng sang bước người dùng xem; không gọi Author để tự đoán câu trả lời. Prompt yêu cầu tránh hỏi lại điều SPEC đã nói rõ không quy định. Mọi câu hỏi còn lại tiếp tục chặn duyệt theo policy hiện tại.

Nếu hết ngân sách, bản nháp đọc được vẫn được lưu trong Hợp đồng. Nếu output không đọc được sau lượt sửa, run bị chặn và raw output/lỗi trường được giữ trong artifact. Lỗi runtime hoặc gián đoạn không được coi là sửa thành công. Sau khi sửa hợp lệ, vẫn cần người dùng duyệt trước khi Author viết test và Developer chạy.

## Theo dõi và thao tác

Tab Hợp đồng hiển thị kế hoạch hợp lệ ngay lượt đầu, đã sửa hợp lệ, hoặc còn cần người dùng xử lý. Mở phần lỗi bản nháp đầu để xem toàn bộ lỗi và output. Đọc câu hỏi, sửa hợp đồng theo yêu cầu thực tế rồi duyệt hash mới. Không tự xóa câu hỏi để bật nút duyệt.

`RunDetail.planReview`, báo cáo JSON/Markdown và artifact `Test plan review` ghi số lượt, trạng thái hợp lệ lần đầu, có dùng lượt sửa hay không, kết quả và lỗi còn lại. Metadata chỉ dùng cho đúng hash/phiên bản hợp đồng; sửa nội dung sẽ làm bản thống kê đó hết hiệu lực. Artifact cũ vẫn giữ lịch sử. Sự kiện `execution.retry` có lý do `invalid_output` để thống kê thời gian/lượt chạy lại theo cơ chế hiện tại.

## Kiểm tra

Regression nằm ở `tests/testplan-repair.test.ts`, thuộc danh sách tường minh `test:reliability`. Fixture dùng agent giả, không dùng model thật. Bao gồm liên kết một nguồn, dữ liệu cũ/hash, sửa thành công, câu hỏi, chống giảm ca, ngân sách, gián đoạn/restart, UI và báo cáo. Nhóm quality, API và runtime hiện có tiếp tục kiểm tra khóa test, bằng chứng và nghiệm thu.

Chạy `pnpm build` và `pnpm test:reliability`. Nếu pnpm ở máy hiện tại tự kiểm dependency và dừng vì build script chưa được phê duyệt, có thể chạy các lệnh tương đương với dependency đã cài:

```powershell
node node_modules/typescript/bin/tsc --noEmit
node node_modules/vite/bin/vite.js build
node scripts/test-reliability.mjs
```

Fixture chứng minh giới hạn và chuyển trạng thái hoạt động. Tỷ lệ tự hoàn tất và thời gian thực tế cần đo ở các run model mới; không suy kết quả đó từ test fixture.
