# AI Department Exporter: đọc thiết kế Figma và đưa vào task

Tài liệu của tính năng đã triển khai. Đặc tả gốc: [figma-exporter-plan.md](figma-exporter-plan.md). Mục **“Chưa xác nhận”** ở cuối ghi những gì chưa được kiểm chứng trên Figma Desktop thật.

## Luồng

**Tab MCP → Cài Figma Desktop & Exporter → đăng nhập → Ghép đôi → Chọn nguồn và phạm vi → Export → xem, xác nhận giới hạn, duyệt snapshot → giao task dùng thiết kế.**

```text
Figma Desktop
  ├─ Exporter main   đọc tài liệu bằng Figma Plugin API (không mạng, không DOM)
  └─ Exporter UI     ghép đôi, chia chunk, băm SHA-256, gửi HTTP
            │  HTTP loopback có xác thực (/api/figma-exporter/*)
            ▼
AI Department
  ExporterHub → staging → ExportValidator → SnapshotStore (KB) → publish
                                                   │
                                   Project / Hợp đồng (design binding)
                                                   │
                            Planner / Author / Developer / Verifier
```

Không dùng MCP server, bridge cộng đồng hay Figma REST API. Không gọi model để crawl hay sinh Markdown.

## Cài đặt và đăng nhập

- **Cài Figma Desktop & Exporter**: phát hiện Figma có sẵn (giữ nguyên, không hạ phiên bản); nếu thiếu, tải installer theo catalog đã khóa (`src/server/figma/installer.ts`, Figma 126.9.16 x64), kiểm SHA-256 và Authenticode, chạy `--silent` bằng quyền người dùng (không `RunAs`, không MSI, không shell), rồi chuẩn bị thư mục plugin. Mỗi bước lưu trong job; chạy lại chỉ làm phần còn thiếu.
- Department **không nhận mật khẩu, cookie hay token** của Figma. Đăng nhập diễn ra trên Figma/trình duyệt chính thức.
- **Mở thư mục Exporter**: mở đúng thư mục có `manifest.json` của instance này. Import một lần: Plugins → Development → Import plugin from manifest. Đổi cổng Department thì tạo bundle mới (nút cài) và import lại.
- Tự cài chỉ hỗ trợ Windows x64. Máy khác: cài Figma thủ công, phần plugin vẫn dùng được.

## Phạm vi và nguồn

Ba phạm vi: **frame đang chọn**, **một hoặc nhiều trang**, **toàn bộ file** (lựa chọn tường minh, không bao giờ là mặc định). Gốc và scope hash được chốt khi tạo job; đổi selection sau đó không đổi phạm vi.

Nguồn: plugin trả `fileKey` khi API cho phép; URL người dùng nhập được đối chiếu (sai file thì chặn). Không có `fileKey` thì nguồn là **do người dùng xác nhận** (tên file, trang), ghi rõ trong snapshot và là một giới hạn phải được chấp nhận. Tên file hay mã node không bao giờ thay file key.

## Thuật toán đọc

Tám bước trong `plugins/figma-exporter/src/main/exporter.ts`: chốt job (nonce phiên nguồn + scope hash) → tải trang (`loadAllPagesAsync` cho cả file, `page.loadAsync` cho phạm vi nhỏ) → bật đọc con ẩn của instance (`skipInvisibleInstanceChildren = false`, khôi phục sau) → kiểm kê lặp (không recursion) → đọc thuộc tính từng node → phụ thuộc và tài nguyên → đối chiếu lần hai (kiểm kê + hash dữ liệu chính của từng node + sự kiện `documentchange` cho cả file) → kết thúc. Mỗi lát đọc tối đa 100 node hoặc 8 ms rồi nhường UI.

Mỗi trường có trạng thái `read | mixed | not_applicable | unsupported | unavailable | error` kèm lý do và API nguồn; 0, `false` và `null` hợp lệ được giữ nguyên, không điền giá trị đoán. Text nhiều style dùng `getStyledTextSegments`; `mixed` chỉ đủ làm căn cứ khi phần phân rã đã được lưu cùng.

### Bảng hỗ trợ reader v1

| Nhóm | Dữ liệu | Node |
|---|---|---|
| common | tên, hiển thị, khóa, opacity, blend, mask, transform, bounds, clip, export settings | mọi node |
| layout | auto-layout, padding, gap, sizing, align, constraints, min/max, grid | FRAME, COMPONENT, COMPONENT_SET, INSTANCE, SECTION, GROUP + thuộc tính con trong auto-layout |
| paint | fills, strokes, gradient, ảnh (hash), bo góc, effects | FRAME, COMPONENT*, INSTANCE, SECTION, TEXT, hình |
| text | characters, segments theo range, căn lề, auto-resize, font thiếu | TEXT |
| component | key, mô tả, định nghĩa thuộc tính/variant, set cha | COMPONENT, COMPONENT_SET |
| instance | main component, giá trị thuộc tính, override trực tiếp | INSTANCE |
| style | style id, variable gắn, mode hiển thị/rõ ràng | node có style |
| vector | path, vector network, geometry, boolean, star/polygon | VECTOR, BOOLEAN_OPERATION, hình |
| prototype | reaction, trigger, action, overflow | node có tương tác |
| phụ thuộc | style, variable (kèm alias closure), collection, main component | theo tham chiếu; toàn file thêm mọi style/variable cục bộ |
| tài nguyên | ảnh gốc theo hash nội dung, SVG vector, PNG xem trước (cạnh dài ≤ 2048) | `original_image`, `vector_export`, `preview` |

Loại node chưa hỗ trợ (FigJam, bảng, widget…) vẫn có bản ghi cây + nhóm `common` và issue `unsupported_node_type`, không bị coi là đã đọc. **Chưa nằm trong v1**: FigJam, Slides, video, comment, lịch sử phiên bản, font binary, thư viện ngoài (ghi `dependency_unresolved`), `inherited override` của instance (chỉ có giá trị hiệu lực và override trực tiếp).

## Truyền dữ liệu

HTTP loopback tới `/api/figma-exporter/{pair,poll,event,chunk,finish,disconnect}`. Mã ghép đôi 8 chữ số, dùng một lần, sống 5 phút, tối đa 5 lần sai; token phiên 256-bit chỉ nằm trong bộ nhớ. Chunk tối đa 256 KiB, kèm số thứ tự, hash và byte; server lưu rồi mới ACK; gửi lại cùng chunk là no-op, cùng seq khác nội dung là 409, thiếu seq không finalize. Tối đa hai chunk chưa ACK. Hủy thu hồi quyền ghi trước và server **giữ khóa tới khi plugin báo đã dừng** (hoặc hết 10 giây) để hai export không chồng nhau.

Giới hạn mặc định: 10 phút, 20.000 node, 200 MiB, 25 MiB/tài nguyên; nâng được tới 60 phút, 200.000 node, 2 GiB, 100 MiB. Chạm trần tạo bản chưa đầy đủ để xem, không publish được.

## Kiểm tra và publish

`ExportValidator` (`src/core/figmavalidate.ts`) kiểm độc lập: hash từng bản ghi, đồ thị (trùng id, cha/con, thứ tự, vòng), kiểm kê đầu/cuối, mọi nhóm trường có trạng thái nhất quán, phụ thuộc/alias, tài nguyên, tổng hợp luồng. Kết quả tách **sáu thước đo** (cấu trúc, trường, phụ thuộc, tài nguyên, nguồn, nhất quán), không có “100%”. Sai cấu trúc/hash/thiếu node/chạm giới hạn/nguồn đổi là **blocker**; trường không đọc được, thư viện ngoài, thiếu ảnh gốc, nguồn do người xác nhận là **giới hạn** (phải xác nhận từng mục khi duyệt, gắn với `snapshotHash`).

Nhãn duy nhất hai loại: “Đã đọc đủ cấu trúc trong phạm vi” và “Có giới hạn”. Không có nhãn nào nói thiết kế đã được hiểu hay chứng minh đúng.

Snapshot (`design-snapshots/<id>/`) bất biến, dựng ở thư mục tạm rồi đổi tên; có `manifest.json` (hash từng file), `index.json`, `review.json`, `source/` (bản ghi thuộc tính đã đọc, chia theo trang), `pages/`, `components/`, `tokens/`, `assets/` (theo hash nội dung). `contentHash` (so nội dung) tách khỏi `snapshotHash` (duyệt, hợp đồng). Biên nhận publish nằm riêng, không nằm trong manifest. Markdown sinh bằng template; tên layer/text bị escape, SVG chỉ tải xuống (CSP `sandbox`).

## Dùng trong task

Project có thể đặt snapshot mặc định; khi tạo task chọn mặc định, bản khác hoặc không dùng. Hợp đồng giữ `TaskContract.design` (`snapshotId`, `snapshotHash`, `targetIds`, `acknowledgedIssueIds`, `designPolicyVersion`) nằm trong hash hợp đồng. **Server** ghi trường này: Planner hay form không tự đặt/làm rơi được (`reviseContract` luôn giữ). Đổi nguồn là thao tác sửa hợp đồng (tăng version, mất duyệt). Task không dùng thiết kế giữ nguyên hash cũ.

Tham chiếu thiết kế `{nodeId, fieldPath}` khai báo cạnh yêu cầu hoặc ca (`designRefs`). Trước **mọi** lượt AI, hệ thống chặn nếu snapshot không còn dùng được (chưa duyệt, đã sửa file, hash khác hợp đồng) hoặc một tham chiếu bắt buộc trỏ tới trường không ở trạng thái `read` (hay `mixed` có phân rã). Tick cảnh báo không vượt được các chặn này.

Mỗi vai nhận tóm tắt (≤ 8000 ký tự, nói rõ khi cắt) cộng đường dẫn tới bản sao riêng của run (`design-inputs/<run>/…`, Docker mount chỉ đọc `/aidept-design`). Bản sao được băm trước và sau mỗi lượt; lượt làm đổi thư mục bị chặn và lượt sau được cấp bản sạch từ snapshot. Design context không phụ thuộc `contextEnabled` hay ngân sách Verifier. Người diễn giải độc lập (Clarify) không nhận thiết kế. Biên nhận (`Design input receipt/check`) chứng minh cái đã cấp, không chứng minh model đã đọc. Báo cáo nghiệm thu có mục **Nguồn thiết kế**, giới hạn đã chấp nhận và dòng “chưa có kiểm chứng hình ảnh”.

Snapshot còn được project hay task (kể cả đã hoàn thành) tham chiếu thì không xóa được.

## Bảo mật

Plugin chỉ nhận 6 lệnh cố định (`HELLO, LIST_PAGES, LIST_ROOTS, START_EXPORT, CANCEL, DISCONNECT`), không có lệnh chạy code, sửa node hay mở file. Namespace plugin có xác thực riêng; chỉ Origin `null` (iframe của plugin) hoặc không có Origin; preflight không dùng wildcard; token phiên **không** gọi được API project/run/publish (vẫn cần CSRF của trang). Manifest chỉ cho kết nối tới origin loopback của instance (`devAllowedDomains`).

## Kiểm thử

Fixture dùng Figma giả mô phỏng API thật (trang phải load, getter ném lỗi, `figma.mixed`, byte ảnh async) chạy **bundle plugin thật** + **UI thật** (jsdom) + **server thật**: `tests/figma-*.test.ts` (core, validator, transport, installer, snapshots, e2e, edges, design-run, ui). Không gọi model; installer luôn là fake. `pnpm typecheck` kiểm main của plugin với `@figma/plugin-typings` đã pin và UI với DOM; `pnpm build` dựng bundle; `pnpm package` chép bundle vào gói portable. Bằng chứng: `docs/figma-exporter-evidence.md` / `.json`.

## Chưa xác nhận (không có Figma Desktop thật trong lần triển khai này)

- Import development bundle từ `manifest.json` (không có `id`), việc Figma có yêu cầu `id` do Figma cấp ở lần đầu, và luồng cập nhật manifest.
- `networkAccess` với `allowedDomains: ["none"]` + `devAllowedDomains: ["http://127.0.0.1:<cổng>"]`, CORS/Private Network Access của iframe, và việc `Origin: null` đúng như giả định.
- `figma.fileKey` thực tế trả gì với plugin development (có thể luôn trống: khi đó nguồn là “do người dùng xác nhận”).
- Hành vi thực của từng getter trên file thật; bảng đối chiếu ≥ 30 node từ file **AI Department Exporter Qualification** soát trong Figma; export toàn file thật; sửa node giữa lúc export; đóng plugin giữa upload.
- Cài đặt thật bằng tài khoản Windows chuẩn (không admin), máy bị policy chặn, và checksum catalog `4E5A411C…3795` (lấy từ đặc tả, chưa tải installer để đối chiếu); chữ ký Authenticode của installer.
- Import bundle từ gói portable trên thư mục có dấu/khoảng trắng; đóng Desktop sau publish rồi chạy task thật.
- CI GitHub trên Windows/Linux chưa chạy cho thay đổi này.

Phần fixture đã kiểm tra là hành vi của code đối với mô hình API giả; nó không chứng minh Figma thật hành xử y hệt.
