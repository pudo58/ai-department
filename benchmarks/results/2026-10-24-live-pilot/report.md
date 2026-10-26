# HoldStock: AI Department và một agent GPT 6 Luna

Đây là pilot chạy model thật qua kết nối CLI đã có. Single dùng GPT 6 Luna; Department Verify dùng GPT 6 Luna ở Planner/Developer và Claude Haiku 5.5 ở Author/Verifier. Hai bên xuất phát từ cùng commit 82844293d04203b84b1f1579b8980b51c1c19a62, cùng SPEC, cùng quyền sửa logic nghiệp vụ/test và giới hạn thời gian 15 phút. Bộ chấm 33 ca được khóa trước khi gọi model; bản gốc giữ nguyên hash a8d74b203e64503cedb5cdf9729cbaae0725474feb2d36c3b2431f5a0515027e. Kết quả dùng bản sửa lỗi gọi sync/async được công khai bên dưới, không sửa input/assertion.

Kết quả chính: hai bên cùng đạt 33/33 ca hợp lệ, nhưng cùng bỏ sót đối số null ở bốn điểm vào. Với bài toán nhỏ và đặc tả rõ này, Single cho kết quả tương đương nhanh hơn nhiều và không cần chỉnh kế hoạch. Department có thêm dấu vết kiểm chứng và tìm ra một phần lỗi null qua Verifier, nhưng vẫn kết luận pass và chưa yêu cầu sửa.

## Kết quả đo được

| Chỉ số | Single | Department Verify |
|---|---:|---:|
| Bộ chấm ngoài | 33/33 | 33/33 |
| Điểm trên 33 ca đã định trước, sau sửa lỗi test harness | 10/10 | 10/10 |
| Probe null bổ sung ngoài điểm chính | 0/4 đạt | 0/4 đạt |
| Thời gian toàn lượt | 65.0s | 684.9s |
| Tổng thời gian các lượt agent | 65.0s | 561.9s |
| Lượt gọi agent | 1 | 5 |
| Input tokens, gồm phần cached | 290097 | 3126546 |
| Cached input | 272384 | 2918421 |
| Output tokens | 4301 | 104885 |
| Can thiệp chỉnh kế hoạch trước triển khai | 0 | 9/20 ca, giải quyết 5 câu hỏi |
| Trạng thái workflow | Native CLI completed | awaiting_acceptance |

Tokens của hai hãng không phải đơn vị chi phí tương đương. CLI dùng gói thuê bao; không có hóa đơn tiền thực cho từng task. Native fallback estimate là $0.1994, Department app ghi $0.4308, nhưng app tính Claude subscription bằng 0 và Codex bằng ước lượng; KHÔNG lấy hai số này để tuyên bố bên nào rẻ hơn.

Hai bên cùng giới hạn 15 phút. Department có trần $6 trong cơ chế tính của app; native không có giới hạn USD tương đương do provider cưỡng chế. Vì vậy đây không phải so sánh cùng ngân sách tiền thực. Department mất khoảng 10.5 lần thời gian wall của Single trong lượt này, có gồm duyệt kế hoạch và sai lệch cài dependency.

| Nhóm ca ngoài | Single | Department |
|---|---:|---:|
| happy | 2/2 | 2/2 |
| invalid | 5/5 | 5/5 |
| idempotency | 8/8 | 8/8 |
| authorization | 3/3 | 3/3 |
| state | 4/4 | 4/4 |
| expiry | 5/5 | 5/5 |
| concurrency | 2/2 | 2/2 |
| isolation | 4/4 | 4/4 |

## Những gì thực sự được so sánh

Hai model viết src/inventory.js cho inventory giữ hàng trong bộ nhớ: idempotency theo cặp user/key, validation, quyền, hết hạn tại biên, confirm/cancel và bất biến số lượng khi nhiều lời gọi cùng lúc. HTTP server và HTML demo là scaffold chung viết trước bài thử. Bộ chấm không được đặt trong hai project và không đưa kết quả lỗi cho model để sửa.

Single tự test 6 ca bằng Vitest; host chạy lại đạt 6/6. Nó gặp lỗi loader cấu hình trong sandbox và tự chọn --configLoader runner; host chạy lệnh mặc định vẫn đạt. Native output đã chụp thành checkpoint aa994f25ca6e5add8165f4072b9a736b44f9655f. File ngoài scope bị thay đổi: 0.

## Công hỗ trợ và sai lệch cần giữ rõ

Department chưa tự đi hết từ đề bài đến code mà không hỗ trợ. Haiku đề xuất 20 ca và 5 câu hỏi; trợ lý điều phối này đã sửa 9 mô tả ca theo SPEC, rồi duyệt. Ví dụ: không yêu cầu API được phép async phải trả object ngay khi không await; không yêu cầu cancel thành công sau confirm; tách fixture để ca hợp lệ không vô tình thiếu hàng. Đây là hỗ trợ bởi AI điều phối ngoài hai model trong app, không phải số đo công người dùng thật. Chi tiết trước/sau: plan-review-interventions.json. Không sửa implementation hoặc test source thay hai bên.

Script chuẩn bị dependency của pilot bỏ qua EEXIST trong khi GitWorkspaces tạo node_modules rỗng; Department Author phải tự cài tool. Native nhận junction có sẵn. Đây là lỗi môi trường của bài thử, không quy thành lỗi điều phối của sản phẩm; thời gian wall có gồm phần này. Xem provisioning-deviation.json.

Kết quả một task tổng hợp và một lượt chạy không đủ suy ra tỉ lệ giảm lỗi, chi phí trung bình hoặc hiệu quả trên project lớn. Điểm /10 ở đây chỉ là tỉ lệ đạt 33 ca theo quy tắc đã khóa, không thay thế điểm đánh giá toàn sản phẩm.

## Lỗi của bộ chấm và probe bổ sung

Ca C01 ban đầu gọi reserve trực tiếp trong Array.from rồi mới đưa mảng vào Promise.allSettled. Hàm sync ném OUT_OF_STOCK khiến mapper thoát trước allSettled; hàm async của Single không gặp lỗi này. Đây là lỗi TEST_SCRIPT vì SPEC cho phép cả sync và async. Bản gốc grade.mjs và kết quả 32/33 không hợp lệ của Department được giữ lại. grade-compatible.mjs chỉ thêm async vào mapper; cùng input, assertion và số ca, áp dụng lại cho cả hai code đã đóng băng. Hash bản sửa 22db6146fcdf6c5d7f8b9f994fb85a5b1c81dd40db3fa757e1f20664288db953; chi tiết evaluator-correction.json. Không sửa implementation để đạt điểm.

Đọc code sau khi chốt đầu ra phát hiện destructuring null trước validation. Probe ngoài bộ chấm ban đầu kiểm tra createInventory(null), reserve(null), confirm(null), cancel(null): cả hai bản đều thất bại 4/4, cùng một nhóm lỗi validation ở bốn điểm vào. Qua HTTP adapter chung, POST /api/reserve với JSON null trả 500 INTERNAL_ERROR thay vì 400 INVALID_INPUT ở cả hai. Bằng chứng: native-exploratory.json, department-exploratory.json, null-http-diagnostic.json. Không cộng các ca post-hoc này vào mẫu đã khóa hay gộp thành điểm mới.

Haiku Verifier đã ghi finding minor về null nhưng vẫn decision pass. Phần evidence còn nói gọi không tham số cũng lỗi tương tự; probe trong bộ 33 ca cho thấy gọi thiếu tham số được xử lý đúng, nên finding này đúng một phần và mô tả quá rộng. Điều kiện nghiệm thu app vẫn ready=true vì các ca khai báo đạt và finding là minor. Run giữ awaiting_acceptance; chưa giao/nghiệm thu bản biết còn lỗi.

Mutation Department chạy thật trong clone riêng: baseline passed, 125 killed, 20 survived, 0 timeout, 35.1 giây. Mutant sống không đồng nghĩa từng mutant là lỗi nghiệp vụ. Single không được chạy mutation trong lượt này, nên không so sánh mutation score giữa hai bên. Tổng test nội bộ Department: 36 (20 Author, 15 Developer, 1 smoke scaffold); số lượng test không thay cho chất lượng đầu ra.

## Trạng thái demo và code

- Single: C:/Users/ADMIN/OneDrive/Desktop/ai-department-pilot-20261024/single; demo http://127.0.0.1:14331.
- Department: export checkpoint d51806489ea3acab655fa31d6ab5a2df4d72ed29 tại C:/Users/ADMIN/OneDrive/Desktop/ai-department-pilot-20261024/department-result; demo chạy từ workspace đã chấm tại http://127.0.0.1:14332.
- Run app: http://127.0.0.1:4310/#/run/run_c35ae023; trạng thái chờ nghiệm thu, chưa chấp nhận lỗi thay người dùng.
- HTTP smoke đạt cho cả hai. Kiểm tra hình ảnh bằng công cụ trình duyệt bị chặn do Work settings tắt local browser use; không tuyên bố đã kiểm tra UI trực quan ở lượt pilot này.

Ưu tiên rút ra từ pilot: kiểm tra chất lượng kế hoạch ngay từ đầu (ngăn luồng mâu thuẫn), đưa validation toàn đối số vào ma trận ca, và yêu cầu đánh giá rõ vi phạm hợp đồng đã có bằng chứng thay vì để severity minor biến thành pass dễ dàng. Chưa sửa AI Department hoặc hai đầu ra trong pilot để giữ phép so sánh nguyên vẹn.

## Ca Department không đạt

Không có ca nào thất bại trong bộ chấm này.

## Bằng chứng và chạy lại

- protocol.json: cấu hình/đề bài/hash trước khi gọi model.
- native-raw.jsonl, native-result.json, native-capture.json: log và đầu ra Single.
- department-detail.json, department-history.jsonl: run/attempt/check/artifact thật từ API.
- native-grade.json, department-grade.json: từng ca của bộ chấm ngoài.
- comparison.json: dữ liệu tổng hợp; mutation và findings giữ trong trường quality/findings.
- Project: C:/Users/ADMIN/OneDrive/Desktop/ai-department-pilot-20261024.

Chấm lại: node grade-compatible.mjs <thư-mục-candidate> <file-kết-quả.json>. Probe null: node exploratory.mjs <thư-mục-candidate> <file-kết-quả.json>. Các lệnh chạy từ thư mục evidence; không gọi AI. Code AI Department gốc và những thay đổi chưa commit trước pilot được giữ nguyên; pilot chỉ tạo project/data/evidence riêng.
