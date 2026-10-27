# Chẩn đoán, căn cứ assertion và phản ví dụ — chính sách v3

> Từ nay Verify mới dùng chính sách v4 ([evidence-v4.md](evidence-v4.md)), siết các fallback dưới đây và thêm vòng regression. Tài liệu này mô tả v3, vẫn áp dụng cho run đã tạo với `qualityPolicyVersion: 3`.

Run Verify mới dùng `qualityPolicyVersion: 3`. Run cũ giữ phiên bản và hash hợp đồng đã lưu; đọc hoặc resume không tự nâng chính sách. Single/Clarify/Compare không tự có thêm lượt Author lập kế hoạch.

## Kế hoạch và assertion

Hợp đồng tiếp tục dùng test-plan schema v2, thêm `reasoningVersion: 1`. Mỗi ca tự động có các bước với `id`, `before`, `action`, `expected`, `after`, `requirementIds`. Ca trạng thái/đồng thời/nhất quán bắt buộc vẫn cần ít nhất hai bước và bất biến. Căn cứ của bước phải thuộc các trích dẫn hiện hành của ca. Thiếu dữ kiện nghiệp vụ phải thành câu hỏi, không được đoán để đi tiếp.

Manifest v2 bổ sung `assertions`: mỗi binding ghi `stepId`, `expected` đúng nguyên văn bước đã duyệt và `expression` đúng biểu thức assertion trong file test. Nếu expression lặp lại, cần thêm `line`. Mỗi bước bắt buộc phải có binding. Trước khi khóa, adapter JS/TS so khớp các call `expect(...).matcher(...)` / `assert(...)` bằng AST; comment không được tính và assertion ngoài khai báo bị từ chối. Source của file test được Author sửa/tạo là phạm vi kiểm tra; không tuyên bố kiểm được helper bên ngoài, alias hoặc framework assertion tùy biến. Ngôn ngữ chưa có adapter ghi rõ chỉ đối chiếu khai báo, kèm cảnh báo nghiệm thu.

Liên kết nguồn chỉ xác nhận trace và cú pháp. Nó không chứng minh expected đúng về nghiệp vụ, assertion đã được thực thi trên mọi nhánh, hoặc toàn bộ hệ thống đã được kiểm tra. Tab Hợp đồng cho xem/sửa trạng thái từng bước; sửa nội dung đổi hash và cần duyệt lại.

### Tham chiếu binding và sửa draft Author

Output Author JS/TS với reporter JSON ưu tiên `bindingProtocol: 2`, `contractHash` và `files:[{path,recipeId}]`. Author đặt `// @aidept-case C-x` ngay trước test có tên tĩnh, `// @aidept-step S-x` ngay trước từng statement assertion trong test. Assertion trong helper ngoài test dùng `// @aidept-bind C-2/S-2,C-3/S-1` liệt kê tường minh các cặp gọi helper đó. Comment chỉ khai báo liên kết; server vẫn đòi assertion thật trong AST. Comment áp dụng statement kế tiếp, không tự truyền tới assertion sau. Server lấy tên describe/test, biểu thức và dòng từ source, expected từ đúng bước; không đoán liên kết theo tag trong tên. Dạng alias, each, skip/only, tên động và stack chưa hỗ trợ không được coi là đã biên dịch manifest hợp lệ.

Protocol tham chiếu JSON `bindingProtocol: 1`, `contractHash` và `entries` vẫn được hỗ trợ. Mỗi assertion chỉ cần `stepId`, `expression`, `line` (khi biểu thức trùng trong file). Server lấy `expected` từ đúng cặp case/bước trong hợp đồng đã duyệt; không dùng AI để viết lại phần này. Nếu Author vẫn gửi `expected` và nội dung sai, validator tiếp tục từ chối. Manifest lưu trữ giữ schema v2 và expected tường minh; output cũ giữ kiểm tra như trước, không sửa hash khi đọc.

Khung prompt liệt kê case, yêu cầu, bước và kết quả đã duyệt. Khi draft v3 không hợp lệ, hệ thống lưu raw output/patch trước khi hoàn nguyên và cho Author **một lượt sửa** trong ngân sách implement hiện có. Marker được lưu trước lời gọi AI, gắn phiên bản hợp đồng, hash/config/checkpoint và draft gốc. Resume/restart hoặc đổi cấu hình không cấp thêm lượt cho cùng phiên bản hợp đồng. Run v3 cũ có draft còn hiệu lực nhưng chưa dùng lượt sửa có thể bấm **Sửa draft và chạy tiếp**; không phải tự nâng policy.

Lượt sửa nhận lỗi đầy đủ và danh mục biểu thức/số dòng thực. Chỉ được sửa metadata và thêm assertion quan sát cho bước còn thiếu: không đổi tên test/recipe/liên kết yêu cầu, không xóa hay sửa assertion cũ, không đổi setup/thao tác hoặc file ngoài phạm vi. Guard cú pháp bảo toàn phần thân ngoài statement assertion và số lần xuất hiện của assertion cũ. Đây là kiểm tra bảo toàn cú pháp, không chứng minh ý nghĩa assertion hoặc helper. Draft cần sửa kỳ vọng nghiệp vụ/fixture setup phải dừng để review, không được tự hợp thức hóa ở lượt sửa định dạng.

Sau sửa, mọi gate scope, manifest, bước bắt buộc và AST đều chạy lại trước checkpoint/khóa; chỉ khi đạt mới sang Developer → checks → mutation phù hợp → Verifier. Sửa thất bại/gián đoạn vẫn giữ draft và hoàn nguyên workspace; bấm Chạy tiếp không gọi Author vô hạn. **Kiểm tra lại output đã lưu** vẫn chỉ kiểm tra đúng draft/hash, không gọi AI.

## Chẩn đoán trước Developer

Output v3 cần `assessment`: expected, actual, vị trí, các ID test thực sự thất bại, oracle và đích sửa. `implementation` chỉ hợp lệ khi đích là source và test phù hợp hợp đồng. Đích test cần conformity=false; `ambiguous` dùng unknown/null. Nhãn, đích sửa và các trường bằng chứng phải nhất quán; server không suy nhãn từ từ khóa trong văn xuôi.

Nếu output sai cấu trúc hoặc tự mâu thuẫn, Author nhận một lượt sửa trong ngân sách hiện tại. Marker được lưu trước khi gọi; gián đoạn/resume không tạo thêm lượt. Hết lượt hoặc thiếu căn cứ thì dừng rõ lý do trước Developer. Lỗi report, môi trường, skip hoặc thiếu bằng chứng vẫn đi qua gate hiện có.

Sửa assertion phải chỉ ra biểu thức trước/sau và căn cứ. Patch được hoàn nguyên khi chờ người dùng duyệt đúng proposal/hash. Sau duyệt, manifest được cập nhật expression, đối chiếu lại source, tạo checkpoint, khóa lại test rồi chạy bằng chứng mới. Lịch sử diagnosis sai và raw output vẫn giữ trong artifact.

## Phản ví dụ của Verifier

Verifier có thể khai báo JSON `reproduction` cho public API Node ESM: module tương đối, factory, tham số và chuỗi method calls có expected. Đối số có thể tham chiếu kết quả trước bằng `{$ref:"S-1",path:["token"]}`. Kết quả mong đợi là `equals` hoặc `throwsCode`, có oracle theo hợp đồng. Không nhận shell command hoặc script tùy ý từ model.

Adapter đầu tiên chạy Local trên bản clone của đúng checkpoint, không dùng dependency ghi chung. Node 24 permission giới hạn filesystem vào clone và không cấp quyền tạo tiến trình con cho module. Worker không kế thừa provider credentials hay NODE_OPTIONS. Đây không phải sandbox mạng/OS hoàn chỉnh; project phải là code người dùng đã cho phép chạy. Module cần dependency ngoài clone, cú pháp TS Node không hỗ trợ, checkpoint có symlink hoặc stack khác có thể chưa chạy được; khi đó ghi unsupported/error và không tính là xác nhận lỗi.

Giới hạn: tối đa 30 giây mỗi probe, 3 probe và 60 giây cho một batch. Mỗi finding/checkpoint/phiên bản hợp đồng/cấu hình/scenario chỉ được thử một lượt tự động. Kết quả lưu quan sát từng bước và phân biệt reproduced, not_reproduced, unsupported, error, timeout, interrupted. Restart đánh dấu lượt dở interrupted; tiến trình có watchdog và các clone tạm được dọn theo workspace của run.

Mismatch là bằng chứng để xem xét oracle, không tự cấp quyền sửa test hay tự xác nhận finding. Sau sửa finding, chỉ tự đánh dấu resolved khi cùng scenario đã reproduced trước sửa và not_reproduced trên checkpoint mới. Checks xanh không thay thế bước này. UI và JSON/Markdown thể hiện cả lịch sử trước/sau cùng giới hạn.

## Xác nhận

```powershell
pnpm build
pnpm test:reliability
```

Regression mới: `reasoning.test.ts`, `diagnosis-v3.test.ts`, `reproduction.test.ts`, `reasoning-ui.test.ts`. Agent là fixture, nhưng test chẩn đoán chạy Vitest thật và replay chạy Node/Git thật. Không dùng quota model. Các fixture v2 được pin phiên bản để giữ kiểm tra tương thích; test mới xác nhận mặc định v3, guard chẩn đoán, sửa assertion có duyệt và runner trước/sau sửa. Số liệu cải thiện tốc độ hoặc tỷ lệ lỗi thực tế cần benchmark model thật tiếp theo; không suy từ fixture.
