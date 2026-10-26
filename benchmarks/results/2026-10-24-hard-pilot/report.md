# LeaseQueue: pilot khó hơn, model thật

Single: GPT 6 Luna, medium. Department Verify: GPT 6 Luna Planner/Developer và Claude Haiku 5.5 Author/Verifier. Cùng SPEC, base commit 5c79a3254f31fc9f546385f880207e8aedac555e, Node 24, Vitest 3.2.4, Stryker 9.6.1 và lệnh test --configLoader runner. Dependency preflight xác nhận cả thư mục node_modules rỗng do runtime tạo được thay bằng junction đúng. Khác lượt HoldStock, không để agent phải cài dependency vì lỗi helper.

## Kết quả

| Chỉ số | Single không hỗ trợ | Department tiếp tục có hỗ trợ metadata/duyệt |
|---|---:|---:|
| Bộ chấm ngoài đã khóa | 41/42 | 42/42 |
| Điểm riêng trên bộ ca | 9.8/10 | 10/10 |
| Wall time đến trạng thái cuối | 106.4s | 880.8s |
| Tổng thời gian agent | 106.4s | 808.3s |
| Lượt gọi | 1 | 4 |
| Input gồm cache | 333715 | 3079368 |
| Cached input | 297344 | 2838661 |
| Output | 8415 | 168864 |
| Trạng thái workflow | CLI completed | failed |

Điểm chỉ là tỉ lệ ca của task LeaseQueue, không phải chấm chung sản phẩm. Department dừng ở bước checks do một test nghiệm thu thất bại; mutation và Verifier chưa chạy. Wall time Department gồm chờ duyệt, các lượt agent và checks đã chạy. Hai bên được phép tối đa 20 phút, nhưng Department không dùng hết trần. Department có trần kế toán app $6; Single không có provider-enforced cash cap tương đương. Không so tiền thực giữa hai gói thuê bao. App Department ghi $0.5664; Single fallback estimate $0.3245; giá trị này không so sánh trực tiếp vì Claude subscription bị tính 0 trong app.

### Cách đọc kết quả

**Về hành vi theo bộ chấm ngoài:** Department nhỉnh hơn 1 ca (42/42 so với 41/42). Cả hai xử lý đủ các nhóm queue khó như CAS contention giữa hai instance, lease, replay idempotent, restart persistence và cách ly tenant. Single bỏ lọt validation payload sai; HTTP diagnostic sau đó xác nhận null, số, chuỗi và boolean đều được chấp nhận và lưu. Department trả INVALID_INPUT cho cả bốn loại này.

**Về khả năng tự hoàn tất qua sản phẩm:** lượt Department ban đầu bị chặn trước Developer do output Planner không parse được và metadata Author sai schema. Sau can thiệp được ghi trong receipt, Developer tạo ra implementation đạt 42/42 bên ngoài, nhưng pipeline sản phẩm chạy 41 test nội bộ và bị chặn bởi C-2. Test này đặt giờ hiện tại là 500, enqueue một job với delay 500 rồi kỳ vọng job đã đến hạn ngay ở 500; theo hợp đồng, job chỉ đến hạn tại 1000. Assertion bị sai, nên đây không phải bằng chứng implementation sai. Dù vậy, workflow đã dừng đúng theo quy tắc “test nghiệm thu thất bại thì không nghiệm thu”; trạng thái cuối là failed, không có mutation/Verifier và không giao kết quả thành công. Không nên gọi đây là một lần Department hoàn tất end-to-end.

Do đó câu trả lời phụ thuộc tiêu chí: **implementation theo bộ chấm kín: Department tốt hơn nhẹ; tốc độ và tự vận hành không cần hỗ trợ: Single tốt hơn rõ trong lượt này.** Một pilot cho mỗi bên chưa đủ để kết luận mô hình nào tốt hơn nói chung.

| Kiểm tra HTTP ngoài bộ chấm | Single | Department |
|---|---|---|
| enqueue → claim → sai lease bị từ chối → ack → ack replay | Qua | Qua |
| Tenant khác không nhìn thấy job | Qua | Qua |
| Payload null, số, chuỗi, boolean bị từ chối | **Không** — HTTP 200 và lưu đủ 4 job | Qua — HTTP 400 INVALID_INPUT, không lưu |

Các HTTP smoke này chạy qua adapter chung do scaffold cung cấp; chúng không được tính vào 42 ca, và chỉ đo queue engine phía sau adapter.

| Nhóm ca | Single | Department |
|---|---:|---:|
| basic | 2/2 | 2/2 |
| validation | 3/4 | 4/4 |
| idempotency | 4/4 | 4/4 |
| tenants | 2/2 | 2/2 |
| scheduling | 4/4 | 4/4 |
| leases | 6/6 | 6/6 |
| ack | 2/2 | 2/2 |
| retry | 2/2 | 2/2 |
| cancel | 3/3 | 3/3 |
| concurrency | 5/5 | 5/5 |
| storage | 4/4 | 4/4 |
| persistence | 2/2 | 2/2 |
| isolation | 2/2 | 2/2 |

| Lượt trong Department | Model | Trạng thái | Wall time của lượt |
|---|---|---|---:|
| planner / prepare | gpt-6-luna | completed | 23.0s |
| author / prepare | claude-haiku-5-5 | completed | 85.2s |
| author / implement | claude-haiku-5-5 | completed | 565.9s |
| developer / implement | gpt-6-luna | completed | 134.2s |

Wall time của một lượt agent gồm chờ provider, model suy nghĩ/sinh output và chạy công cụ; không suy thành CPU time hay chỉ thời gian suy luận. Hai lượt benchmark có thời gian chạy chồng nhau trên cùng máy và tài khoản provider; không dùng tỉ lệ tốc độ một lượt làm ước lượng tổng quát.

## Vì sao khó hơn HoldStock

Queue không chỉ quản lý trạng thái trong RAM: mỗi thao tác phải đọc/ghi qua async load/CAS, chống mất cập nhật giữa hai instance, giữ thứ tự khi conflict và phục hồi sau lỗi ghi. Job có lease token, ack replay receipt riêng, expiry, backoff, dead-letter và cách ly tenant. Bộ chấm có ghi file thật rồi mở từ tiến trình Node mới. CAS adapter là scaffold chung; queue không được dựa vào private internals của adapter. Simultaneous multi-process OS writers ngoài phạm vi, chỉ hai queue instance chia sẻ một atomic store.

Trước model: grade.mjs được khóa hash 9c62ae8a4f8b04293d340f30d0d9c17ece371d0b024a625b6a24aa599855e40b. Control kiểm tra cả sync throw và async rejection, scaffold bị chấm 0/42. Bộ chấm bên ngoài project, không đưa lỗi của nó cho model để sửa. Không thêm ca sau khi thấy đầu ra.

Một lỗi timing trong E04 được công khai sửa ở grade-v2.mjs: SPEC không bắt buộc eager I/O trong constructor, nên test chấp nhận CORRUPT_STORE trong openQueue hoặc lần list đầu tiên. Vẫn cùng bốn input hỏng và cùng mã lỗi, không chấp nhận reset/ghi đè. Native ban đầu 40/42 gồm 1 lỗi giả của grader; sau sửa là 41/42, lỗi payload thật vẫn fail. Original grade.mjs/hash và native-grade-original.json được giữ. Author độc lập cũng đặt câu hỏi tương tự về timing trước Developer. Chi tiết evaluator-correction.json. Score cuối áp dụng cùng grade-v2 cho hai candidate.

## Can thiệp điều phối

{
  "at": "2026-10-24T03:33:14.725Z",
  "approved": true,
  "originalWorkflow": "blocked before Developer; retained separately and scored as no deliverable",
  "interventions": [
    {
      "type": "schema-repair",
      "detail": "Moved five notApplicable entries with unsupported group names to assumptions. Every allowed risk group already has cases; all 23 cases and IDs retained unchanged.",
      "removed": [
        {
          "group": "ui",
          "reason": "Đây là thư viện ESM không có giao diện; không có màn hình hay tương tác người dùng cần kiểm thử."
        },
        {
          "group": "performance",
          "reason": "Hợp đồng không đưa ra ngưỡng thời gian hay tải; kiểm thử tải nằm ngoài nghiệm thu này."
        },
        {
          "group": "multi-process-writer",
          "reason": "Hợp đồng ghi rõ nhiều tiến trình OS ghi độc lập đồng thời nằm ngoài phạm vi; chỉ kiểm thử reopen sau khi tiến trình thoát (C-21) và contention giữa hai queue object (C-13 đến C-15)."
        },
        {
          "group": "clock-overflow",
          "reason": "Hợp đồng ghi rõ tràn số và now() không ném lỗi nằm ngoài phạm vi."
        },
        {
          "group": "payload-execution",
          "reason": "Hợp đồng nói không thao tác nào tự thực thi payload; điều này được kiểm qua C-6 (payload chỉ nhận JSON) và C-10 (payload giữ nguyên), không cần ca riêng."
        }
      ]
    },
    {
      "type": "question-resolution",
      "questions": [
        "Q1 (C-14): Hợp đồng nói CAS false được retry tối đa 8 lần nhưng cũng nói sau 8 kết quả false thì ném CONFLICT. Có hai cách đọc: tổng 8 lần thử (CONFLICT ở lần false thứ 8) hay 9 lần thử (1 lần đầu + 8 retry, CONFLICT ở lần false thứ 9)? Cần chốt để test đếm đúng số lần CAS.",
        "Q2 (C-18): CORRUPT_STORE báo ở openQueue hay ở thao tác đầu tiên? Và state undefined (khác null) có phải garbage cần CORRUPT_STORE không? Hợp đồng chỉ nói 'non-null garbage'; nếu undefined được coi như null thì queue mới sẽ được tạo.",
        "Q3: Thứ tự ưu tiên lỗi khi nhiều điều kiện cùng đúng là gì, ví dụ INVALID_INPUT so với NOT_FOUND hay STALE_LEASE, và việc chuẩn hóa hết hạn có chạy trước validation không? Hợp đồng nói chuẩn hóa chạy trước 'mỗi thao tác hợp lệ', nên đề xuất: validate đầu vào trước, rồi chuẩn hóa, rồi kiểm tra nghiệp vụ.",
        "Q4 (C-18/C-17): store.load trả về hình dạng sai, ví dụ version âm, version không phải số nguyên, hoặc thiếu state, thì báo lỗi code nào? Hợp đồng chỉ định STORAGE_ERROR cho load/CAS ném lỗi, chưa định nghĩa cho dữ liệu sai hình dạng từ store. Đề xuất: CORRUPT_STORE cho state sai, STORAGE_ERROR cho version sai. Cần xác nhận.",
        "Q5 (C-11, C-13, C-15, C-21): Để kiểm tra 'tenant khác không bị chuẩn hóa' và 'không lộ receipt' thì test được phép đọc state đã commit (dạng JSON opaque từ store.load) hay chỉ được dùng API công khai? Nếu chỉ API công khai thì assertion 'tenant B không bị chuẩn hóa' không quan sát được trực tiếp; đề xuất cho phép đọc snapshot từ store.load mà không phụ thuộc layout bên trong."
      ],
      "answers": [
        "CAS false: 8 false results total means CONFLICT, as SPEC explicitly states; no ninth attempt.",
        "CORRUPT_STORE may be reported at openQueue or the first operation that loads state. Only state=null means brand new; undefined is not null. Test error around open plus first operation. Do not require eager loading.",
        "Validate method arguments before any storage mutation. Tenant/id lookup precedes lease/state validation. Normalization applies before valid tenant operations; invalid input must not mutate.",
        "Store contract guarantees a nonnegative integer version and a state field; malformed version/envelope is outside this task. Do not invent additional error-code requirements for those unsupported envelopes. Validate garbage state as specified.",
        "Public store.load snapshots may be compared before/after for cross-tenant nonmutation, without inspecting a private queue layout. Public returned Job must expose exactly its documented fields, not private ack receipt data.",
        "C-17 follows SPEC: failed write leaves job absent BEFORE a successful retry; after successful retry the job must be visible after reopen. The phrase about replay not seeing the job refers only to the failed uncommitted attempt, not to a later successful retry."
      ]
    },
    {
      "type": "planner-fallback-not-rewritten",
      "detail": "Planner response had opening json fence but no closing fence; app kept original SPEC as R-1. Did not replace it with a coordinator-written contract."
    }
  ],
  "caseDefinitionsEdited": 0,
  "sourceOrTestCodeEditedByCoordinator": false
}

Không sửa code/test implementation hộ hai bên. Chưa nhận kết quả bằng app khi còn phát hiện lỗi. Nếu Department dừng trước Developer vì policy/manifest, bản stub vẫn được chấm 0 và lưu trạng thái; không loại lượt đó khỏi kết quả.

Lượt Department tự động ban đầu đã BLOCKED trước Developer: Planner output có dấu mở json fence nhưng thiếu dấu đóng, parser không nhận và giữ hợp đồng nháp R-1 là toàn bộ SPEC; Author dùng các tên nhóm ui/performance/multi-process-writer/clock-overflow/payload-execution ngoài schema. Kết quả gốc là không có implementation (stub 0/42), lưu department-unassisted-blocked.json và department-unassisted-grade.json. Tiếp tục có hỗ trợ trên cùng run để vẫn quan sát khả năng viết code: chuyển 5 mục ngoài schema sang assumptions, trả lời 5 câu hỏi theo SPEC, không sửa 23 định nghĩa ca và không viết source/test. Công này do trợ lý điều phối ngoài app thực hiện, không phải do hai model trong app tự xử lý; không gọi kết quả tiếp tục là hoàn toàn tự động. Kế hoạch gốc và receipt được lưu nguyên vẹn.

## Ca Single không đạt

- V04 (validation): Missing expected rejection.

## Ca Department không đạt

Không có ca thất bại trong bộ chấm.

## Bằng chứng và chạy lại

- protocol.json, SPEC.md, grade.mjs: đầu vào và hash khóa.
- native-result.json, native-raw.jsonl, native-capture.json: model thật, usage, checkpoint và test nội bộ.
- department-detail.json, department-history.jsonl: run/attempt/check/artifact của app.
- approval-receipt.json: mọi thay đổi ở bước duyệt.
- native-grade.json, department-grade.json: từng ca thất bại/đạt.
- comparison.json: dữ liệu tổng hợp, findings và mutation nếu có.
- Project: C:/Users/ADMIN/OneDrive/Desktop/ai-department-leasequeue-20261024; run http://127.0.0.1:4310/#/run/run_82c59831.

Từ repo AI Department: node test-results/2026-10-24-hard-pilot/grade-v2.mjs <candidate-dir> <output-json>. Không gọi AI. Đã giữ nguyên thay đổi chưa commit của repository chính; pilot ghi project/data/evidence riêng.
