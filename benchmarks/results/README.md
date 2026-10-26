# Kết quả benchmark các task

Lưu ngày 2026-10-26 (Asia/Bangkok). Đây là bản sao báo cáo, điểm chấm, số đo, kết quả mutation, audit bộ chấm và SPEC/protocol dùng để hiểu kết quả. Giữ cả lần bị chặn, chạy lại, kết quả gốc và kết quả đã audit; không gộp các cohort thành một lần chạy.

Không xuất riêng source candidate/scaffold/reference/grader, script điều phối, ZIP dự án, runtime/database, raw output agent, log, snapshot sản phẩm hay kết quả regression/UI fixture. Báo cáo JSON có thể chứa trích đoạn diff, output và thông tin chẩn đoán đã có trong báo cáo gốc. Các báo cáo lịch sử được giữ nguyên nên có thể nhắc hoặc liên kết tới những file chỉ còn ở máy chạy, đường dẫn test-results cũ và URL localhost; chúng không phải liên kết xem được trên GitHub. Các điểm chấm trong JSON không được tái tính trong lần lưu này.

Đọc báo cáo cùng audit/correction/adjudication trước khi so sánh. Đặc biệt PatchBook có kết quả grader gốc Department 95/95, Single 94/95; một ca ngoài SPEC được thẩm định riêng, so sánh đủ căn cứ là 94/94 cho cả hai. Không suy ra ưu thế tổng quát từ một task, thời gian dừng sớm hoặc mutation trên số lượng mutant khác nhau.

Tổng cộng **16 thư mục benchmark**, **196 file kết quả/ngữ cảnh**. [manifest.json](manifest.json) ghi đường dẫn gốc, kích thước và SHA-256 của từng file; tất cả bản sao đã đối chiếu hash với bản local.

| Benchmark / cohort | Báo cáo | File |
|---|---|---:|
| [2026-10-24-hard-pilot](2026-10-24-hard-pilot/) | [department-report.md](2026-10-24-hard-pilot/department-report.md) · [report.md](2026-10-24-hard-pilot/report.md) | 13 |
| [2026-10-24-leasegrid](2026-10-24-leasegrid/) | [report.md](2026-10-24-leasegrid/report.md) | 9 |
| [2026-10-24-leasegrid-postfix](2026-10-24-leasegrid-postfix/) | [report.md](2026-10-24-leasegrid-postfix/report.md) | 7 |
| [2026-10-24-live-pilot](2026-10-24-live-pilot/) | [report.md](2026-10-24-live-pilot/report.md) | 14 |
| [2026-10-24-outboxpilot](2026-10-24-outboxpilot/) | [report-final.md](2026-10-24-outboxpilot/report-final.md) · [report.md](2026-10-24-outboxpilot/report.md) | 11 |
| [2026-10-24-quotavault](2026-10-24-quotavault/) | [report.md](2026-10-24-quotavault/report.md) | 8 |
| [2026-10-24-speed](2026-10-24-speed/) | [report.md](2026-10-24-speed/report.md) | 4 |
| [2026-10-24-streambench](2026-10-24-streambench/) | [department-rerun-report.md](2026-10-24-streambench/department-rerun-report.md) · [haiku-comparison-report.md](2026-10-24-streambench/haiku-comparison-report.md) · [report.md](2026-10-24-streambench/report.md) | 15 |
| [2026-10-25-cartstock-single](2026-10-25-cartstock-single/) | [COMPARISON.md](2026-10-25-cartstock-single/COMPARISON.md) | 11 |
| [2026-10-25-cartstock-source-bindings](2026-10-25-cartstock-source-bindings/) | [UPGRADE-REPORT.md](2026-10-25-cartstock-source-bindings/UPGRADE-REPORT.md) | 7 |
| [2026-10-25-cartstock-v3](2026-10-25-cartstock-v3/) | [REPORT.md](2026-10-25-cartstock-v3/REPORT.md) | 9 |
| [2026-10-25-cartstock-v3-assisted](2026-10-25-cartstock-v3-assisted/) | [result.json](2026-10-25-cartstock-v3-assisted/result.json) | 1 |
| [2026-10-25-escrowbatch](2026-10-25-escrowbatch/) | [report.md](2026-10-25-escrowbatch/report.md) · [department-assisted/final-acceptance-report.md](2026-10-25-escrowbatch/department-assisted/final-acceptance-report.md) · [department-assisted/final-report.md](2026-10-25-escrowbatch/department-assisted/final-report.md) · [department-assisted/report.md](2026-10-25-escrowbatch/department-assisted/report.md) | 26 |
| [2026-10-25-escrowbatch-rerun](2026-10-25-escrowbatch-rerun/) | [report-generator-output.md](2026-10-25-escrowbatch-rerun/report-generator-output.md) · [report.md](2026-10-25-escrowbatch-rerun/report.md) | 12 |
| [2026-10-25-patchbook](2026-10-25-patchbook/) | [BENCHMARK.md](2026-10-25-patchbook/BENCHMARK.md) | 21 |
| [2026-10-25-pulsegraph](2026-10-25-pulsegraph/) | [report.md](2026-10-25-pulsegraph/report.md) · [department-full/report.md](2026-10-25-pulsegraph/department-full/report.md) | 28 |
