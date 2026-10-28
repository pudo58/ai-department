import { PNG } from 'pngjs';
import type { SnapshotFile, SnapshotPreviews } from '../../shared/design.js';
import { PREVIEW_MAX_EDGE, PREVIEW_MAX_PIXELS, SCREEN_PREVIEW_MAX_EDGE, type DependencyRecord } from '../../shared/figma.js';
import { idHash, sha256Hex } from '../../core/design.js';

type Row = { id: string; name: string; type: string };
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

/** Legacy snapshots remain immutable: describe only their real preview assets, never arbitrary PNG icons. */
export function previewCatalog(files: SnapshotFile[], deps: DependencyRecord[], row: (id: string) => Row | undefined): SnapshotPreviews {
  const images: SnapshotPreviews['images'] = [];
  const warnings: string[] = [];
  for (const d of deps) {
    if (d.k !== 'asset' || d.assetKind !== 'preview' || !d.source.nodeId) continue;
    if (d.status !== 'stored') { warnings.push(`Thiếu ảnh ${d.source.nodeId}: ${d.reason ?? d.status}`); continue; }
    const file = files.find((f) => f.kind === 'asset' && f.sha256 === d.id && f.mime === 'image/png');
    if (!file) continue;
    const node = row(d.source.nodeId);
    images.push({ nodeId: d.source.nodeId, name: node?.name ?? d.preview?.name ?? d.source.nodeId, nodeType: node?.type ?? d.preview?.nodeType ?? 'UNKNOWN',
      role: d.preview?.role ?? (node?.type === 'SECTION' ? 'overview' : 'screen'), fileId: file.id, path: file.path,
      width: d.width, height: d.height, scale: d.preview?.scale });
  }
  return { images, warnings };
}

/** Derived crops use the uploaded PNG, so creating them never edits the Figma document or a published snapshot. */
export async function buildPreviewCatalog(files: SnapshotFile[], deps: DependencyRecord[], row: (id: string) => Row | undefined,
  read: (path: string) => Buffer, write: (path: string, bytes: Buffer) => void): Promise<SnapshotPreviews> {
  const catalog = previewCatalog(files, deps, row);
  let detailCount = 0, detailBytes = 0;
  for (const image of [...catalog.images]) {
    if (image.role !== 'screen') continue;
    const bytes = read(image.path);
    if (bytes.length < 24 || !bytes.subarray(0, 8).equals(PNG_SIGNATURE)) { catalog.warnings.push(`Ảnh ${image.nodeId} không có PNG hợp lệ để tạo vùng chi tiết.`); continue; }
    const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20);
    image.width = width; image.height = height;
    if (width <= PREVIEW_MAX_EDGE && height <= PREVIEW_MAX_EDGE) continue;
    // Check IHDR before allocating decoded pixels; a compressed file can expand far beyond its byte limit.
    if (!width || !height || width > SCREEN_PREVIEW_MAX_EDGE || height > SCREEN_PREVIEW_MAX_EDGE || width * height > PREVIEW_MAX_PIXELS) {
      catalog.warnings.push(`Ảnh ${image.nodeId} vượt giới hạn xử lý vùng chi tiết; hãy export phạm vi nhỏ hơn.`); continue;
    }
    try {
      const source = await new Promise<PNG>((resolve, reject) => new PNG().parse(bytes, (error, png) => error ? reject(error) : resolve(png)));
      for (let y = 0; y < height; y += PREVIEW_MAX_EDGE) for (let x = 0; x < width; x += PREVIEW_MAX_EDGE) {
        if (detailCount >= 400 || detailBytes >= 64 * 1024 * 1024) throw new Error('Đã chạm giới hạn 400 vùng chi tiết hoặc 64 MB ảnh chi tiết.');
        const w = Math.min(PREVIEW_MAX_EDGE, width - x), h = Math.min(PREVIEW_MAX_EDGE, height - y);
        const tile = new PNG({ width: w, height: h });
        source.bitblt(tile, x, y, w, h, 0, 0); tile.gamma = source.gamma;
        const output = await new Promise<Buffer>((resolve, reject) => {
          const chunks: Buffer[] = [];
          tile.pack().on('data', (chunk: Buffer) => chunks.push(chunk)).on('error', reject).on('end', () => resolve(Buffer.concat(chunks)));
        });
        if (detailBytes + output.length > 64 * 1024 * 1024) throw new Error('Đã chạm giới hạn 64 MB ảnh chi tiết.');
        const path = `assets/${sha256Hex(output)}.png`;
        write(path, output);
        const scale = image.scale && image.scale > 0 && Number.isFinite(image.scale) ? image.scale : 1;
        catalog.images.push({ ...image, role: 'detail', fileId: idHash(path), path, width: w, height: h,
          region: { x: x / scale, y: y / scale, width: w / scale, height: h / scale } });
        detailCount++; detailBytes += output.length;
      }
    } catch (error) { catalog.warnings.push(`Không tạo đủ vùng chi tiết cho ${image.nodeId}: ${(error as Error).message.slice(0, 200)}`); }
  }
  return catalog;
}
