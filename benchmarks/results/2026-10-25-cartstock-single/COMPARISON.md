# CartStock — Department và Single, GPT-6 Luna medium

Đã chạy Single run_24c7854e trên cùng SPEC/scaffold/runner, cùng model/effort và trần $10.80 như Department run_3973832e. **Bộ chấm ngoài đã khóa: cả hai 64/64.** Single nhanh hơn tới gate nghiệm thu trong lượt này, nhưng kiểm tra bổ sung sau đọc code phát hiện nhóm lỗi null ở Single. Không sửa candidate sau chấm để làm đẹp kết quả.

| Tiêu chí | Department | Single |
|---|---:|---:|
| Bộ chấm gốc | 64/64 | 64/64 |
| Runner cuối | 13/13, không skip | 16/16, không skip |
| Thời gian pipeline tự động | 361.8 s | 190.2 s |
| Mutation ngoài pipeline | đã nằm trong pipeline | 60.7 s |
| Tự động tính cả mutation ngoài | 361.8 s | 250.9 s |
| Chi phí ước tính | $1.0269 | $1.1433 |
| Lượt model | 6 | 4 |
| Các vai | Planner 1, Author 3, Developer 1, Verifier 1 | Planner 1, Developer 3 |
| Mutation killed / survived / no coverage | 277 / 126 / 47 | 264 / 39 / 7 |
| Chẩn đoán null bổ sung, ngoài grader gốc | 7/7 | 2/7 |
| Trạng thái sản phẩm | completed, giao branch thành công | awaiting_acceptance; chưa giao |

Single của sản phẩm có một Planner và một vai viết code/test/tự review, với nhiều lượt khi cần. Không có Author hay Verifier độc lập. Đây không phải phép so một lời gọi model với sáu lời gọi.

## Diễn biến Single và can thiệp

1. Môi trường host đạt trước Planner. Giữ cùng source product snapshot và project config với Department, HEAD scaffold deed43127fd6d0dc806bbe5a0852ecb540ae2553.
2. Planner tạo 17 yêu cầu. Người vận hành soát và làm rõ một ví dụ thiếu hàng bằng B:3; duyệt đúng hash qua API. R-1 API surface và R-17 scope do Planner đánh dấu manual, được đọc riêng; các yêu cầu tự động R-2..R-16 giữ nguyên. Không thay đổi schema, dependency hay cấu hình.
3. Trước Developer, xóa remote ref tới branch Department trong workspace Single và trỏ origin về scaffold gốc. Planner không có command tool call đọc code. Chỉ đổi Git metadata, không đổi file task; xem pre-developer-isolation.json. Đây là phòng tránh lộ candidate qua thao tác Git thông thường, không phải sandbox bảo mật tuyệt đối.
4. Developer lượt đầu triển khai code/README nhưng không viết test vào runner; runner chỉ chạy smoke 1/1. Hệ thống yêu cầu bổ sung bằng chứng cho R-2..R-16. Agent tự thêm test ở lượt hai.
5. Runner lượt hai đạt 15, fail 1 ở R-12. Test kỳ vọng advance(1) lỗi khi now=0, trái quy tắc thời gian không giảm. Agent sửa test để advance tới 1 rồi kiểm tra advance(0) báo INVALID_TIME. Đây là sửa test đúng hợp đồng, không phải sửa implementation. Diff cuối chỉ đổi 3 dòng trong tests/stockroom.contract.test.js; được giữ tại last-test-correction.patch. Runner cuối 16/16.
6. Bộ chấm ngoài gốc đạt 64/64, không đưa kết quả vào prompt. Chạy Stryker ngoài pipeline trên bản clone đúng checkpoint với cùng cài đặt: tối đa 5 phút, concurrency 2, related=false, chỉ source JS/TS thay đổi. Baseline passed, hoàn tất 60.7 s, không đổi candidate/source/dependency/lockfile.

Các lệnh npm test agent tự chạy trong sandbox báo lỗi môi trường esbuild Access is denied; không tính những lệnh đó là pass. Runner do runtime host chạy đạt thực tế. Thời gian chờ thô trong app gồm review, kiểm tra ngoài và thời gian lập báo cáo; không dùng để kết luận tốc độ model. Mutation Single ngoài luồng được cộng riêng trong bảng để tránh so 190 s với Department vốn đã có mutation.

## Lỗi bổ sung tìm được sau đọc code

Code Single dùng destructuring ngay ở tham số createStockroom/reserve/amend/confirm/cancel. Default ={} chỉ thay undefined, không thay null. Khi truyền null, JavaScript ném TypeError trước khi validator gắn code INVALID chạy. Mình áp dụng cùng 7 probe cho cả hai candidate; Department trả INVALID cả 7, Single sai 5 lời gọi trên, đúng null-stock và null-get.

Căn cứ là điều 1 SPEC: invalid shapes/scalars phải ném Error có code INVALID. Audit diễn giải quy tắc này bao gồm outer options/request null. **Đây là chẩn đoán source-informed sau khi thấy code**, không phải ca held-out đã khóa trước model. Không gộp thành điểm 71 ca, không đổi bộ chấm gốc, không gửi lỗi cho agent sửa để cứu kết quả. Xem edge-audit.mjs / edge-audit.json; lỗi có layer api, cause APPLICATION, confidence high theo phép tái hiện trên mỗi public call.

Single vẫn có completion.ready=true theo bằng chứng sản phẩm đã biết. Mình chưa nghiệm thu/giao branch vì phát hiện nhóm lỗi ngoài bộ chấm; không ghi sai thành run bị hệ thống chặn hoặc pipeline crash.

## Đánh giá

- Hành vi trong bộ chấm đã khóa: hòa 64/64.
- Tốc độ tới gate: Single ít thời gian tự động hơn; tính cả mutation ngoài là 250.9 s so với 361.8 s. Đây chỉ là một lần chạy, không đo mức tăng tốc phổ quát.
- Chi phí: Single $1.14, Department $1.03 trong mẫu này; không thể khẳng định Single luôn rẻ hơn.
- Test cuối Single có ít mutant sống sót/không phủ hơn, nhưng code tạo ra tập 310 mutant thay vì 450. Không dùng mutation score hai codebase khác nhau để chứng minh test Single tốt hơn toàn diện. Không coi số test lớn hơn là chất lượng cao hơn.
- Code Department phòng vệ input null tốt hơn trong audit bổ sung. Không đủ căn cứ quy lỗi/ưu thế này hoàn toàn cho kiến trúc đa tác nhân; có thể là khác biệt implementation/model trong mẫu.
- Department cung cấp kế hoạch độc lập, khóa test trước code và Verifier riêng. Single tự tạo rồi sửa test của mình. Cả hai vẫn cần test ngoài và review; Department Verifier lượt này cũng chỉ review, chưa tự chạy test thêm.

Giữ toàn bộ lượt Department bị chặn trước nâng cấp tại ../2026-10-25-cartstock-v3/ và ../2026-10-25-cartstock-v3-assisted/. Đây là so sánh Single mới với Department thành công sau sửa, không phải sáu lần lặp hoặc bằng chứng thắng chung.

## Bằng chứng

- comparison.json: số đo chi tiết, token, lịch sử checks, phạm vi diễn giải và giới hạn.
- protocol.json, contract-review.json, receipt-*.json: protocol và can thiệp.
- final-detail.json, candidate/, candidate.patch: candidate và lịch sử model.
- latest-grade.json: 64 ca gốc; external-mutation.json và mutation.log: Stryker thật.
- edge-audit.json: 7 probe bổ sung mỗi bên, tách điểm gốc.

[Mở Single](http://127.0.0.1:14343/#/run/run_24c7854e) · [Mở Department](http://127.0.0.1:14343/#/run/run_3973832e)
