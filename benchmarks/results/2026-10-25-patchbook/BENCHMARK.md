# PatchBook — benchmark Department vs Single

Ngày 2026-10-25 (Asia/Bangkok). Hai nhánh dùng **GPT-6 Luna medium**, cùng SPEC/scaffold/tool và trần **$10.80**. Một lượt mỗi nhánh, Department chạy trước. Kết quả theo SPEC: **cả hai 94/94 ca đủ căn cứ đạt**; Single nhanh và rẻ hơn trong cặp thử này. Có một lỗi giả định trong grader được thẩm định riêng, không che kết quả gốc.

## Bài toán và điều kiện

PatchBook là module JSON in-memory có put/remove/check/move theo lô nguyên tử, revision, path escaping, own/prototype keys, array insertion và destination sau removal, replay receipt lịch sử và snapshot/restore. Source ngắn nhưng các bước có thể ảnh hưởng trạng thái các bước sau. Yêu cầu: [SPEC.md](SPEC.md).

Hai repository được clone từ cùng commit a3b6308a3e65ad27af5fff9ea1ba3d2a4c07085b trước bất kỳ lượt model nào. Department không thể ghi branch kết quả vào repo Single. Guidance cấm đọc dự án/candidate/nhánh khác và grader/reference; model không được cung cấp kết quả ngoài để sửa bài. Product source kể cả thay đổi chưa commit đã snapshot/hash trước chạy; không sửa giữa benchmark. [protocol.json](protocol.json), [source-manifest.json](source-manifest.json).

Single ở đây là chế độ Single của sản phẩm: Planner và một vai viết code/test/tự review qua nhiều lượt; không phải một lời gọi model duy nhất. Không có Author hoặc Verifier độc lập ở Single.

## Kết quả

| Tiêu chí | Department Verify | Single |
|---|---:|---:|
| Ca đủ căn cứ SPEC | **94/94** | **94/94** |
| Kết quả grader gốc, giữ nguyên | 95/95 | 94/95 |
| Tới gate chờ nghiệm thu | đạt | đạt |
| Runner cuối | 13/13, 0 skip | 13/13, 0 skip |
| Thời gian pipeline tự động | 7m 33.6s | 2m 27.0s |
| Mutation ngoài pipeline | đã nằm trong pipeline | 82.6 s |
| Tự động tính cả mutation ngoài | **7m 33.6s** | **3m 49.6s** |
| Chi phí ước tính | $1.2091 | $0.6405 |
| Lượt model | 6 | 3 |
| Lượt theo vai | Planner 1, Author 3, Developer 1, Verifier 1 | Planner 1, Developer 2 |
| Sửa hợp đồng bởi người vận hành | 1 | 0 |
| Mutation killed | 395 | 392 |
| Mutation survived / no coverage | 60 / 8 | 100 / 10 |
| Mutation timeout / error / pending | 2 / 0 / 0 | 2 / 0 / 0 |
| Giao branch | succeeded | chưa nghiệm thu do giữ protocol gốc |

Single ít thời gian tự động hơn khoảng 49.4% khi đã cộng mutation ngoài, và chi phí ước tính thấp hơn 47.0%. Chỉ là số đo của cặp run này, không phải mức tăng tốc chung. Chi phí do sản phẩm ước tính từ token/cache theo fallback rate, không phải hóa đơn provider.

Thời gian chờ thô: Department 260.9 s, Single 353.9 s. Các số này gồm review, thao tác benchmark, riêng Single có cả mutation ngoài và thẩm định grader; không dùng làm phép đo tốc độ model/human effort công bằng. Token, từng span và lượt được giữ ở comparison.json / detail files.

## Bằng chứng chất lượng và lịch sử sửa

**Department:** Planner đề xuất hợp đồng, Author lập kế hoạch rồi sửa một lượt theo validator. Còn lỗi oracle ở C-10 và một lỗi ngữ nghĩa C-7: cho rằng check thành công giữ revision 0. Người vận hành sửa kế hoạch qua API/hash trước Developer: check-only batch thành công phải tăng revision, các check thất bại sau đó dùng revision mới. Giữ đủ 12 ca bắt buộc, làm rõ null-read mutation và array lookup/put để tránh assertion trái hợp đồng; xem department-contract-review.json và receipt-1/2.

Author viết test đạt ngay lượt đầu, server tạo/khóa manifest cho 12 ca và 54 assertion thật. Developer triển khai một lượt; checks 13/13. Stryker baseline passed, completed 63.1 s. Verifier pass 0 finding nhưng nêu rõ không tự chạy test thêm; chỉ review và tham chiếu runner. Người vận hành đọc module/README cho R-16, xác nhận cảnh báo mutation và phạm vi Verifier rồi nghiệm thu; branch aidept/run_627ff9de-A trỏ đúng 9c9f1a09b0b505b00038c94a4dfe797a70f62528. Không merge/push.

**Single:** Planner/hợp đồng đủ dùng, được duyệt không sửa. Developer lượt đầu viết implementation/README, chạy smoke và một số probe nhưng không đưa test nghiệm thu vào report; runner chỉ 1/1 smoke. Hệ thống yêu cầu thêm bằng chứng. Developer lượt hai thêm 12 test, runner cuối 13/13. Diff lượt hai chỉ có tests/patchbook.test.js (171 dòng); implementation đầu và cuối giống nhau theo Git blob hash. Không có code sửa tay; xem single-repair.patch. Mutation ngoài luồng baseline passed, completed 82.6 s trên clone đúng checkpoint; candidate giữ sạch, HEAD không đổi.

Hai bộ test cuối cùng đều đạt, nhưng không lấy số lượng test/assertion để tuyên bố đầy đủ. Bộ chấm ngoài gồm ca độc lập và 8 chuỗi 80 thao tác/seed đối chiếu mô hình array riêng. Reference đạt 95/95; scaffold chỉ đạt 1/95 (exports); cả 10 mutant cài cố ý bị bắt trước model. Mutant audit là kiểm tra grader, khác với Stryker trên candidate.

## Lỗi grader: giữ dữ liệu gốc, không phạt yêu cầu không có trong SPEC

Ca D05-invalid-restore- truyền **[]** vào restorePatchBook và bắt buộc Error.code INVALID. SPEC điều 8 chỉ bắt buộc null/non-object outer arguments lỗi INVALID và chỉ yêu cầu restore đúng các snapshot do implementation tạo; mảng là một object JavaScript không-null, không phải snapshot đã tạo. Grader đã thêm một yêu cầu ngoài hợp đồng.

Single không ném lỗi tại lời gọi này; mọi ca còn lại đạt. Department kiểm tra chặt hơn và ném INVALID. Không đủ căn cứ gọi khác biệt này là bug chức năng của Single. Một biến thể reference chỉ đổi guard outer từ plain object sang non-null object, giữ mọi hành vi bắt buộc khác, cũng đạt 94/95 và chỉ lệch đúng ca đó. Bằng chứng: [grader-adjudication.json](grader-adjudication.json), spec-audit-reference.mjs và spec-audit-reference-grade.json.

Không sửa SPEC, grader gốc, candidate hoặc output cũ; giữ raw Department 95/95 và Single 94/95. Ca không có căn cứ được giữ với trạng thái **unscored** trong so sánh áp dụng cho cả hai; 94 ca còn lại đều đạt. Không gọi thêm model và không gửi kết quả grader vào prompt để cứu bài. Đây là thẩm định lỗi script benchmark sau chạy, không phải một lần benchmark mới hay âm thầm nới assertion.

Protocol gốc yêu cầu grader đạt toàn bộ trước giao branch. Department đã nghiệm thu theo protocol đó. Single vẫn awaiting_acceptance dù completion.ready=true và runner xanh; mình giữ chưa giao theo protocol gốc. Đây là quyết định vận hành benchmark vì lỗi grader, **không** tính thành thất bại hoàn thành pipeline của Single.

## Nhận xét

Chưa có bằng chứng Department tạo code đúng hơn Single ở bài này: mọi ca đủ căn cứ cùng đạt, implementation Single cũng không cần sửa ở lượt thêm test. Single ít thời gian/model/cost hơn. Department có kế hoạch độc lập, test khóa trước code, mutation và Verifier riêng; các gate đó tăng căn cứ và khả năng kiểm toán nhưng chưa biến thành ưu thế hành vi trong mẫu này. Author vẫn cần người sửa oracle, còn Verifier chưa tự chạy thêm test.

Mutation Department có ít survived/no-coverage hơn, nhưng hai codebase tạo 465 và 504 mutant khác nhau. Không so thẳng mutation score để suy chất lượng test tuyệt đối. Hai timeout mỗi bên không được tính thành killed/test bắt lỗi nghiệp vụ. Chưa có finding mới để xác nhận đường replay; không báo đã chứng minh tính năng đó qua run này.

Một cặp chạy, thứ tự cố định, review có con người và bộ chấm có một lỗi giả định không cho phép kết luận kiến trúc nào tốt hơn nói chung. Bài học đo được: với module này, Single đạt cùng hành vi được kiểm chứng với ít chi phí/thời gian hơn; cần benchmark nhiều dạng task và nhiều lần trước quyết định mặc định.

## File và cách kiểm tra

- comparison.json: số đo, nhóm kết quả và giới hạn.
- department-final-detail.json / single-final-detail.json: raw attempts, artifacts, receipts, checks, budget, timing.
- department-latest-grade.json / single-latest-grade.json: giữ kết quả 95 ca gốc.
- department-final-report.json / single-final-report.json: báo cáo nghiệm thu sản phẩm.
- candidate-department/ / candidate-single/: source, tests, SPEC, README, package và config; không có node_modules/.git.
- source-department.zip / source-single.zip: bản gọn để tải xem/chạy.
- grader-audit.json, reference-grade.json, scaffold-grade.json, audit/: kiểm tra bộ chấm trước model.

Từ repo root, không gọi model:

```powershell
node test-results/2026-10-25-patchbook/grade.mjs test-results/2026-10-25-patchbook/candidate-department test-results/2026-10-25-patchbook/department-recheck.json
node test-results/2026-10-25-patchbook/grade.mjs test-results/2026-10-25-patchbook/candidate-single test-results/2026-10-25-patchbook/single-recheck.json
```

Đó vẫn là grader gốc với ca [] chưa có căn cứ; đọc kèm adjudication, không diễn giải raw 94/95 thành bug đã xác nhận.

[Mở Department](http://127.0.0.1:14345/#/run/run_627ff9de) · [Mở Single](http://127.0.0.1:14345/#/run/run_509fd9fe)
