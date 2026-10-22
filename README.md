# AI Department v4.3

Harness làm nền, **Single là mặc định**, Team (Clarify / Verify / Compare) dùng có chọn lọc. Chạy local, server chỉ bind loopback.

```bash
npm run build && npm start     # http://127.0.0.1:4310
npm run dev                    # server + Vite (127.0.0.1:5173)
npm test                       # vitest
npm run eval -- <lệnh>         # bộ đo M0 (xem bên dưới)
```

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
| Phát hiện stack chỉ-đọc, gợi ý guidance và check khi tạo/sửa project | Xong, có test; chỉ nhận diện hệ Node/JS/TS |
| Nhiều check mỗi project (UI thêm/sửa/xóa), check không có report (typecheck, lint, build) | Xong, có test, đã chạy với tiến trình thật qua LocalRuntime |
| Ngữ cảnh project: bản đồ repo, bộ nhớ đã duyệt, ngân sách token theo vai, xem trước | Xong, có test; **tắt mặc định**, chưa đo được lợi ích với Codex thật. Agent chưa tự đề xuất bộ nhớ (bước 3, chờ số đo) |
| Công cụ phân tích knip/jscpd/dependency-cruiser | Chưa nối: báo "chưa phân tích" |
| Feature mới (phase base+stub) | Chưa tự động; chỉ bugfix/refactor có red/green |
| Khóa theo test id (`missingTestIds`) | Hàm có sẵn, chưa nối; hiện khóa theo path |
| Chạy Reviewer thật cho M0a | `runM0a` nhận `Reviewer` bất kỳ; chưa có adapter CLI |

Run **mô phỏng** (FakeProvider) chỉ kiểm tra workflow. Mọi check của nó là `incomplete` nên không bao giờ nghiệm thu được.

## Báo cáo nghiệm thu và test đang chạy

Khi task tới bước nghiệm thu, trang task mở tab **Nghiệm thu** với một báo cáo đầy đủ để bạn đọc rồi mới quyết định: yêu cầu gốc, từng yêu cầu và các test chứng minh nó, file đã đổi so với bản gốc (+/−, diff đầy đủ), kết quả chạy test (pass/fail/bỏ qua, tên các test bị bỏ qua), kết luận và lời của Verifier độc lập, chi phí và công sức, và lệnh git để xem/merge branch. Báo cáo có thể tải về dạng Markdown (\`GET /api/runs/:id/report.md\`).

Mọi điều hệ thống **không chứng minh được** hiện thành cảnh báo: test bị bỏ qua, Verifier từ chối kết luận hoặc chưa chạy, tiêu chí thủ công, check flaky/quarantine. Nếu có cảnh báo, nút Nghiệm thu chỉ mở sau khi bạn tick xác nhận đã đọc (server cũng chặn nếu thiếu \`acknowledgeWarnings\`). Báo cáo bạn đã xem được lưu cùng task (artifact "Báo cáo nghiệm thu"). Số test pass/fail/bỏ qua chỉ có với check chạy sau khi tính năng này có; check cũ hiện "—" cho tới khi **Chạy lại check**.

Trong lúc check chạy, đầu trang task hiện khung **Chương trình test đang chạy**: lệnh đang chạy, thời gian, bộ đếm pass/fail/bỏ qua cập nhật theo từng test và console của chính test đó. Bộ đếm đọc output dạng spec/TAP của \`node --test\` và dấu tick của Jest/Vitest; nó chỉ là chỉ báo trực tiếp, kết quả chính thức là report đọc khi test chạy xong.

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
  - dung lượng bản sao làm việc theo từng task (đo ở nền), kèm nút **Dọn** cho task đã nghiệm thu, bị chặn hoặc thất bại hơn 7 ngày, hoặc bản sao không còn task (`POST /api/system/cleanup`). Nút này chỉ xóa `.data/workspaces/<run>-*`, không đụng project gốc;
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

Giới hạn: detector chỉ hiểu hệ Node; repo Python/Go/Rust chỉ nhận ghi chú và phải tự nhập check. Với pnpm/yarn, lệnh cài đặt gợi ý đi qua `npx` vì Windows không chạy trực tiếp `.cmd`; Bun chưa được hỗ trợ chạy trực tiếp.

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
- **Lệnh chạy:** lấy `previewCommand` của project (ô **Lệnh chạy thử app** trong Sửa project). Nếu trống thì tự đoán theo thứ tự: `npm run dev`, `npm start`, `node server.mjs`/`server.js`/`index.mjs`, hoặc server tĩnh có sẵn (`tools/preview/static-server.mjs`) cho thư mục chỉ có `index.html`. Server tĩnh không phục vụ file ẩn như `.env`.
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

- **Git có ít nhất một commit**: như trước. Agent làm trên bản clone, kết quả giao bằng một branch `aidept/<run>-A` mới.
- **Git chưa có commit, hoặc không phải git**: hệ thống chụp một bản sao thư mục (trừ `.git`, `node_modules`, `.data`, symlink; tối đa 20.000 file / 300 MB) thành repo git riêng của run trong `.data/workspaces/<run>-base`, tôn trọng `.gitignore` của project nên file bị ignore (như `.env`) không tới tay agent. Bản chụp chỉ tạo một lần mỗi run nên sửa thư mục project giữa chừng không làm lệch base. Khi **nghiệm thu**, các file task đã đổi được ghi thẳng vào thư mục project, không tạo branch và không đụng `.git`. Nếu một file đã bị bạn sửa (hoặc xóa) sau khi task bắt đầu thì không ghi gì cả (tất cả hoặc không), log ghi danh sách xung đột và kết quả vẫn nằm trong bản sao làm việc. Báo cáo nghiệm thu vẫn in lệnh git theo branch; với loại project này hãy bỏ qua phần đó.

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
