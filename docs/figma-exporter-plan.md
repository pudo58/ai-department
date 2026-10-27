# AI Department Exporter — kế hoạch triển khai chi tiết

Ngày lập: 27/10/2026. Căn cứ repo: `43a4a0e`. Đây là đặc tả để triển khai, chưa phải tính năng đã có hoặc kết quả kiểm thử đã đạt. Bản này thay thế các plan Figma trước đó.

## 1. Kết quả phải bàn giao

AI Department có tab MCP với card **Figma Desktop · Kết nối trực tiếp**. Người dùng bấm cài, đăng nhập Figma bằng giao diện chính thức, chạy plugin **AI Department Exporter**, chọn page/frame hoặc toàn bộ file, export thành snapshot KB, duyệt và dùng snapshot đó trong task.

Đường dữ liệu không dùng MCP server, bridge cộng đồng hoặc Figma REST API:

```text
Figma Desktop
  ├─ Exporter main: đọc tài liệu bằng Figma Plugin API
  └─ Exporter UI: ghép đôi, nhận lệnh cố định, truyền dữ liệu
           ↕ HTTP loopback, có xác thực session
AI Department
  ├─ Connection/Job Manager → staging → validator → snapshot/KB
  └─ Project/Contract → nguồn đã khóa → Planner/Author/Developer/Verifier
```

Không cần Bun. Plugin không nhận code/script tùy ý từ Department. Không tạo agent mới, không gọi model để crawl hoặc sinh Markdown. Các lượt agent dùng KB vẫn tính ngân sách hiện có.

Chốt hỗ trợ v1: Windows x64 để tự cài Desktop; editor Figma Design; schema/protocol/reader version 1. FigJam, Slides, video bytes, comment, version history, font binary và toàn bộ thư viện ngoài chưa nằm trong phạm vi đọc đầy đủ v1. Loại node/API chưa hỗ trợ phải hiện trong coverage, không biến thành dữ liệu rỗng rồi coi là đã đọc.

“Toàn bộ file” nghĩa là mọi page/node của file đang mở mà Plugin API cho phép truy cập. Không có quyền thì không thể đọc file khác chỉ bằng việc biết URL.

## 2. Giao diện và cài đặt

### 2.1. Tab MCP

Thêm route `#/mcp`, mục MCP trên sidebar. Dùng cơ chế điều hướng, API client, modal và UI hiện có. Không nhập module Node vào bundle client.

Trang có ba vùng: kết nối Figma, job export, thư viện snapshot. Card Figma được ghi nhãn **Desktop · Trực tiếp**, không quảng bá đây là MCP chính thức. Chỉ xây khung catalog có loại adapter để thêm MCP sau; không thêm trình nhập shell command/MCP server tùy ý trong v1.

Các nút:

- **Cài Figma Desktop & Exporter**: chạy job cài.
- **Mở Figma để đăng nhập**: mở executable đã xác minh.
- **Mở thư mục Exporter**: mở đúng thư mục chứa manifest để import.
- **Ghép đôi / Ngắt kết nối**: tạo mã một lần hoặc thu hồi session.
- **Kiểm tra kết nối**: kiểm tra plugin, protocol, metadata và khả năng đọc; không suy trạng thái login từ PID.
- **Chọn nguồn và phạm vi**, **Bắt đầu export**, **Hủy**, **Xem snapshot**, **Duyệt snapshot**.

Trạng thái riêng của Desktop, bundle plugin và session phải nhìn thấy độc lập. “Desktop đã mở” chưa phải “đã kết nối”; “đã kết nối” chưa phải “đã export đủ”. Error hiển thị nguyên nhân và một bước xử lý phù hợp, không dẫn người dùng gọi lại agent.

### 2.2. Cài Desktop bằng user thường

Phát hiện Desktop qua thông tin cài ứng dụng của user/machine và vị trí executable được hỗ trợ; kiểm tra file, chữ ký và phiên bản thực tế, không chỉ dựa registry. Nếu bản có sẵn dùng được thì giữ nguyên, không downgrade hay tự đóng app.

Nếu thiếu: tải `.exe` chính thức theo catalog installer của Department, kiểm tra SHA-256 và Authenticode, chạy `--silent` bằng quyền hiện tại, chờ có timeout 10 phút, sau đó xác minh executable và phiên bản. Không chạy MSI, `RunAs`, command shell tùy ý hoặc yêu cầu nâng quyền. Installer bị chặn trả lỗi có log; không né chính sách máy.

Catalog đầu tiên khóa Figma 126.9.16 x64: URL `https://desktop.figma.com/win/build/Figma-126.9.16.exe`, SHA-256 `4E5A411C95105D9826D23533F9D18E89B2FCC10E878BB85DD46DFD6F616C3795`. Catalog phải có trong bản phát hành và được review khi cập nhật; không lấy checksum từ cùng response tải file để tự coi là đáng tin. Figma có thể tự cập nhật; ghi phiên bản thấy được, không giả định app mãi ở bản installer ban đầu.

Job lưu từng bước để lần cài lại kiểm tra thành phần thực sự còn thiếu. Hủy trong lúc installer đã chạy chuyển sang bước đối chiếu sau cài; không xóa app vừa cài hoặc khẳng định rollback. Restart đối chiếu app/process trước khi cho cài lại. Gỡ tích hợp chỉ thu hồi session/bundle không dùng nữa, không tự gỡ Desktop hoặc xóa tài khoản của người dùng.

### 2.3. Đăng nhập và import plugin

Đăng nhập vẫn diễn ra trên Desktop/trình duyệt chính thức. Department không nhận email/mật khẩu, cookie, OAuth token của Desktop và không sửa dữ liệu nội bộ Figma. Không hứa tự chuyển một phiên web thành phiên Desktop.

Department chuẩn bị plugin dạng development bundle và mở thư mục manifest. Người dùng import trong Figma, mở file rồi chạy plugin. Nếu Figma yêu cầu tạo development plugin/ID trong tài khoản ở lần đầu, wizard hướng dẫn đúng bước đó và dùng ID do Figma cấp; không bịa ID xuất bản. Import development bundle và luồng cập nhật manifest là một hạng mục phải smoke-test trên bản Desktop thật.

## 3. Xây AI Department Exporter

### 3.1. Source, build và đóng gói

Tạo package nội bộ tại `plugins/figma-exporter/`, có ba phần độc lập:

| Phần | Trách nhiệm | Giới hạn |
|---|---|---|
| Main plugin | Figma API, inventory, readers, dependency graph, asset export | Không gọi API Department, không có Node/browser DOM |
| UI iframe | Ghép đôi, HTTP, băm/chia chunk, tiến trình, gửi ACK/yield về main | Không trực tiếp truy cập cây node Figma |
| Shared protocol/schema | Message, record, version, lỗi, validator dùng chung | Không import Node hoặc `figma` global |

Main và UI dùng TypeScript, typecheck bằng cấu hình riêng. Pin `@figma/plugin-typings`; bundle main thành một IIFE ES2020, không Node import, không module import còn lại. UI gồm HTML/JS/CSS local, không CDN hoặc script tải động. Dùng esbuild đã có qua Vite theo cách script package hiện đang sử dụng.

Build tạo `manifest.json`, `code.js`, `ui.html`, `bundle-manifest.json` và hướng dẫn import. Bundle manifest ghi plugin version, protocol version, reader version, hash từng file. `pnpm build` xây và kiểm tra plugin; script package phải chép đầy đủ bundle vào gói portable/npm để máy đích không cần build plugin.

Manifest đặt `editorType: ["figma"]`, `documentAccess: "dynamic-page"`. Chỉ cho kết nối origin loopback của instance Department; khi cài, tạo manifest/UI cấu hình theo port hiện tại từ template đã hash. Port thay đổi thì tạo bundle cấu hình mới và hướng dẫn import lại; không mở network wildcard. Không yêu cầu private/proposed API hoặc quyền current-user để tính năng cơ bản hoạt động.

### 3.2. Cách main và UI nói chuyện

Main mở UI bằng `figma.showUI`, nhận/trả message có schema qua `figma.ui.onmessage` và `postMessage`. UI chỉ chấp nhận message từ parent plugin; mọi message đều kiểm tra type, version, job ID và source session.

Chỉ có các lệnh: `HELLO`, `LIST_PAGES`, `LIST_ROOTS`, `START_EXPORT`, `ACK`, `YIELD_ACK`, `CANCEL`, `DISCONNECT`. Mỗi lệnh có tham số định kiểu; không có `eval`, lệnh sửa tài liệu hoặc đường chạy script tự do.

Đọc tối đa 100 node hoặc 8 ms liên tục rồi yield qua UI để Figma xử lý tương tác/hủy. Hai chunk chưa được ACK là mức backpressure tối đa. UI timeout ACK thì main dừng tạo dữ liệu mới, không tích toàn bộ file trong RAM. Lưu ý main sandbox không dựa vào `setTimeout`/DOM/fetch; scheduler và HTTP nằm ở iframe.

### 3.3. Nguồn và phạm vi

Plugin tạo source-session nonce mới mỗi lần chạy, trả `figma.root.name`, page IDs/names, selection, editor/API/plugin versions và file key nếu API thực sự trả được. Root/page ID hoặc tên file không được dùng như file key duy nhất.

URL người dùng nhập được parse để lấy file/branch key và node ID. Có file key thì đối chiếu; sai thì chặn. Không có file key thì lưu `sourceIdentity: user_attested`, hiển thị file name/page/root preview và yêu cầu xác nhận nguồn. Không bật private API chỉ để né giới hạn này. Source receipt ràng buộc URL khai báo, session nonce, scope hash và thời gian.

Ba phạm vi: selection, page(s), whole-file. Mặc định selection nếu có; nếu không thì yêu cầu chọn frame/page, không tự chọn cả file. Toàn bộ file là lựa chọn tường minh.

Chốt root IDs lúc bắt đầu. Khi người dùng đổi selection/current page, scope đang export không đổi. Root chồng nhau được khử trùng theo ancestry; thứ tự children gốc luôn được giữ.

### 3.4. Thuật toán export

1. Nhận job đã được Department tạo, xác minh source-session và scope hash; chụp config/limits, kiểm tra hủy.
2. Với whole-file, gọi `figma.loadAllPagesAsync()` trước khi quét. Với scope nhỏ, chỉ `page.loadAsync()` các page cần. Trạng thái UI phải tách “đang tải page” khỏi “đang đọc node”.
3. Đặt `skipInvisibleInstanceChildren = false` trong thời gian quét rồi khôi phục giá trị trước đó khi kết thúc. Không sửa visibility, current page hoặc thuộc tính tài liệu để làm export dễ hơn.
4. Pass inventory: duyệt bằng stack/queue lặp, không recursion theo độ sâu JS; lưu page/root, node ID/type, parent và ordered child IDs. Không bỏ qua INSTANCE, hidden hoặc locked layer. Không gom cả file bằng một `findAll()` rồi giữ toàn bộ vào một object lớn.
5. Pass read: mỗi node đi qua reader theo type; emit record và hash, thu reference component/style/variable/image. Getter lỗi được ghi theo field, không nuốt lỗi.
6. Đọc dependency và assets theo quy tắc bên dưới, có visited set, xử lý cycle và không tạo/import nội dung vào Figma.
7. Pass verification: đọc lại inventory và hash các dữ liệu đã serialize để đối chiếu. ID mất/thêm, children đổi hoặc value đổi đều thành `source_changed`, không tạo draft được phép publish. Kiểm tra cả token/style/dependency đã thu. Whole-file còn theo dõi `documentchange` sau khi đã tải đủ page; scope nhỏ không giả định event đó hoạt động khi chưa load toàn file.
8. Gửi manifest kết thúc và kiểm kê; server tự kiểm chứng chunk/graph/field coverage rồi mới chuyển sang `review_ready`.

Không có snapshot nguyên tử do Plugin API cấp. Kết quả verification được ghi là “không thấy thay đổi qua các pass đối chiếu”, không gọi là lock tài liệu hay version Figma đã được xác nhận. User nên tránh sửa file lúc export. Preview raster ghi thời điểm riêng và không được coi là phép chứng minh pixel khớp dữ liệu.

### 3.5. Readers và dữ liệu cụ thể

Không `JSON.stringify(node)` hoặc enumerate mù mọi getter. Mỗi reader có danh sách trường, điều kiện áp dụng và serializer đã typecheck theo typings được pin. Bản lưu “raw” là các thuộc tính API đã đọc, không quảng bá là file Figma nguyên gốc.

| Reader | Dữ liệu phải giữ | Điểm dễ sai cần xử lý |
|---|---|---|
| Common/tree | id/name/type, parent/children order, visibility/locked, opacity, transforms, bounds, rotation, clipping/mask | Giữ hidden child, transform và parent relation; không dùng tên làm key |
| Layout/container | auto-layout, padding/gap, wrap, sizing, alignment, constraints, min/max, grid khi được hỗ trợ | Giữ đơn vị và enum; không suy breakpoint từ tọa độ |
| Paint/effect | fills/strokes, gradient và stop, weight/alignment, radius, blend/effects | Giữ nhiều paint, alpha và transform; không thay bằng một màu gần đúng |
| Text | characters, text box settings, alignment, paragraph/list/line-height/spacing, text runs, style/binding refs, missing-font | `figma.mixed` thành trạng thái mixed; dùng `getStyledTextSegments` và API theo range cho các trường chưa được segments trả đủ, giữ start/end |
| Component/set | key/description, definitions, property/variant axes, child components trong scope | Không tách variant bằng cách đoán chuỗi tên khi API có property definitions |
| Instance | rendered/effective children và values, `getMainComponentAsync`, componentProperties, direct override fields, nested instance refs | Direct overrides không bao gồm inherited overrides; giữ effective value, không gọi `resetOverrides` hoặc detach |
| Style/variable | style object, collection/mode IDs, valuesByMode, alias refs, bindings, explicit/resolved mode, literal value thấy trên node | Không dùng mode đầu tiên cho mọi instance; alias cycle/missing được ghi rõ |
| Vector/media | geometry/paths có thể đọc, image refs, crop/scale/filter, export settings | Không flatten/clone/sửa node để export; video có metadata nhưng v1 chưa hứa có binary |
| Prototype | reactions, trigger/action/transition, destination và flow info công khai | Link ra ngoài scope được giữ như external ref; không coi đó là logic nghiệp vụ hoàn chỉnh |

Mỗi trường có trạng thái: `read`, `mixed`, `not_applicable`, `unsupported`, `unavailable` hoặc `error`, kèm lý do và API nguồn. Giữ số 0, boolean false, null hợp lệ và đơn vị; không dùng giá trị mặc định đoán để lấp chỗ thiếu. Kiểu node mới vẫn có common/tree record và issue `unsupported_node_type`, không tự gọi là đã đọc đầy đủ.

### 3.6. Dependency và asset

Scope frame/page: lấy style/variable/image được tham chiếu và alias closure; lấy main component đọc được mà không cần import, ghi `dependency_only` cho nội dung ngoài root. Không tự kéo mọi variant sibling hay toàn bộ team library. Variant coverage chỉ ghi các variant thực sự đọc. Nếu muốn đủ component set, người dùng chọn thêm set vào scope.

Whole-file: ngoài references còn liệt kê toàn bộ local styles và local variable collections/variables bằng API async. Không đồng nghĩa với mọi thư viện từ xa. Alias được giải theo mode, có visited set để phát hiện cycle. Giữ refs và literal/effective value kể cả khi metadata dependency không lấy được; không báo dependency đã resolve.

Image: `getImageByHash(hash)` rồi `getBytesAsync()`, khử trùng theo nội dung; lưu metadata crop/filter riêng trên paint. SVG chỉ export node phù hợp; giữ JSON geometry riêng. Root preview dùng PNG, cạnh dài mặc định tối đa 2048 px. Không export PNG khổng lồ của toàn page rồi coi đó là dữ liệu cấu trúc.

Mỗi asset có loại `original_image`, `vector_export` hoặc `preview`, node/ref nguồn, MIME, byte length và SHA-256. Tên file server sinh từ hash, không từ tên layer. Preview hiển thị PNG; SVG chỉ tải xuống hoặc render sau sanitizer, không nhúng SVG/HTML nguồn vào DOM.

Để v1 có điểm kết thúc rõ: asset đơn tối đa 25 MiB; vượt giới hạn ghi thiếu asset và không coi group đó là complete. Không thu font binary, media stream hoặc tài nguyên ngoài bằng URL tùy ý. Có `missing-font` thì cảnh báo khả năng render, không tự thay font trong tài liệu.

## 4. Giao thức local và vòng đời job

### 4.1. Dùng HTTP của server hiện có

Không thêm relay/port riêng. Exporter UI dùng origin loopback được cấu hình khi chuẩn bị bundle, gửi HTTP JSON tới namespace `/api/figma-exporter/`. UI poll có xác thực để nhận lệnh, server không cần mở kết nối vào Figma.

Admin UI của Department vẫn dùng Host/Origin/CSRF hiện có. Chỉ namespace plugin có cơ chế auth riêng; không bỏ bảo vệ chung và không cho session plugin gọi API project/run/delivery.

Ghép đôi:

- Admin UI tạo mã ngẫu nhiên 8 chữ số, dùng một lần, TTL 5 phút; tối đa 5 lần sai cho một mã, có giới hạn tốc độ chung. Tạo mã mới vô hiệu mã cũ.
- Người dùng nhập mã trong Exporter, thấy tên instance Department và xác nhận kết nối.
- Server cấp token 256-bit, giữ hash trong memory, bind connection/source-session. UI plugin giữ token trong memory, không nhét token vào URL/log hoặc lưu cùng snapshot.
- Không xem Origin opaque của iframe là bằng chứng auth. Chỉ các endpoint plugin nhận đúng Origin được hỗ trợ cùng mã/token; preflight CORS chỉ cho namespace này, không dùng wildcard credentials.
- Restart thu hồi session token; job đang chạy thành interrupted. Người dùng ghép đôi lại và tạo job mới.

### 4.2. Chunk và xác nhận

Envelope phiên bản 1 có `jobId`, `sourceSession`, `scopeHash`, `seq`, `kind`, `byteLength`, `sha256` và payload base64. Dữ liệu record là UTF-8 NDJSON; binary asset là stream riêng. Nếu một record dài hơn chunk thì chia theo byte và reassemble trước khi parse, không cắt chuỗi Unicode theo character count.

Chunk tối đa 256 KiB decoded, request tối đa 512 KiB; giữ body limit chung của app. Server kiểm tra độ dài/hash và append vào staging rồi mới ACK `seq`. Cùng job/seq/hash gửi lại là no-op; cùng seq khác hash trả 409; thiếu sequence chưa được finalize. ACK chỉ chứng minh bytes đã lưu, chưa chứng minh đã đọc đầy đủ Figma.

Inventory và manifest lớn cũng được truyền bằng stream chunk. Request `finish` chỉ mang lastSeq, stream/manifest hashes và tổng bytes, không gửi lại toàn bộ danh sách node trong một HTTP body. Vì vậy whole-file lớn vẫn tuân body limit thay vì phải nới giới hạn chung.

UI được gửi lại đúng chunk tối đa 2 lần khi mất ACK trong cùng phiên còn sống. Không retry tự động traversal, export ảnh hoặc job đã đổi nguồn. Poll timeout 25 giây, request data 30 giây, heartbeat 10 giây; mất liên lạc 30 giây dừng job. Bộ đệm tối đa 2 chunk để backpressure tới main.

Mặc định: 10 phút/job, 20.000 node, 200 MiB decoded gồm verification/upload và asset, 25 MiB/asset. Form nâng cao cho tăng tới 60 phút, 200.000 node, 2 GiB/job, 100 MiB/asset sau kiểm tra dung lượng; limits được khóa trong job. Chạm trần tạo partial draft và hiển thị nút tạo lượt mới, không giảm phạm vi hoặc tự nâng limits.

### 4.3. State machine và recovery

Các pha: `queued → preparing → inventory → reading → dependencies → assets → verifying → assembling → review_ready`. Trạng thái kết thúc khác: `partial`, `failed`, `cancelled`, `interrupted`. `published` là trạng thái snapshot, không phải bằng chứng job vẫn chạy.

Một active export/connection; Browse/Check không chen vào lúc đang export. Cài/gỡ/cập nhật plugin cũng khóa khi connection đang có job. Tạo job và chiếm lock trong cùng giao dịch DB.

Hủy đánh dấu ý định trước, gửi CANCEL, thu hồi quyền ghi job; chunk muộn bị từ chối. Promise Figma đang tải page/export không nhất thiết hủy ngay, nhưng kết quả của nó không còn được nhận. Không tự đóng Desktop hoặc sửa tài liệu để hủy.

V1 không resume extraction giữa hai phiên: restart hoặc đổi source-session bắt đầu job mới từ đầu. Staging cũ còn để chẩn đoán tới khi người dùng xóa; có thể dọn staging terminal sau 7 ngày, tuyệt đối không dọn snapshot được tham chiếu. Không cấp quyền tự tiếp tục job chỉ vì thấy lock file.

## 5. Validator, snapshot và KB

### 5.1. Điều kiện trước khi review

Server kiểm tra độc lập:

- Toàn bộ chunk đúng thứ tự/hash/byte length và manifest kết thúc khớp.
- Root đã yêu cầu đều có; page/node ID duy nhất; graph không có cycle, parent/child khớp, giữ ordered children.
- Tập ID inventory đầu/cuối và tập node record khớp; ID bị thiếu hoặc lỗi traversal là blocker. Tỷ lệ node không dùng để che việc chưa biết số descendant của phần chưa đọc.
- Mỗi reader đã trả trạng thái cho các field group áp dụng, không chỉ “node có JSON”.
- References được resolve hoặc có issue cụ thể; asset không giả dạng complete khi chỉ có preview.
- Verification không phát hiện nguồn thay đổi và session/scope không đổi.

Phân biệt `structureComplete`, `fieldCoverage`, `dependencyCoverage`, `assetCoverage`, `sourceIdentity`, `consistency`. Không gộp chúng thành một nhãn “100%”. Sai cấu trúc/hash/thiếu node/chạm giới hạn không được publish để dùng cho task. Trường API không hỗ trợ, thư viện ngoài, thiếu asset phụ hoặc nguồn do người xác nhận có thể publish **có giới hạn** sau khi xem và xác nhận đúng danh sách issue. Run về sau cần dữ liệu thiếu đó thì phải chặn trước AI, không để tick cảnh báo vượt yêu cầu bắt buộc.

### 5.2. Lưu trữ và hash

Thư mục dữ liệu: `integrations/figma/` chứa bundle cấu hình; `design-staging/<jobId>/` chứa chunk/record; `design-snapshots/<snapshotId>/` chứa bản bất biến. Node file name dùng hash ID, asset file name dùng content hash để hợp lệ trên Windows và không có path traversal. Metadata/query đặt trong SQLite Collection như các thực thể hiện có; không nhét binary hoặc cả file vào một row.

Snapshot có: schema/reader/protocol/bundle versions, source/receipt, scope, limits, thời gian bắt đầu/kết thúc, verification/coverage/issues, node/asset inventory và hash các file.

Tách hai hash:

- `contentHash`: dữ liệu thiết kế và asset đã chuẩn hóa, không gồm thời gian hay receipt; phục vụ so sánh nội dung.
- `snapshotHash`: manifest bất biến với provenance và hash file; dùng cho duyệt và hợp đồng.

Receipt publish lưu riêng, không sửa manifest đã hash. Finalize ghi thư mục tạm rồi rename cùng volume; DB chuyển review_ready/published trong transaction sau khi file tồn tại và kiểm tra được. Recovery đối chiếu orphan directory/record, không suy thành công từ một cờ DB hoặc thư mục rỗng.

### 5.3. Cấu trúc KB và refresh

```text
snapshot/
  manifest.json
  index.json
  source/                 # record thuộc tính đã đọc + coverage, không phải .fig gốc
  pages/<id-hash>/         # index phân cấp, tránh một index khổng lồ
  components/<id-hash>/
    index.md
    variants.json
  tokens/
  assets/<content-hash>.*
  review.json
```

Markdown sinh bằng template từ facts; giữ tên gốc dưới dạng data và escape HTML/fence. Không suy atomic design, quy tắc responsive hoặc behavior từ hình. Layer text và description là nội dung tham khảo, không phải instruction có quyền sửa hợp đồng/chạy lệnh.

Refresh là export mới với source/phạm vi xác nhận lại. Diff theo ID/key và value: thêm/sửa/xóa, mode/override/asset đổi, phần thiếu mới. Source không có định danh tin cậy chỉ được nối lịch sử sau xác nhận nguồn, không tự ghép hai file vì cùng tên. Snapshot cũ bất biến; ghi chú người dùng nằm ở collection riêng.

UI cho xem kiểm kê, field issue, node/raw/normalized record, preview và diff. `publish` nhận snapshotHash và issue IDs đã xác nhận; server tính lại, hash cũ hoặc thiếu xác nhận trả 409. Nhãn dùng “Đã đọc đủ cấu trúc trong phạm vi” hoặc “Có giới hạn”, không dùng “thiết kế đã được chứng minh đúng”.

## 6. Đưa nguồn vào project và run

### 6.1. Contract binding

Project có snapshot mặc định tùy chọn. Create Run cho dùng mặc định, chọn snapshot khác hoặc không dùng. Server chốt reference tại create, kiểm tra trạng thái publish/hash trước Planner, không chọn “latest” lúc resume.

Thêm `TaskContract.design?` chứa `snapshotId`, `snapshotHash`, `targetIds`, `acknowledgedIssueIds`, `designPolicyVersion: 1`. Tất cả nằm trong hash hợp đồng. Target có thể là một subset của KB toàn file, để không ép task đọc cả design system.

Planner nhận nguồn đã chốt nhưng không tự thay ID/hash/target. Tất cả code path đề xuất/sửa hợp đồng phải giữ design binding do server quản lý: hiện `reviseContract` thay toàn bộ content nên không được để output Planner làm rơi field mới. Chọn nguồn khác là action sửa hợp đồng, tăng version và làm mất approval/bằng chứng theo cơ chế hiện có; không xóa lịch sử.

Kế hoạch ca vẫn dùng R-x/C-x và oracle hiện có. Có thể thêm design reference tùy chọn `{nodeId, fieldPath}` cạnh ca; nó không thay thế căn cứ requirement và không tự tạo assertion bắt buộc mới. UI review hiển thị nguồn/target/giới hạn cạnh hợp đồng. Yêu cầu hành vi không có trong thiết kế phải được làm rõ, không bịa test từ tọa độ.

Chặn dữ liệu bắt buộc theo quy tắc xác định: tree của target luôn bắt buộc; mỗi design reference của ca bắt buộc phải tồn tại trong snapshot và có trạng thái `read` hoặc `mixed` với dữ liệu range/segment đủ để dùng. `unsupported`, `unavailable`, `error` hoặc `not_applicable` không đáp ứng reference đó. Nếu chưa có plan ở Single/Clarify/Compare, các design reference bắt buộc được khai báo cạnh requirement. Khi chưa khai báo reference, server chỉ có thể chặn lỗi cấu trúc và cảnh báo coverage; không được tuyên bố tự hiểu được mọi dữ liệu mà nghiệp vụ sẽ cần. Thay reference phải sửa hợp đồng/kế hoạch và duyệt lại.

### 6.2. Context cho các vai

Planner nhận mục tiêu/coverage; Author nhận facts liên quan kế hoạch; Developer nhận component/token/asset target; Verifier nhận cùng nguồn gốc và evidence hiện hành, không nhận giải thích của Developer. Independent interpreter của Clarify vẫn giữ nguyên quy tắc chỉ đọc yêu cầu gốc.

Design context tách khỏi bộ nhớ project: không bị tắt vì `contextEnabled=false` hoặc Verifier budget 0. Prompt có summary, target index và đường dẫn tới KB; không nhét toàn bộ snapshot. Summary tối đa 2.000 token ước tính/vai, phần còn lại đọc từ file. Không cắt âm thầm dữ liệu bắt buộc; nếu target quá lớn phải chia task/target hoặc báo giới hạn rõ.

Tạo run-specific copy nội dung đã chọn ngoài source code: Docker bind-mount `/aidept-design:ro`; local dùng thư mục dữ liệu riêng cho run và kiểm tra hash trước/sau mỗi attempt. Local runtime không được quảng bá là có OS sandbox tuyệt đối; thay đổi bản cấp cho agent phải bị phát hiện và chặn, không dùng làm nguồn mới. Không cấp đường dẫn canonical store cho agent.

Runtime thiếu khả năng cung cấp file thiết kế phải chặn trước lượt AI thay vì chạy với prompt thiếu nguồn. Run checks không cần kết nối Desktop. Chỉ asset được Developer đưa vào vùng code được hợp đồng cho phép mới xuất hiện trong diff/delivery; không tự sao chép cả KB.

Agent input receipt ghi snapshot/target hash, summary hash, file index đã cấp và vị trí mount, không khẳng định model đã đọc mọi file. Report JSON/Markdown và RunDetail thể hiện nguồn, coverage, giới hạn và việc chưa có visual verification. Không hạ blocker check/manifest/delivery hiện tại và không tự nâng qualityPolicyVersion vì thêm nguồn thiết kế.

## 7. Interfaces và API

Thêm types/schema có version: `IntegrationConnection`, `IntegrationInstallJob`, `ExporterSession`, `FigmaExportJob`, `FigmaNodeRecord`, `ExportCoverage`, `DesignSnapshot`, `DesignPublishReceipt`, `DesignInputReceipt`. Project thêm `designSource?`; contract thêm `design?`; dữ liệu cũ giữ absent, không tự thêm null/default làm đổi hash.

| API của Department UI | Hành vi |
|---|---|
| `GET /api/integrations` | Catalog và connection summary, Figma/direct đầu tiên |
| `POST /api/integrations/figma/install` | Job cài Desktop và chuẩn bị bundle |
| `POST /api/integrations/figma/open-desktop` | Mở app bằng executable được phát hiện, không nhận command/args tùy ý |
| `POST /api/integrations/figma/open-plugin-folder` | Mở thư mục bundle thuộc instance hiện tại |
| `POST /api/integrations/figma/pairing` | Tạo mã ghép đôi |
| `POST /api/integrations/figma/check` | Kiểm tra phiên đã ghép đôi, metadata/capabilities |
| `POST /api/integrations/figma/disconnect` | Thu hồi session, dừng quyền ghi job |
| `POST /api/integrations/figma/browse` | Liệt kê page/root có giới hạn, không bắt đầu export ngầm |
| `POST /api/design-exports` | Tạo job với connection/source/scope/limits; trả 202 + jobId |
| `GET /api/design-exports/:id` | Tiến trình, phase, số liệu, issues |
| `POST /api/design-exports/:id/cancel` | Hủy idempotent |
| `GET /api/design-snapshots` và `/:id` | Metadata, manifest, coverage |
| `GET /api/design-snapshots/:id/files/:fileId` | Chỉ file có trong manifest, không nhận filesystem path tùy ý |
| `GET /api/design-snapshots/:id/diff?base=...` | Diff cùng nguồn/phạm vi hoặc trả không so sánh được |
| `POST /api/design-snapshots/:id/publish` | Duyệt đúng hash và issue IDs |
| `DELETE /api/design-snapshots/:id` | Chỉ bản không được project/run tham chiếu |

Namespace plugin chỉ có `pair`, `poll`, `chunk`, `event`, `finish`, `disconnect`; phiên plugin không gọi được API duyệt/publish/run/project. Session, job và command đều có version/ID ràng buộc; command cũ không được thực thi lần hai sau khi reconnect. Publish, đổi source project và chọn nguồn run dùng API cùng CSRF hiện có; không cho plugin tự duyệt dữ liệu nó gửi.

Payload sai trả 400; không tìm thấy 404; token sai/hết hạn 401/403; xung đột trạng thái/hash/version 409; vượt request bytes 413; quá tốc độ 429. Error response có mã lỗi và hướng xử lý, không log document body/token. Không dùng nguồn URL/node name để dựng shell hay đường dẫn.

Gỡ project giữ snapshot còn run/project khác tham chiếu; cleanup phải xét cả run completed để còn khả năng audit. Chưa có chính sách retention snapshot tự động thì chỉ cho xóa thủ công bản không được tham chiếu. Bundle phiên bản còn được session dùng cũng được bảo vệ.

## 8. Các mốc triển khai và gate

| Mốc | Việc phải làm | Gate để đi tiếp |
|---|---|---|
| A — Plugin thật tối thiểu | Build bundle; import trên Desktop; ghép đôi HTTP; đọc một frame và child/text/image | Windows user thường chạy được, CSP/CORS/port và metadata được xác nhận; nếu lỗi phải sửa, không bỏ phần live bằng fixture |
| B — Reader và export đầy đủ | Inventory/read/verify, toàn file, dependencies, assets, coverage, chunk/ACK/cancel | Fixture không cho partial/source-changed thành complete; không có call sửa file |
| C — Tab và installer | Wizard, Desktop user install, progress/errors, bundle version/update | Cài/rerun/đã cài/bị chặn có đúng trạng thái và hướng xử lý |
| D — Snapshot và review | Staging, validator, hashes, KB, diff/publish/ref protection | Hash cũ/thiếu chunk/thiếu node không publish; nguồn có giới hạn hiển thị đúng |
| E — Task integration | Project/default, contract/hash, prompt/file mount, report và compatibility | Các vai có cùng nguồn, old-run hash giữ nguyên, không cần Desktop sau publish |
| F — Qualification/bàn giao | Live golden file, build/reliability, package smoke test, tài liệu/evidence | Có bảng xác nhận từng nhóm dữ liệu; phần chưa xác nhận ghi riêng |

## 9. Kiểm thử và tiêu chí hoàn tất

### 9.1. Test tự động bằng fixture

Fixture Figma API phải có async page loading, getter ném lỗi, `mixed` và object không JSON-serializable để tránh unit test chỉ phản ánh plain JSON dễ đọc.

- Tree: nhiều page, hidden/locked layer, nested instance, overlap root, thứ tự, độ sâu lớn, node bị xóa/thêm giữa pass.
- Reader: gradient/alpha, min/max sizing, text nhiều style và binding, direct/inherited override, variant set, alias theo mode/cycle/missing, main component remote không đọc được, node type mới.
- Completeness: thiếu record nhưng counts khớp giả, parent/child sai, duplicate ID, stub, field group bị bỏ, preview có nhưng asset gốc thiếu.
- Transport: chunk Unicode/binary chia biên, record lớn, duplicate/sai hash/sai seq, ACK mất, backpressure, source nonce sai, chunk muộn sau cancel, code pairing hết hạn/brute-force.
- Failure: giới hạn tài nguyên, mất mạng local, plugin đóng, page.load/export promise chưa kết thúc khi hủy, server crash trước/sau finalize/DB update.
- Storage: Windows path, traversal, symlink, tên layer chứa HTML/fence, SVG có script/external resource, snapshot bị sửa sau publish, receipt cũ, cleanup khi còn run tham chiếu.
- Integration: Planner output không làm rơi design; source/target đổi yêu cầu duyệt lại; no-source run giữ hash; Verifier nhận design khi memory budget 0; local/Docker path và hash; agent không ghi vào nguồn; không đưa KB vào branch/files delivery.
- UI: cài/chờ login/chờ plugin, 2 nút đã yêu cầu, scope whole-file, progress, partial/source-changed, issue acknowledgement reset khi hash đổi, publish và chọn nguồn trong hợp đồng.

Thêm test mới vào allowlist reliability tường minh. Không dùng live model, không retry assertion để lấy xanh. Windows/Linux CI chạy fake Figma + transport/storage thật; Docker-specific test chạy khi runtime đó có sẵn và được ghi riêng.

### 9.2. Qualification trên Figma Desktop thật

Chuẩn bị file **AI Department Exporter Qualification** với ít nhất 3 page, nested auto-layout, hidden instance child, 1 component set nhiều variants, instance override/nested instance, mixed-style text, variable có 2 mode/alias, gradient/image/crop/vector/mask và prototype link. Lưu bảng kỳ vọng được soát trực tiếp trong Figma, không sinh oracle từ chính output Exporter.

Đối chiếu ít nhất 30 node đại diện và toàn bộ collection/mode/binding/asset reference trong file kiểm chứng. Giữ raw value trong schema; số double so với bảng chuẩn dùng sai số tuyệt đối 1e-6 khi phù hợp, enum/string/order phải khớp chính xác. Không dùng ảnh trông giống để kết luận JSON đúng. Asset kiểm tra bytes/hash hoặc khả năng decode/format theo loại; preview không thay asset gốc.

Thử whole-file và selection, chỉnh node giữa export, đóng plugin giữa upload, đổi server port và source không có file key. Kết quả phải phân biệt đúng đủ/partial/unsupported/user_attested/source_changed.

Kiểm tra installer trong tài khoản Windows chuẩn sạch; không dùng kết quả chạy dưới admin để chứng minh user-install. Thử máy có sẵn Figma và cài bị policy chặn. Import bundle từ gói portable trên thư mục có dấu/khoảng trắng. Sau khi publish, đóng Desktop, tạo task fixture cho mọi vai và xác nhận vẫn đọc được nguồn.

### 9.3. Hồ sơ bàn giao

- Tài liệu cài/import/login/pair/export/publish và xử lý lỗi.
- Bảng hỗ trợ node/field/API reader v1, cùng giới hạn cụ thể.
- JSON/Markdown kết quả fixture, UI và live; thời gian, byte/node count, peak buffer và lỗi từng nhóm.
- Build/typecheck gồm plugin + client/server, reliability và package smoke test đạt.
- Bằng chứng cài user thường, export whole-file, source-change detection và old-run compatibility.
- Không gọi model thật để xác nhận exporter. Live Figma và CI chỉ ghi đạt khi thực sự chạy; phần thiếu bằng chứng giữ trạng thái chưa xác nhận.

Không commit/push triển khai hoặc thay benchmark cũ chỉ từ việc duyệt plan này. Bảo toàn `.claude/`, `pnpm-workspace.yaml` và các thay đổi khác của người dùng. Mục tiêu hoàn tất là đường Desktop → Exporter → snapshot có duyệt → các vai dùng đúng nguồn chạy trọn vẹn, không chỉ có thêm tab cài đặt.

## 10. Nguồn kỹ thuật đã đối chiếu

- [Figma: How Plugins Run](https://developers.figma.com/docs/plugins/how-plugins-run/): main sandbox và UI iframe có khả năng khác nhau.
- [Figma: Accessing the Document](https://developers.figma.com/docs/plugins/accessing-document/): dynamic page loading và full traversal.
- [Figma: Plugin Manifest](https://developers.figma.com/docs/plugins/manifest/): documentAccess, main/UI và network permissions.
- [Figma global API](https://developers.figma.com/docs/plugins/api/figma/): giới hạn fileKey, hidden instance children và loadAllPagesAsync.
- [Figma InstanceNode](https://developers.figma.com/docs/plugins/api/InstanceNode/): main component async và direct overrides.
- [Figma TextNode](https://developers.figma.com/docs/plugins/api/TextNode/): mixed properties và range data.
- [Figma variables](https://developers.figma.com/docs/plugins/api/figma-variables/): APIs async của variables/collections.
- [Figma Image](https://developers.figma.com/docs/plugins/api/Image/): getBytesAsync và image handles.
- [Installer Figma 126.9.16](https://github.com/microsoft/winget-pkgs/blob/master/manifests/f/Figma/Figma/126.9.16/Figma.Figma.installer.yaml): EXE user scope và --silent.
