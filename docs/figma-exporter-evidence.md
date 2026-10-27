# Bằng chứng: Figma Exporter (fixture)

Sinh lúc 2026-10-27T17:15:04.800Z trên nền commit `43a4a0e` (cộng thay đổi chưa commit lúc chạy) bằng `scripts/figma-exporter-evidence.mjs`. Đây là bằng chứng về **code** chạy với Figma giả mô phỏng API (bundle plugin thật, UI thật trong jsdom, server thật). **Không** phải kết quả trên Figma Desktop thật.

## Test

136/136 đạt, 0 lỗi.

| File | Đạt | Lỗi | Bỏ qua | ms |
|---|---|---|---|---|
| figma-core.test.ts | 34 | 0 | 0 | 32 |
| figma-design-run.test.ts | 16 | 0 | 0 | 9976 |
| figma-exporter-e2e.test.ts | 2 | 0 | 0 | 1376 |
| figma-exporter-edges.test.ts | 13 | 0 | 0 | 12201 |
| figma-installer.test.ts | 17 | 0 | 0 | 697 |
| figma-snapshots.test.ts | 9 | 0 | 0 | 6212 |
| figma-transport.test.ts | 15 | 0 | 0 | 97 |
| figma-ui.test.ts | 14 | 0 | 0 | 2490 |
| figma-validator.test.ts | 16 | 0 | 0 | 15 |

## Export mẫu

| Export | Trạng thái | Node | Trang | Byte | Chunk | Đỉnh chưa ACK | ms | Nhất quán |
|---|---|---|---|---|---|---|---|---|
| một frame (selection) | review_ready | 6 | 0 | 33935 | 8 | 2 | 156 | unchanged_across_passes |
| toàn bộ file (golden, 3 trang) | review_ready | 12 | 3 | 52238 | 9 | 2 | 177 | unchanged_across_passes |
| frame lớn (1.800 node thêm) | review_ready | 1806 | 0 | 8550851 | 51 | 2 | 5290 | unchanged_across_passes |

Chỉ số độc lập, không gộp (ví dụ export toàn file):

```json
{
  "structureComplete": true,
  "fieldCoverage": {
    "total": 870,
    "read": 129,
    "mixed": 2,
    "notApplicable": 739,
    "unsupported": 0,
    "unavailable": 0,
    "error": 0
  },
  "dependencyCoverage": {
    "total": 5,
    "resolved": 5,
    "dependencyOnly": 0,
    "unavailable": 0
  },
  "assetCoverage": {
    "total": 4,
    "stored": 4,
    "missing": 0,
    "oversize": 0,
    "error": 0,
    "previewOnly": 2
  },
  "sourceIdentity": "verified",
  "consistency": "unchanged_across_passes"
}
```

## Chưa xác nhận

- figmaDesktop: chưa xác nhận
- installerUserScope: chưa xác nhận
- qualificationFile: chưa xác nhận
- ci: chưa chạy trên GitHub Windows/Linux

Chi tiết các mục chưa xác nhận: cuối `docs/figma-exporter.md`.
