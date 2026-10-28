import type { SnapshotDiagnosticItem, SnapshotDiagnostics } from '../../shared/design.js';
import { FIGMA_NO_VISIBLE_LAYERS, hasNoVisiblePaint, hiddenNode } from '../../shared/figma.js';
import type { SnapshotReader } from './snapshots.js';

/** Read-only analysis also works for old snapshots; it never changes their hashes or accepted issue IDs. */
export function snapshotDiagnostics(reader: SnapshotReader): SnapshotDiagnostics {
  const rows = new Map([...reader.allRows()].map((row) => [row.id, row]));
  const facts = new Map<string, { parentId: string | null; visible?: boolean }>();
  const components = new Map<string, string>();
  const dependencies = [...reader.dependencies()];
  for (const d of dependencies) if (d.k === 'component') components.set(d.id, d.name);
  const componentItems: SnapshotDiagnosticItem[] = [], hiddenItems: SnapshotDiagnosticItem[] = [], failedItems: SnapshotDiagnosticItem[] = [], emptyItems: SnapshotDiagnosticItem[] = [];
  const paintless = new Set<string>();
  const item = (nodeId: string, reason: string): SnapshotDiagnosticItem => {
    const row = rows.get(nodeId), parts: string[] = [], seen = new Set<string>();
    for (let at = row; at && !seen.has(at.id); at = at.parentId ? rows.get(at.parentId) : undefined) { seen.add(at.id); parts.unshift(at.name || at.id); }
    return { nodeId, name: row?.name ?? nodeId, nodeType: row?.type ?? 'UNKNOWN', path: `${parts.length > 4 ? '… / ' : ''}${parts.slice(-4).join(' / ')}`, reason };
  };
  for (const row of rows.values()) {
    const node = reader.node(row.id);
    if (!node) continue;
    const visible = node.fields['common.visible'];
    facts.set(row.id, { parentId: row.parentId, visible: visible?.s === 'read' && typeof visible.v === 'boolean' ? visible.v : undefined });
    if (hasNoVisiblePaint(node)) paintless.add(row.id);
    const prop = node.fields['instance.componentProperties'];
    if (prop && ['error', 'unavailable', 'unsupported'].includes(prop.s)) {
      const entry = item(row.id, prop.r ?? prop.s);
      const main = node.fields['instance.mainComponentId'];
      if (main?.s === 'read' && typeof main.v === 'string') entry.component = { nodeId: main.v, name: components.get(main.v) ?? rows.get(main.v)?.name ?? main.v };
      componentItems.push(entry);
    }
  }
  for (const d of dependencies) {
    if (d.k !== 'asset' || d.assetKind !== 'vector_export' || !['missing', 'error'].includes(d.status)) continue;
    const nodeId = d.source.nodeId;
    const entry = item(nodeId ?? d.id, d.reason ?? d.status);
    const hidden = nodeId ? hiddenNode(nodeId, facts) : undefined;
    if (hidden) { entry.hiddenBy = { nodeId: hidden, name: rows.get(hidden)?.name ?? hidden }; hiddenItems.push(entry); }
    else if (nodeId && d.status === 'error' && FIGMA_NO_VISIBLE_LAYERS.test(d.reason ?? '') && paintless.has(nodeId)) emptyItems.push(entry);
    else failedItems.push(entry);
  }
  const groups: SnapshotDiagnostics['groups'] = [
    { kind: 'component_properties', title: 'Component property không đọc được', explanation: 'Figma không trả được cấu hình property/variant của các instance này. Kiểm tra component gốc được nêu bên dưới; ảnh và những trường đọc được vẫn được giữ.', items: componentItems },
    { kind: 'hidden_vector', title: 'SVG chưa xuất: node hoặc layer cha đang ẩn', explanation: 'Có bằng chứng visible=false trong snapshot. Cấu trúc và thuộc tính vẫn được lưu, nhưng SVG chưa có; cần export lại nếu bật hiển thị hoặc task cần tài nguyên này.', items: hiddenItems },
    { kind: 'vector_no_paint', title: 'SVG không xuất: node không có gì để vẽ', explanation: 'Figma báo node không có layer nhìn thấy và bản ghi node không có fill, stroke hay hiệu ứng hiển thị. Không có hình nào bị thiếu nên không cần xác nhận; liệt kê để bạn kiểm tra nếu muốn.', items: emptyItems },
    { kind: 'vector_failure', title: 'SVG chưa xuất: cần kiểm tra nguyên nhân', explanation: 'Chưa có bằng chứng node đang ẩn trong phạm vi đã đọc. Giữ nguyên lỗi API gốc; không coi các SVG này là đã có hoặc tự kết luận không cần thiết.', items: failedItems },
  ];
  return { groups: groups.filter((group) => group.items.length) };
}
