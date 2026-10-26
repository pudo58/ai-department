# ReplayGate benchmark: AI Department vs one GPT-6 Luna agent

## Kết quả

| Hạng mục | Agent đơn | AI Department Verify |
|---|---:|---:|
| Model | GPT-6 Luna | GPT-6 Luna ở cả Planner, Author, Developer, Verifier |
| Trạng thái | Hoàn tất | Bị chặn trước Developer |
| Lượt model | 1 turn | 3 turn: Planner, Author lập kế hoạch, Author tạo manifest |
| Thời gian | 70,4 giây | 7 phút 10,7 giây từ lúc tạo run đến lúc bị chặn |
| Test tự viết chạy được | 5/5 | Chưa chạy; Author bị chặn ở manifest |
| Bộ chấm kín đã audit | 43/43, **10/10** | Không có candidate để chấm |
| Can thiệp operator | 0 | 2 đợt: sửa/duyệt kế hoạch, rồi duyệt cảnh báo hợp đồng |
| Chi phí | Ước tính $0,234 | App ước tính $0,816 |

**Kết luận lượt này:** agent đơn thắng về khả năng giao code trong điều kiện benchmark này. Department thể hiện giá trị ở chỗ chặn manifest không khớp trước khi Developer bắt đầu, nhưng quy trình chưa tự đi hết và chưa tạo candidate; vì vậy không có cơ sở chấm điểm chất lượng code của Department. Đây là kết quả của một tác vụ, không chứng minh agent đơn tốt hơn nói chung.

## Bài toán và cách chạy

ReplayGate là một transactional webhook outbox nhỏ, nhưng có state machine, idempotency, priority/FIFO, lease expiry đúng biên, fencing token, retry exponential, dead-letter, cancellation, payload cloning và concurrent claims. Hai nhánh bắt đầu từ cùng scaffold và cùng SPEC đã khóa. Chỉ `src/outbox.js` được chấm; test và README được phép thay đổi.

Protocol dùng GPT-6 Luna, medium, tối đa 12 phút, một lượt mỗi nhánh. Bộ evaluator ngoài có 43 kiểm tra hành vi, không nằm trong hai project. Hash SPEC là `6dd040cd71f1d9f3b26cd0223ad2f9fdc33bc06fedbe8c8bacebb6e6dfef55b4`; hash grader gốc là `8f950ffe78d77ad94c2025154c29f6bb928decd209f3b1d56893c88268bc2674`.

Agent đơn hoàn tất trong 70,4 giây. Test Vitest của nó đạt 5/5; evaluator độc lập đã audit đạt 43/43. Agent nói runner bị chặn quyền đọc config trong sandbox, nên bằng chứng 5/5 là lần host chạy lại sau đó, không phải lần agent tự chạy thành công.

Department có ba lượt model, tất cả đúng `gpt-6-luna`. Lượt Author lập kế hoạch trả cấu trúc không hợp schema và bốn câu hỏi về hành vi chưa được đặc tả. Mình lưu raw output, sửa phần cấu trúc/căn cứ, ghi rõ các điểm ngoài đặc tả bị loại khỏi ca bắt buộc, rồi duyệt hợp đồng. Đây là một đợt can thiệp.

Author tiếp theo tạo 16 ca test nhưng manifest thiếu tag yêu cầu trong một số tên test: C-5 thiếu R-8/R-9/R-10; C-9 thiếu R-11; C-16 thiếu R-5/R-6. Runtime chặn trước khi tạo checkpoint; Developer và Verifier không chạy. Mình không sửa file ứng viên hay gọi lại model để tránh biến benchmark thành bản đã được coach. Đợt can thiệp thứ hai là duyệt cảnh báo/cho phép kế hoạch sau khi đã xem nội dung.

## Điểm cần đọc cùng với 10/10

Lần chạy grader ban đầu báo 28/43, nhưng audit cho thấy hai lỗi ở harness: `assert.rejects` không xử lý đúng hàm ném lỗi đồng bộ, và một ca thời gian chưa tiến đồng hồ đến lúc job đủ điều kiện claim. Grader và kết quả gốc được giữ nguyên. Bản `grade-audited.mjs` chỉ sửa cách gọi kiểm tra và setup thời gian; không đổi assertion nghiệp vụ, SPEC hay code của agent. Điểm chính dùng kết quả audit 43/43.

Sau khi khóa điểm, một probe thăm dò ngoài bộ 43 ca phát hiện agent đơn chưa lazy-expire lease khi một public call khác bị từ chối vì input sai tại đúng thời điểm hết hạn. Ca này không được cộng/trừ điểm chính; xem `single-exploratory.json`. Vì vậy 10/10 chỉ có nghĩa là đạt các ca đã khóa, không phải hoàn toàn không còn lỗi.

Chi phí đều là ước tính trên CLI subscription, không phải hóa đơn thực tế. Số token và số tiền app không tương đương hoàn toàn. Một task, một lượt mỗi nhánh cũng không đủ để kết luận về hiệu suất trung bình.

## Bằng chứng

- `protocol.json`: cấu hình và hash trước khi gọi model.
- `single-grade-audited.json`: 43 ca chấm chính; `single-grade.json`: grader gốc được giữ lại.
- `native-result.json`, `native-raw.jsonl`: lượt agent đơn và usage.
- `department-plan-before-repair.json`, `department-plan-review.json`, `department-plan-after-repair.json`: output Author và phần sửa kế hoạch được ghi lại.
- `comparison.json`: số liệu đã tổng hợp.
- AI Department run: [run_f7c3e2a3](http://127.0.0.1:4310/#/run/run_f7c3e2a3).
- Agent đơn code: `C:/Users/ADMIN/OneDrive/Desktop/ai-department-outboxpilot-20261024/single`.

Chấm lại candidate đơn không gọi AI:

```powershell
node test-results/2026-10-24-outboxpilot/grade-audited.mjs `
  C:\Users\ADMIN\OneDrive\Desktop\ai-department-outboxpilot-20261024\single `
  test-results/2026-10-24-outboxpilot/single-grade-audited.json
```

